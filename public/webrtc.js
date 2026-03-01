/**
 * webrtc.js — Turquoise
 *
 * Render = signaling relay only (offer/answer/ICE, ~few KB total).
 * After handshake: ALL data flows P2P over local WiFi via DataChannels.
 * Nothing — messages, files, audio, video — ever touches Render after connect.
 *
 * Channels per peer:
 *   'ctrl' — JSON (chat, file-meta, nick updates, call signals)
 *   'data' — raw binary ArrayBuffer (file chunks only)
 *
 * Voice/video renegotiation goes via ctrl DataChannel (P2P, never Render).
 * WebSocket auto-reconnects with φ-backoff when Render free tier sleeps.
 *
 * Permission errors (mic/camera denied) are caught here and sent to both sides.
 */

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

export class TurquoiseNetwork {
  constructor(identity) {
    if (!identity?.fingerprint) throw new Error('identity.fingerprint required');
    this.id     = identity;
    this.peers  = new Map();   // fp → PeerState
    this.ws     = null;
    this._wsURL = null;
    this._retry = 0;
    this._timer = null;
    this._dead  = false;

    // Callbacks — set by app.js
    this.onPeerConnected    = null; // (fp, nick)
    this.onPeerDisconnected = null; // (fp)
    this.onMessage          = null; // (fp, msg) — ALL ctrl messages
    this.onBinaryChunk      = null; // (fp, ArrayBuffer)
    this.onLog              = null; // (text, isErr)
  }

  // ── Signaling (Render WebSocket) ───────────────────────────────────────────
  connect(url) {
    this._wsURL = url; this._dead = false; this._retry = 0;
    this._openWS();
  }

  _openWS() {
    if (this._dead) return;
    this._log('connecting to signaling…');
    let ws;
    try { ws = new WebSocket(this._wsURL); }
    catch (e) { this._log('WS create failed: ' + e.message, true); this._schedWS(); return; }

    this.ws = ws;
    ws.onopen = () => {
      this._retry = 0;
      this._log('signaling connected ✓');
      ws.send(JSON.stringify({ type: 'announce', from: this.id.fingerprint, nick: this.id.nickname }));
      this.onSignalingConnected?.();
    };
    ws.onmessage = (e) => { try { this._onSignal(JSON.parse(e.data)); } catch {} };
    ws.onerror   = () => {};
    ws.onclose   = (e) => {
      if (this._dead) return;
      const reason = e.code === 1006 ? 'network dropped' : `code ${e.code}`;
      this._log(`signaling lost (${reason}) — retry…`, true);
      this.onSignalingDisconnected?.();
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

  _onSignal(msg) {
    if (!msg?.type) return;
    if (msg.type === 'peer') {
      const fp = msg.fingerprint;
      if (fp && fp !== this.id.fingerprint && !this.peers.has(fp)) this._initiate(fp);
      return;
    }
    const from = msg.from; if (!from) return;
    if (msg.type === 'offer')  { this._onOffer(from, msg.sdp, msg.nick); return; }
    if (msg.type === 'answer') { this._onAnswer(from, msg.sdp); return; }
    if (msg.type === 'ice')    { this._onICE(from, msg.candidate); return; }
  }

  // ── PeerConnection factory ─────────────────────────────────────────────────
  _makePC(fp) {
    let pc;
    try { pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }); }
    catch (e) { this._log('PC failed: ' + e.message, true); return null; }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this._sig({ type: 'ice', from: this.id.fingerprint, to: fp, candidate });
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') { try { pc.restartIce(); } catch {} }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') this._log(`P2P link up: ${fp.slice(0, 8)}`);
      if (s === 'failed' || s === 'closed') {
        const ps      = this.peers.get(fp);
        const wasReady = ps?.ready;
        const nick    = ps?.nick || fp.slice(0, 8);
        // Mark as closing before cleanup to suppress spurious channel errors
        if (ps) ps._closing = true;
        this._closePeer(fp);
        if (wasReady) this.onPeerDisconnected?.(fp);
        this._log(`✗ ${nick} disconnected`, true);
        if (!this._dead) setTimeout(() => { if (!this.peers.has(fp)) this._initiate(fp); }, 3000);
      }
    };

    // Remote audio/video tracks
    pc.ontrack = (e) => {
      const ps = this.peers.get(fp); if (!ps) return;
      if (!ps.remoteStream) ps.remoteStream = new MediaStream();
      const track = e.track;
      if (!ps.remoteStream.getTracks().includes(track)) ps.remoteStream.addTrack(track);
      ps.onRemoteStream?.(ps.remoteStream);
      track.onunmute = () => ps.onRemoteStream?.(ps.remoteStream);
    };

    return pc;
  }

  // ── DataChannel wiring ─────────────────────────────────────────────────────
  _wireCtrl(fp, ch) {
    const ps = this.peers.get(fp); if (ps) ps.ctrl = ch;
    ch.onopen = () => {
      this._log(`ctrl ✓ ${fp.slice(0, 8)}`);
      try { ch.send(JSON.stringify({ type: 'hello', fingerprint: this.id.fingerprint, nick: this.id.nickname })); } catch {}
      this._checkReady(fp);
    };
    ch.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      this._onPeerMsg(fp, msg);
    };
    ch.onerror = () => {
      // Suppress errors during intentional close or when PC already failed
      const ps2 = this.peers.get(fp);
      if (ps2?._closing) return;
      const state = ps2?.pc?.connectionState;
      if (state === 'failed' || state === 'closed') return;
      this._log(`ctrl channel error: ${fp.slice(0, 8)}`, true);
    };
    ch.onclose = () => {};
  }

  _wireData(fp, ch) {
    const ps = this.peers.get(fp); if (ps) ps.data = ch;
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = 2 * 1024 * 1024;
    ch.onopen  = () => { this._log(`data ✓ ${fp.slice(0, 8)}`); this._checkReady(fp); };
    ch.onmessage = (e) => { if (e.data instanceof ArrayBuffer) this.onBinaryChunk?.(fp, e.data); };
    ch.onerror = () => {
      const ps2 = this.peers.get(fp);
      if (ps2?._closing) return;
      const state = ps2?.pc?.connectionState;
      if (state === 'failed' || state === 'closed') return;
      this._log(`data channel error: ${fp.slice(0, 8)}`, true);
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

  // ── Initiate ───────────────────────────────────────────────────────────────
  async _initiate(fp) {
    if (this.peers.has(fp)) return;
    this._log(`→ ${fp.slice(0, 8)}`);
    const pc = this._makePC(fp); if (!pc) return;

    const ps = { pc, ctrl: null, data: null, ready: false, nick: null,
                 remoteStream: null, localStream: null, onRemoteStream: null, _closing: false };
    this.peers.set(fp, ps);

    const ctrl = pc.createDataChannel('ctrl', { ordered: true });
    const data = pc.createDataChannel('data', { ordered: true });
    this._wireCtrl(fp, ctrl); ps.ctrl = ctrl;
    this._wireData(fp, data); ps.data = data;

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

  // ── Respond ────────────────────────────────────────────────────────────────
  async _onOffer(fp, sdp, nick) {
    if (!sdp) return;
    let ps = this.peers.get(fp);

    if (!ps) {
      this._log(`← ${fp.slice(0, 8)}`);
      const pc = this._makePC(fp); if (!pc) return;
      ps = { pc, ctrl: null, data: null, ready: false, nick: nick || null,
             remoteStream: null, localStream: null, onRemoteStream: null, _closing: false };
      this.peers.set(fp, ps);
      pc.ondatachannel = (e) => {
        if (e.channel.label === 'ctrl') this._wireCtrl(fp, e.channel);
        else if (e.channel.label === 'data') this._wireData(fp, e.channel);
      };
    } else if (nick) { ps.nick = nick; }

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
    const ps = this.peers.get(fp); if (!ps || !sdp) return;
    try { await ps.pc.setRemoteDescription(sdp); }
    catch (e) { this._log('setRemote err: ' + e.message, true); }
  }

  async _onICE(fp, candidate) {
    const ps = this.peers.get(fp); if (!ps || !candidate) return;
    try { await ps.pc.addIceCandidate(candidate); }
    catch (e) { if (!String(e).includes('701') && !String(e).includes('closed')) this._log('ICE err: ' + e.message, true); }
  }

  // ── P2P ctrl messages ──────────────────────────────────────────────────────
  _onPeerMsg(fp, msg) {
    if (!msg?.type) return;
    if (msg.type === 'hello') {
      const ps = this.peers.get(fp); if (ps && msg.nick) ps.nick = msg.nick;
    }
    // answer-reneg: apply SDP silently — app.js doesn't need to handle this
    if (msg.type === 'answer-reneg') { this._applyRenegAnswer(fp, msg.sdp); return; }
    // Everything else (including offer-reneg, permission-denied, etc.) → app.js
    this.onMessage?.(fp, msg);
  }

  async _applyRenegAnswer(fp, sdp) {
    const ps = this.peers.get(fp); if (!ps || !sdp) return;
    try { await ps.pc.setRemoteDescription(sdp); }
    catch (e) { this._log('reneg answer err: ' + e.message, true); }
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
      if (!ps?.data || ps.data.bufferedAmount < (ps.data.bufferedAmountLowThreshold ?? 2097152)) { res(); return; }
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

  getPeerNick(fp) { return this.peers.get(fp)?.nick || fp?.slice(0, 8) || '?'; }

  // ── Voice / Video: Initiator ───────────────────────────────────────────────
  async startMedia(fp, video = false) {
    const ps = this.peers.get(fp);
    if (!ps) throw new Error('Peer not connected');

    ps.localStream?.getTracks().forEach(t => t.stop());
    ps.pc.getSenders().forEach(s => { try { ps.pc.removeTrack(s); } catch {} });

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : false,
      });
    } catch (e) {
      // Classify the error for the UI
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        // Tell the peer why we can't call
        this.sendCtrl(fp, { type: 'permission-denied', media: video ? 'camera/mic' : 'microphone' });
        throw new Error('permission-denied:' + (video ? 'camera/mic' : 'microphone'));
      }
      if (e.name === 'NotFoundError') throw new Error('no-device:' + (video ? 'camera/mic' : 'microphone'));
      throw e;
    }

    ps.localStream = stream;
    stream.getTracks().forEach(t => ps.pc.addTrack(t, stream));

    const offer = await ps.pc.createOffer();
    await ps.pc.setLocalDescription(offer);
    this.sendCtrl(fp, { type: 'offer-reneg', sdp: ps.pc.localDescription, callType: video ? 'video' : 'audio' });
    return stream;
  }

  // ── Voice / Video: Receiver (auto-answer) ──────────────────────────────────
  async answerMedia(fp, remoteSdp, video = false) {
    const ps = this.peers.get(fp);
    if (!ps) throw new Error('Peer not found');

    ps.localStream?.getTracks().forEach(t => t.stop());
    ps.pc.getSenders().forEach(s => { try { ps.pc.removeTrack(s); } catch {} });

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : false,
      });
    } catch (e) {
      // Tell initiator their call couldn't be answered
      this.sendCtrl(fp, { type: 'permission-denied', media: video ? 'camera/mic' : 'microphone' });
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        throw new Error('permission-denied:' + (video ? 'camera/mic' : 'microphone'));
      }
      if (e.name === 'NotFoundError') throw new Error('no-device:' + (video ? 'camera/mic' : 'microphone'));
      throw e;
    }

    ps.localStream = stream;
    stream.getTracks().forEach(t => ps.pc.addTrack(t, stream));

    await ps.pc.setRemoteDescription(remoteSdp);
    const answer = await ps.pc.createAnswer();
    await ps.pc.setLocalDescription(answer);
    this.sendCtrl(fp, { type: 'answer-reneg', sdp: ps.pc.localDescription });
    return stream;
  }

  async stopMedia(fp) {
    const ps = this.peers.get(fp); if (!ps) return;
    ps.localStream?.getTracks().forEach(t => t.stop());
    ps.pc.getSenders().forEach(s => { try { ps.pc.removeTrack(s); } catch {} });
    ps.localStream = null;
    this.sendCtrl(fp, { type: 'call-end' });
  }

  setRemoteStreamHandler(fp, fn) {
    const ps = this.peers.get(fp); if (!ps) return;
    ps.onRemoteStream = fn;
    if (ps.remoteStream) fn(ps.remoteStream);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  _closePeer(fp) {
    const ps = this.peers.get(fp); if (!ps) return;
    ps._closing = true;
    ps.localStream?.getTracks().forEach(t => t.stop());
    try { ps.ctrl?.close(); } catch {}
    try { ps.data?.close(); } catch {}
    try { ps.pc.close(); } catch {}
    this.peers.delete(fp);
  }

  destroy() {
    this._dead = true; clearTimeout(this._timer);
    try { this.ws?.close(); } catch {}
    for (const fp of [...this.peers.keys()]) this._closePeer(fp);
  }

  _log(text, isErr = false) {
    this.onLog?.(text, isErr);
    (isErr ? console.warn : console.log)('[TQ]', text);
  }
}
