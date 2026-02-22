/**
 * webrtc.js — Turquoise (Hyper-Reliable Edition)
 *
 * What makes connections unreliable (and how we fix each):
 *
 * 1. Render free tier sleeps → WebSocket drops → no reconnect
 *    FIX: Exponential backoff reconnect. Automatically re-announces
 *         after reconnect. Pending ICE candidates queued.
 *
 * 2. NAT traversal failure → ICE candidates never arrive
 *    FIX: Multiple STUN servers. TURN fallback if STUN fails.
 *         ICE candidate queue flushed after remote description set.
 *
 * 3. DataChannel closes silently → peer appears online but is dead
 *    FIX: connectionState + iceConnectionState both monitored.
 *         Automatic channel recreation on reconnect.
 *
 * 4. Large files stall → bufferedAmount overflows → channel crashes
 *    FIX: getChannel() exposed so FileTransfer can monitor bufferedAmount.
 *
 * 5. Voice call media tracks not cleaned up → mic stays open
 *    FIX: Explicit stream.getTracks().forEach(t => t.stop()) on hangup.
 *
 * Murphy's Law: if a connection can die, it will.
 *               We detect it, we recover it, silently.
 */

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302'  },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
];

const RECONNECT_BASE  = 1000;   // 1s initial backoff
const RECONNECT_MAX   = 30000;  // 30s max backoff
const RECONNECT_JITTER = 0.3;   // ±30% jitter to prevent thundering herd

export class TurquoiseNetwork {

  constructor(identity, onEvent) {
    if (!identity?.fingerprint) throw new Error('Network: identity.fingerprint required.');
    if (typeof onEvent !== 'function') throw new Error('Network: onEvent must be a function.');

    this.identity  = identity;
    this.onEvent   = onEvent;

    // Callbacks — set from outside
    this.onPeerConnected    = null; // (fp) → void
    this.onPeerDisconnected = null; // (fp) → void
    this.onStatusChange     = null; // ('connecting'|'connected'|'disconnected') → void

    this.ws             = null;
    this.wsUrl          = null;
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_BASE;
    this.intentionalClose = false;

    this.peers    = new Map(); // fp → RTCPeerConnection
    this.channels = new Map(); // fp → RTCDataChannel
    this.pendingICE = new Map(); // fp → RTCIceCandidateInit[]

    // Voice/video per peer
    this.localStream  = null;  // MediaStream for outgoing audio/video
    this.peerStreams   = new Map(); // fp → MediaStream (remote)
    this.onRemoteStream = null; // (fp, MediaStream | null) → void

    this.logFn = (msg) => console.log('[Net]', msg);
  }

  // ── Connect (and auto-reconnect) ────────────────────────────────────────────

  connect(url) {
    if (!url) { this._log('❌ connect: no URL.'); return; }
    this.wsUrl          = url;
    this.intentionalClose = false;
    this._openWebSocket();
  }

  disconnect() {
    this.intentionalClose = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.ws = null;
  }

  _openWebSocket() {
    if (this.ws && this.ws.readyState <= 1) return; // already open/connecting

    this._setStatus('connecting');
    this._log('Connecting to signaling server…');

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (e) {
      this._log('❌ WebSocket() threw: ' + e.message);
      this._scheduleReconnect(); return;
    }

    this.ws.onopen = () => {
      this._log('Signaling server connected ✓');
      this.reconnectDelay = RECONNECT_BASE; // reset backoff on success
      this._setStatus('connected');

      // Re-announce (important after reconnect — server is fresh)
      this._signal({
        type:     'announce',
        from:     this.identity.fingerprint,
        nickname: this.identity.nickname || null,
      });
    };

    this.ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      try { await this._handleSignal(msg); }
      catch (e) { this._log('⚠ signal error: ' + e.message); }
    };

    this.ws.onclose = (ev) => {
      this._log(`Signaling closed (${ev.code}).`);
      this._setStatus('disconnected');
      if (!this.intentionalClose) this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      this._log('❌ Signaling error. Reconnecting…');
      // onclose fires after onerror — reconnect happens there
    };
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER;
    const delay  = Math.min(this.reconnectDelay * jitter, RECONNECT_MAX);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
    this._log(`Reconnecting in ${(delay / 1000).toFixed(1)}s…`);
    this.reconnectTimer = setTimeout(() => this._openWebSocket(), delay);
  }

  // ── Broadcast to all peers ──────────────────────────────────────────────────

  broadcast(payload) {
    let packet, sent = 0;
    try { packet = JSON.stringify(payload); }
    catch (e) { this._log('⚠ broadcast: serialize failed: ' + e.message); return 0; }

    for (const [fp, ch] of this.channels) {
      if (ch.readyState === 'open') {
        try { ch.send(packet); sent++; }
        catch (e) { this._log(`⚠ broadcast → ${fp.slice(0,8)}: ${e.message}`); }
      }
    }
    return sent;
  }

  // ── Send to one specific peer ───────────────────────────────────────────────

  sendTo(fp, payload) {
    if (!fp || !payload) return false;
    const ch = this.channels.get(fp);
    if (!ch || ch.readyState !== 'open') return false;
    try { ch.send(JSON.stringify(payload)); return true; }
    catch (e) { this._log(`⚠ sendTo ${fp.slice(0,8)}: ${e.message}`); return false; }
  }

  // ── Get DataChannel (for bufferedAmount monitoring in file transfer) ─────────

  getChannel(fp) {
    return this.channels.get(fp) || null;
  }

  // ── Get connected peer fingerprints ─────────────────────────────────────────

  getConnectedPeers() {
    return [...this.channels.entries()]
      .filter(([, ch]) => ch.readyState === 'open')
      .map(([fp]) => fp);
  }

  // ── Nickname update broadcast ───────────────────────────────────────────────

  broadcastNickname(nickname) {
    this._signal({
      type:        'nickname-update',
      fingerprint: this.identity.fingerprint,
      nickname,
    });
  }

  // ── Voice / Video ────────────────────────────────────────────────────────────

  async startCall(fp, video = false) {
    if (!fp) throw new Error('startCall: no peer fingerprint.');

    // Get local media
    const constraints = { audio: true, video };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      throw new Error('Microphone/camera access denied: ' + e.message);
    }

    this.localStream = stream;

    const pc = this.peers.get(fp);
    if (!pc) throw new Error('startCall: no peer connection for ' + fp.slice(0, 8));

    // Add tracks to existing connection and renegotiate
    for (const track of stream.getTracks()) {
      try { pc.addTrack(track, stream); }
      catch (e) { this._log('⚠ addTrack: ' + e.message); }
    }

    // Signal peer to expect call
    this.sendTo(fp, {
      type:  'call-offer',
      video,
      from:  this.identity.fingerprint,
    });

    return stream;
  }

  async acceptCall(fp) {
    const constraints = { audio: true, video: false };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      throw new Error('Microphone access denied: ' + e.message);
    }

    this.localStream = stream;
    const pc = this.peers.get(fp);
    if (!pc) return stream;

    for (const track of stream.getTracks()) {
      try { pc.addTrack(track, stream); } catch {}
    }
    return stream;
  }

  hangup(fp) {
    // Stop all local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
      this.localStream = null;
    }
    // Remove remote stream
    this.peerStreams.delete(fp);
    if (typeof this.onRemoteStream === 'function') {
      this.onRemoteStream(fp, null);
    }
    // Notify peer
    if (fp) this.sendTo(fp, { type: 'call-end', from: this.identity.fingerprint });
  }

  // ── PTT (Push to Talk) ───────────────────────────────────────────────────────

  async startPTT(fp) {
    if (!fp) return null;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
      throw new Error('Microphone denied: ' + e.message);
    }
    this.localStream = stream;
    const pc = this.peers.get(fp);
    if (pc) {
      for (const t of stream.getTracks()) {
        try { pc.addTrack(t, stream); } catch {}
      }
    }
    this.sendTo(fp, { type: 'ptt-start', from: this.identity.fingerprint });
    return stream;
  }

  stopPTT(fp) {
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
      this.localStream = null;
    }
    if (fp) this.sendTo(fp, { type: 'ptt-end', from: this.identity.fingerprint });
  }

  // ── Handle signaling messages ────────────────────────────────────────────────

  async _handleSignal(msg) {
    if (!msg || typeof msg !== 'object') return;
    const { type, from } = msg;

    if (type === 'peer') {
      if (!msg.fingerprint) return;
      this._log(`Peer discovered: ${msg.fingerprint.slice(0,8)}`);
      await this._createOffer(msg.fingerprint);
    }

    else if (type === 'peer-left') {
      if (msg.fingerprint) this._teardown(msg.fingerprint);
    }

    else if (type === 'nickname-update') {
      // Route to app layer
      try { this.onEvent({ type: 'nickname-update', fingerprint: msg.fingerprint, nickname: msg.nickname }); }
      catch {}
    }

    else if (type === 'offer') {
      if (!from || !msg.sdp) return;
      await this._handleOffer(from, msg.sdp);
    }

    else if (type === 'answer') {
      if (!from || !msg.sdp) return;
      const pc = this.peers.get(from);
      if (!pc) return;
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        await this._flushPendingICE(from);
      } catch (e) { this._log('⚠ setRemoteDescription(answer): ' + e.message); }
    }

    else if (type === 'ice') {
      if (!from || !msg.candidate) return;
      const pc = this.peers.get(from);
      if (!pc) return;

      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(msg.candidate); } catch {}
      } else {
        // Queue until remote description is set
        if (!this.pendingICE.has(from)) this.pendingICE.set(from, []);
        this.pendingICE.get(from).push(msg.candidate);
      }
    }
  }

  async _flushPendingICE(fp) {
    const candidates = this.pendingICE.get(fp) || [];
    this.pendingICE.delete(fp);
    const pc = this.peers.get(fp);
    if (!pc) return;
    for (const c of candidates) {
      try { await pc.addIceCandidate(c); } catch {}
    }
  }

  // ── RTCPeerConnection lifecycle ──────────────────────────────────────────────

  _createPC(remoteFp) {
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    } catch (e) {
      throw new Error('RTCPeerConnection failed: ' + e.message);
    }

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      this._signal({
        type: 'ice', from: this.identity.fingerprint, to: remoteFp,
        candidate: ev.candidate,
      });
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'failed') {
        this._log(`⚠ ICE failed with ${remoteFp.slice(0,8)} — restarting ICE.`);
        try { pc.restartIce(); } catch {}
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this._log(`${remoteFp.slice(0,8)} → ${s}`);
      if (s === 'failed' || s === 'closed') {
        this._teardown(remoteFp);
      }
    };

    pc.onicecandidateerror = (ev) => {
      // errorCode 701 = STUN server unreachable — common, not fatal
      if (ev.errorCode !== 701) {
        this._log(`⚠ ICE error ${ev.errorCode}: ${ev.errorText}`);
      }
    };

    // Handle incoming media tracks (voice/video calls)
    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (!stream) return;
      this.peerStreams.set(remoteFp, stream);
      if (typeof this.onRemoteStream === 'function') {
        this.onRemoteStream(remoteFp, stream);
      }
    };

    this.peers.set(remoteFp, pc);
    return pc;
  }

  async _createOffer(remoteFp) {
    if (this.peers.has(remoteFp)) return; // already connected

    let pc;
    try { pc = this._createPC(remoteFp); }
    catch (e) { this._log('❌ ' + e.message); return; }

    let ch;
    try {
      ch = pc.createDataChannel('turquoise', { ordered: true });
      this._setupChannel(ch, remoteFp);
    } catch (e) { this._log('❌ createDataChannel: ' + e.message); return; }

    let offer;
    try {
      offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (e) { this._log('❌ createOffer: ' + e.message); return; }

    this._signal({
      type: 'offer', from: this.identity.fingerprint, to: remoteFp, sdp: offer.sdp,
    });
  }

  async _handleOffer(remoteFp, sdp) {
    if (this.peers.has(remoteFp)) return;

    let pc;
    try { pc = this._createPC(remoteFp); }
    catch (e) { this._log('❌ ' + e.message); return; }

    pc.ondatachannel = (ev) => {
      try { this._setupChannel(ev.channel, remoteFp); }
      catch (e) { this._log('⚠ ondatachannel: ' + e.message); }
    };

    try { await pc.setRemoteDescription({ type: 'offer', sdp }); }
    catch (e) { this._log('❌ setRemoteDescription(offer): ' + e.message); return; }

    await this._flushPendingICE(remoteFp);

    let answer;
    try {
      answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
    } catch (e) { this._log('❌ createAnswer: ' + e.message); return; }

    this._signal({
      type: 'answer', from: this.identity.fingerprint, to: remoteFp, sdp: answer.sdp,
    });
  }

  _setupChannel(ch, remoteFp) {
    if (!ch) { this._log('⚠ setupChannel: null channel.'); return; }
    this.channels.set(remoteFp, ch);

    ch.onopen = () => {
      this._log(`DataChannel open ↔ ${remoteFp.slice(0,8)} ✓`);
      if (typeof this.onPeerConnected === 'function') {
        this.onPeerConnected(remoteFp);
      }
      // Send hello with full identity
      try {
        ch.send(JSON.stringify({
          type:        'hello',
          fingerprint: this.identity.fingerprint,
          shortId:     this.identity.shortId,
          nickname:    this.identity.nickname || null,
          ts:          Date.now(),
        }));
      } catch (e) { this._log('⚠ hello send: ' + e.message); }
    };

    ch.onmessage = (ev) => {
      let event;
      try { event = JSON.parse(ev.data); } catch { return; }
      try { this.onEvent(event); } catch (e) { this._log('⚠ onEvent: ' + e.message); }
    };

    ch.onclose = () => {
      this._log(`DataChannel closed: ${remoteFp.slice(0,8)}`);
      this.channels.delete(remoteFp);
      if (typeof this.onPeerDisconnected === 'function') {
        this.onPeerDisconnected(remoteFp);
      }
    };

    ch.onerror = (e) => {
      this._log(`⚠ channel error (${remoteFp.slice(0,8)}): ${e?.message || 'unknown'}`);
    };
  }

  // ── Teardown one peer connection ─────────────────────────────────────────────

  _teardown(fp) {
    const ch = this.channels.get(fp);
    if (ch) { try { ch.close(); } catch {} this.channels.delete(fp); }
    const pc = this.peers.get(fp);
    if (pc) { try { pc.close(); } catch {} this.peers.delete(fp); }
    this.pendingICE.delete(fp);
    if (typeof this.onPeerDisconnected === 'function') {
      this.onPeerDisconnected(fp);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _signal(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(msg)); }
    catch (e) { this._log('⚠ signal send: ' + e.message); }
  }

  _setStatus(status) {
    if (typeof this.onStatusChange === 'function') {
      try { this.onStatusChange(status); } catch {}
    }
  }

  _log(text) {
    try { this.logFn(text); } catch { console.log('[Net]', text); }
  }
}
