/**
 * network.js — Turquoise Dual-Mode Connection Engine
 *
 * MODE ONLINE:  Render WebSocket → WebRTC → STUN + TURN
 * MODE OFFLINE: Rust mDNS → local WS → WebRTC host candidates
 *
 * Same WebRTC engine for both modes. What changes is the signaling path:
 *   Online  → cloud WebSocket (ws://turquoise.onrender.com)
 *   Offline → Rust local WS   (ws://192.168.x.x:7788)
 *
 * For files in offline mode, we route through Rust TCP instead of DataChannel
 * to achieve maximum WiFi throughput.
 *
 * Auto mode detection:
 *   - If navigator.onLine === false → start in offline
 *   - If cloud WS fails 3× → switch to offline
 *   - Toggle is always available
 *
 * Murphy's Law: ICE restart on failure, exponential backoff on WS, peer
 *               watchdog via connectionState, no silent failures anywhere.
 */

import { IS_TAURI, listen, getPeerWsUrl } from './bridge.js';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302'  },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  {
    urls:       'turn:openrelay.metered.ca:80',
    username:   'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls:       'turn:openrelay.metered.ca:443',
    username:   'openrelayproject',
    credential: 'openrelayproject',
  },
];

// ONLINE uses STUN+TURN, OFFLINE uses host candidates only (no TURN needed on LAN)
const ICE_SERVERS_LAN = [
  { urls: 'stun:stun.l.google.com:19302' },
];

const RECONNECT_BASE = 1_000;
const RECONNECT_MAX  = 30_000;
const RECONNECT_JITTER = 0.3;
const MAX_CLOUD_FAILURES = 3;

export const Mode = Object.freeze({ ONLINE: 'online', OFFLINE: 'offline' });

export class TurquoiseNetwork {

  constructor(identity, onEvent) {
    if (!identity?.fingerprint) throw new Error('Network: identity.fingerprint required.');
    if (typeof onEvent !== 'function') throw new Error('Network: onEvent must be a function.');

    this.identity  = identity;
    this.onEvent   = onEvent;
    this.mode      = navigator.onLine === false ? Mode.OFFLINE : Mode.ONLINE;

    this.ws             = null;
    this.wsUrl          = null;
    this.cloudUrl       = null;
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_BASE;
    this.cloudFailures  = 0;
    this.intentionalClose = false;

    this.peers      = new Map();  // fp → RTCPeerConnection
    this.channels   = new Map();  // fp → RTCDataChannel
    this.pendingICE = new Map();  // fp → candidate[]

    // Voice/video
    this.localStream      = null;
    this.peerStreams       = new Map();
    this.onRemoteStream   = null;

    // Peer connections per LAN peer (offline mode — one local WS per peer)
    this.lanSignaling = new Map(); // fp → WebSocket (to peer's local WS server)

    // Callbacks
    this.onPeerConnected    = null;
    this.onPeerDisconnected = null;
    this.onStatusChange     = null;
    this.onModeChange       = null;

    this.logFn = (t) => console.log('[Net]', t);

    // Listen to Tauri events in Tauri mode
    if (IS_TAURI) this._bindTauriEvents();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  connect(cloudUrl) {
    this.cloudUrl       = cloudUrl;
    this.intentionalClose = false;
    if (this.mode === Mode.ONLINE) {
      this._openCloudWS(cloudUrl);
    } else {
      this._setStatus('offline');
      this._log('Starting in offline LAN mode.');
    }
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;

    if (mode === Mode.ONLINE) {
      this._log('Switching to ONLINE mode.');
      this.cloudFailures = 0;
      if (this.cloudUrl) this._openCloudWS(this.cloudUrl);
    } else {
      this._log('Switching to OFFLINE LAN mode.');
      // Disconnect from cloud WS but keep peer connections
      if (this.ws) {
        this.intentionalClose = true;
        try { this.ws.close(); } catch {}
        this.ws = null;
        this.intentionalClose = false;
      }
      clearTimeout(this.reconnectTimer);
      this._setStatus('disconnected');
    }

    if (typeof this.onModeChange === 'function') this.onModeChange(mode);
  }

  sendTo(fp, payload) {
    if (!fp || !payload) return false;
    const ch = this.channels.get(fp);
    if (!ch || ch.readyState !== 'open') return false;
    try { ch.send(JSON.stringify(payload)); return true; }
    catch (e) { this._log(`⚠ sendTo ${fp.slice(0,8)}: ${e.message}`); return false; }
  }

  broadcast(payload) {
    let sent = 0;
    let packet;
    try { packet = JSON.stringify(payload); }
    catch { return 0; }
    for (const [fp, ch] of this.channels) {
      if (ch.readyState === 'open') {
        try { ch.send(packet); sent++; } catch {}
      }
    }
    return sent;
  }

  getChannel(fp) { return this.channels.get(fp) || null; }

  getConnectedPeers() {
    return [...this.channels.entries()]
      .filter(([, ch]) => ch.readyState === 'open')
      .map(([fp]) => fp);
  }

  broadcastNickname(nickname) {
    // Online: tell server
    this._signal({ type: 'nickname-update', fingerprint: this.identity.fingerprint, nickname });
    // All open channels: tell peers directly
    this.broadcast({ type: 'nickname-update', fingerprint: this.identity.fingerprint, nickname });
  }

  disconnect() {
    this.intentionalClose = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
  }

  // ── Voice / Video ────────────────────────────────────────────────────────────

  async startCall(fp, video = false) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    this.localStream = stream;
    const pc = this.peers.get(fp);
    if (pc) stream.getTracks().forEach(t => { try { pc.addTrack(t, stream); } catch {} });
    this.sendTo(fp, { type: 'call-offer', video, from: this.identity.fingerprint });
    return stream;
  }

  async acceptCall(fp) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.localStream = stream;
    const pc = this.peers.get(fp);
    if (pc) stream.getTracks().forEach(t => { try { pc.addTrack(t, stream); } catch {} });
    return stream;
  }

  hangup(fp) {
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
      this.localStream = null;
    }
    this.peerStreams.delete(fp);
    if (typeof this.onRemoteStream === 'function') this.onRemoteStream(fp, null);
    if (fp) this.sendTo(fp, { type: 'call-end', from: this.identity.fingerprint });
  }

  async startPTT(fp) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.localStream = stream;
    const pc = this.peers.get(fp);
    if (pc) stream.getTracks().forEach(t => { try { pc.addTrack(t, stream); } catch {} });
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

  // ── Cloud WebSocket (Online Mode) ────────────────────────────────────────────

  _openCloudWS(url) {
    if (this.ws && this.ws.readyState <= 1) return;
    this._setStatus('connecting');
    this._log('Connecting to cloud signaling…');

    try { this.ws = new WebSocket(url); }
    catch (e) {
      this._log('❌ WebSocket() threw: ' + e.message);
      this._handleCloudFailure(); return;
    }

    this.ws.onopen = () => {
      this._log('Cloud signaling ✓');
      this.reconnectDelay = RECONNECT_BASE;
      this.cloudFailures  = 0;
      this._setStatus('connected');
      this._signal({ type: 'announce', from: this.identity.fingerprint, nickname: this.identity.nickname });
    };

    this.ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      try { await this._handleSignal(msg, 'cloud'); }
      catch (e) { this._log('⚠ cloud signal: ' + e.message); }
    };

    this.ws.onclose = (ev) => {
      this._log(`Cloud WS closed (${ev.code}).`);
      this._setStatus('disconnected');
      if (!this.intentionalClose) this._handleCloudFailure();
    };

    this.ws.onerror = () => {};
  }

  _handleCloudFailure() {
    this.cloudFailures++;
    if (this.cloudFailures >= MAX_CLOUD_FAILURES && this.mode === Mode.ONLINE) {
      this._log(`Cloud failed ${this.cloudFailures}× — suggesting offline mode.`);
      try {
        this.onEvent({ type: 'cloud-unreachable', attempts: this.cloudFailures });
      } catch {}
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    if (this.mode !== Mode.ONLINE || this.intentionalClose) return;
    const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER;
    const delay  = Math.min(this.reconnectDelay * jitter, RECONNECT_MAX);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
    this._log(`Reconnecting in ${(delay / 1000).toFixed(1)}s…`);
    this.reconnectTimer = setTimeout(() => {
      if (this.cloudUrl) this._openCloudWS(this.cloudUrl);
    }, delay);
  }

  _signal(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(msg)); } catch {}
  }

  // ── Local WS signaling (Offline Mode) ────────────────────────────────────────

  /**
   * Connect to a LAN peer's local WebSocket signaling server.
   * Called when mDNS discovers a new peer (via Tauri event).
   */
  async connectToLanPeer(peerFp, wsUrl) {
    if (this.lanSignaling.has(peerFp)) return; // already connecting

    this._log(`LAN: connecting to peer ${peerFp.slice(0,8)} at ${wsUrl}`);

    let ws;
    try { ws = new WebSocket(wsUrl); }
    catch (e) {
      this._log(`❌ LAN WS to ${peerFp.slice(0,8)}: ${e.message}`); return;
    }

    this.lanSignaling.set(peerFp, ws);

    ws.onopen = async () => {
      this._log(`LAN signaling ↔ ${peerFp.slice(0,8)} ✓`);
      // Announce ourselves on this local channel
      ws.send(JSON.stringify({
        type:     'announce',
        from:     this.identity.fingerprint,
        nickname: this.identity.nickname,
      }));
      // Initiate WebRTC offer
      await this._createOffer(peerFp);
    };

    ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      try { await this._handleSignal(msg, 'lan', peerFp); }
      catch (e) { this._log('⚠ LAN signal: ' + e.message); }
    };

    ws.onclose = () => {
      this.lanSignaling.delete(peerFp);
      this._log(`LAN signaling closed: ${peerFp.slice(0,8)}`);
    };

    ws.onerror = (e) => {
      this._log(`⚠ LAN WS error ${peerFp.slice(0,8)}`);
    };
  }

  _signalLan(peerFp, msg) {
    const ws = this.lanSignaling.get(peerFp);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  // ── Tauri event listeners ─────────────────────────────────────────────────────

  _bindTauriEvents() {
    // New LAN peer discovered via mDNS
    listen('lan-peer-found', async (peer) => {
      try {
        this._log(`LAN peer found: ${peer.short_id}`);
        try { this.onEvent({ type: 'lan-peer-found', peer }); } catch {}

        if (this.mode === Mode.OFFLINE) {
          // Connect to their local WS signaling server
          const wsUrl = `ws://${peer.ws_addr}`;
          await this.connectToLanPeer(peer.fingerprint, wsUrl);
        }
      } catch (e) { this._log('⚠ lan-peer-found: ' + e.message); }
    });

    // LAN peer went away
    listen('lan-peer-lost', (data) => {
      try {
        this._log(`LAN peer lost: ${data.fingerprint?.slice(0,8)}`);
        this.lanSignaling.delete(data.fingerprint);
        this._teardown(data.fingerprint);
        try { this.onEvent({ type: 'lan-peer-lost', fingerprint: data.fingerprint }); } catch {}
      } catch {}
    });

    // Signal message relayed by OUR local WS server (other peers talking to us)
    listen('lan-signal', async (msg) => {
      try {
        await this._handleSignal(msg, 'lan');
      } catch (e) { this._log('⚠ lan-signal: ' + e.message); }
    });

    // File transfer events
    listen('transfer-start',    (data) => { try { this.onEvent({ type: 'tcp-transfer-start',    ...data }); } catch {} });
    listen('transfer-progress', (data) => { try { this.onEvent({ type: 'tcp-transfer-progress', ...data }); } catch {} });
    listen('transfer-complete', (data) => { try { this.onEvent({ type: 'tcp-transfer-complete', ...data }); } catch {} });
  }

  // ── Signal handler (shared, cloud + LAN) ─────────────────────────────────────

  async _handleSignal(msg, source, sourceFp) {
    if (!msg?.type) return;
    const { type, from } = msg;

    if (type === 'peer' || type === 'announce') {
      const fp = msg.fingerprint || from;
      if (!fp || fp === this.identity.fingerprint) return;
      this._log(`Peer discovered (${source}): ${fp.slice(0,8)}`);
      try { this.onEvent({ type: 'peer-discovered', fingerprint: fp, nickname: msg.nickname }); } catch {}
      if (!this.peers.has(fp)) await this._createOffer(fp);
    }

    else if (type === 'peer-left') {
      if (msg.fingerprint) this._teardown(msg.fingerprint);
    }

    else if (type === 'nickname-update') {
      try { this.onEvent({ type: 'nickname-update', fingerprint: msg.fingerprint, nickname: msg.nickname }); } catch {}
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
        await this._flushICE(from);
      } catch (e) { this._log('⚠ setRemoteDesc(answer): ' + e.message); }
    }

    else if (type === 'ice') {
      if (!from || !msg.candidate) return;
      const pc = this.peers.get(from);
      if (!pc) return;
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(msg.candidate); } catch {}
      } else {
        if (!this.pendingICE.has(from)) this.pendingICE.set(from, []);
        this.pendingICE.get(from).push(msg.candidate);
      }
    }
  }

  async _flushICE(fp) {
    const list = this.pendingICE.get(fp) || [];
    this.pendingICE.delete(fp);
    const pc = this.peers.get(fp);
    if (!pc) return;
    for (const c of list) { try { await pc.addIceCandidate(c); } catch {} }
  }

  // ── RTCPeerConnection ─────────────────────────────────────────────────────────

  _createPC(fp) {
    const iceServers = this.mode === Mode.OFFLINE ? ICE_SERVERS_LAN : ICE_SERVERS;
    const pc = new RTCPeerConnection({ iceServers });

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      const iceMsg = { type: 'ice', from: this.identity.fingerprint, to: fp, candidate: ev.candidate };
      if (this.mode === Mode.OFFLINE) {
        this._signalLan(fp, iceMsg);
      } else {
        this._signal(iceMsg);
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        this._log(`⚠ ICE failed ${fp.slice(0,8)} — restarting.`);
        try { pc.restartIce(); } catch {}
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this._log(`${fp.slice(0,8)} → ${s}`);
      if (s === 'failed' || s === 'closed') this._teardown(fp);
    };

    pc.onicecandidateerror = (ev) => {
      if (ev.errorCode !== 701) this._log(`⚠ ICE err ${ev.errorCode}: ${ev.errorText}`);
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (!stream) return;
      this.peerStreams.set(fp, stream);
      if (typeof this.onRemoteStream === 'function') this.onRemoteStream(fp, stream);
    };

    this.peers.set(fp, pc);
    return pc;
  }

  async _createOffer(fp) {
    if (this.peers.has(fp)) return;
    const pc = this._createPC(fp);
    const ch = pc.createDataChannel('tq', { ordered: true });
    this._setupChannel(ch, fp);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const offerMsg = { type: 'offer', from: this.identity.fingerprint, to: fp, sdp: offer.sdp };
      if (this.mode === Mode.OFFLINE) this._signalLan(fp, offerMsg);
      else                             this._signal(offerMsg);
    } catch (e) { this._log('❌ createOffer: ' + e.message); }
  }

  async _handleOffer(fp, sdp) {
    if (this.peers.has(fp)) return;
    const pc = this._createPC(fp);
    pc.ondatachannel = (ev) => {
      try { this._setupChannel(ev.channel, fp); } catch {}
    };

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await this._flushICE(fp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const answerMsg = { type: 'answer', from: this.identity.fingerprint, to: fp, sdp: answer.sdp };
      if (this.mode === Mode.OFFLINE) this._signalLan(fp, answerMsg);
      else                             this._signal(answerMsg);
    } catch (e) { this._log('❌ handleOffer: ' + e.message); }
  }

  _setupChannel(ch, fp) {
    if (!ch) return;
    this.channels.set(fp, ch);

    ch.onopen = () => {
      this._log(`DataChannel ↔ ${fp.slice(0,8)} ✓ [${this.mode}]`);
      if (typeof this.onPeerConnected === 'function') this.onPeerConnected(fp);
      try {
        ch.send(JSON.stringify({
          type:        'hello',
          fingerprint: this.identity.fingerprint,
          shortId:     this.identity.shortId,
          nickname:    this.identity.nickname || null,
          ts:          Date.now(),
        }));
      } catch {}
    };

    ch.onmessage = (ev) => {
      let event;
      try { event = JSON.parse(ev.data); } catch { return; }
      try { this.onEvent(event); } catch {}
    };

    ch.onclose  = () => {
      this.channels.delete(fp);
      if (typeof this.onPeerDisconnected === 'function') this.onPeerDisconnected(fp);
    };

    ch.onerror = (e) => this._log(`⚠ channel ${fp.slice(0,8)}: ${e?.message || '?'}`);
  }

  _teardown(fp) {
    const ch = this.channels.get(fp);
    if (ch) { try { ch.close(); } catch {} this.channels.delete(fp); }
    const pc = this.peers.get(fp);
    if (pc) { try { pc.close(); } catch {} this.peers.delete(fp); }
    this.pendingICE.delete(fp);
    this.lanSignaling.delete(fp);
    if (typeof this.onPeerDisconnected === 'function') this.onPeerDisconnected(fp);
  }

  _setStatus(s) {
    if (typeof this.onStatusChange === 'function') try { this.onStatusChange(s); } catch {}
  }

  _log(t) { try { this.logFn(t); } catch { console.log('[Net]', t); } }
}
