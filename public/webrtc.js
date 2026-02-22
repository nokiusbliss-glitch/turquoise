/**
 * webrtc.js — Turquoise v7 (LAN-First Engine)
 *
 * ── LAN-First Transfer ───────────────────────────────────────────────────────
 * iceTransportPolicy: 'all' — allows ALL candidate types.
 * ICE priority order (built into WebRTC spec):
 *   1. host candidates     (LAN direct — fastest, zero relay)
 *   2. srflx candidates    (STUN, same NAT)
 *   3. relay candidates    (TURN, internet relay — slowest)
 *
 * When both devices are on same WiFi/hotspot:
 *   ICE ALWAYS selects the host candidate.
 *   Data flows directly over LAN at full 5GHz speed.
 *   No server involved. No TURN used.
 *
 * When devices are on different networks (mobile data vs WiFi):
 *   TURN is used as fallback.
 *   Still works, just slower.
 *
 * No manual mode toggle needed — WebRTC handles it automatically.
 *
 * ── Two DataChannels per peer ────────────────────────────────────────────────
 *   'ctrl' — ordered, reliable  → chat, signals, call events
 *   'ft'   — unordered, unreliable → file chunks (app-level reliability)
 *
 * Unordered/unreliable for file transfer = UDP-like SCTP.
 * We handle ordering and integrity at app layer (chunk index + CRC).
 * This eliminates head-of-line blocking — much faster on LAN.
 *
 * ── Call Renegotiation ───────────────────────────────────────────────────────
 * onnegotiationneeded fires when addTrack() is called.
 * We send 'renegotiate-offer' (distinct from initial 'offer').
 * Remote answers with 'renegotiate-answer'.
 * This keeps the DataChannel alive while adding media.
 *
 * Murphy's Law: ICE failure → restartIce(). Connection failure → teardown.
 *               Every async is try/catched. Dead peers removed from registry.
 */

// ── ICE config: LAN-first, TURN as last resort ────────────────────────────────
const ICE = [
  { urls: 'stun:stun.l.google.com:19302'  },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ],
    username:   'openrelayproject',
    credential: 'openrelayproject',
  },
];

const RECONNECT_BASE = 1_000;
const RECONNECT_MAX  = 30_000;

export class TurquoiseNetwork {

  constructor(identity) {
    if (!identity?.fingerprint) throw new Error('Network: identity.fingerprint required.');
    this.identity = identity;

    this.wsUrl            = null;
    this.ws               = null;
    this.reconnectDelay   = RECONNECT_BASE;
    this.reconnectTimer   = null;
    this.intentionalClose = false;

    // Per-peer state
    this.pcs         = new Map(); // fp → RTCPeerConnection
    this.ctrlCh      = new Map(); // fp → RTCDataChannel (ordered, reliable)
    this.ftCh        = new Map(); // fp → RTCDataChannel (unordered, unreliable)
    this.pendingICE  = new Map(); // fp → ICECandidate[]

    // Media
    this.localStream  = null;
    this.remoteStreams = new Map(); // fp → MediaStream

    // ── Callbacks ─────────────────────────────────────────────────────────────
    this.onCtrlMessage     = null; // (fp, object) → void
    this.onBinaryChunk     = null; // (fp, ArrayBuffer) → void
    this.onPeerConnected   = null; // (fp) → void
    this.onPeerDisconnected= null; // (fp) → void
    this.onStatusChange    = null; // ('connecting'|'connected'|'disconnected') → void
    this.onRemoteStream    = null; // (fp, MediaStream|null) → void

    this.logFn = t => console.log('[Net]', t);
  }

  // ── Connect to signaling ──────────────────────────────────────────────────

  connect(url) {
    this.wsUrl = url;
    this.intentionalClose = false;
    this._openWS();
  }

  disconnect() {
    this.intentionalClose = true;
    clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch {}
  }

  _openWS() {
    if (this.ws && this.ws.readyState <= 1) return;
    this._status('connecting');
    this._log('Connecting to signaling server…');

    try { this.ws = new WebSocket(this.wsUrl); }
    catch (e) { this._log('❌ WebSocket: ' + e.message); this._scheduleReconnect(); return; }

    this.ws.onopen = () => {
      this._log('Signaling connected ✓');
      this.reconnectDelay = RECONNECT_BASE;
      this._status('connected');
      this._announce();
    };

    this.ws.onmessage = async ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      try { await this._onSignal(msg); }
      catch (e) { this._log('⚠ signal handler: ' + e.message); }
    };

    this.ws.onclose  = ev => {
      this._log(`Signaling closed (${ev.code}).`);
      this._status('disconnected');
      if (!this.intentionalClose) this._scheduleReconnect();
    };

    this.ws.onerror = () => this._log('❌ WebSocket error.');
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const jitter = 1 + (Math.random() - 0.5) * 0.4; // ±20%
    const delay  = Math.min(this.reconnectDelay * jitter, RECONNECT_MAX);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
    this._log(`Reconnecting in ${(delay / 1000).toFixed(1)}s…`);
    this.reconnectTimer = setTimeout(() => this._openWS(), delay);
  }

  _announce() {
    this._signal({
      type:     'announce',
      from:     this.identity.fingerprint,
      nickname: this.identity.nickname || null,
    });
  }

  broadcastNick(nick) {
    this._signal({ type: 'nick', fingerprint: this.identity.fingerprint, nickname: nick });
  }

  // ── Send via ctrl channel ─────────────────────────────────────────────────

  sendCtrl(fp, payload) {
    const ch = this.ctrlCh.get(fp);
    if (!ch || ch.readyState !== 'open') return false;
    try { ch.send(JSON.stringify(payload)); return true; }
    catch (e) { this._log(`⚠ sendCtrl ${fp.slice(0,8)}: ${e.message}`); return false; }
  }

  broadcastCtrl(payload) {
    const str = JSON.stringify(payload);
    let n = 0;
    for (const [, ch] of this.ctrlCh) {
      if (ch.readyState === 'open') { try { ch.send(str); n++; } catch {} }
    }
    return n;
  }

  // ── Send binary via ft channel ────────────────────────────────────────────

  sendBinary(fp, buffer) {
    const ch = this.ftCh.get(fp);
    if (!ch || ch.readyState !== 'open') return false;
    try { ch.send(buffer); return true; }
    catch (e) { this._log(`⚠ sendBinary ${fp.slice(0,8)}: ${e.message}`); return false; }
  }

  getCtrlChannel(fp)   { return this.ctrlCh.get(fp)  || null; }
  getFtChannel(fp)     { return this.ftCh.get(fp)    || null; }
  getConnectedPeers()  { return [...this.ctrlCh.entries()].filter(([,c])=>c.readyState==='open').map(([f])=>f); }

  // ── Media ─────────────────────────────────────────────────────────────────

  async startCall(fp, video = false) {
    const pc = this.pcs.get(fp);
    if (!pc) throw new Error(`No peer connection: ${fp.slice(0,8)}`);
    const stream = await this._getMedia({ audio: true, video });
    this.localStream = stream;
    for (const t of stream.getTracks()) { try { pc.addTrack(t, stream); } catch {} }
    // Notify peer — onnegotiationneeded will handle the SDP exchange
    this.sendCtrl(fp, { type: 'call-offer', video, from: this.identity.fingerprint });
    return stream;
  }

  async acceptCall(fp) {
    const stream = await this._getMedia({ audio: true, video: false });
    this.localStream = stream;
    const pc = this.pcs.get(fp);
    if (pc) for (const t of stream.getTracks()) { try { pc.addTrack(t, stream); } catch {} }
    return stream;
  }

  async startPTT(fp) {
    const stream = await this._getMedia({ audio: true, video: false });
    this.localStream = stream;
    const pc = this.pcs.get(fp);
    if (pc) for (const t of stream.getTracks()) { try { pc.addTrack(t, stream); } catch {} }
    this.sendCtrl(fp, { type: 'ptt-start', from: this.identity.fingerprint });
    return stream;
  }

  stopPTT(fp) {
    this._stopMedia();
    if (fp) this.sendCtrl(fp, { type: 'ptt-end', from: this.identity.fingerprint });
  }

  hangup(fp) {
    this._stopMedia();
    if (fp) {
      this.remoteStreams.delete(fp);
      if (typeof this.onRemoteStream === 'function') this.onRemoteStream(fp, null);
      this.sendCtrl(fp, { type: 'call-end', from: this.identity.fingerprint });
    }
  }

  async _getMedia(constraints) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Media devices not available (HTTPS required).');
    }
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      throw new Error(`Media access denied: ${e.message}`);
    }
  }

  _stopMedia() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
      this.localStream = null;
    }
  }

  // ── Signaling dispatch ────────────────────────────────────────────────────

  async _onSignal(msg) {
    if (!msg || typeof msg !== 'object') return;
    const { type, from } = msg;

    if (type === 'peer' && msg.fingerprint) {
      this._log(`Peer discovered: ${msg.fingerprint.slice(0,8)}`);
      if (!this.pcs.has(msg.fingerprint)) await this._createOffer(msg.fingerprint);
    }
    else if (type === 'peer-left' && msg.fingerprint) {
      this._teardown(msg.fingerprint);
    }
    else if (type === 'nick') {
      if (typeof this.onCtrlMessage === 'function') {
        this.onCtrlMessage(null, { type:'nick', fingerprint:msg.fingerprint, nickname:msg.nickname });
      }
    }
    else if (type === 'offer'               && from) { await this._handleOffer(from, msg.sdp); }
    else if (type === 'answer'              && from) { await this._handleAnswer(from, msg.sdp); }
    else if (type === 'ice'                 && from) { await this._handleICE(from, msg.candidate); }
    else if (type === 'renegotiate-offer'   && from) { await this._handleReOffer(from, msg.sdp); }
    else if (type === 'renegotiate-answer'  && from) { await this._handleReAnswer(from, msg.sdp); }
  }

  // ── RTCPeerConnection ─────────────────────────────────────────────────────

  _makePC(fp) {
    const pc = new RTCPeerConnection({
      iceServers:          ICE,
      iceTransportPolicy: 'all',   // allow all candidates; host = LAN = fastest
    });

    pc.onicecandidate = ev => {
      if (!ev.candidate) return;
      this._signal({ type:'ice', from:this.identity.fingerprint, to:fp, candidate:ev.candidate });
    };

    pc.onicecandidateerror = ev => {
      if (ev.errorCode !== 701) this._log(`⚠ ICE error ${ev.errorCode}: ${ev.errorText}`);
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'failed') {
        this._log(`ICE failed ↔ ${fp.slice(0,8)} — restarting`);
        try { pc.restartIce(); } catch {}
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this._log(`${fp.slice(0,8)} → ${s}`);
      if (s === 'failed' || s === 'closed') this._teardown(fp);
    };

    // ── THE KEY FIX FOR CALLS ─────────────────────────────────────────────
    // When addTrack() is called (on an existing connection), this fires.
    // We send a renegotiate-offer (not offer) so remote knows to keep existing channels.
    let negotiating = false;
    pc.onnegotiationneeded = async () => {
      if (negotiating || pc.signalingState !== 'stable') return;
      negotiating = true;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this._signal({ type:'renegotiate-offer', from:this.identity.fingerprint, to:fp, sdp:offer.sdp });
      } catch (e) {
        this._log(`⚠ onnegotiationneeded: ${e.message}`);
      } finally {
        negotiating = false;
      }
    };

    // Incoming media tracks (calls accepted by remote)
    pc.ontrack = ev => {
      const stream = ev.streams[0];
      if (!stream) return;
      this.remoteStreams.set(fp, stream);
      if (typeof this.onRemoteStream === 'function') this.onRemoteStream(fp, stream);
    };

    this.pcs.set(fp, pc);
    return pc;
  }

  async _createOffer(fp) {
    if (this.pcs.has(fp)) return;
    const pc = this._makePC(fp);

    // ctrl channel: ordered + reliable for chat/signals
    let ctrl;
    try {
      ctrl = pc.createDataChannel('ctrl', { ordered: true });
      this._setupCtrl(ctrl, fp);
    } catch (e) { this._log('❌ createDataChannel(ctrl): ' + e.message); return; }

    // ft channel: unordered + unreliable for file chunks (we handle reliability)
    let ft;
    try {
      ft = pc.createDataChannel('ft', { ordered: false, maxRetransmits: 0 });
      ft.binaryType = 'arraybuffer';
      this._setupFT(ft, fp);
    } catch (e) { this._log('❌ createDataChannel(ft): ' + e.message); }

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this._signal({ type:'offer', from:this.identity.fingerprint, to:fp, sdp:offer.sdp });
    } catch (e) { this._log('❌ createOffer: ' + e.message); }
  }

  async _handleOffer(fp, sdp) {
    if (this.pcs.has(fp)) return;
    const pc = this._makePC(fp);

    pc.ondatachannel = ev => {
      const ch = ev.channel;
      if (ch.label === 'ctrl') { ch.binaryType = 'arraybuffer'; this._setupCtrl(ch, fp); }
      if (ch.label === 'ft')   { ch.binaryType = 'arraybuffer'; this._setupFT(ch, fp); }
    };

    try { await pc.setRemoteDescription({ type:'offer', sdp }); }
    catch (e) { this._log('❌ setRemoteDescription(offer): ' + e.message); return; }

    await this._flushICE(fp);

    try {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this._signal({ type:'answer', from:this.identity.fingerprint, to:fp, sdp:answer.sdp });
    } catch (e) { this._log('❌ createAnswer: ' + e.message); }
  }

  async _handleAnswer(fp, sdp) {
    const pc = this.pcs.get(fp);
    if (!pc) return;
    try { await pc.setRemoteDescription({ type:'answer', sdp }); await this._flushICE(fp); }
    catch (e) { this._log('❌ setRemoteDescription(answer): ' + e.message); }
  }

  async _handleICE(fp, candidate) {
    const pc = this.pcs.get(fp);
    if (!pc) return;
    if (pc.remoteDescription) {
      try { await pc.addIceCandidate(candidate); } catch {}
    } else {
      if (!this.pendingICE.has(fp)) this.pendingICE.set(fp, []);
      this.pendingICE.get(fp).push(candidate);
    }
  }

  async _flushICE(fp) {
    const list = this.pendingICE.get(fp) || [];
    this.pendingICE.delete(fp);
    const pc = this.pcs.get(fp);
    if (!pc) return;
    for (const c of list) { try { await pc.addIceCandidate(c); } catch {} }
  }

  // Renegotiation (call tracks added after initial connection)
  async _handleReOffer(fp, sdp) {
    const pc = this.pcs.get(fp);
    if (!pc) return;
    try {
      await pc.setRemoteDescription({ type:'offer', sdp });
      await this._flushICE(fp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this._signal({ type:'renegotiate-answer', from:this.identity.fingerprint, to:fp, sdp:answer.sdp });
    } catch (e) { this._log('❌ renegotiate-offer: ' + e.message); }
  }

  async _handleReAnswer(fp, sdp) {
    const pc = this.pcs.get(fp);
    if (!pc) return;
    try { await pc.setRemoteDescription({ type:'answer', sdp }); }
    catch (e) { this._log('❌ renegotiate-answer: ' + e.message); }
  }

  // ── DataChannel setup ─────────────────────────────────────────────────────

  _setupCtrl(ch, fp) {
    this.ctrlCh.set(fp, ch);

    ch.onopen = () => {
      this._log(`ctrl open ↔ ${fp.slice(0,8)} ✓`);
      try {
        ch.send(JSON.stringify({
          type:        'hello',
          fingerprint: this.identity.fingerprint,
          shortId:     this.identity.shortId,
          nickname:    this.identity.nickname || null,
          ts:          Date.now(),
        }));
      } catch {}
      if (typeof this.onPeerConnected === 'function') this.onPeerConnected(fp);
    };

    ch.onmessage = ev => {
      if (typeof ev.data !== 'string') return;
      let event;
      try { event = JSON.parse(ev.data); } catch { return; }
      if (typeof this.onCtrlMessage === 'function') {
        try { this.onCtrlMessage(fp, event); }
        catch (e) { this._log('⚠ onCtrlMessage: ' + e.message); }
      }
    };

    ch.onclose = () => {
      this._log(`ctrl closed: ${fp.slice(0,8)}`);
      this.ctrlCh.delete(fp);
      if (typeof this.onPeerDisconnected === 'function') this.onPeerDisconnected(fp);
    };

    ch.onerror = e => this._log(`⚠ ctrl error (${fp.slice(0,8)}): ${e?.message||'?'}`);
  }

  _setupFT(ch, fp) {
    this.ftCh.set(fp, ch);
    ch.binaryType = 'arraybuffer';

    // Set low-water mark for backpressure in file transfer
    ch.bufferedAmountLowThreshold = 4 * 1024 * 1024; // 4MB

    ch.onmessage = ev => {
      const data = ev.data;
      // Binary = file chunk
      if (data instanceof ArrayBuffer) {
        if (typeof this.onBinaryChunk === 'function') {
          try { this.onBinaryChunk(fp, data); }
          catch (e) { this._log('⚠ onBinaryChunk: ' + e.message); }
        }
      } else if (data instanceof Blob) {
        // Safari sometimes sends Blob — convert
        data.arrayBuffer().then(buf => {
          if (typeof this.onBinaryChunk === 'function') {
            try { this.onBinaryChunk(fp, buf); } catch {}
          }
        });
      }
    };

    ch.onclose = () => this.ftCh.delete(fp);
    ch.onerror = e => this._log(`⚠ ft error (${fp.slice(0,8)}): ${e?.message||'?'}`);
  }

  // ── Teardown ──────────────────────────────────────────────────────────────

  _teardown(fp) {
    for (const map of [this.ctrlCh, this.ftCh]) {
      const ch = map.get(fp);
      if (ch) { try { ch.close(); } catch {} map.delete(fp); }
    }
    const pc = this.pcs.get(fp);
    if (pc) { try { pc.close(); } catch {} this.pcs.delete(fp); }
    this.pendingICE.delete(fp);
    if (typeof this.onPeerDisconnected === 'function') this.onPeerDisconnected(fp);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _signal(msg) {
    if (!this.ws || this.ws.readyState !== 1) return;
    try { this.ws.send(JSON.stringify(msg)); }
    catch (e) { this._log('⚠ signal: ' + e.message); }
  }

  _status(s) {
    if (typeof this.onStatusChange === 'function') try { this.onStatusChange(s); } catch {}
  }

  _log(t) { try { this.logFn(t); } catch { console.log('[Net]', t); } }
}
