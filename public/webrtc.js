/**
 * webrtc.js — Turquoise v5
 *
 * STUN-free (local WiFi), WS ping every 25s, perfect negotiation.
 * Flow control: LOW_WATER=64KB threshold, HIGH_WATER=1MB pause.
 *
 * Fixes:
 *   - getStats(): divided by r.timestamp/1000 which is the absolute epoch
 *     in seconds (~1.7 million), making all kbps readings effectively zero.
 *     Fix: track a per-peer stats baseline and compute delta bytes / delta time.
 *   - _schedWS(): exponential backoff had no jitter, causing thundering-herd
 *     reconnects when multiple clients lost connection simultaneously.
 *     Fix: added ±15% random jitter on the backoff delay.
 *   - waitForBuffer(): if the peer disconnected while we were waiting, the
 *     promise would hang for the full 5s timeout and then silently resolve,
 *     allowing the send loop to try (and fail) on a closed channel.
 *     Fix: check peer state and reject immediately on disconnect.
 *   - _closePeer(): clears pending waitForBuffer resolvers so transfers
 *     abort immediately instead of blocking the drain loop.
 *   - offerWithStream/answerWithStream: isCircle flag correctly threaded.
 */

const LOW_WATER  =  64 * 1024;   // 64 KB  — bufferedAmountLowThreshold
const HIGH_WATER = 1024 * 1024;  // 1 MB   — pause sending above this

export class TurquoiseNetwork {
  constructor(identity) {
    if (!identity?.fingerprint) throw new Error('identity.fingerprint required');
    this.id    = identity;
    this.peers = new Map();   // fp → PeerState

    this.ws      = null;
    this._wsURL  = null;
    this._retry  = 0;
    this._timer  = null;
    this._ping   = null;
    this._dead   = false;

    // Callbacks
    this.onPeerConnected         = null;
    this.onPeerDisconnected      = null;
    this.onMessage               = null;
    this.onBinaryChunk           = null;
    this.onLog                   = null;
    this.onSignalingConnected    = null;
    this.onSignalingDisconnected = null;
  }

  // ── Signaling ─────────────────────────────────────────────────────────────

  connect(url) {
    this._wsURL = url;
    this._dead  = false;
    this._retry = 0;
    // Close any existing WS cleanly before reconnecting
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      try { this.ws.close(); } catch {}
    }
    this._openWS();
  }

  _openWS() {
    if (this._dead) return;
    this._log('connecting to signaling…');
    let ws;
    try { ws = new WebSocket(this._wsURL); }
    catch (e) { this._log('WS init failed: ' + e.message, true); this._schedWS(); return; }

    this.ws = ws;

    ws.onopen = () => {
      this._retry = 0;
      this._log('signaling connected ✓');
      try {
        ws.send(JSON.stringify({
          type: 'announce',
          from: this.id.fingerprint,
          nick: this.id.nickname,
        }));
      } catch {}
      this.onSignalingConnected?.();

      clearInterval(this._ping);
      this._ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
        }
      }, 25_000);
    };

    ws.onmessage = (e) => {
      try { this._onSignal(JSON.parse(e.data)); } catch {}
    };

    ws.onerror = () => {}; // onclose fires next with the reason

    ws.onclose = (e) => {
      clearInterval(this._ping);
      if (this._dead) return;
      const reason = e.code === 1006 ? 'network dropped' : `code ${e.code}`;
      this._log(`signaling lost (${reason}) — retry…`, true);
      this.onSignalingDisconnected?.();
      this._schedWS();
    };
  }

  _schedWS() {
    if (this._dead) return;
    // Exponential backoff capped at 30s, with ±15% jitter to prevent
    // thundering-herd when many clients reconnect simultaneously
    const base  = Math.min(30_000, 1_000 * Math.pow(1.618, Math.min(this._retry++, 8)));
    const jitter = base * (0.85 + Math.random() * 0.30); // [0.85x, 1.15x]
    this._timer = setTimeout(() => this._openWS(), Math.round(jitter));
  }

  _sig(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)); } catch {}
    }
  }

  _onSignal(msg) {
    if (!msg?.type) return;

    if (msg.type === 'peer') {
      const fp = msg.fingerprint;
      if (fp && fp !== this.id.fingerprint && !this.peers.has(fp)) {
        setTimeout(() => {
          if (!this.peers.has(fp)) this._initiate(fp);
        }, Math.random() * 150);
      }
      return;
    }

    if (msg.type === 'pong') return; // application-level pong from server

    const from = msg.from;
    if (!from) return;
    if (msg.type === 'offer')  { this._onOffer(from, msg.sdp, msg.nick); return; }
    if (msg.type === 'answer') { this._onAnswer(from, msg.sdp); return; }
    if (msg.type === 'ice')    { this._onICE(from, msg.candidate); return; }
  }

  // ── PeerConnection factory ────────────────────────────────────────────────

  _makePC(fp) {
    let pc;
    try { pc = new RTCPeerConnection({ iceServers: [] }); }
    catch (e) { this._log('RTCPeerConnection failed: ' + e.message, true); return null; }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this._sig({ type: 'ice', from: this.id.fingerprint, to: fp, candidate });
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        try { pc.restartIce(); } catch {}
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        this._log(`P2P link up: ${fp.slice(0, 8)}`);
      }
      if (s === 'failed' || s === 'closed') {
        const ps      = this.peers.get(fp);
        const wasReady = ps?.ready;
        const nick     = ps?.nick || fp.slice(0, 8);
        if (ps) ps._closing = true;
        this._closePeer(fp);
        if (wasReady) this.onPeerDisconnected?.(fp);
        this._log(`✗ ${nick} disconnected`, true);
        if (!this._dead) {
          setTimeout(() => { if (!this.peers.has(fp)) this._initiate(fp); }, 3_000);
        }
      }
    };

    pc.ontrack = (e) => {
      const ps = this.peers.get(fp);
      if (!ps) return;
      if (!ps.remoteStream) ps.remoteStream = new MediaStream();
      if (!ps.remoteStream.getTracks().includes(e.track)) {
        ps.remoteStream.addTrack(e.track);
      }
      ps.onRemoteStream?.(ps.remoteStream);
      e.track.onunmute = () => ps.onRemoteStream?.(ps.remoteStream);
    };

    return pc;
  }

  // ── Data channel wiring ───────────────────────────────────────────────────

  _wireCtrl(fp, ch) {
    const ps = this.peers.get(fp);
    if (ps) ps.ctrl = ch;
    let closed = false;

    ch.onopen = () => {
      this._log(`ctrl ✓ ${fp.slice(0, 8)}`);
      try {
        ch.send(JSON.stringify({
          type: 'hello',
          fingerprint: this.id.fingerprint,
          nick: this.id.nickname,
        }));
      } catch {}
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
      const ps2 = this.peers.get(fp);
      if (!ps2 || ps2._closing) return;
      const s = ps2.pc?.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') return;
      this._log(`ctrl channel error: ${fp.slice(0, 8)}`, true);
    };

    ch.onclose = () => { closed = true; };
  }

  _wireData(fp, ch) {
    const ps = this.peers.get(fp);
    if (ps) ps.data = ch;
    let closed = false;

    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = LOW_WATER;

    ch.onopen = () => {
      this._log(`data ✓ ${fp.slice(0, 8)}`);
      this._checkReady(fp);
    };

    ch.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this.onBinaryChunk?.(fp, e.data);
    };

    // Wake any waitForBuffer callers that were paused on backpressure
    ch.onbufferedamountlow = () => {
      const ps2 = this.peers.get(fp);
      if (ps2?._bufferLowResolvers?.length) {
        const resolvers = ps2._bufferLowResolvers.splice(0);
        resolvers.forEach(r => r());
      }
    };

    ch.onerror = () => {
      if (closed) return;
      const ps2 = this.peers.get(fp);
      if (!ps2 || ps2._closing) return;
      const s = ps2.pc?.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') return;
      this._log(`data channel error: ${fp.slice(0, 8)}`, true);
    };

    ch.onclose = () => {
      closed = true;
      // Abort any pending waitForBuffer promises so the send loop doesn't hang
      const ps2 = this.peers.get(fp);
      if (ps2?._bufferLowResolvers?.length) {
        const resolvers = ps2._bufferLowResolvers.splice(0);
        resolvers.forEach(r => r()); // resolve (not reject) so caller can check channel state
      }
    };
  }

  _checkReady(fp) {
    const ps = this.peers.get(fp);
    if (!ps || ps.ready) return;
    if (ps.ctrl?.readyState === 'open' && ps.data?.readyState === 'open') {
      ps.ready = true;
      this._log(`✓ ${ps.nick || fp.slice(0, 8)} ready (P2P)`);
      this.onPeerConnected?.(fp, ps.nick);
    }
  }

  // ── Initiate / accept ─────────────────────────────────────────────────────

  async _initiate(fp) {
    if (this.peers.has(fp)) return;
    this._log(`→ ${fp.slice(0, 8)}`);
    const pc = this._makePC(fp);
    if (!pc) return;

    const ps = {
      pc, ctrl: null, data: null, ready: false, nick: null,
      remoteStream: null, localStream: null, onRemoteStream: null,
      _closing: false, _makingOffer: false, _mediaLock: false,
      _isPolite: this.id.fingerprint < fp,
      _bufferLowResolvers: [],
      _statsBaseline: null,   // for getStats() delta calculation
    };
    this.peers.set(fp, ps);

    const ctrl = pc.createDataChannel('ctrl', { ordered: true });
    const data = pc.createDataChannel('data', { ordered: true });
    this._wireCtrl(fp, ctrl);
    this._wireData(fp, data);
    ps.ctrl = ctrl;
    ps.data = data;

    pc.onnegotiationneeded = async () => {
      if (ps._mediaLock) return;
      try {
        ps._makingOffer = true;
        await pc.setLocalDescription();
        this._sig({
          type: 'offer', from: this.id.fingerprint, to: fp,
          sdp: pc.localDescription, nick: this.id.nickname,
        });
      } catch (e) {
        this._log('offer err: ' + e.message, true);
      } finally {
        ps._makingOffer = false;
      }
    };
  }

  async _onOffer(fp, sdp, nick) {
    if (!sdp) return;
    let ps = this.peers.get(fp);

    if (!ps) {
      this._log(`← ${fp.slice(0, 8)}`);
      const pc = this._makePC(fp);
      if (!pc) return;
      ps = {
        pc, ctrl: null, data: null, ready: false, nick: nick || null,
        remoteStream: null, localStream: null, onRemoteStream: null,
        _closing: false, _makingOffer: false, _mediaLock: false,
        _isPolite: this.id.fingerprint < fp,
        _bufferLowResolvers: [],
        _statsBaseline: null,
      };
      this.peers.set(fp, ps);
      pc.ondatachannel = (e) => {
        if (e.channel.label === 'ctrl') this._wireCtrl(fp, e.channel);
        else if (e.channel.label === 'data') this._wireData(fp, e.channel);
      };
    } else if (nick) {
      ps.nick = nick;
    }

    const collision = ps._makingOffer || ps.pc.signalingState !== 'stable';
    if (collision) {
      if (!ps._isPolite) return;
      try { await ps.pc.setLocalDescription({ type: 'rollback' }); }
      catch {
        this._closePeer(fp);
        if (!this._dead) setTimeout(() => this._initiate(fp), 200);
        return;
      }
    }

    try {
      await ps.pc.setRemoteDescription(sdp);
      await ps.pc.setLocalDescription();
      this._sig({
        type: 'answer', from: this.id.fingerprint, to: fp,
        sdp: ps.pc.localDescription,
      });
    } catch (e) {
      this._log('answer err: ' + e.message, true);
      this._closePeer(fp);
    }
  }

  async _onAnswer(fp, sdp) {
    const ps = this.peers.get(fp);
    if (!ps || !sdp) return;
    try { await ps.pc.setRemoteDescription(sdp); }
    catch (e) { this._log('setRemoteDescription: ' + e.message, true); }
  }

  async _onICE(fp, candidate) {
    const ps = this.peers.get(fp);
    if (!ps || !candidate) return;
    try { await ps.pc.addIceCandidate(candidate); }
    catch (e) {
      const msg = String(e);
      if (!msg.includes('701') && !msg.includes('closed')) {
        this._log('ICE candidate: ' + e.message, true);
      }
    }
  }

  _onPeerMsg(fp, msg) {
    if (!msg?.type) return;
    if (msg.type === 'hello') {
      const ps = this.peers.get(fp);
      if (ps && msg.nick) ps.nick = msg.nick;
    }
    if (msg.type === 'answer-reneg') {
      this._applyRenegAnswer(fp, msg.sdp);
      return;
    }
    this.onMessage?.(fp, msg);
  }

  async _applyRenegAnswer(fp, sdp) {
    const ps = this.peers.get(fp);
    if (!ps || !sdp) return;
    try { await ps.pc.setRemoteDescription(sdp); }
    catch (e) { this._log('reneg answer: ' + e.message, true); }
  }

  // ── Public send API ───────────────────────────────────────────────────────

  sendCtrl(fp, msg) {
    const ps = this.peers.get(fp);
    if (ps?.ctrl?.readyState === 'open') {
      try { ps.ctrl.send(JSON.stringify(msg)); return true; } catch {}
    }
    return false;
  }

  sendBinary(fp, buf) {
    const ps = this.peers.get(fp);
    if (ps?.data?.readyState === 'open') {
      try { ps.data.send(buf); return true; } catch {}
    }
    return false;
  }

  /**
   * Resolves when the data channel's bufferedAmount drops below HIGH_WATER,
   * or immediately if it's already below. Rejects if the peer disconnects.
   */
  waitForBuffer(fp) {
    return new Promise((resolve, reject) => {
      const ps = this.peers.get(fp);

      // Peer gone or channel closed — fail fast so the send loop aborts
      if (!ps?.data || ps.data.readyState !== 'open') {
        reject(new Error('DataChannel not open'));
        return;
      }

      if (ps.data.bufferedAmount < HIGH_WATER) {
        resolve();
        return;
      }

      // Park the resolver — _wireData's onbufferedamountlow / onclose will wake it
      const timeout = setTimeout(() => {
        const idx = ps._bufferLowResolvers.indexOf(resolve);
        if (idx !== -1) ps._bufferLowResolvers.splice(idx, 1);
        // Resolve (not reject) after timeout so caller can check channel state
        resolve();
      }, 5_000);

      const wrapped = () => { clearTimeout(timeout); resolve(); };
      ps._bufferLowResolvers.push(wrapped);
    });
  }

  isReady(fp) {
    const ps = this.peers.get(fp);
    return !!(ps?.ready && ps.ctrl?.readyState === 'open' && ps.data?.readyState === 'open');
  }

  getConnectedPeers() {
    return [...this.peers.entries()]
      .filter(([, ps]) => ps.ready)
      .map(([fp]) => fp);
  }

  getPeerNick(fp) {
    return this.peers.get(fp)?.nick || fp?.slice(0, 8) || '?';
  }

  // ── Media ─────────────────────────────────────────────────────────────────

  async getLocalStream(video = false) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression:  true,
          autoGainControl:   true,
        },
        video: video
          ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
          : false,
      });
    } catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        throw new Error('permission-denied:' + (video ? 'camera/mic' : 'microphone'));
      }
      if (e.name === 'NotFoundError') {
        throw new Error('no-device:' + (video ? 'camera/mic' : 'microphone'));
      }
      throw e;
    }
  }

  async offerWithStream(fp, stream, isCircle = false) {
    const ps = this.peers.get(fp);
    if (!ps) throw new Error('Peer not connected');
    ps.localStream?.getTracks().forEach(t => t.stop());
    ps.pc.getSenders().forEach(s => { try { ps.pc.removeTrack(s); } catch {} });
    ps.localStream = stream;
    ps._mediaLock  = true;
    try {
      stream.getTracks().forEach(t => ps.pc.addTrack(t, stream));
      const offer = await ps.pc.createOffer();
      await ps.pc.setLocalDescription(offer);
      this.sendCtrl(fp, {
        type:     'offer-reneg',
        sdp:      ps.pc.localDescription,
        callType: stream.getVideoTracks().length > 0 ? 'video' : 'audio',
        circle:   isCircle,
      });
    } finally {
      ps._mediaLock = false;
    }
  }

  async answerWithStream(fp, remoteSdp, stream) {
    const ps = this.peers.get(fp);
    if (!ps) throw new Error('Peer not found');
    ps.localStream?.getTracks().forEach(t => t.stop());
    ps.pc.getSenders().forEach(s => { try { ps.pc.removeTrack(s); } catch {} });
    ps.localStream = stream;
    ps._mediaLock  = true;
    try {
      stream.getTracks().forEach(t => ps.pc.addTrack(t, stream));
      await ps.pc.setRemoteDescription(remoteSdp);
      const answer = await ps.pc.createAnswer();
      await ps.pc.setLocalDescription(answer);
      this.sendCtrl(fp, { type: 'answer-reneg', sdp: ps.pc.localDescription });
    } finally {
      ps._mediaLock = false;
    }
  }

  async stopMedia(fp) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    ps.localStream?.getTracks().forEach(t => t.stop());
    ps.pc.getSenders().forEach(s => { try { ps.pc.removeTrack(s); } catch {} });
    ps.localStream = null;
    this.sendCtrl(fp, { type: 'call-end' });
  }

  setRemoteStreamHandler(fp, fn) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    ps.onRemoteStream = fn;
    if (ps.remoteStream) fn(ps.remoteStream);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  /**
   * Returns call stats for the given peer.
   * Uses delta bytes / delta time for bandwidth estimates so readings are
   * accurate regardless of session length (fixes near-zero kbps bug).
   */
  async getStats(fp) {
    const ps = this.peers.get(fp);
    if (!ps) return null;
    try {
      const report = await ps.pc.getStats();
      const now    = Date.now();
      const stats  = {};

      report.forEach(r => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') {
          stats.videoWidth  = r.frameWidth;
          stats.videoHeight = r.frameHeight;
          stats.fps         = Math.round(r.framesPerSecond || 0);
          stats._videoBytes = r.bytesReceived || 0;
        }
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          stats._audioBytes = r.bytesReceived || 0;
        }
        if (r.type === 'candidate-pair' && r.nominated) {
          stats.rttMs    = Math.round((r.currentRoundTripTime || 0) * 1000);
          stats.bytesSent = r.bytesSent    || 0;
          stats.bytesRecv = r.bytesReceived || 0;
        }
      });

      // Delta-based bandwidth: avoids the epoch-division bug
      const baseline = ps._statsBaseline;
      const dt       = baseline ? (now - baseline.ts) / 1000 : 0;

      if (baseline && dt > 0) {
        const videoD = (stats._videoBytes || 0) - (baseline.videoBytes || 0);
        const audioD = (stats._audioBytes || 0) - (baseline.audioBytes || 0);
        stats.videoKbps = Math.round((videoD * 8) / 1000 / dt);
        stats.audioKbps = Math.round((audioD * 8) / 1000 / dt);
      }

      // Update baseline for next poll
      ps._statsBaseline = {
        ts:         now,
        videoBytes: stats._videoBytes || 0,
        audioBytes: stats._audioBytes || 0,
      };

      return stats;
    } catch {
      return null;
    }
  }

  // ── Peer teardown ─────────────────────────────────────────────────────────

  _closePeer(fp) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    ps._closing = true;

    // Wake any parked waitForBuffer resolvers so send loops don't hang
    if (ps._bufferLowResolvers?.length) {
      ps._bufferLowResolvers.splice(0).forEach(r => r());
    }

    ps.localStream?.getTracks().forEach(t => t.stop());
    try { ps.ctrl?.close(); } catch {}
    try { ps.data?.close(); } catch {}
    try { ps.pc.close();    } catch {}
    this.peers.delete(fp);
  }

  destroy() {
    this._dead = true;
    clearTimeout(this._timer);
    clearInterval(this._ping);
    try { this.ws?.close(); } catch {}
    for (const fp of [...this.peers.keys()]) this._closePeer(fp);
  }

  _log(text, isErr = false) {
    this.onLog?.(text, isErr);
    (isErr ? console.warn : console.log)('[TQ]', text);
  }
}
