/**
 * webrtc.js — Turquoise v7.1
 *
 * Fixes over v7:
 *   - offer-reneg forwarded to onMessage so app.js call handlers fire.
 *     answer-reneg is applied internally as an SDP answer.
 *   - answerWithStream(fp, sdp, stream): now accepts the SDP from the
 *     offer-reneg, sets remote description, adds tracks, sends answer-reneg.
 *     Previously only added tracks with no SDP exchange → call never connected.
 *   - pc.ontrack replaced with addEventListener('track') + ps.onRemoteStream
 *     callback. App uses net.setRemoteStreamHandler(fp, fn) instead of
 *     directly overwriting ps.pc.ontrack (which clobbered the existing handler).
 *   - stopMedia: switched to removing sender tracks directly (was checking
 *     ps.stream which is only set from the remote track event, not local).
 *   - isReady(fp) public helper added so app.js doesn't need to access
 *     internal peers Map directly.
 */

import { TQLog } from './tqlog.js';

let _ice = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478'   },
  { urls: 'stun:stun.stunprotocol.org:3478' },
];

const LOW     =   64 * 1024;
const HIGH    = 1024 * 1024;
const HB_IV   = 8_000;
const HB_DL   = 6_000;
const HB_MAX  = 3;
const RB_BASE = 2_000;
const RB_MAX  = 30_000;
const FILE    = 'webrtc';

const jit = (base, f=0.25) => base * (1 - f/2 + Math.random() * f);

const ab2b64 = buf => { const u=new Uint8Array(buf); let s=''; for(let i=0;i<u.length;i++) s+=String.fromCharCode(u[i]); return btoa(s); };
const b642ab = s   => { const b=atob(s); const u=new Uint8Array(b.length); for(let i=0;i<b.length;i++) u[i]=b.charCodeAt(i); return u.buffer; };

export class TurquoiseNetwork {
  constructor(identity) {
    if (!identity?.fingerprint) throw new Error('identity.fingerprint required');
    this.id    = identity;
    this.peers = new Map();
    this.ws    = null;
    this._wsURL      = null;
    this._retry      = 0;
    this._wsOK       = false;
    this._dead       = false;
    this._known      = new Map();
    this._initiating = new Set();
    this._hbTimer    = null;
    this._ping       = null;
    this._log        = TQLog.get();

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

  /**
   * Hard reconnect on device wake / network change.
   * Mobile browsers keep WS readyState=OPEN after TCP was killed during sleep,
   * so the old (!_wsOK) guard did nothing.  We forcibly close the dead socket,
   * tear down every stale peer (re-queuing in _known), then open fresh WS.
   * _reconnectKnown() on ws.onopen re-establishes all known peers automatically.
   */
  forceReconnect() {
    if (this._dead) return;
    this._log.info(FILE, 'forceReconnect', 'forcing full reconnect');
    this._wsOK = false;
    clearInterval(this._ping);
    if (this.ws) {
      const dead = this.ws; this.ws = null;
      try { dead.onopen=dead.onclose=dead.onerror=dead.onmessage=null; dead.close(1000,'wake'); } catch {}
    }
    // Tear down all peers. _teardown schedules exponential-backoff retries, but we
    // want immediate reconnect — so after tearing down, reset every retry counter
    // and cancel every pending timer. _reconnectKnown() on ws.onopen takes over.
    for (const fp of [...this.peers.keys()]) this._teardown(fp, 'wake');
    for (const [, k] of this._known) {
      k.retry = 0;
      clearTimeout(k.timer);
      k.timer = null;
    }
    this._retry = 0;
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
      }, 20_000); // 20s: render.com drops idle WS at ~30s
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
      case 'offer':  this._onOffer(msg);  break;
      case 'answer': this._onAnswer(msg); break;
      case 'answer-reneg': this._onAnswerReneg(msg); break;
      case 'ice':    this._onIce(msg);    break;
      // offer-reneg is forwarded to app.js for media handling.
      // answer-reneg is handled internally (applied as an SDP answer).
      default: this.onMessage?.(from, msg);
    }
  }

  // ── Peer connection lifecycle ─────────────────────────────────────────────

  _initiate(fp, nick) {
    if (this._initiating.has(fp) || this.peers.has(fp)) return;
    this._initiating.add(fp);
    const ps = this._makePS(fp, nick);
    this.peers.set(fp, ps);

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
      hbMiss:0, hbTimer:null, _discTimer:null, _ctrlCloseTimer:null,
      _resolve:null, _reject:null,
      onRemoteStream: null,
    };

    pc.onicecandidate = e => {
      if (e.candidate) this._sig({type:'ice', ice:e.candidate.toJSON(), to:fp, from:this.id.fingerprint});
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this._log.debug(FILE, 'conn', `${fp.slice(0,8)}: ${s}`);
      // _onReady now fires from ctrl.onopen so the logged tier is always accurate.
      // (Previously fired here — before ctrl DC opened — so tier was always 'ws-relay'.)
      if (s === 'disconnected') {
        try { pc.restartIce(); } catch {}
        clearTimeout(ps._discTimer);
        ps._discTimer = setTimeout(() => {
          if (ps.pc.connectionState === 'disconnected' || ps.pc.connectionState === 'failed') {
            this._teardown(fp, 'disconnected-timeout');
          }
        }, 10_000);
      }
      if (s === 'failed') { clearTimeout(ps._discTimer); this._teardown(fp, 'failed'); }
      if (s === 'closed') { clearTimeout(ps._discTimer); this._teardown(fp, 'closed'); }
    };

    pc.ondatachannel = e => {
      if (e.channel.label === 'ctrl') ps.ctrl = this._mkDC(fp, ps, 'ctrl', null, e.channel);
      if (e.channel.label === 'data') ps.data = this._mkDC(fp, ps, 'data', null, e.channel);
    };

    // Use addEventListener so app.js callbacks registered via setRemoteStreamHandler
    // work independently without overwriting this handler.
    pc.addEventListener('track', e => {
      const stream = e.streams[0] || null;
      ps.stream = stream;
      if (ps.onRemoteStream) ps.onRemoteStream(stream);
    });

    return ps;
  }

  _mkDC(fp, ps, label, init, existing) {
    const dc = existing || ps.pc.createDataChannel(label, init);
    dc.bufferedAmountLowThreshold = LOW;

    if (label === 'ctrl') {
      dc.onopen    = () => {
        this._log.debug(FILE,'dc',`ctrl open ${fp.slice(0,8)}`);
        // Fire _onReady here — ctrl just opened so connTier returns 'p2p' correctly.
        if (!ps.ready) { ps.ready = true; this._onReady(fp, ps); }
      };
      dc.onmessage = e => this._onCtrl(fp, e.data);
      // Fix A: don't immediately teardown when ctrl closes — give the PC 1.5s to
      // report its own state change first.  Tearing down instantly creates a cascade
      // where both peers chase each other's reconnects, producing rapid ctrl-open/
      // ctrl-close cycles.  If the PC is still 'connected' after the grace period,
      // try an ICE restart instead of a full teardown.
      dc.onclose   = () => {
        this._log.debug(FILE, 'dc', `ctrl closed ${fp.slice(0,8)}`);
        if (!this.peers.has(fp)) return;
        clearTimeout(ps._ctrlCloseTimer);
        ps._ctrlCloseTimer = setTimeout(() => {
          const cur = this.peers.get(fp);
          if (!cur) return; // already torn down by PC state change
          const s = cur.pc.connectionState;
          if (s === 'connected' || s === 'connecting') {
            // PC is still alive — attempt ICE restart; let onconnectionstatechange
            // handle teardown if it actually fails.
            this._log.debug(FILE, 'dc', `ctrl closed but PC ${s} (${fp.slice(0,8)}) — restarting ICE`);
            try { cur.pc.restartIce(); } catch {}
          } else {
            this._teardown(fp, 'ctrl-closed');
          }
        }, 1500);
      };
    } else {
      dc.onopen    = () => { this._log.debug(FILE,'dc',`data open ${fp.slice(0,8)}`); };
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
    clearTimeout(ps._discTimer);
    clearTimeout(ps._ctrlCloseTimer);
    try { ps.pc.close(); } catch {}
    ps._reject?.(new Error('peer gone'));

    if (ps.ready) {
      this._log.info(FILE, 'teardown', `${fp.slice(0,8)}: ${reason}`);
      this.onLog?.(`▼ ${ps.nick}`);
      this.onPeerDisconnected?.(fp, ps.nick);
    }

    const k = this._known.get(fp);
    if (k && !this._dead) {
      clearTimeout(k.timer);
      k.timer = setTimeout(() => this._initiate(fp, k.nick), jit(Math.min(RB_MAX, RB_BASE * Math.pow(1.8, Math.min(k.retry++, 8)))));
    }
  }

  _reconnectKnown() {
    for (const [fp, k] of this._known) {
      const ps = this.peers.get(fp);
      if (ps) {
        // Peer exists but is stuck in a terminal or pre-ready state — tear it down
        // silently so we can re-initiate below. Without this, a peer whose offer
        // was lost (WS was down when onnegotiationneeded fired) stays in the map
        // forever and _initiate is never retried.
        const pcState = ps.pc.connectionState;
        const stale   = !ps.ready && (pcState === 'failed' || pcState === 'closed');
        const alsoStale = ps.ready && (pcState === 'failed' || pcState === 'closed');
        if (stale || alsoStale) {
          this._log.debug(FILE, '_reconnectKnown', `${fp.slice(0,8)}: stale (${pcState}), replacing`);
          this.peers.delete(fp);
          ['ctrl','data'].forEach(k => { try { ps[k]?.close(); } catch {} });
          clearTimeout(ps.hbTimer);
          try { ps.pc.close(); } catch {}
          ps._reject?.(new Error('peer gone'));
          if (alsoStale) { this.onLog?.(`▼ ${ps.nick}`); this.onPeerDisconnected?.(fp, ps.nick); }
        }
      }
      if (!this.peers.has(fp)) this._initiate(fp, k.nick);
    }
  }

  // ── Signaling handlers ────────────────────────────────────────────────────

  async _onOffer(msg) {
    const { from:fp, sdp } = msg;
    if (!fp || !sdp) return;
    let ps = this.peers.get(fp);

    // Discard stale PS before accepting a fresh offer.
    // When the remote _initiate sends a new offer, negotiating it on the old
    // PeerConnection (whose ctrl DC is closed) re-establishes ICE but the
    // pre-negotiated DCs (id:0/1) can't reopen through SDP alone — they stay
    // closed forever, producing the infinite connecting/connected loop.
    if (ps) {
      const pcState = ps.pc.connectionState;
      const ctrlOk  = ps.ctrl?.readyState === 'open' || ps.ctrl?.readyState === 'connecting';
      if (pcState === 'failed' || pcState === 'closed' || !ctrlOk) {
        this._log.debug(FILE, '_onOffer', `${fp.slice(0,8)}: stale PS (pc=${pcState} ctrl=${ps.ctrl?.readyState}), replacing`);
        // Delete from map and close silently — do NOT call full _teardown()
        // because that would schedule another _initiate via _known, conflicting
        // with the incoming offer which IS the reconnect.
        this.peers.delete(fp);
        ['ctrl','data'].forEach(k => { try { ps[k]?.close(); } catch {} });
        clearTimeout(ps.hbTimer);
        try { ps.pc.close(); } catch {}
        ps = null;
      }
    }

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
    this._sig({type:'answer', sdp:ps.pc.localDescription.sdp, to:fp, from:this.id.fingerprint});
  }

  async _onAnswer(msg) {
    const ps = this.peers.get(msg.from);
    if (!ps || !msg.sdp) return;
    // NOTE: intentionally NOT checking ps.ignoreOffer here.
    // ignoreOffer only gates incoming *offers* during a glare collision.
    // An *answer* is always a valid response to our own offer and must be applied.
    // Blocking it here left the impolite peer stuck in 'have-local-offer' forever,
    // so its DataChannels never opened — causing one-way-only connectivity.
    try {
      await ps.pc.setRemoteDescription({type:'answer', sdp:msg.sdp});
      ps.ignoreOffer = false; // safe to clear now — collision resolved
    } catch(e) { this._log.warn(FILE, '_onAnswer', e.message); }
  }

  // answer-reneg is the SDP answer to offer-reneg; apply it like a normal answer.
  async _onAnswerReneg(msg) { return this._onAnswer(msg); }

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
    // Reset miss counters on all connected peers. Without this, a WS reconnect
    // (connect() → _startHB()) starts counting from the previous hbMiss value,
    // so a peer at hbMiss=2 would tear down after just one more tick (~8s)
    // instead of the full 3×8s=24s window.
    for (const [, ps] of this.peers) ps.hbMiss = 0;
    this._hbTimer = setInterval(() => {
      for (const [fp, ps] of this.peers) {
        if (!ps.ready) continue;
        if (ps.ctrl?.readyState !== 'open') continue;
        if (++ps.hbMiss >= HB_MAX) { this._teardown(fp,'hb-timeout'); continue; }
        clearTimeout(ps.hbTimer);
        ps.hbTimer = setTimeout(() => {}, HB_DL);
        try { ps.ctrl.send(JSON.stringify({type:'hb-ping'})); } catch {}
      }
    }, HB_IV);
  }

  // ── Public send API ───────────────────────────────────────────────────────

  sendCtrl(fp, msg) {
    const ps = this.peers.get(fp);
    if (ps?.ctrl?.readyState === 'open') {
      try { ps.ctrl.send(JSON.stringify(msg)); return true; } catch {}
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({...msg, to:fp, _relay:true})); return true; } catch {}
    }
    return false;
  }

  sendBinary(fp, buf) {
    const ps = this.peers.get(fp);
    if (ps?.data?.readyState === 'open') {
      if (ps.data.bufferedAmount > HIGH) return false;
      try { ps.data.send(buf); return true; } catch {}
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({type:'bin-relay', to:fp, data:ab2b64(buf)})); return true; } catch {}
    }
    return false;
  }

  waitForBuffer(fp) {
    const ps = this.peers.get(fp);
    if (!ps?.data || ps.data.bufferedAmount <= HIGH) return Promise.resolve();
    return new Promise((res, rej) => { ps._resolve = res; ps._reject = rej; });
  }

  // ── Media ─────────────────────────────────────────────────────────────────

  /** Register handler called when a remote track stream arrives for fp. */
  setRemoteStreamHandler(fp, handler) {
    const ps = this.peers.get(fp);
    if (ps) ps.onRemoteStream = handler;
  }

  /** Add local tracks and send offer-reneg (call initiator side). */
  async offerWithStream(fp, stream) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    // Use addTransceiver (NOT addTrack + createOffer) to append new audio/video
    // m-lines at the END of the existing SDP. addTrack + createOffer can reorder
    // m-lines on a PC that already negotiated DataChannels, causing Chrome's
    // "The order of m-lines in subsequent offer doesn't match" error.
    for (const track of stream.getTracks()) {
      ps.pc.addTransceiver(track, { streams:[stream], direction:'sendrecv' });
    }
    try {
      // setLocalDescription() with no args = implicit offer. It appends new
      // m-lines after existing ones rather than reordering them.
      await ps.pc.setLocalDescription();
      this._sig({type:'offer-reneg', sdp:ps.pc.localDescription.sdp, to:fp, from:this.id.fingerprint});
    } catch(e) { this._log.warn(FILE,'offerWithStream',e.message); }
  }

  /**
   * Set remote SDP, add local tracks, complete the SDP answer (call acceptor side).
   * @param {string} fp
   * @param {string} sdp  — the SDP from offer-reneg
   * @param {MediaStream} stream
   */
  async answerWithStream(fp, sdp, stream) {
    const ps = this.peers.get(fp);
    if (!ps || !sdp) return;
    try {
      await ps.pc.setRemoteDescription({type:'offer', sdp});
      stream.getTracks().forEach(t => ps.pc.addTrack(t, stream));
      await ps.pc.setLocalDescription();
      this._sig({type:'answer-reneg', sdp:ps.pc.localDescription.sdp, to:fp, from:this.id.fingerprint});
    } catch(e) { this._log.warn(FILE,'answerWithStream',e.message); }
  }

  stopMedia(fp) {
    const ps = this.peers.get(fp);
    if (!ps) return;
    ps.pc.getSenders().forEach(s => {
      if (!s.track) return;
      try { s.track.stop(); ps.pc.removeTrack(s); } catch {}
    });
    ps.stream = null;
  }

  // ── Status ────────────────────────────────────────────────────────────────

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

  /**
   * Pre-register a peer so connections are retried on page reload without
   * waiting for the signaling server to broadcast their presence.
   *
   * Call during app boot for every peer loaded from IDB.  After a reload
   * _known is empty and _reconnectKnown() has nothing to work with — so
   * reconnection stalls silently until the remote device happens to be on
   * the server exactly when we connect.  Pre-populating _known bypasses
   * that race: we actively initiate as soon as signaling is ready.
   *
   * Safe to call multiple times for the same fp — later server {type:'peer'}
   * messages are still handled normally (they update nick, reset retry).
   */
  addKnownPeer(fp, nick) {
    if (!fp || this._known.has(fp)) return;
    const k = { retry: 0, timer: null, nick: nick || fp.slice(0, 8) };
    this._known.set(fp, k);
    // If signaling is already up, initiate immediately (async so caller returns first)
    if (this._wsOK && !this.peers.has(fp)) {
      setTimeout(() => this._initiate(fp, k.nick), 0);
    }
    this._log.debug(FILE, 'addKnownPeer', `pre-registered ${fp.slice(0,8)}`);
  }

  /** True if peer is connected and ready. Avoids exposing internal peers Map. */
  isReady(fp) {
    return this.peers.get(fp)?.ready === true;
  }

  connTier(fp) {
    const ps = this.peers.get(fp);
    if (!ps?.ready) return 'disconnected';
    if (ps.ctrl?.readyState === 'open') return 'p2p';
    if (this._wsOK) return 'ws-relay';
    return 'disconnected';
  }

  destroy() {
    if (this._dead) return;
    this._dead = true;
    clearInterval(this._hbTimer); clearInterval(this._ping);
    for (const fp of [...this.peers.keys()]) this._teardown(fp, 'destroy');
    try { this.ws?.close(1000); } catch {}
    this.ws = null;
  }
}
