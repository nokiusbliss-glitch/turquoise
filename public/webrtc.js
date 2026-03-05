/**
 * webrtc.js — Turquoise v5
 *
 * Cryptographic mesh heartbeat (every 5–7 s per peer):
 *   Each heartbeat payload: { type, ts, nonce, from, prevHash }
 *   Signed with ECDSA private key → verified with peer's public key.
 *   prevHash = SHA-256 of previous heartbeat payload → creates a
 *   tamper-evident chain (blockchain-style) that re-anchors on reconnect.
 *   Works entirely on local WiFi — no internet, no server dependency.
 *
 * Stale detection:
 *   20 s no valid heartbeat → warn + ICE restart attempt
 *   35 s → hard close + reconnect
 *
 * Public-key exchange:
 *   hello message includes pubkeyHex (exported ECDSA P-256 public key).
 *   Receiver verifies SHA-256(pubkey) === fingerprint before trusting.
 *   If key is non-exportable (legacy), heartbeats use hash-only chain (no sig verify).
 *
 * Renegotiation model: Perfect Negotiation (WebRTC §10.6)
 *   polite peer  = lower fingerprint → rolls back on collision
 *   impolite peer = higher fingerprint → drops conflicting offer
 *   _mediaLock + per-peer _mediaPending mutex guard concurrent offerWithStream calls
 */

const LOW_WATER  = 64  * 1024;
const HIGH_WATER = 1024 * 1024;
const FP_RE      = /^[a-f0-9]{64}$/i;

const HB_MIN_MS  = 5_000;
const HB_MAX_MS  = 7_000;
const HB_WARN_MS = 20_000;
const HB_DEAD_MS = 35_000;

/* ── crypto helpers ── */

async function sha256hex(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function randomHex(bytes = 8) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map(b => b.toString(16).padStart(2,'0')).join('');
}

/* ── network ── */

export class TurquoiseNetwork {
  constructor(identity) {
    if (!identity?.fingerprint) throw new Error('identity.fingerprint required');
    this.id     = identity;
    this.peers  = new Map();
    this.ws     = null;
    this._wsURL = null;
    this._retry = 0;
    this._timer = null;
    this._ping  = null;
    this._dead  = false;
    this._streamRefs = new WeakMap();

    this.onPeerConnected        = null;
    this.onPeerDisconnected     = null;
    this.onMessage              = null;
    this.onBinaryChunk          = null;
    this.onLog                  = null;
    this.onSignalingConnected   = null;
    this.onSignalingDisconnected = null;
  }

  connect(url) {
    this._wsURL = url;
    this._dead  = false;
    this._retry = 0;
    clearTimeout(this._timer);
    try { this.ws?.close(); } catch {}
    this._openWS();
  }

  destroy() {
    this._dead = true;
    clearTimeout(this._timer);
    clearInterval(this._ping);
    try { this.ws?.close(); } catch {}
    this.ws = null;
    for (const fp of [...this.peers.keys()]) this._closePeer(fp);
  }

  /* ── WebSocket ── */

  _openWS() {
    if (this._dead) return;
    this._log('connecting to signaling…');
    let ws;
    try { ws = new WebSocket(this._wsURL); }
    catch (e) { this._log('WS create failed: ' + (e?.message||e), true); this._scheduleWS(); return; }
    this.ws = ws;

    ws.onopen = () => {
      if (ws !== this.ws) return;
      this._retry = 0;
      this._log('signaling connected');
      this._send({ type:'announce', from:this.id.fingerprint, nick:this.id.nickname });
      this.onSignalingConnected?.();
      clearInterval(this._ping);
      this._ping = setInterval(() => {
        if (ws.readyState === 1) try { ws.send(JSON.stringify({type:'ping'})); } catch {}
      }, 25_000);
    };

    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      try { this._onSignal(JSON.parse(e.data)); } catch {}
    };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      if (ws !== this.ws) return;
      clearInterval(this._ping);
      if (this._dead) return;
      this._log(`signaling lost (${e.code}) — retrying`, true);
      this.onSignalingDisconnected?.();
      this._scheduleWS();
    };
  }

  _scheduleWS() {
    clearTimeout(this._timer);
    const ms = Math.min(30_000, 1000 * Math.pow(1.618, Math.min(this._retry++, 8)));
    this._timer = setTimeout(() => this._openWS(), ms);
  }

  _send(obj) {
    if (this.ws?.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  /* ── signaling dispatch ── */

  _onSignal(msg) {
    if (!msg?.type) return;
    if (msg.type === 'peer') {
      const fp = String(msg.fingerprint||'').toLowerCase();
      if (FP_RE.test(fp) && fp !== this.id.fingerprint && !this.peers.has(fp)) {
        setTimeout(() => { if (!this.peers.has(fp)) this._initiate(fp); }, Math.random()*200+50);
      }
      return;
    }
    if (msg.to && msg.to !== this.id.fingerprint) return;
    const from = String(msg.from||'').toLowerCase();
    if (!FP_RE.test(from)) return;
    switch (msg.type) {
      case 'offer':  this._onOffer(from, msg.sdp, msg.nick);  break;
      case 'answer': this._onAnswer(from, msg.sdp);           break;
      case 'ice':    this._onICE(from, msg.candidate);        break;
    }
  }

  /* ── peer state factory ── */

  _newPeerState(fp, pc, nick = null) {
    return {
      pc, ctrl:null, data:null, ready:false, nick,
      remoteStream:null, localStream:null, onRemoteStream:null,
      _closing:false,
      _isPolite: this.id.fingerprint < fp,
      _makingOffer:false, _ignoreOffer:false, _renegQueued:false,
      _mediaLock:false, _mediaPending:null,
      _pendingIce:[], _iceRestartTimer:null,
      _statsPrev: new Map(),
      // heartbeat chain
      _hbInterval:  null,
      _hbWarnTimer: null,
      _hbDeadTimer: null,
      _hbChain:     null,   // hex hash of last heartbeat WE sent
      _hbPeerChain: null,   // hex hash of last heartbeat WE RECEIVED
      _hbPubKey:    null,   // CryptoKey for peer's public key (ECDSA verify)
      _hbPubKeyHex: null,
    };
  }

  /* ── RTCPeerConnection factory ── */

  _makePC(fp) {
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers:[], bundlePolicy:'max-bundle', rtcpMuxPolicy:'require' });
    } catch (e) { this._log('RTCPeerConnection failed: '+(e?.message||e), true); return null; }

    pc.onicecandidate = ({candidate}) => {
      if (candidate) this._send({type:'ice', from:this.id.fingerprint, to:fp, candidate});
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        const ps = this.peers.get(fp);
        if (!ps) return;
        clearTimeout(ps._iceRestartTimer);
        ps._iceRestartTimer = setTimeout(() => {
          if (this.peers.get(fp)?.pc === pc && pc.iceConnectionState === 'failed') {
            this._log(`ICE restart: ${fp.slice(0,8)}`);
            try { pc.restartIce(); } catch {}
          }
        }, 500);
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') this._log(`P2P connected: ${fp.slice(0,8)}`);
      if (s === 'failed' || s === 'closed') {
        const ps      = this.peers.get(fp);
        const wasReady = !!ps?.ready;
        const name    = ps?.nick || fp.slice(0,8);
        this._closePeer(fp);
        if (wasReady) this.onPeerDisconnected?.(fp);
        this._log(`peer lost: ${name}`, wasReady);
        if (!this._dead) {
          setTimeout(() => { if (!this.peers.has(fp)) this._initiate(fp); }, 3000+Math.random()*1000);
        }
      }
    };

    pc.ontrack = (e) => {
      const ps = this.peers.get(fp);
      if (!ps) return;
      if (!ps.remoteStream) ps.remoteStream = new MediaStream();
      const track = e.track;
      if (!ps.remoteStream.getTracks().includes(track)) ps.remoteStream.addTrack(track);
      ps.onRemoteStream?.(ps.remoteStream);
      track.onunmute = () => ps.onRemoteStream?.(ps.remoteStream);
    };

    return pc;
  }

  /* ── data channel wiring ── */

  _wireCtrl(fp, ch) {
    const ps = this.peers.get(fp);
    if (ps) ps.ctrl = ch;
    let closed = false;

    ch.onopen = () => {
      this._log(`ctrl open: ${fp.slice(0,8)}`);
      this._sendHello(fp);
      this._checkReady(fp);
    };

    ch.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this._onPeerMsg(fp, msg);
    };

    ch.onerror = () => {
      if (closed) return;
      const p = this.peers.get(fp);
      if (!p || p._closing) return;
      const s = p.pc?.connectionState;
      if (s==='failed'||s==='closed'||s==='disconnected') return;
      this._log(`ctrl error: ${fp.slice(0,8)}`, true);
    };

    ch.onclose = () => { closed = true; };
  }

  _wireData(fp, ch) {
    const ps = this.peers.get(fp);
    if (ps) ps.data = ch;
    let closed = false;
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = LOW_WATER;

    ch.onopen = () => { this._log(`data open: ${fp.slice(0,8)}`); this._checkReady(fp); };
    ch.onmessage = (e) => { if (e.data instanceof ArrayBuffer) this.onBinaryChunk?.(fp, e.data); };
    ch.onerror = () => {
      if (closed) return;
      const p = this.peers.get(fp);
      if (!p||p._closing) return;
      const s = p.pc?.connectionState;
      if (s==='failed'||s==='closed'||s==='disconnected') return;
      this._log(`data error: ${fp.slice(0,8)}`, true);
    };
    ch.onclose = () => { closed = true; };
  }

  _checkReady(fp) {
    const ps = this.peers.get(fp);
    if (!ps || ps.ready) return;
    if (ps.ctrl?.readyState === 'open' && ps.data?.readyState === 'open') {
      ps.ready = true;
      this._log(`peer ready: ${ps.nick || fp.slice(0,8)}`);
      this.onPeerConnected?.(fp, ps.nick);
      this._startHeartbeat(fp);
    }
  }

  /* ── hello handshake (public key exchange) ── */

  async _sendHello(fp) {
    let pubkeyHex = null;
    if (this.id.exportPublicKey) {
      try { pubkeyHex = await this.id.exportPublicKey(); } catch {}
    }
    try {
      this.peers.get(fp)?.ctrl?.send(JSON.stringify({
        type: 'hello',
        fingerprint: this.id.fingerprint,
        nick: this.id.nickname,
        pubkeyHex,
      }));
    } catch {}
  }

  /* ─────────────────────────────────────────────────────────────
   * CRYPTOGRAPHIC HEARTBEAT CHAIN
   *
   * Every HB_MIN_MS–HB_MAX_MS each peer signs:
   *   { ts, nonce, from, prevHash }
   * where prevHash = SHA-256 of previous outgoing heartbeat payload.
   *
   * This creates a tamper-evident sequential chain across the
   * connection lifetime — works entirely on local WiFi, no internet.
   *
   * On receive: verify fingerprint → sig (if pubkey known) →
   *   prevHash continuity → reset stale timer.
   * ─────────────────────────────────────────────────────────────*/

  _startHeartbeat(fp) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    this._stopHeartbeat(ps);
    this._scheduleNextHB(fp);
  }

  _scheduleNextHB(fp) {
    const ps = this.peers.get(fp);
    if (!ps || ps._closing) return;
    const jitter = HB_MIN_MS + Math.random() * (HB_MAX_MS - HB_MIN_MS);
    ps._hbInterval = setTimeout(() => this._sendHeartbeat(fp), jitter);
  }

  async _sendHeartbeat(fp) {
    const ps = this.peers.get(fp);
    if (!ps || ps._closing || ps.ctrl?.readyState !== 'open') return;

    const prevHash = ps._hbChain || await sha256hex(this.id.fingerprint);
    const nonce    = randomHex(8);
    const ts       = Date.now();

    const payload  = { ts, nonce, from: this.id.fingerprint, prevHash };
    let sig = null;

    if (this.id.sign) {
      try { sig = await this.id.sign(payload); } catch {}
    }

    const hb = { type: 'heartbeat', ...payload, sig };

    // Update our chain with hash of this payload
    ps._hbChain = await sha256hex(JSON.stringify(payload));

    try { ps.ctrl.send(JSON.stringify(hb)); } catch {}

    this._scheduleNextHB(fp);
  }

  async _onHeartbeat(fp, msg) {
    const ps = this.peers.get(fp);
    if (!ps) return;

    // 1. Verify fingerprint matches
    if (msg.from !== fp) {
      this._log(`heartbeat fingerprint mismatch: ${fp.slice(0,8)}`, true);
      return;
    }

    // 2. Verify signature if we have the peer's public key
    if (ps._hbPubKey && msg.sig && this.id.verify) {
      const payload = { ts: msg.ts, nonce: msg.nonce, from: msg.from, prevHash: msg.prevHash };
      try {
        const valid = await this.id.verify(payload, msg.sig, ps._hbPubKey);
        if (!valid) {
          this._log(`heartbeat sig INVALID: ${fp.slice(0,8)} — possible tampering`, true);
          return;
        }
      } catch {}
    }

    // 3. Chain continuity check
    const expectedPrev = ps._hbPeerChain || await sha256hex(fp);
    if (ps._hbPeerChain && msg.prevHash !== expectedPrev) {
      // Chain break — may indicate reconnect or clock skew; log but don't drop
      this._log(`heartbeat chain break: ${fp.slice(0,8)} (reconnect?)`, false);
    }

    // 4. Update peer chain
    const payload = { ts: msg.ts, nonce: msg.nonce, from: msg.from, prevHash: msg.prevHash };
    ps._hbPeerChain = await sha256hex(JSON.stringify(payload));

    // 5. Reset stale timers
    this._resetHBTimers(fp);

    this._log(`♥ ${fp.slice(0,8)}${ps._hbPubKey ? ' ✓sig' : ''}`, false);
  }

  _resetHBTimers(fp) {
    const ps = this.peers.get(fp);
    if (!ps) return;

    clearTimeout(ps._hbWarnTimer);
    clearTimeout(ps._hbDeadTimer);

    ps._hbWarnTimer = setTimeout(() => {
      if (!this.peers.has(fp)) return;
      this._log(`heartbeat stale: ${fp.slice(0,8)} — attempting ICE restart`, true);
      try { this.peers.get(fp)?.pc?.restartIce(); } catch {}
    }, HB_WARN_MS);

    ps._hbDeadTimer = setTimeout(() => {
      if (!this.peers.has(fp)) return;
      this._log(`heartbeat dead: ${fp.slice(0,8)} — forcing reconnect`, true);
      const wasReady = !!this.peers.get(fp)?.ready;
      this._closePeer(fp);
      if (wasReady) this.onPeerDisconnected?.(fp);
      if (!this._dead) {
        setTimeout(() => { if (!this.peers.has(fp)) this._initiate(fp); }, 500);
      }
    }, HB_DEAD_MS);
  }

  _stopHeartbeat(ps) {
    if (!ps) return;
    clearTimeout(ps._hbInterval);
    clearTimeout(ps._hbWarnTimer);
    clearTimeout(ps._hbDeadTimer);
    ps._hbInterval = ps._hbWarnTimer = ps._hbDeadTimer = null;
  }

  async _importPeerPubKey(fp, pubkeyHex) {
    if (!pubkeyHex) return;
    const ps = this.peers.get(fp);
    if (!ps) return;

    try {
      // Verify SHA-256(pubkey) === fingerprint
      const raw = Uint8Array.from(pubkeyHex.match(/.{2}/g).map(h => parseInt(h,16)));
      const computedFp = await sha256hex(raw);
      if (computedFp !== fp) {
        this._log(`pubkey fingerprint mismatch for ${fp.slice(0,8)} — rejected`, true);
        return;
      }

      const key = await crypto.subtle.importKey(
        'raw', raw,
        { name:'ECDSA', namedCurve:'P-256' },
        false, ['verify']
      );
      ps._hbPubKey    = key;
      ps._hbPubKeyHex = pubkeyHex;
      this._log(`pubkey verified: ${fp.slice(0,8)}`);
    } catch (e) {
      this._log(`pubkey import failed: ${fp.slice(0,8)} — ${e?.message}`, true);
    }
  }

  /* ── initiate (caller side) ── */

  async _initiate(fp) {
    if (this.peers.has(fp)) return;
    this._log(`initiating: ${fp.slice(0,8)}`);
    const pc = this._makePC(fp);
    if (!pc) return;

    const ps = this._newPeerState(fp, pc, null);
    this.peers.set(fp, ps);

    const ctrl = pc.createDataChannel('ctrl', { ordered:true });
    const data = pc.createDataChannel('data', { ordered:true });
    this._wireCtrl(fp, ctrl);
    this._wireData(fp, data);

    pc.onnegotiationneeded = async () => {
      if (ps._mediaLock) return;
      if (ps._makingOffer) { ps._renegQueued = true; return; }
      try {
        ps._makingOffer = true; ps._renegQueued = false;
        await pc.setLocalDescription();
        this._send({ type:'offer', from:this.id.fingerprint, to:fp, sdp:pc.localDescription, nick:this.id.nickname });
      } catch (e) {
        if (!ps._closing) this._log('offer error: '+(e?.message||e), true);
      } finally {
        ps._makingOffer = false;
        if (ps._renegQueued && !ps._closing) {
          ps._renegQueued = false;
          setTimeout(() => pc.onnegotiationneeded?.(), 50);
        }
      }
    };
  }

  /* ── offer / answer / ICE ── */

  async _onOffer(fp, sdp, nick) {
    if (!sdp) return;
    let ps = this.peers.get(fp);
    if (!ps) {
      const pc = this._makePC(fp);
      if (!pc) return;
      ps = this._newPeerState(fp, pc, nick||null);
      this.peers.set(fp, ps);
      pc.ondatachannel = (e) => {
        if (e.channel.label === 'ctrl') this._wireCtrl(fp, e.channel);
        if (e.channel.label === 'data') this._wireData(fp, e.channel);
      };
    } else if (nick) { ps.nick = nick; }

    const collision = ps._makingOffer || ps.pc.signalingState !== 'stable';
    ps._ignoreOffer = !ps._isPolite && collision;
    if (ps._ignoreOffer) { this._log(`offer ignored (impolite+collision): ${fp.slice(0,8)}`); return; }

    if (collision) {
      try { await ps.pc.setLocalDescription({type:'rollback'}); ps._makingOffer = false; }
      catch (e) {
        this._log('rollback failed: '+(e?.message||e), true);
        this._closePeer(fp);
        if (!this._dead) setTimeout(() => this._initiate(fp), 300);
        return;
      }
    }

    try {
      await ps.pc.setRemoteDescription(sdp);
      await this._flushPendingIce(ps);
      await ps.pc.setLocalDescription();
      this._send({ type:'answer', from:this.id.fingerprint, to:fp, sdp:ps.pc.localDescription });
    } catch (e) {
      this._log('answer error: '+(e?.message||e), true);
      this._closePeer(fp);
    }
  }

  async _onAnswer(fp, sdp) {
    const ps = this.peers.get(fp);
    if (!ps||!sdp) return;
    if (ps._ignoreOffer) { ps._ignoreOffer = false; return; }
    try {
      await ps.pc.setRemoteDescription(sdp);
      await this._flushPendingIce(ps);
    } catch (e) {
      this._log('setRemoteDescription(answer) error: '+(e?.message||e), true);
    }
  }

  async _onICE(fp, candidate) {
    const ps = this.peers.get(fp);
    if (!ps||!candidate) return;
    if (!ps.pc.remoteDescription) { ps._pendingIce.push(candidate); return; }
    try { await ps.pc.addIceCandidate(candidate); }
    catch (e) {
      const m = String(e);
      if (!m.includes('701')&&!m.includes('closed')) this._log('ICE error: '+(e?.message||e), true);
    }
  }

  async _flushPendingIce(ps) {
    if (!ps?.pc?.remoteDescription||!ps._pendingIce?.length) return;
    const pending = ps._pendingIce.splice(0);
    for (const c of pending) {
      try { await ps.pc.addIceCandidate(c); }
      catch (e) {
        const m = String(e);
        if (!m.includes('701')&&!m.includes('closed')) this._log('ICE flush error: '+(e?.message||e), true);
      }
    }
  }

  /* ── peer message dispatch ── */

  _onPeerMsg(fp, msg) {
    if (!msg?.type) return;

    if (msg.type === 'hello') {
      const ps = this.peers.get(fp);
      if (ps && msg.nick) ps.nick = msg.nick;
      if (msg.pubkeyHex) this._importPeerPubKey(fp, msg.pubkeyHex);
      return;
    }

    if (msg.type === 'heartbeat') {
      this._onHeartbeat(fp, msg);
      return;
    }

    if (msg.type === 'answer-reneg') {
      this._applyRenegAnswer(fp, msg.sdp);
      return;
    }

    this.onMessage?.(fp, msg);
  }

  async _applyRenegAnswer(fp, sdp) {
    const ps = this.peers.get(fp);
    if (!ps||!sdp) return;
    try { await ps.pc.setRemoteDescription(sdp); await this._flushPendingIce(ps); }
    catch (e) { this._log('reneg answer error: '+(e?.message||e), true); }
  }

  /* ── public send API ── */

  sendCtrl(fp, msg) {
    const ps = this.peers.get(fp);
    if (ps?.ctrl?.readyState !== 'open') return false;
    try { ps.ctrl.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  sendBinary(fp, buf) {
    const ps = this.peers.get(fp);
    if (ps?.data?.readyState !== 'open') return false;
    try { ps.data.send(buf); return true; } catch { return false; }
  }

  waitForBuffer(fp) {
    return new Promise((resolve) => {
      const ps  = this.peers.get(fp);
      const ch  = ps?.data;
      if (!ch||ch.readyState!=='open'||ch.bufferedAmount<HIGH_WATER) { resolve(); return; }
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        clearTimeout(timer);
        ch.removeEventListener('bufferedamountlow', finish);
        resolve();
      };
      const timer = setTimeout(finish, 5000);
      ch.addEventListener('bufferedamountlow', finish, { once:true });
    });
  }

  isReady(fp) {
    const ps = this.peers.get(fp);
    return !!(ps?.ready && ps.ctrl?.readyState==='open' && ps.data?.readyState==='open');
  }

  getConnectedPeers() {
    return [...this.peers.entries()].filter(([,ps])=>ps.ready).map(([fp])=>fp);
  }

  getPeerNick(fp) {
    return this.peers.get(fp)?.nick || fp?.slice(0,8) || '?';
  }

  /* ── media ── */

  async getLocalStream(video = false) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true },
        video: video ? { width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30} } : false,
      });
    } catch (e) {
      if (e.name==='NotAllowedError'||e.name==='PermissionDeniedError')
        throw new Error('permission-denied:'+(video?'camera/mic':'microphone'));
      if (e.name==='NotFoundError')
        throw new Error('no-device:'+(video?'camera/mic':'microphone'));
      throw e;
    }
  }

  async offerWithStream(fp, stream, extra = {}) {
    const ps = this.peers.get(fp);
    if (!ps) throw new Error('Peer not connected: '+fp.slice(0,8));
    while (ps._mediaPending) { try { await ps._mediaPending; } catch {} }

    let _resolve;
    ps._mediaPending = new Promise(r => { _resolve = r; });
    try {
      this._releaseStream(ps.localStream);
      ps.pc.getSenders().forEach(s => { try { ps.pc.removeTrack(s); } catch {} });
      ps.localStream = stream;
      this._retainStream(stream);
      ps._mediaLock = true;
      stream.getTracks().forEach(t => ps.pc.addTrack(t, stream));
      const offer = await ps.pc.createOffer();
      await ps.pc.setLocalDescription(offer);
      this.sendCtrl(fp, {
        type:'offer-reneg', sdp:ps.pc.localDescription,
        callType: stream.getVideoTracks().length > 0 ? 'stream' : 'walkie', ...extra,
      });
    } finally {
      ps._mediaLock = false; ps._mediaPending = null; _resolve?.();
    }
  }

  async answerWithStream(fp, remoteSdp, stream, extra = {}) {
    const ps = this.peers.get(fp);
    if (!ps) throw new Error('Peer not connected: '+fp.slice(0,8));
    while (ps._mediaPending) { try { await ps._mediaPending; } catch {} }

    let _resolve;
    ps._mediaPending = new Promise(r => { _resolve = r; });
    try {
      this._releaseStream(ps.localStream);
      ps.pc.getSenders().forEach(s => { try { ps.pc.removeTrack(s); } catch {} });
      ps.localStream = stream;
      this._retainStream(stream);
      ps._mediaLock = true;
      stream.getTracks().forEach(t => ps.pc.addTrack(t, stream));
      await ps.pc.setRemoteDescription(remoteSdp);
      await this._flushPendingIce(ps);
      const answer = await ps.pc.createAnswer();
      await ps.pc.setLocalDescription(answer);
      this.sendCtrl(fp, { type:'answer-reneg', sdp:ps.pc.localDescription, ...extra });
    } finally {
      ps._mediaLock = false; ps._mediaPending = null; _resolve?.();
    }
  }

  async stopMedia(fp) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    this._releaseStream(ps.localStream);
    ps.localStream = null;
    ps.pc.getSenders().forEach(s => { try { ps.pc.removeTrack(s); } catch {} });
    this.sendCtrl(fp, { type:'call-end' });
  }

  setRemoteStreamHandler(fp, fn) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    ps.onRemoteStream = fn;
    if (ps.remoteStream) fn(ps.remoteStream);
  }

  /* ── stream ref counting ── */

  _retainStream(s) { if (!s) return; this._streamRefs.set(s, (this._streamRefs.get(s)||0)+1); }
  _releaseStream(s) {
    if (!s) return;
    const r = this._streamRefs.get(s)||0;
    if (r<=1) { this._streamRefs.delete(s); s.getTracks().forEach(t=>t.stop()); }
    else this._streamRefs.set(s, r-1);
  }

  /* ── stats ── */

  async getPeerStats(fp) {
    const ps = this.peers.get(fp);
    if (!ps?.pc) return null;
    const report = await ps.pc.getStats();
    const now    = Date.now();
    const out    = {
      connection: { rttMs:null, local:null, remote:null, state:ps.pc.connectionState },
      audio: { inKbps:0, outKbps:0, jitterMs:null, lost:0 },
      video: { inKbps:0, outKbps:0, width:null, height:null, fps:null, lost:0 },
    };
    const rateKbps = (stat, key) => {
      const cur  = typeof stat[key]==='number' ? stat[key] : null;
      const prev = ps._statsPrev.get(stat.id);
      ps._statsPrev.set(stat.id, {t:now, b:cur});
      if (!prev||cur===null||prev.b===null) return 0;
      const dt = (now-prev.t)/1000;
      return dt<=0 ? 0 : Math.max(0, ((cur-prev.b)*8)/1000/dt);
    };
    let pair = null;
    report.forEach(s => {
      if (s.type==='candidate-pair'&&s.state==='succeeded'&&s.nominated) pair = s;
      if (s.type==='inbound-rtp'&&!s.isRemote) {
        const kind = s.kind||'audio';
        const kbps = rateKbps(s,'bytesReceived');
        if (kind==='audio') { out.audio.inKbps+=kbps; if(typeof s.jitter==='number') out.audio.jitterMs=s.jitter*1000; out.audio.lost+=Number(s.packetsLost||0); }
        else { out.video.inKbps+=kbps; out.video.lost+=Number(s.packetsLost||0); if(s.frameWidth) out.video.width=s.frameWidth; if(s.frameHeight) out.video.height=s.frameHeight; if(s.framesPerSecond) out.video.fps=s.framesPerSecond; }
      }
      if (s.type==='outbound-rtp'&&!s.isRemote) {
        const kind = s.kind||'audio';
        const kbps = rateKbps(s,'bytesSent');
        if (kind==='audio') out.audio.outKbps+=kbps;
        else out.video.outKbps+=kbps;
      }
    });
    if (pair) {
      if (typeof pair.currentRoundTripTime==='number') out.connection.rttMs = pair.currentRoundTripTime*1000;
      const loc = report.get(pair.localCandidateId);
      const rem = report.get(pair.remoteCandidateId);
      out.connection.local  = loc  ? `${loc.candidateType}/${loc.protocol}`  : null;
      out.connection.remote = rem  ? `${rem.candidateType}/${rem.protocol}`  : null;
    }
    return out;
  }

  /* ── cleanup ── */

  _closePeer(fp) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    ps._closing = true;
    this._stopHeartbeat(ps);
    clearTimeout(ps._iceRestartTimer);
    this._releaseStream(ps.localStream);
    ps.onRemoteStream = null;
    try { ps.ctrl?.close(); } catch {}
    try { ps.data?.close(); } catch {}
    try { ps.pc.close();    } catch {}
    this.peers.delete(fp);
  }

  _log(text, isErr = false) {
    this.onLog?.(text, isErr);
    (isErr ? console.warn : console.log)('[TQ]', text);
  }
}
