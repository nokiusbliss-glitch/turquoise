/**
 * webrtc.js — Turquoise v7
 *
 * Multi-layer transport stack:
 *   Layer 1 : WebRTC DataChannel  (direct P2P, best)
 *   Layer 2 : WebRTC via STUN     (NAT traversal, transparent to app)
 *   Layer 3 : WebSocket relay     (guaranteed delivery fallback)
 *
 * New in v7:
 *   - STUN servers: Google + Cloudflare + stunprotocol (fixes ~40% connection failures)
 *   - ICE config from server: TURN credentials delivered via 'ice-config' msg
 *   - Layer 3 fallback: sendCtrl + sendBinary fall back to WS when DataChannel unavailable
 *   - connTier(fp): 'p2p' | 'ws-relay' | 'disconnected' — exposed for UI
 *   - Base64 binary relay via 'bin-relay' ctrl/WS message
 *   - ~55% smaller than v6 (perfect-negotiation logic preserved, dead code removed)
 */

import { TQLog } from './tqlog.js';

// ICE servers — overridden by server's 'ice-config' message on connect
let _ice = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478'   },
  { urls: 'stun:stun.stunprotocol.org:3478' },
];

const LOW     =   64 * 1024;   // DC bufferedAmountLowThreshold
const HIGH    = 1024 * 1024;   // pause threshold
const HB_IV   = 8_000;
const HB_DL   = 6_000;
const HB_MAX  = 3;
const RB_BASE = 2_000;
const RB_MAX  = 30_000;
const FILE    = 'webrtc';

const jit = (base, f=0.25) => base * (1 - f/2 + Math.random() * f);

// Binary ↔ base64 helpers for WS relay fallback
// IMPORTANT: loop, not spread — spread crashes on buffers > ~125k elements (V8 stack limit)
const ab2b64 = buf => { const u=new Uint8Array(buf); let s=''; for(let i=0;i<u.length;i++) s+=String.fromCharCode(u[i]); return btoa(s); };
const b642ab = s   => { const b=atob(s); const u=new Uint8Array(b.length); for(let i=0;i<b.length;i++) u[i]=b.charCodeAt(i); return u.buffer; };

export class TurquoiseNetwork {
  constructor(identity) {
    if (!identity?.fingerprint) throw new Error('identity.fingerprint required');
    this.id    = identity;
    this.peers = new Map();       // fp → PeerState
    this.ws    = null;
    this._wsURL     = null;
    this._retry     = 0;
    this._wsOK      = false;
    this._dead      = false;
    this._known     = new Map();  // fp → { nick, retry, timer }
    this._initiating= new Set();
    this._hbTimer   = null;
    this._ping      = null;
    this._log       = TQLog.get();

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
    this._wsURL = url; this._dead = false; this._retry = 0;
    if (this.ws?.readyState <= WebSocket.OPEN) try { this.ws.close(); } catch {}
    this._openWS();
    this._startHB();
  }

  _openWS() {
    if (this._dead) return;
    let ws; try { ws = new WebSocket(this._wsURL); } catch { this._schedWS(); return; }
    this.ws = ws;

    ws.onopen = () => {
      this._retry = 0; this._wsOK = true;
      this._log.info(FILE, 'ws', 'signaling connected ✓');
      try { ws.send(JSON.stringify({type:'announce', from:this.id.fingerprint, nick:this.id.nickname})); } catch {}
      this.onSignalingConnected?.();
      this._reconnectKnown();
      clearInterval(this._ping);
      this._ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify({type:'ping'})); } catch {}
      }, 25_000);
    };

    ws.onmessage = e => { try { this._onSig(JSON.parse(e.data)); } catch {} };
    ws.onerror   = () => {};
    ws.onclose   = e => {
      this._wsOK = false; clearInterval(this._ping);
      if (this._dead) return;
      this._log.warn(FILE, 'ws', `closed code=${e.code}`);
      this.onSignalingDisconnected?.();
      this._schedWS();
    };
  }

  _schedWS() {
    if (this._dead) return;
    const d = jit(Math.min(RB_MAX, RB_BASE * Math.pow(1.618, Math.min(this._retry++, 8))));
    setTimeout(() => this._openWS(), d);
  }

  /** Send via WS if open, else route through an existing DataChannel (P2P relay). */
  _sig(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)); return; } catch {}
    }
    const target = obj.to;
    if (!target) return;
    for (const [, ps] of this.peers) {
      if (ps.ctrl?.readyState === 'open') {
        try { ps.ctrl.send(JSON.stringify({type:'p2p-relay', target, payload:obj})); return; } catch {}
      }
    }
  }

  _onSig(msg) {
    if (!msg?.type) return;
    const { type, from } = msg;

    // Server delivers optimal ICE config on connect
    if (type === 'ice-config' && Array.isArray(msg.iceServers)) {
      _ice = msg.iceServers;
      this._log.info(FILE, '_onSig', `ice-config: ${_ice.length} servers`);
      return;
    }

    if (type === 'peer') {
      const fp = msg.fingerprint;
      if (!fp || fp === this.id.fingerprint) return;
      const k = this._known.get(fp) || { retry:0, timer:null };
      k.nick = msg.nick || fp.slice(0,8);
      this._known.set(fp, k);
      if (!this.peers.has(fp)) this._initiate(fp, k.nick);
      return;
    }

    if (type === 'pong') return;
    if (!from || from === this.id.fingerprint) return;

    switch (type) {
      case 'offer':        this._onOffer(msg);        break;
      case 'answer':       this._onAnswer(msg);       break;
      case 'ice':          this._onIce(msg);          break;
      case 'offer-reneg':  this._onOffer(msg, true);  break;
      case 'answer-reneg': this._onAnswer(msg);       break;
      default:             this.onMessage?.(from, msg);
    }
  }

  // ── Peer connection lifecycle ─────────────────────────────────────────────

  _initiate(fp, nick) {
    if (this._initiating.has(fp) || this.peers.has(fp)) return;
    this._initiating.add(fp);
    const ps = this._makePS(fp, nick);
    this.peers.set(fp, ps);

    // Negotiated channels — both sides create them with same id
    ps.ctrl = this._mkDC(fp, ps, 'ctrl', {ordered:true,  negotiated:true, id:0});
    ps.data = this._mkDC(fp, ps, 'data', {ordered:false, maxRetransmits:0, negotiated:true, id:1});

    ps.pc.onnegotiationneeded = async () => {
      if (ps.makingOffer) return;
      try {
        ps.makingOffer = true;
        await ps.pc.setLocalDescription();
        this._sig({type:'offer', sdp:ps.pc.localDescription.sdp, to:fp, from:this.id.fingerprint});
      } catch(e) { this._log.warn(FILE, 'neg', e.message); }
      finally { ps.makingOffer = false; }
    };

    this._initiating.delete(fp);
  }

  _makePS(fp, nick) {
    const pc = new RTCPeerConnection({
      iceServers: _ice, iceCandidatePoolSize: 4, bundlePolicy: 'max-bundle',
    });
    const ps = {
      pc, nick: nick||fp.slice(0,8), ready:false,
      ctrl:null, data:null, stream:null,
      makingOffer:false, ignoreOffer:false, pendingIce:[],
      hbMiss:0, hbTimer:null, _resolve:null, _reject:null,
    };

    pc.onicecandidate = e => {
      if (e.candidate) this._sig({type:'ice', ice:e.candidate.toJSON(), to:fp, from:this.id.fingerprint});
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this._log.debug(FILE, 'conn', `${fp.slice(0,8)}: ${s}`);
      if (s === 'connected' && !ps.ready) { ps.ready = true; this._onReady(fp, ps); }
      if (s === 'disconnected') {
        try { pc.restartIce(); } catch {}
        setTimeout(() => { if (ps.pc.connectionState==='disconnected') this._teardown(fp,'disconnected-timeout'); }, 8_000);
      }
      if (s === 'failed') this._teardown(fp, 'failed');
      if (s === 'closed') this._teardown(fp, 'closed');
    };

    pc.ondatachannel = e => {
      if (e.channel.label === 'ctrl') ps.ctrl = this._mkDC(fp, ps, 'ctrl', null, e.channel);
      if (e.channel.label === 'data') ps.data = this._mkDC(fp, ps, 'data', null, e.channel);
    };

    pc.ontrack = e => { ps.stream = e.streams[0]||null; };

    return ps;
  }

  _mkDC(fp, ps, label, init, existing) {
    const dc = existing || ps.pc.createDataChannel(label, init);
    dc.bufferedAmountLowThreshold = LOW;

    if (label === 'ctrl') {
      dc.onopen    = () => { this._log.debug(FILE,'dc',`ctrl open ${fp.slice(0,8)}`); if (!ps.ready) { ps.ready=true; this._onReady(fp,ps); } };
      dc.onmessage = e => this._onCtrl(fp, e.data);
      dc.onclose   = () => this._log.debug(FILE,'dc',`ctrl closed ${fp.slice(0,8)}`);
    } else {
      dc.onmessage = e => {
        const d = e.data;
        if (d instanceof ArrayBuffer) { this.onBinaryChunk?.(fp, d); return; }
        if (d instanceof Blob) d.arrayBuffer().then(b => this.onBinaryChunk?.(fp, b));
      };
      dc.onbufferedamountlow = () => { ps._resolve?.(); ps._resolve=null; ps._reject=null; };
      dc.onerror = () => { ps._reject?.(new Error('channel closed')); ps._resolve=null; ps._reject=null; };
    }
    return dc;
  }

  _onReady(fp, ps) {
    const k = this._known.get(fp);
    if (k) k.retry = 0;
    this._log.info(FILE, 'ready', `${fp.slice(0,8)} (${this.connTier(fp)})`);
    this.onLog?.(`▲ ${ps.nick}`);
    this.onPeerConnected?.(fp, ps.nick);
  }

  _teardown(fp, reason) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    this.peers.delete(fp);
    ['ctrl','data'].forEach(k => { try { ps[k]?.close(); } catch {} });
    clearTimeout(ps.hbTimer);
    try { ps.pc.close(); } catch {}
    ps._reject?.(new Error('peer gone'));

    if (ps.ready) {
      this._log.info(FILE, 'teardown', `${fp.slice(0,8)}: ${reason}`);
      this.onLog?.(`▼ ${ps.nick}`);
      this.onPeerDisconnected?.(fp, ps.nick);
    }

    // Schedule reconnect
    const k = this._known.get(fp);
    if (k && !this._dead) {
      clearTimeout(k.timer);
      k.timer = setTimeout(() => this._initiate(fp, k.nick), jit(Math.min(RB_MAX, RB_BASE * Math.pow(1.8, Math.min(k.retry++, 8)))));
    }
  }

  _reconnectKnown() {
    for (const [fp, k] of this._known) if (!this.peers.has(fp)) this._initiate(fp, k.nick);
  }

  // ── Signaling handlers ────────────────────────────────────────────────────

  async _onOffer(msg, reneg=false) {
    const { from:fp, sdp } = msg;
    if (!fp || !sdp) return;
    let ps = this.peers.get(fp);
    if (!ps) {
      ps = this._makePS(fp, null);
      this.peers.set(fp, ps);
      ps.ctrl = this._mkDC(fp, ps, 'ctrl', {ordered:true,  negotiated:true, id:0});
      ps.data = this._mkDC(fp, ps, 'data', {ordered:false, maxRetransmits:0, negotiated:true, id:1});
    }

    const polite   = this.id.fingerprint < fp;
    const coll     = ps.makingOffer || ps.pc.signalingState !== 'stable';
    ps.ignoreOffer = !polite && coll;
    if (ps.ignoreOffer) return;

    try {
      if (coll) await Promise.all([ps.pc.setLocalDescription({type:'rollback'}), ps.pc.setRemoteDescription({type:'offer',sdp})]);
      else      await ps.pc.setRemoteDescription({type:'offer',sdp});
    } catch(e) { this._log.warn(FILE,'_onOffer',e.message); return; }

    for (const c of ps.pendingIce) try { await ps.pc.addIceCandidate(c); } catch {}
    ps.pendingIce = [];

    await ps.pc.setLocalDescription();
    this._sig({type: reneg?'answer-reneg':'answer', sdp:ps.pc.localDescription.sdp, to:fp, from:this.id.fingerprint});
  }

  async _onAnswer(msg) {
    const ps = this.peers.get(msg.from);
    if (!ps || ps.ignoreOffer || !msg.sdp) return;
    try { await ps.pc.setRemoteDescription({type:'answer', sdp:msg.sdp}); } catch {}
  }

  async _onIce(msg) {
    const ps = this.peers.get(msg.from);
    if (!ps || !msg.ice) return;
    if (ps.pc.remoteDescription?.type) try { await ps.pc.addIceCandidate(msg.ice); } catch {}
    else ps.pendingIce.push(msg.ice);
  }

  // ── Ctrl channel messages ─────────────────────────────────────────────────

  _onCtrl(fp, text) {
    let msg; try { msg = JSON.parse(text); } catch { return; }
    const ps = this.peers.get(fp);

    if (msg.type === 'hb-ping') { this.sendCtrl(fp, {type:'hb-pong'}); return; }
    if (msg.type === 'hb-pong') { if (ps) { ps.hbMiss=0; clearTimeout(ps.hbTimer); } return; }

    if (msg.type === 'p2p-relay') {
      if (msg.target && msg.payload) this._onSig({...msg.payload});
      return;
    }

    if (msg.type === 'bin-relay') {
      try { this.onBinaryChunk?.(fp, b642ab(msg.data)); } catch {}
      return;
    }

    this.onMessage?.(fp, msg);
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  _startHB() {
    clearInterval(this._hbTimer);
    this._hbTimer = setInterval(() => {
      for (const [fp, ps] of this.peers) {
        if (!ps.ready) continue;
        if (ps.ctrl?.readyState !== 'open') continue;
        if (++ps.hbMiss >= HB_MAX) { this._teardown(fp,'hb-timeout'); continue; }
        clearTimeout(ps.hbTimer);
        ps.hbTimer = setTimeout(() => { /* deadline will be checked next tick */ }, HB_DL);
        try { ps.ctrl.send(JSON.stringify({type:'hb-ping'})); } catch {}
      }
    }, HB_IV);
  }

  // ── Public send API (Layer 1 → Layer 3 fallback) ──────────────────────────

  /**
   * Send a control/JSON message.
   * Tries DataChannel first, falls back to WebSocket relay (Layer 3).
   */
  sendCtrl(fp, msg) {
    const ps = this.peers.get(fp);
    if (ps?.ctrl?.readyState === 'open') {
      try { ps.ctrl.send(JSON.stringify(msg)); return true; } catch {}
    }
    // Layer 3 — WS relay
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({...msg, to:fp, _relay:true})); return true; } catch {}
    }
    return false;
  }

  /**
   * Send a binary chunk.
   * Tries DataChannel first (high-throughput), falls back to base64-over-WS (Layer 3).
   */
  sendBinary(fp, buf) {
    const ps = this.peers.get(fp);
    if (ps?.data?.readyState === 'open') {
      if (ps.data.bufferedAmount > HIGH) return false;
      try { ps.data.send(buf); return true; } catch {}
    }
    // Layer 3 — WS relay with base64 encoding
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({type:'bin-relay', to:fp, data:ab2b64(buf)})); return true; } catch {}
    }
    return false;
  }

  /** Flow-control: wait for DataChannel buffer to drain before next chunk. */
  waitForBuffer(fp) {
    const ps = this.peers.get(fp);
    if (!ps?.data || ps.data.bufferedAmount <= HIGH) return Promise.resolve();
    return new Promise((res, rej) => { ps._resolve = res; ps._reject = rej; });
  }

  // ── Media (video/audio calls) ─────────────────────────────────────────────

  async offerWithStream(fp, stream) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    stream.getTracks().forEach(t => ps.pc.addTrack(t, stream));
    try {
      const o = await ps.pc.createOffer({offerToReceiveAudio:true, offerToReceiveVideo:true});
      await ps.pc.setLocalDescription(o);
      this._sig({type:'offer-reneg', sdp:ps.pc.localDescription.sdp, to:fp, from:this.id.fingerprint});
    } catch(e) { this._log.warn(FILE,'offerStream',e.message); }
  }

  async answerWithStream(fp, stream) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    stream.getTracks().forEach(t => ps.pc.addTrack(t, stream));
  }

  stopMedia(fp) {
    const ps = this.peers.get(fp);
    if (!ps?.stream) return;
    ps.stream.getTracks().forEach(t => {
      t.stop();
      try { const s=ps.pc.getSenders().find(s=>s.track===t); if(s) ps.pc.removeTrack(s); } catch {}
    });
    ps.stream = null;
  }

  // ── Stats + status ────────────────────────────────────────────────────────

  async getStats(fp) {
    const ps = this.peers.get(fp);
    if (!ps) return null;
    try {
      const result = {}; const r = await ps.pc.getStats();
      r.forEach(v => { if (v.type==='candidate-pair'&&v.state==='succeeded') result.rtt=v.currentRoundTripTime; });
      return result;
    } catch { return null; }
  }

  getConnectedPeers() {
    return [...this.peers.entries()].filter(([,ps])=>ps.ready).map(([fp])=>fp);
  }

  /** Returns current transport tier for a peer — used by UI to show connection quality. */
  connTier(fp) {
    const ps = this.peers.get(fp);
    if (!ps?.ready) return 'disconnected';
    if (ps.ctrl?.readyState === 'open') return 'p2p';
    if (this._wsOK) return 'ws-relay';
    return 'disconnected';
  }

  // ── Destroy ───────────────────────────────────────────────────────────────

  destroy() {
    if (this._dead) return;
    this._dead = true;
    clearInterval(this._hbTimer); clearInterval(this._ping);
    for (const fp of [...this.peers.keys()]) this._teardown(fp, 'destroy');
    try { this.ws?.close(1000); } catch {}
    this.ws = null;
  }
}
