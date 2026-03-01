/**
 * webrtc.js — Turquoise
 * Dual DataChannel: 'ctrl' (JSON) + 'data' (binary file chunks)
 * Auto-reconnect WebSocket with exponential backoff
 * Voice/video via renegotiation on existing PeerConnection
 * Murphy's Law: every failure path handled
 */

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

const CTRL  = 'ctrl';
const DATA  = 'data';

export class TurquoiseNetwork {
  constructor(identity) {
    if (!identity?.fingerprint) throw new Error('Network: identity.fingerprint required');

    this.identity = identity;
    this.peers    = new Map(); // fp → PeerState
    this.ws       = null;
    this.wsURL    = null;

    // Reconnect state
    this._wsRetry    = 0;
    this._wsTimer    = null;
    this._wsDestroyed = false;

    // Callbacks (set by app.js)
    this.onPeerConnected    = null; // (fp, nick)
    this.onPeerDisconnected = null; // (fp)
    this.onMessage          = null; // (fp, msg)
    this.onBinaryChunk      = null; // (fp, ArrayBuffer)
    this.onLog              = null; // (text, isErr)
  }

  // ── Connect / reconnect ──────────────────────────────────────────────────────
  connect(url) {
    if (!url) { this._log('❌ No signaling URL', true); return; }
    this._wsURL      = url;
    this._wsDestroyed = false;
    this._wsRetry    = 0;
    this._openWS();
  }

  destroy() {
    this._wsDestroyed = true;
    clearTimeout(this._wsTimer);
    try { this.ws?.close(); } catch {}
    for (const [fp] of this.peers) this._closePeer(fp);
  }

  _openWS() {
    if (this._wsDestroyed) return;
    this._log('Connecting to signaling…');

    let ws;
    try {
      ws = new WebSocket(this._wsURL);
    } catch (e) {
      this._log('❌ WebSocket constructor failed: ' + e.message, true);
      this._scheduleReconnect(); return;
    }

    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this._wsRetry = 0;
      this._log('Signaling connected ✓', false, true);
      this._announce();
    };

    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        this._handleSignal(msg);
      }
    };

    ws.onerror = () => {};  // onclose fires next

    ws.onclose = (e) => {
      if (this._wsDestroyed) return;
      this._log(`Signaling closed (${e.code}) — reconnecting…`, true);
      this._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    if (this._wsDestroyed) return;
    const delay = Math.min(30000, 1000 * Math.pow(1.618, Math.min(this._wsRetry, 8)));
    this._wsRetry++;
    this._wsTimer = setTimeout(() => this._openWS(), delay);
  }

  _announce() {
    this._wsSend({
      type: 'announce',
      from: this.identity.fingerprint,
      nick: this.identity.nickname,
    });
  }

  _wsSend(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)); } catch {}
    }
  }

  // ── Signaling ─────────────────────────────────────────────────────────────────
  _handleSignal(msg) {
    if (!msg?.type) return;

    if (msg.type === 'peer') {
      // New peer discovered → initiate connection
      const fp = msg.fingerprint;
      if (fp && fp !== this.identity.fingerprint && !this.peers.has(fp)) {
        this._initiatePeer(fp);
      }
      return;
    }

    const from = msg.from;
    if (!from) return;

    switch (msg.type) {
      case 'offer':  this._handleOffer(from, msg.sdp, msg.nick); break;
      case 'answer': this._handleAnswer(from, msg.sdp); break;
      case 'ice':    this._handleICE(from, msg.candidate); break;
    }
  }

  // ── PeerConnection lifecycle ──────────────────────────────────────────────────
  _newPC(fp) {
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: ICE });
    } catch (e) {
      this._log(`❌ RTCPeerConnection failed for ${fp.slice(0,8)}: ${e.message}`, true);
      return null;
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this._wsSend({ type: 'ice', from: this.identity.fingerprint, to: fp, candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === 'failed' || state === 'disconnected') {
        this._log(`↻ ${fp.slice(0,8)} ICE ${state} — restarting`);
        pc.restartIce?.();
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'failed' || state === 'closed') {
        this._log(`✗ ${fp.slice(0,8)} disconnected`);
        this._closePeer(fp);
        this.onPeerDisconnected?.(fp);
        // Re-attempt after delay
        setTimeout(() => {
          if (!this.peers.has(fp) && !this._wsDestroyed) {
            this._log(`↻ ${fp.slice(0,8)} retry`);
            this._initiatePeer(fp);
          }
        }, 3000);
      }
    };

    // Incoming media tracks (for voice/video)
    pc.ontrack = (e) => {
      const ps = this.peers.get(fp);
      if (ps) {
        ps.remoteStream = e.streams[0] || ps.remoteStream;
        ps.onRemoteStream?.(ps.remoteStream);
      }
    };

    return pc;
  }

  _newDataChannels(fp, pc, isInitiator) {
    if (isInitiator) {
      const ctrl = pc.createDataChannel(CTRL, { ordered: true });
      const data = pc.createDataChannel(DATA, { ordered: true });
      this._wireCtrl(fp, ctrl);
      this._wireData(fp, data);
      return { ctrl, data };
    } else {
      // Channels come via ondatachannel
      return { ctrl: null, data: null };
    }
  }

  _wireCtrl(fp, ch) {
    ch.binaryType = 'arraybuffer';
    ch.onopen = () => {
      this._log(`⟷ ${fp.slice(0,8)} ctrl open`);
      // Send hello
      ch.send(JSON.stringify({
        type: 'hello',
        fingerprint: this.identity.fingerprint,
        nick: this.identity.nickname,
      }));
      const ps = this.peers.get(fp);
      if (ps && ps.data?.readyState === 'open') {
        this._onBothOpen(fp);
      }
    };
    ch.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this._handlePeerMessage(fp, msg);
    };
    ch.onerror = () => this._log(`⚠ ${fp.slice(0,8)} ctrl error`, true);
    ch.onclose = () => this._log(`✗ ${fp.slice(0,8)} ctrl closed`);
    const ps = this.peers.get(fp);
    if (ps) ps.ctrl = ch;
  }

  _wireData(fp, ch) {
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = 1 * 1024 * 1024; // 1MB low water
    ch.onopen = () => {
      this._log(`⟷ ${fp.slice(0,8)} data open`);
      const ps = this.peers.get(fp);
      if (ps && ps.ctrl?.readyState === 'open') {
        this._onBothOpen(fp);
      }
    };
    ch.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        this.onBinaryChunk?.(fp, e.data);
      }
    };
    ch.onerror = () => this._log(`⚠ ${fp.slice(0,8)} data error`, true);
    const ps = this.peers.get(fp);
    if (ps) ps.data = ch;
  }

  _onBothOpen(fp) {
    const ps = this.peers.get(fp);
    if (!ps || ps.ready) return;
    ps.ready = true;
    this._log(`✓ ${fp.slice(0,8)} connected`);
    this.onPeerConnected?.(fp, ps.nick || fp.slice(0,8));
  }

  // ── Initiator path ────────────────────────────────────────────────────────────
  async _initiatePeer(fp) {
    if (this.peers.has(fp)) return;
    this._log(`→ ${fp.slice(0,8)} connecting`);

    const pc = this._newPC(fp);
    if (!pc) return;

    const ps = { pc, ctrl: null, data: null, ready: false, nick: null, remoteStream: null };
    this.peers.set(fp, ps);

    // Create channels before offer
    const { ctrl, data } = this._newDataChannels(fp, pc, true);
    ps.ctrl = ctrl;
    ps.data = data;

    let negotiating = false;
    pc.onnegotiationneeded = async () => {
      if (negotiating) return;
      negotiating = true;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this._wsSend({
          type: 'offer',
          from: this.identity.fingerprint,
          to:   fp,
          sdp:  pc.localDescription,
          nick: this.identity.nickname,
        });
      } catch (e) {
        this._log(`❌ offer failed: ${e.message}`, true);
      } finally {
        negotiating = false;
      }
    };
  }

  // ── Responder path ────────────────────────────────────────────────────────────
  async _handleOffer(fp, sdp, nick) {
    if (!sdp) return;

    // If already exists (renegotiation)
    let ps = this.peers.get(fp);
    if (!ps) {
      this._log(`← ${fp.slice(0,8)} offer`);
      const pc = this._newPC(fp);
      if (!pc) return;
      ps = { pc, ctrl: null, data: null, ready: false, nick: nick || null, remoteStream: null };
      this.peers.set(fp, ps);

      // Wire incoming data channels
      pc.ondatachannel = (e) => {
        const { channel: ch } = e;
        if (ch.label === CTRL) this._wireCtrl(fp, ch);
        else if (ch.label === DATA) this._wireData(fp, ch);
      };
    }

    const { pc } = ps;
    if (nick) ps.nick = nick;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this._wsSend({
        type: 'answer',
        from: this.identity.fingerprint,
        to:   fp,
        sdp:  pc.localDescription,
      });
    } catch (e) {
      this._log(`❌ answer failed: ${e.message}`, true);
      this._closePeer(fp);
    }
  }

  async _handleAnswer(fp, sdp) {
    if (!sdp) return;
    const ps = this.peers.get(fp);
    if (!ps) return;
    try {
      await ps.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (e) {
      this._log(`❌ setRemoteDescription failed: ${e.message}`, true);
    }
  }

  async _handleICE(fp, candidate) {
    if (!candidate) return;
    const ps = this.peers.get(fp);
    if (!ps) return;
    try {
      await ps.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      if (!e.message?.includes('701')) { // ICE 701 is benign (already closed)
        this._log(`⚠ ICE candidate: ${e.message}`, true);
      }
    }
  }

  // ── Peer message routing ──────────────────────────────────────────────────────
  _handlePeerMessage(fp, msg) {
    if (!msg?.type) return;

    if (msg.type === 'hello') {
      const ps = this.peers.get(fp);
      if (ps) ps.nick = msg.nick || msg.fingerprint?.slice(0,8) || fp.slice(0,8);
    }

    // Renegotiation (voice/video)
    if (msg.type === 'offer-renegotiate') {
      this._handleRenegotiateOffer(fp, msg.sdp); return;
    }
    if (msg.type === 'answer-renegotiate') {
      this._handleRenegotiateAnswer(fp, msg.sdp); return;
    }

    this.onMessage?.(fp, msg);
  }

  // ── Public: send control message to peer ──────────────────────────────────────
  sendCtrl(fp, msg) {
    const ps = this.peers.get(fp);
    if (!ps?.ctrl || ps.ctrl.readyState !== 'open') return false;
    try {
      ps.ctrl.send(JSON.stringify(msg));
      return true;
    } catch { return false; }
  }

  // ── Public: send binary chunk to peer ────────────────────────────────────────
  sendBinary(fp, buffer) {
    const ps = this.peers.get(fp);
    if (!ps?.data || ps.data.readyState !== 'open') return false;
    try {
      ps.data.send(buffer);
      return true;
    } catch { return false; }
  }

  // ── Public: wait for data channel buffer to drain ────────────────────────────
  waitForBuffer(fp) {
    return new Promise((resolve) => {
      const ps = this.peers.get(fp);
      if (!ps?.data) { resolve(); return; }
      if (ps.data.bufferedAmount <= ps.data.bufferedAmountLowThreshold) { resolve(); return; }
      const prev = ps.data.onbufferedamountlow;
      ps.data.onbufferedamountlow = () => {
        ps.data.onbufferedamountlow = prev;
        resolve();
      };
    });
  }

  // ── Public: check if peer's data channel is open ─────────────────────────────
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
    return this.peers.get(fp)?.nick || fp?.slice(0,8) || '?';
  }

  // ── Voice/Video ───────────────────────────────────────────────────────────────
  async startMedia(fp, video = true) {
    const ps = this.peers.get(fp);
    if (!ps) throw new Error('Peer not connected');

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : false,
    });
    ps.localStream = stream;

    stream.getTracks().forEach(track => ps.pc.addTrack(track, stream));

    // Renegotiate — send via ctrl channel (not signaling server)
    const offer = await ps.pc.createOffer();
    await ps.pc.setLocalDescription(offer);
    this.sendCtrl(fp, { type: 'offer-renegotiate', sdp: ps.pc.localDescription });

    return stream;
  }

  async stopMedia(fp) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    ps.localStream?.getTracks().forEach(t => { t.stop(); ps.pc.removeTrack(ps.pc.getSenders().find(s => s.track === t)); });
    ps.localStream = null;
    // Signal end
    this.sendCtrl(fp, { type: 'call-end' });
  }

  async _handleRenegotiateOffer(fp, sdp) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    try {
      await ps.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await ps.pc.createAnswer();
      await ps.pc.setLocalDescription(answer);
      this.sendCtrl(fp, { type: 'answer-renegotiate', sdp: ps.pc.localDescription });
    } catch (e) {
      this._log(`❌ renegotiate answer: ${e.message}`, true);
    }
  }

  async _handleRenegotiateAnswer(fp, sdp) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    try {
      await ps.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (e) {
      this._log(`❌ renegotiate setRemote: ${e.message}`, true);
    }
  }

  setRemoteStreamHandler(fp, fn) {
    const ps = this.peers.get(fp);
    if (ps) ps.onRemoteStream = fn;
  }

  // ── Close peer ────────────────────────────────────────────────────────────────
  _closePeer(fp) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    try { ps.ctrl?.close(); } catch {}
    try { ps.data?.close(); } catch {}
    try { ps.pc.close(); } catch {}
    ps.localStream?.getTracks().forEach(t => t.stop());
    this.peers.delete(fp);
  }

  // ── Log ───────────────────────────────────────────────────────────────────────
  _log(text, isErr = false) {
    this.onLog?.(text, isErr);
    if (isErr) console.warn('[TQ]', text);
    else       console.log('[TQ]', text);
  }
}
