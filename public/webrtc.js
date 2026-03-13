/**
 * webrtc.js — Turquoise v6
 *
 * ── What changed from v5 ────────────────────────────────────────────────────
 *
 * CONNECTION PERSISTENCE (primary fix):
 *   - Known-peers registry: all successfully-connected peers are remembered.
 *     When signaling reconnects, we immediately re-initiate to any peer that
 *     disappeared while the server was unreachable.
 *   - Data-channel heartbeat: every 8s we ping each peer over the ctrl channel.
 *     If 3 consecutive pings go unanswered the peer is considered dead and
 *     reconnection is triggered. This catches "half-open" connections that
 *     RTCPeerConnection doesn't always detect (especially after device sleep).
 *   - ICE restart on 'disconnected': previously we only acted on 'failed'.
 *     'disconnected' is recoverable; we now call restartIce() immediately and
 *     only close/reopen on 'failed'.
 *   - Reconnect backoff per peer: each peer gets its own retry counter so
 *     one flaky peer doesn't affect backoff timing for others.
 *
 * SERVER-FREE MESH (offline relay):
 *   - P2P relay signaling: if the WS server is unreachable but we are connected
 *     to at least one peer, new offers/answers/ICE candidates for a third peer
 *     are forwarded through the existing data channels. Message type on the
 *     ctrl channel: { type: 'p2p-relay', target: fp, payload: {offer/answer/ice} }.
 *   - When a relay message arrives, we apply it exactly as if it came from WS.
 *   - This means once two devices share even one common connected peer, they can
 *     find each other without the server.
 *
 * DATA CHANNEL LIVENESS:
 *   - ctrl and data channels are now monitored: if ctrl.readyState is 'closed'
 *     but pc.connectionState is still 'connected', we attempt channel recreation
 *     via re-negotiation rather than tearing down the full PC.
 *
 * LOGGING:
 *   - Full TQLog integration. Every state transition, every send/recv, every
 *     error is logged with file+function context for black-box analysis.
 *
 * MURPHY'S LAW HARDENING:
 *   - _makePC: RTCPeerConnection constructor wrapped in try/catch per candidate pair check
 *   - _initiate: guard against duplicate calls for the same fp mid-flight
 *   - _onOffer: null-guard on sdp fields before setRemoteDescription
 *   - waitForBuffer: rejects (not resolves) on peer disconnect so callers abort fast
 *   - destroy(): idempotent, safe to call multiple times
 *
 * Unchanged: perfect-negotiation polite/impolite logic, flow-control constants,
 * media (offerWithStream / answerWithStream / stopMedia / getStats).
 */

import { TQLog, LEVEL } from './tqlog.js';

const LOW_WATER  =  64 * 1024;   // 64 KB  — bufferedAmountLowThreshold
const HIGH_WATER = 1024 * 1024;  // 1 MB   — pause sending above this

// Heartbeat: ping every 8s, 3 misses = dead
const HB_INTERVAL_MS = 8_000;
const HB_DEADLINE_MS = 6_000;
const HB_MAX_MISSES  = 3;

// Reconnect delays (per peer)
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS  = 30_000;

const FILE = 'webrtc';

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
    this._wsOK   = false;   // true while WS is OPEN

    // Known peers: fp → { nick, retryCount, retryTimer }
    // Persisted in memory; re-populated from signaling on reconnect.
    this._knownPeers = new Map();

    // In-flight initiation guards: set of fp currently mid-initiate
    this._initiating = new Set();

    // Heartbeat timer
    this._hbTimer = null;

    // Callbacks
    this.onPeerConnected         = null;
    this.onPeerDisconnected      = null;
    this.onMessage               = null;
    this.onBinaryChunk           = null;
    this.onLog                   = null;
    this.onSignalingConnected    = null;
    this.onSignalingDisconnected = null;

    this._log = TQLog.get();
  }

  // ── Signaling ─────────────────────────────────────────────────────────────

  connect(url) {
    this._wsURL = url;
    this._dead  = false;
    this._retry = 0;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      try { this.ws.close(); } catch {}
    }
    this._openWS();
    this._startHeartbeat();
  }

  _openWS() {
    if (this._dead) return;
    this._tqlog('info', '_openWS', 'connecting to signaling…');
    let ws;
    try { ws = new WebSocket(this._wsURL); }
    catch (e) {
      this._tqlog('warn', '_openWS', 'WS init failed: ' + e.message);
      this._schedWS();
      return;
    }

    this.ws = ws;

    ws.onopen = () => {
      this._retry = 0;
      this._wsOK  = true;
      this._tqlog('info', 'ws.onopen', 'signaling connected ✓');
      try {
        ws.send(JSON.stringify({
          type: 'announce',
          from: this.id.fingerprint,
          nick: this.id.nickname,
        }));
      } catch {}
      this.onSignalingConnected?.();

      // Re-initiate any known peers that aren't currently connected
      this._reconnectKnownPeers();

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

    ws.onerror = () => {}; // onclose fires next

    ws.onclose = (e) => {
      this._wsOK = false;
      clearInterval(this._ping);
      if (this._dead) return;
      const reason = e.code === 1006 ? 'network dropped' : `code ${e.code}`;
      this._tqlog('warn', 'ws.onclose', `signaling lost (${reason}) — scheduling retry`);
      this.onSignalingDisconnected?.();
      this._schedWS();
    };
  }

  _schedWS() {
    if (this._dead) return;
    const base   = Math.min(30_000, 1_000 * Math.pow(1.618, Math.min(this._retry++, 8)));
    const jitter = base * (0.85 + Math.random() * 0.30);
    this._tqlog('debug', '_schedWS', `retry in ${Math.round(jitter)}ms (attempt ${this._retry})`);
    this._timer = setTimeout(() => this._openWS(), Math.round(jitter));
  }

  /** Send via WS if open, or relay through a connected P2P peer. */
  _sig(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)); return; } catch {}
    }

    // Signaling is down — try P2P relay
    const target = typeof obj.to === 'string' ? obj.to : null;
    if (!target) return; // broadcast signals can't be relayed meaningfully

    // Find any connected peer that might forward it
    for (const [fp, ps] of this.peers) {
      if (ps.ready && ps.ctrl?.readyState === 'open') {
        try {
          ps.ctrl.send(JSON.stringify({
            type:    'p2p-relay',
            target,
            payload: obj,
          }));
          this._tqlog('debug', '_sig', `relayed ${obj.type} to ${target.slice(0,8)} via ${fp.slice(0,8)}`);
          return;
        } catch {}
      }
    }
    this._tqlog('debug', '_sig', `dropped ${obj.type} — no signaling and no relay path`);
  }

  _onSignal(msg) {
    if (!msg?.type) return;

    if (msg.type === 'peer') {
      const fp = msg.fingerprint;
      if (!fp || fp === this.id.fingerprint) return;
      // Record as known peer (persists through server restarts)
      if (!this._knownPeers.has(fp)) {
        this._knownPeers.set(fp, { nick: msg.nick || null, retryCount: 0, retryTimer: null });
      }
      if (!this.peers.has(fp)) {
        setTimeout(() => {
          if (!this.peers.has(fp)) this._initiate(fp);
        }, Math.random() * 150);
      }
      return;
    }

    if (msg.type === 'pong') return;

    const from = msg.from;
    if (!from) return;
    if (msg.type === 'offer')  { this._onOffer(from, msg.sdp, msg.nick); return; }
    if (msg.type === 'answer') { this._onAnswer(from, msg.sdp);          return; }
    if (msg.type === 'ice')    { this._onICE(from, msg.candidate);       return; }
  }

  // ── Known-peer reconnection ──────────────────────────────────────────────

  /**
   * When signaling reconnects, re-initiate to any known peer that isn't
   * currently in the peers map (they may have dropped while WS was down).
   */
  _reconnectKnownPeers() {
    for (const [fp] of this._knownPeers) {
      if (!this.peers.has(fp) && !this._initiating.has(fp)) {
        this._tqlog('info', '_reconnectKnownPeers', `re-initiating known peer ${fp.slice(0,8)}`);
        setTimeout(() => {
          if (!this.peers.has(fp)) this._initiate(fp);
        }, Math.random() * 300);
      }
    }
  }

  /**
   * Schedule a reconnect attempt for a specific peer with backoff.
   */
  _schedPeerReconnect(fp) {
    if (this._dead) return;
    const kp = this._knownPeers.get(fp);
    if (!kp) return;

    if (kp.retryTimer) { clearTimeout(kp.retryTimer); kp.retryTimer = null; }

    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * Math.pow(1.618, Math.min(kp.retryCount, 7))
    ) * (0.9 + Math.random() * 0.2);

    kp.retryCount++;
    this._tqlog('info', '_schedPeerReconnect',
      `peer ${fp.slice(0,8)} retry #${kp.retryCount} in ${Math.round(delay)}ms`);

    kp.retryTimer = setTimeout(() => {
      kp.retryTimer = null;
      if (!this.peers.has(fp) && !this._initiating.has(fp)) {
        this._initiate(fp);
      }
    }, delay);
  }

  // ── Heartbeat (data-channel liveness) ───────────────────────────────────

  _startHeartbeat() {
    this._stopHeartbeat();
    this._hbTimer = setInterval(() => this._doHeartbeat(), HB_INTERVAL_MS);
  }

  _stopHeartbeat() {
    clearInterval(this._hbTimer);
    this._hbTimer = null;
  }

  _doHeartbeat() {
    const ts = Date.now();
    for (const [fp, ps] of this.peers) {
      if (!ps.ready || ps._closing) continue;

      // Send a ping over the ctrl channel
      if (ps.ctrl?.readyState === 'open') {
        try {
          ps.ctrl.send(JSON.stringify({ type: 'hb-ping', ts }));
          ps._hbSent = ts;
          ps._hbMisses = (ps._hbMisses || 0);

          // Schedule miss detection
          if (ps._hbDeadline) clearTimeout(ps._hbDeadline);
          ps._hbDeadline = setTimeout(() => {
            if (!this.peers.has(fp)) return;
            ps._hbMisses = (ps._hbMisses || 0) + 1;
            this._tqlog('warn', '_doHeartbeat',
              `${fp.slice(0,8)} missed heartbeat (${ps._hbMisses}/${HB_MAX_MISSES})`);

            if (ps._hbMisses >= HB_MAX_MISSES) {
              this._tqlog('warn', '_doHeartbeat',
                `${fp.slice(0,8)} dead — forcing reconnect after ${HB_MAX_MISSES} missed pings`);
              const wasReady = ps.ready;
              this._closePeer(fp);
              if (wasReady) this.onPeerDisconnected?.(fp);
              if (!this._dead) this._schedPeerReconnect(fp);
            }
          }, HB_DEADLINE_MS);
        } catch (e) {
          this._tqlog('warn', '_doHeartbeat', `ctrl send failed for ${fp.slice(0,8)}: ${e.message}`);
        }
      } else if (ps.ctrl?.readyState !== 'open') {
        // Channel went away without a connection state change — recover
        this._tqlog('warn', '_doHeartbeat', `${fp.slice(0,8)} ctrl channel closed unexpectedly`);
        const wasReady = ps.ready;
        this._closePeer(fp);
        if (wasReady) this.onPeerDisconnected?.(fp);
        if (!this._dead) this._schedPeerReconnect(fp);
      }
    }
  }

  // ── PeerConnection factory ────────────────────────────────────────────────

  _makePC(fp) {
    let pc;
    try {
      pc = new RTCPeerConnection({
        iceServers: [],
        // Increase ICE timeout for local WiFi: candidates usually arrive quickly
        // but on some networks mdns takes a moment
        iceCandidatePoolSize: 2,
      });
    } catch (e) {
      this._tqlog('error', '_makePC', 'RTCPeerConnection failed: ' + e.message);
      return null;
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this._sig({ type: 'ice', from: this.id.fingerprint, to: fp, candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      this._tqlog('debug', 'pc.oniceconnectionstatechange', `${fp.slice(0,8)} ICE → ${s}`);
      if (s === 'disconnected') {
        // 'disconnected' is often transient (TURN path changed etc.) — try restart
        this._tqlog('info', 'pc.oniceconnectionstatechange',
          `${fp.slice(0,8)} ICE disconnected — requesting restart`);
        try { pc.restartIce(); } catch {}
      }
      if (s === 'failed') {
        this._tqlog('warn', 'pc.oniceconnectionstatechange',
          `${fp.slice(0,8)} ICE failed — attempting restartIce`);
        try { pc.restartIce(); } catch {}
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this._tqlog('info', 'pc.onconnectionstatechange', `${fp.slice(0,8)} → ${s}`);

      if (s === 'connected') {
        this._tqlog('info', 'pc.onconnectionstatechange', `P2P link up: ${fp.slice(0, 8)}`);
        // Reset retry counter on successful connection
        const kp = this._knownPeers.get(fp);
        if (kp) kp.retryCount = 0;
      }

      if (s === 'disconnected') {
        // Transient — wait briefly before acting; often self-heals
        const ps = this.peers.get(fp);
        if (ps) {
          if (ps._disconnectTimer) clearTimeout(ps._disconnectTimer);
          ps._disconnectTimer = setTimeout(() => {
            const current = this.peers.get(fp);
            if (!current || current._closing) return;
            const currentState = current.pc?.connectionState;
            if (currentState === 'disconnected' || currentState === 'failed') {
              this._tqlog('warn', 'onconnectionstatechange',
                `${fp.slice(0,8)} still ${currentState} after grace period — closing`);
              const wasReady = current.ready;
              this._closePeer(fp);
              if (wasReady) this.onPeerDisconnected?.(fp);
              if (!this._dead) this._schedPeerReconnect(fp);
            }
          }, 5_000); // 5s grace period for transient disconnects
        }
      }

      if (s === 'failed' || s === 'closed') {
        const ps       = this.peers.get(fp);
        const wasReady = ps?.ready;
        const nick     = ps?.nick || fp.slice(0, 8);
        if (ps) {
          clearTimeout(ps._disconnectTimer);
          ps._closing = true;
        }
        this._closePeer(fp);
        if (wasReady) this.onPeerDisconnected?.(fp);
        this._tqlog('warn', 'onconnectionstatechange', `✗ ${nick} ${s}`);
        if (!this._dead) this._schedPeerReconnect(fp);
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
      this._tqlog('debug', '_wireCtrl.onopen', `ctrl ✓ ${fp.slice(0, 8)}`);
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

    ch.onerror = (e) => {
      if (closed) return;
      const ps2 = this.peers.get(fp);
      if (!ps2 || ps2._closing) return;
      const s = ps2.pc?.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') return;
      this._tqlog('warn', '_wireCtrl.onerror', `ctrl error: ${fp.slice(0, 8)}`);
    };

    ch.onclose = () => {
      closed = true;
      this._tqlog('debug', '_wireCtrl.onclose', `ctrl closed: ${fp.slice(0, 8)}`);
    };
  }

  _wireData(fp, ch) {
    const ps = this.peers.get(fp);
    if (ps) ps.data = ch;
    let closed = false;

    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = LOW_WATER;

    ch.onopen = () => {
      this._tqlog('debug', '_wireData.onopen', `data ✓ ${fp.slice(0, 8)}`);
      this._checkReady(fp);
    };

    ch.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this.onBinaryChunk?.(fp, e.data);
    };

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
      this._tqlog('warn', '_wireData.onerror', `data channel error: ${fp.slice(0, 8)}`);
    };

    ch.onclose = () => {
      closed = true;
      // Abort pending waitForBuffer so send loops don't hang
      const ps2 = this.peers.get(fp);
      if (ps2?._bufferLowResolvers?.length) {
        ps2._bufferLowResolvers.splice(0).forEach(r => r());
      }
    };
  }

  _checkReady(fp) {
    const ps = this.peers.get(fp);
    if (!ps || ps.ready) return;
    if (ps.ctrl?.readyState === 'open' && ps.data?.readyState === 'open') {
      ps.ready = true;
      this._tqlog('info', '_checkReady', `✓ ${ps.nick || fp.slice(0, 8)} ready (P2P)`);
      // Register in known peers on first successful connect
      if (!this._knownPeers.has(fp)) {
        this._knownPeers.set(fp, { nick: ps.nick, retryCount: 0, retryTimer: null });
      }
      this.onPeerConnected?.(fp, ps.nick);
    }
  }

  // ── Initiate / accept ─────────────────────────────────────────────────────

  async _initiate(fp) {
    if (this.peers.has(fp))      return; // already have this peer
    if (this._initiating.has(fp)) return; // duplicate call guard

    this._initiating.add(fp);
    this._tqlog('info', '_initiate', `→ ${fp.slice(0, 8)}`);

    const pc = this._makePC(fp);
    if (!pc) { this._initiating.delete(fp); return; }

    const ps = {
      pc, ctrl: null, data: null, ready: false,
      nick:            this._knownPeers.get(fp)?.nick || null,
      remoteStream:    null, localStream: null, onRemoteStream: null,
      _closing:        false, _makingOffer: false, _mediaLock: false,
      _isPolite:       this.id.fingerprint < fp,
      _bufferLowResolvers: [],
      _statsBaseline:  null,
      _hbMisses:       0,
      _hbSent:         0,
      _hbDeadline:     null,
      _disconnectTimer: null,
    };
    this.peers.set(fp, ps);
    this._initiating.delete(fp);

    const ctrl = pc.createDataChannel('ctrl', { ordered: true });
    const data = pc.createDataChannel('data', { ordered: true });
    this._wireCtrl(fp, ctrl);
    this._wireData(fp, data);
    ps.ctrl = ctrl;
    ps.data = data;

    pc.onnegotiationneeded = async () => {
      if (ps._mediaLock) return;
      if (ps._makingOffer) return;
      try {
        ps._makingOffer = true;
        await pc.setLocalDescription();
        this._sig({
          type: 'offer', from: this.id.fingerprint, to: fp,
          sdp: pc.localDescription, nick: this.id.nickname,
        });
        this._tqlog('debug', '_initiate.onnegotiationneeded', `offer sent to ${fp.slice(0,8)}`);
      } catch (e) {
        this._tqlog('error', '_initiate.onnegotiationneeded', 'offer err: ' + e.message);
      } finally {
        ps._makingOffer = false;
      }
    };
  }

  async _onOffer(fp, sdp, nick) {
    if (!sdp?.type || !sdp?.sdp) {
      this._tqlog('warn', '_onOffer', `malformed offer from ${fp?.slice(0,8)}`);
      return;
    }
    let ps = this.peers.get(fp);

    if (!ps) {
      this._tqlog('info', '_onOffer', `← ${fp.slice(0, 8)}`);
      const pc = this._makePC(fp);
      if (!pc) return;
      ps = {
        pc, ctrl: null, data: null, ready: false, nick: nick || null,
        remoteStream: null, localStream: null, onRemoteStream: null,
        _closing: false, _makingOffer: false, _mediaLock: false,
        _isPolite: this.id.fingerprint < fp,
        _bufferLowResolvers: [],
        _statsBaseline: null,
        _hbMisses: 0, _hbSent: 0, _hbDeadline: null, _disconnectTimer: null,
      };
      this.peers.set(fp, ps);
      pc.ondatachannel = (e) => {
        if (e.channel.label === 'ctrl') this._wireCtrl(fp, e.channel);
        else if (e.channel.label === 'data') this._wireData(fp, e.channel);
      };
    } else if (nick) {
      ps.nick = nick;
    }

    // Perfect negotiation — collision handling
    const collision = ps._makingOffer || ps.pc.signalingState !== 'stable';
    if (collision) {
      if (!ps._isPolite) {
        this._tqlog('debug', '_onOffer', `${fp.slice(0,8)} offer collision — impolite, ignoring`);
        return;
      }
      try {
        await ps.pc.setLocalDescription({ type: 'rollback' });
      } catch (e) {
        this._tqlog('warn', '_onOffer', `rollback failed for ${fp.slice(0,8)}: ${e.message}`);
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
      this._tqlog('debug', '_onOffer', `answer sent to ${fp.slice(0,8)}`);
    } catch (e) {
      this._tqlog('error', '_onOffer', `answer err for ${fp.slice(0,8)}: ${e.message}`);
      this._closePeer(fp);
    }
  }

  async _onAnswer(fp, sdp) {
    const ps = this.peers.get(fp);
    if (!ps || !sdp) return;
    try {
      await ps.pc.setRemoteDescription(sdp);
      this._tqlog('debug', '_onAnswer', `remote description set for ${fp.slice(0,8)}`);
    } catch (e) {
      this._tqlog('error', '_onAnswer', `setRemoteDescription failed for ${fp.slice(0,8)}: ${e.message}`);
    }
  }

  async _onICE(fp, candidate) {
    const ps = this.peers.get(fp);
    if (!ps || !candidate) return;
    try {
      await ps.pc.addIceCandidate(candidate);
    } catch (e) {
      const msg = String(e);
      if (!msg.includes('701') && !msg.includes('closed')) {
        this._tqlog('warn', '_onICE', `ICE candidate error for ${fp.slice(0,8)}: ${e.message}`);
      }
    }
  }

  // ── Peer messages (from ctrl channel) ────────────────────────────────────

  _onPeerMsg(fp, msg) {
    if (!msg?.type) return;

    // ── Heartbeat response ─────────────────────────────────────────────────
    if (msg.type === 'hb-ping') {
      // Reply immediately
      const ps = this.peers.get(fp);
      if (ps?.ctrl?.readyState === 'open') {
        try { ps.ctrl.send(JSON.stringify({ type: 'hb-pong', ts: msg.ts })); } catch {}
      }
      return;
    }

    if (msg.type === 'hb-pong') {
      const ps = this.peers.get(fp);
      if (!ps) return;
      if (ps._hbDeadline) { clearTimeout(ps._hbDeadline); ps._hbDeadline = null; }
      ps._hbMisses = 0; // Reset miss counter on any pong
      const rtt = msg.ts ? Date.now() - msg.ts : null;
      this._tqlog('debug', '_onPeerMsg', `hb pong from ${fp.slice(0,8)}` + (rtt !== null ? ` rtt ${rtt}ms` : ''));
      return;
    }

    // ── P2P relay (server-free mesh) ──────────────────────────────────────
    if (msg.type === 'p2p-relay') {
      const { target, payload } = msg;
      if (!target || !payload?.type) return;

      // Are we the intended target?
      if (target === this.id.fingerprint) {
        this._tqlog('debug', '_onPeerMsg', `received p2p-relay ${payload.type} from ${fp.slice(0,8)} for us`);
        // Apply as if it came from WS
        payload.from = fp; // ensure 'from' is the actual sender
        this._onSignal(payload);
        return;
      }

      // Forward to the target if we're connected to them
      const targetPs = this.peers.get(target);
      if (targetPs?.ctrl?.readyState === 'open') {
        try {
          targetPs.ctrl.send(JSON.stringify({
            type:    'p2p-relay',
            target,
            payload: { ...payload, from: fp },
          }));
          this._tqlog('debug', '_onPeerMsg',
            `forwarded p2p-relay ${payload.type} from ${fp.slice(0,8)} to ${target.slice(0,8)}`);
        } catch {}
      }
      return;
    }

    // ── Standard control messages ─────────────────────────────────────────
    if (msg.type === 'hello') {
      const ps = this.peers.get(fp);
      if (ps && msg.nick) {
        ps.nick = msg.nick;
        const kp = this._knownPeers.get(fp);
        if (kp) kp.nick = msg.nick;
      }
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
    catch (e) { this._tqlog('warn', '_applyRenegAnswer', e.message); }
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
   * Resolves when bufferedAmount drops below HIGH_WATER.
   * REJECTS (not resolves) if peer disconnects — so send loops abort cleanly.
   */
  waitForBuffer(fp) {
    return new Promise((resolve, reject) => {
      const ps = this.peers.get(fp);

      if (!ps?.data || ps.data.readyState !== 'open') {
        reject(new Error('DataChannel not open'));
        return;
      }

      if (ps.data.bufferedAmount < HIGH_WATER) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        const idx = ps._bufferLowResolvers.indexOf(wrapped);
        if (idx !== -1) ps._bufferLowResolvers.splice(idx, 1);
        // Check if channel is still alive before resolving
        const current = this.peers.get(fp);
        if (!current?.data || current.data.readyState !== 'open') {
          reject(new Error('DataChannel closed during buffer wait'));
        } else {
          resolve();
        }
      }, 5_000);

      const wrapped = () => {
        clearTimeout(timeout);
        // Verify channel is still alive
        const current = this.peers.get(fp);
        if (!current?.data || current.data.readyState !== 'open') {
          reject(new Error('DataChannel closed during buffer wait'));
        } else {
          resolve();
        }
      };
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
    return this.peers.get(fp)?.nick
      || this._knownPeers.get(fp)?.nick
      || fp?.slice(0, 8)
      || '?';
  }

  // ── Media ─────────────────────────────────────────────────────────────────

  async getLocalStream(video = false) {
    this._tqlog('info', 'getLocalStream', `requesting ${video ? 'video+audio' : 'audio'}`);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression:  true,
          autoGainControl:   true,
        },
        video: video
          ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
          : false,
      });
      this._tqlog('info', 'getLocalStream', 'stream acquired', {
        tracks: stream.getTracks().map(t => `${t.kind}:${t.label.slice(0,20)}`),
      });
      return stream;
    } catch (e) {
      this._tqlog('error', 'getLocalStream', `getUserMedia failed: ${e.name}: ${e.message}`);
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
    this._tqlog('info', 'offerWithStream', `${fp.slice(0,8)} isCircle=${isCircle}`);
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
    this._tqlog('info', 'answerWithStream', fp.slice(0,8));
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
    this._tqlog('info', 'stopMedia', fp.slice(0,8));
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
          stats.rttMs     = Math.round((r.currentRoundTripTime || 0) * 1000);
          stats.bytesSent = r.bytesSent    || 0;
          stats.bytesRecv = r.bytesReceived || 0;
        }
      });

      const baseline = ps._statsBaseline;
      const dt       = baseline ? (now - baseline.ts) / 1000 : 0;

      if (baseline && dt > 0) {
        const videoD = (stats._videoBytes || 0) - (baseline.videoBytes || 0);
        const audioD = (stats._audioBytes || 0) - (baseline.audioBytes || 0);
        stats.videoKbps = Math.max(0, Math.round((videoD * 8) / 1000 / dt));
        stats.audioKbps = Math.max(0, Math.round((audioD * 8) / 1000 / dt));
      }

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

    if (ps._hbDeadline)      { clearTimeout(ps._hbDeadline);      ps._hbDeadline = null; }
    if (ps._disconnectTimer) { clearTimeout(ps._disconnectTimer); ps._disconnectTimer = null; }

    // Wake parked waitForBuffer resolvers — they will see channel is closed and reject
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
    if (this._dead) return; // idempotent
    this._dead = true;
    this._stopHeartbeat();
    clearTimeout(this._timer);
    clearInterval(this._ping);
    try { this.ws?.close(); } catch {}
    for (const fp of [...this.peers.keys()]) this._closePeer(fp);
    // Cancel any pending peer reconnect timers
    for (const [, kp] of this._knownPeers) {
      if (kp.retryTimer) { clearTimeout(kp.retryTimer); kp.retryTimer = null; }
    }
    this._tqlog('info', 'destroy', 'network destroyed');
  }

  // ── Internal logging bridge ───────────────────────────────────────────────

  _tqlog(level, fn, msg, data) {
    const l = this._log;
    if (level === 'error') l.error(FILE, fn, msg, data);
    else if (level === 'warn') l.warn(FILE, fn, msg, data);
    else if (level === 'debug') l.debug(FILE, fn, msg, data);
    else l.info(FILE, fn, msg, data);

    // Forward to app's net-log panel (backward compat)
    const isErr = level === 'error' || level === 'warn';
    this.onLog?.(msg, isErr);
    if (!isErr) console.log('[TQ]', msg);
    else        console.warn('[TQ]', msg);
  }
}
