/**
 * webrtc.js — Turquoise
 *
 * Render = signaling ONLY (offer/answer/ICE, ~few KB total per connection)
 * After handshake: ALL data is P2P over local WiFi. Render never sees it.
 *
 * Two DataChannels per peer:
 *   'ctrl' — JSON messages (chat, file-meta, call signals, nick updates)
 *   'data' — raw binary ArrayBuffer (file chunks)
 *
 * Voice/video: renegotiation via ctrl channel (not signaling server)
 * Auto-reconnect: WebSocket reconnects with backoff if Render sleeps
 */

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export class TurquoiseNetwork {
  constructor(identity) {
    if (!identity?.fingerprint) throw new Error('identity.fingerprint required');
    this.id       = identity;
    this.peers    = new Map();      // fp → PeerState
    this.ws       = null;
    this._wsURL   = null;
    this._retry   = 0;
    this._timer   = null;
    this._dead    = false;

    // Callbacks — set by app.js
    this.onPeerConnected    = null;
    this.onPeerDisconnected = null;
    this.onMessage          = null;
    this.onBinaryChunk      = null;
    this.onLog              = null;
  }

  // ── Signaling connection ───────────────────────────────────────────────────
  connect(url) {
    this._wsURL = url;
    this._dead  = false;
    this._retry = 0;
    this._openWS();
  }

  _openWS() {
    if (this._dead) return;
    this._log('Connecting to signaling…');
    let ws;
    try { ws = new WebSocket(this._wsURL); }
    catch (e) { this._log('WebSocket failed: ' + e.message, true); this._schedWS(); return; }

    this.ws = ws;
    ws.onopen  = () => {
      this._retry = 0;
      this._log('Signaling connected ✓');
      ws.send(JSON.stringify({ type: 'announce', from: this.id.fingerprint, nick: this.id.nickname }));
    };
    ws.onmessage = (e) => { try { this._onSignal(JSON.parse(e.data)); } catch {} };
    ws.onerror   = () => {};
    ws.onclose   = (e) => {
      if (this._dead) return;
      this._log(`Signaling dropped (${e.code}) — retry…`, true);
      this._schedWS();
    };
  }

  _schedWS() {
    const ms = Math.min(30000, 1000 * Math.pow(1.618, Math.min(this._retry++, 8)));
    this._timer = setTimeout(() => this._openWS(), ms);
  }

  _sig(obj) {
    if (this.ws?.readyState === 1) try { this.ws.send(JSON.stringify(obj)); } catch {}
  }

  // ── Signaling messages ─────────────────────────────────────────────────────
  _onSignal(msg) {
    if (!msg?.type) return;
    if (msg.type === 'peer') {
      const fp = msg.fingerprint;
      if (fp && fp !== this.id.fingerprint && !this.peers.has(fp)) this._initiate(fp);
      return;
    }
    const from = msg.from;
    if (!from) return;
    if (msg.type === 'offer')  { this._onOffer(from, msg.sdp, msg.nick); return; }
    if (msg.type === 'answer') { this._onAnswer(from, msg.sdp); return; }
    if (msg.type === 'ice')    { this._onICE(from, msg.candidate); return; }
  }

  // ── PeerConnection factory ─────────────────────────────────────────────────
  _makePC(fp) {
    let pc;
    try { pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: 4 }); }
    catch (e) { this._log('PC failed: ' + e.message, true); return null; }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this._sig({ type: 'ice', from: this.id.fingerprint, to: fp, candidate });
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        this._log(`ICE failed → restart: ${fp.slice(0,8)}`);
        try { pc.restartIce(); } catch {}
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        this._log(`P2P link up: ${fp.slice(0,8)}`);
      }
      if (s === 'failed' || s === 'closed') {
        const ps = this.peers.get(fp);
        const nick = ps?.nick || fp.slice(0,8);
        this._closePeer(fp);
        this.onPeerDisconnected?.(fp);
        this._log(`✗ ${nick} disconnected`, true);
        if (!this._dead) setTimeout(() => { if (!this.peers.has(fp)) this._initiate(fp); }, 4000);
      }
    };
    pc.ontrack = (e) => {
      const ps = this.peers.get(fp);
      if (!ps) return;
      // Build or update remote MediaStream
      if (!ps.remoteStream) ps.remoteStream = new MediaStream();
      e.track.onunmute = () => {
        if (!ps.remoteStream.getTracks().includes(e.track)) ps.remoteStream.addTrack(e.track);
        ps.onRemoteStream?.(ps.remoteStream);
      };
      if (!ps.remoteStream.getTracks().includes(e.track)) ps.remoteStream.addTrack(e.track);
      ps.onRemoteStream?.(ps.remoteStream);
    };
    return pc;
  }

  // ── DataChannel wiring ─────────────────────────────────────────────────────
  _wireCtrl(fp, ch) {
    const ps = this.peers.get(fp);
    if (ps) ps.ctrl = ch;
    ch.onopen = () => {
      this._log(`ctrl open: ${fp.slice(0,8)}`);
      try { ch.send(JSON.stringify({ type: 'hello', fingerprint: this.id.fingerprint, nick: this.id.nickname })); } catch {}
      this._checkReady(fp);
    };
    ch.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      this._onPeerMsg(fp, msg);
    };
    ch.onerror = (e) => this._log(`ctrl err ${fp.slice(0,8)}: ${e.message||'?'}`, true);
    ch.onclose = () => this._log(`ctrl closed: ${fp.slice(0,8)}`);
  }

  _wireData(fp, ch) {
    const ps = this.peers.get(fp);
    if (ps) ps.data = ch;
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = 4 * 1024 * 1024; // 4 MB
    ch.onopen  = () => { this._log(`data open: ${fp.slice(0,8)}`); this._checkReady(fp); };
    ch.onmessage = (e) => { if (e.data instanceof ArrayBuffer) this.onBinaryChunk?.(fp, e.data); };
    ch.onerror = (e) => this._log(`data err ${fp.slice(0,8)}: ${e.message||'?'}`, true);
  }

  _checkReady(fp) {
    const ps = this.peers.get(fp);
    if (!ps || ps.ready) return;
    if (ps.ctrl?.readyState === 'open' && ps.data?.readyState === 'open') {
      ps.ready = true;
      this._log(`✓ ${ps.nick || fp.slice(0,8)} ready (P2P)`);
      this.onPeerConnected?.(fp, ps.nick);
    }
  }

  // ── Initiate (we send offer) ───────────────────────────────────────────────
  async _initiate(fp) {
    if (this.peers.has(fp)) return;
    this._log(`→ ${fp.slice(0,8)}`);
    const pc = this._makePC(fp);
    if (!pc) return;

    const ps = { pc, ctrl: null, data: null, ready: false, nick: null, remoteStream: null, localStream: null, onRemoteStream: null };
    this.peers.set(fp, ps);

    // Create both channels
    const ctrl = pc.createDataChannel('ctrl', { ordered: true });
    const data = pc.createDataChannel('data', { ordered: true });
    this._wireCtrl(fp, ctrl);
    this._wireData(fp, data);
    ps.ctrl = ctrl;
    ps.data = data;

    let busy = false;
    pc.onnegotiationneeded = async () => {
      if (busy) return; busy = true;
      try {
        await pc.setLocalDescription();
        this._sig({ type: 'offer', from: this.id.fingerprint, to: fp, sdp: pc.localDescription, nick: this.id.nickname });
      } catch (e) { this._log('offer err: ' + e.message, true); }
      finally { busy = false; }
    };
  }

  // ── Respond (we receive offer) ─────────────────────────────────────────────
  async _onOffer(fp, sdp, nick) {
    if (!sdp) return;
    let ps = this.peers.get(fp);

    if (!ps) {
      this._log(`← ${fp.slice(0,8)}`);
      const pc = this._makePC(fp);
      if (!pc) return;
      ps = { pc, ctrl: null, data: null, ready: false, nick: nick || null, remoteStream: null, localStream: null, onRemoteStream: null };
      this.peers.set(fp, ps);

      pc.ondatachannel = (e) => {
        if (e.channel.label === 'ctrl') this._wireCtrl(fp, e.channel);
        else if (e.channel.label === 'data') this._wireData(fp, e.channel);
      };
    } else {
      // Renegotiation
      if (nick) ps.nick = nick;
    }

    try {
      await ps.pc.setRemoteDescription(sdp);
      await ps.pc.setLocalDescription();
      this._sig({ type: 'answer', from: this.id.fingerprint, to: fp, sdp: ps.pc.localDescription });
    } catch (e) {
      this._log('answer err: ' + e.message, true);
      this._closePeer(fp);
    }
  }

  async _onAnswer(fp, sdp) {
    const ps = this.peers.get(fp);
    if (!ps || !sdp) return;
    try { await ps.pc.setRemoteDescription(sdp); }
    catch (e) { this._log('setRemote err: ' + e.message, true); }
  }

  async _onICE(fp, candidate) {
    const ps = this.peers.get(fp);
    if (!ps || !candidate) return;
    try { await ps.pc.addIceCandidate(candidate); }
    catch (e) { if (!String(e).includes('701') && !String(e).includes('closed')) this._log('ICE err: ' + e.message, true); }
  }

  // ── Peer messages (arrive over ctrl DataChannel — P2P) ─────────────────────
  _onPeerMsg(fp, msg) {
    if (!msg?.type) return;
    if (msg.type === 'hello') {
      const ps = this.peers.get(fp);
      if (ps && msg.nick) ps.nick = msg.nick;
    }
    if (msg.type === 'offer-reneg') { this._onRenegOffer(fp, msg.sdp); return; }
    if (msg.type === 'answer-reneg') { this._onRenegAnswer(fp, msg.sdp); return; }
    this.onMessage?.(fp, msg);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  sendCtrl(fp, msg) {
    const ps = this.peers.get(fp);
    if (ps?.ctrl?.readyState === 'open') { try { ps.ctrl.send(JSON.stringify(msg)); return true; } catch {} }
    return false;
  }

  sendBinary(fp, buf) {
    const ps = this.peers.get(fp);
    if (ps?.data?.readyState === 'open') { try { ps.data.send(buf); return true; } catch {} }
    return false;
  }

  waitForBuffer(fp) {
    return new Promise(res => {
      const ps = this.peers.get(fp);
      if (!ps?.data || ps.data.bufferedAmount < ps.data.bufferedAmountLowThreshold) { res(); return; }
      const prev = ps.data.onbufferedamountlow;
      ps.data.onbufferedamountlow = () => { ps.data.onbufferedamountlow = prev; res(); };
    });
  }

  isReady(fp) {
    const ps = this.peers.get(fp);
    return !!(ps?.ready && ps.ctrl?.readyState === 'open' && ps.data?.readyState === 'open');
  }

  getConnectedPeers() {
    return [...this.peers.entries()].filter(([, ps]) => ps.ready).map(([fp]) => fp);
  }

  getPeerNick(fp) { return this.peers.get(fp)?.nick || fp?.slice(0,8) || '?'; }

  // ── Voice / Video ──────────────────────────────────────────────────────────
  async startMedia(fp, video = false) {
    const ps = this.peers.get(fp);
    if (!ps) throw new Error('Peer not connected');

    // Stop any previous local stream
    ps.localStream?.getTracks().forEach(t => t.stop());

    const constraints = {
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
      video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    ps.localStream = stream;

    // Remove old senders, add new tracks
    ps.pc.getSenders().forEach(s => ps.pc.removeTrack(s));
    stream.getTracks().forEach(t => ps.pc.addTrack(t, stream));

    // Renegotiate via ctrl DataChannel (P2P, not signaling server)
    await ps.pc.setLocalDescription();
    this.sendCtrl(fp, { type: 'offer-reneg', sdp: ps.pc.localDescription });

    return stream;
  }

  async stopMedia(fp) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    ps.localStream?.getTracks().forEach(t => { t.stop(); });
    ps.pc.getSenders().forEach(s => { try { ps.pc.removeTrack(s); } catch {} });
    ps.localStream = null;
    this.sendCtrl(fp, { type: 'call-end' });
  }

  async _onRenegOffer(fp, sdp) {
    const ps = this.peers.get(fp);
    if (!ps || !sdp) return;
    try {
      await ps.pc.setRemoteDescription(sdp);
      await ps.pc.setLocalDescription();
      this.sendCtrl(fp, { type: 'answer-reneg', sdp: ps.pc.localDescription });
    } catch (e) { this._log('reneg answer err: ' + e.message, true); }
  }

  async _onRenegAnswer(fp, sdp) {
    const ps = this.peers.get(fp);
    if (!ps || !sdp) return;
    try { await ps.pc.setRemoteDescription(sdp); }
    catch (e) { this._log('reneg setRemote err: ' + e.message, true); }
  }

  setRemoteStreamHandler(fp, fn) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    ps.onRemoteStream = fn;
    if (ps.remoteStream) fn(ps.remoteStream); // fire immediately if already have stream
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  _closePeer(fp) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    ps.localStream?.getTracks().forEach(t => t.stop());
    try { ps.ctrl?.close(); } catch {}
    try { ps.data?.close(); } catch {}
    try { ps.pc.close(); } catch {}
    this.peers.delete(fp);
  }

  destroy() {
    this._dead = true;
    clearTimeout(this._timer);
    try { this.ws?.close(); } catch {}
    for (const fp of [...this.peers.keys()]) this._closePeer(fp);
  }

  _log(text, isErr = false) {
    this.onLog?.(text, isErr);
    (isErr ? console.warn : console.log)('[TQ]', text);
  }
}
