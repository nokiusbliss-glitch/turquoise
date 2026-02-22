/**
 * webrtc.js — Turquoise Phase 2 (updated for Phase 3+4)
 *
 * Changes from Phase 2:
 *   - hello message now includes full fingerprint
 *   - sendTo(fp, payload) method added — directed peer-to-peer send
 *   - onPeerConnected(fp) callback added
 *   - onPeerDisconnected(fp) callback added
 *   - getConnectedPeers() method added
 *
 * Murphy's Law: every async step, every state transition has explicit handling.
 */

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302'  },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export class TurquoiseNetwork {

  constructor(identity, onEvent) {
    if (!identity?.fingerprint) throw new Error('Network: identity.fingerprint required.');
    if (typeof onEvent !== 'function') throw new Error('Network: onEvent must be a function.');

    this.identity = identity;
    this.onEvent  = onEvent;  // can be replaced by app layer

    // Optional callbacks — set from outside
    this.onPeerConnected    = null; // (fp) → void
    this.onPeerDisconnected = null; // (fp) → void

    this.ws       = null;
    this.peers    = new Map(); // fp → RTCPeerConnection
    this.channels = new Map(); // fp → RTCDataChannel
    this.logFn    = (msg) => console.log('[Net]', msg);
  }

  // ── Connect to signaling server ─────────────────────────────────────────────

  connect(url) {
    if (!url || typeof url !== 'string') {
      this._log('❌ connect: invalid URL.'); return;
    }

    this._log('Connecting to signaling server…');

    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      this._log('❌ WebSocket failed: ' + e.message); return;
    }

    this.ws.onopen = () => {
      this._log('Signaling server connected ✓');
      this._signal({ type: 'announce', from: this.identity.fingerprint });
    };

    this.ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      try { await this._handleSignal(msg); } catch (e) {
        this._log('⚠ Signal error: ' + e.message);
      }
    };

    this.ws.onclose = (ev) => this._log(`Signaling closed (${ev.code}).`);
    this.ws.onerror = ()    => this._log('❌ Signaling error — is server.js running?');
  }

  // ── Send to ALL connected peers (broadcast) ─────────────────────────────────

  broadcast(payload) {
    let sent = 0;
    let packet;
    try   { packet = JSON.stringify(payload); }
    catch (e) { this._log('⚠ broadcast serialize failed: ' + e.message); return 0; }

    for (const [fp, ch] of this.channels) {
      if (ch.readyState === 'open') {
        try { ch.send(packet); sent++; }
        catch (e) { this._log(`⚠ broadcast to ${fp.slice(0,8)} failed: ${e.message}`); }
      }
    }
    return sent;
  }

  // ── Send to ONE specific peer ───────────────────────────────────────────────

  sendTo(fp, payload) {
    if (!fp)      { this._log('⚠ sendTo: no fingerprint.'); return false; }
    if (!payload) { this._log('⚠ sendTo: no payload.'); return false; }

    const ch = this.channels.get(fp);
    if (!ch) {
      this._log(`⚠ sendTo ${fp.slice(0,8)}: no channel.`); return false;
    }
    if (ch.readyState !== 'open') {
      this._log(`⚠ sendTo ${fp.slice(0,8)}: channel ${ch.readyState}.`); return false;
    }

    try {
      ch.send(JSON.stringify(payload));
      return true;
    } catch (e) {
      this._log(`⚠ sendTo ${fp.slice(0,8)} failed: ${e.message}`);
      return false;
    }
  }

  // ── Get list of currently connected peer fingerprints ──────────────────────

  getConnectedPeers() {
    const result = [];
    for (const [fp, ch] of this.channels) {
      if (ch.readyState === 'open') result.push(fp);
    }
    return result;
  }

  // ── Handle signaling messages ───────────────────────────────────────────────

  async _handleSignal(msg) {
    if (!msg || typeof msg !== 'object') return;
    const { type, from } = msg;

    if (type === 'peer') {
      if (!msg.fingerprint) { this._log('⚠ peer msg missing fingerprint.'); return; }
      this._log(`Peer discovered: ${msg.fingerprint.slice(0,8)}`);
      await this._createOffer(msg.fingerprint);
    }

    else if (type === 'offer') {
      if (!from || !msg.sdp) { this._log('⚠ offer missing from/sdp.'); return; }
      this._log(`Offer from: ${from.slice(0,8)}`);
      await this._handleOffer(from, msg.sdp);
    }

    else if (type === 'answer') {
      if (!from || !msg.sdp) { this._log('⚠ answer missing from/sdp.'); return; }
      const pc = this.peers.get(from);
      if (!pc) { this._log(`⚠ answer: no connection for ${from.slice(0,8)}.`); return; }
      try { await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }); }
      catch (e) { this._log(`⚠ setRemoteDescription(answer) failed: ${e.message}`); }
    }

    else if (type === 'ice') {
      if (!from || !msg.candidate) return;
      const pc = this.peers.get(from);
      if (!pc) return;
      try { await pc.addIceCandidate(msg.candidate); } catch { /* normal */ }
    }
  }

  // ── Create RTCPeerConnection ────────────────────────────────────────────────

  _createPeerConnection(remoteFp) {
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    } catch (e) {
      throw new Error('RTCPeerConnection failed: ' + e.message);
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this._signal({ type: 'ice', from: this.identity.fingerprint, to: remoteFp, candidate: ev.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this._log(`${remoteFp.slice(0,8)} → ${s}`);
      if (s === 'failed' || s === 'closed') {
        this.peers.delete(remoteFp);
        if (this.channels.has(remoteFp)) {
          try { this.channels.get(remoteFp).close(); } catch {}
          this.channels.delete(remoteFp);
        }
        if (typeof this.onPeerDisconnected === 'function') {
          this.onPeerDisconnected(remoteFp);
        }
      }
    };

    pc.onicecandidateerror = (ev) => {
      if (ev.errorCode !== 701) {
        this._log(`⚠ ICE ${ev.errorCode}: ${ev.errorText}`);
      }
    };

    this.peers.set(remoteFp, pc);
    return pc;
  }

  // ── Initiator: create offer + DataChannel ───────────────────────────────────

  async _createOffer(remoteFp) {
    if (this.peers.has(remoteFp)) {
      this._log(`Already connecting to ${remoteFp.slice(0,8)}.`); return;
    }

    let pc;
    try { pc = this._createPeerConnection(remoteFp); }
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

    this._signal({ type: 'offer', from: this.identity.fingerprint, to: remoteFp, sdp: offer.sdp });
  }

  // ── Receiver: handle offer, send answer ─────────────────────────────────────

  async _handleOffer(remoteFp, sdp) {
    if (this.peers.has(remoteFp)) {
      this._log(`Already connected to ${remoteFp.slice(0,8)}, ignoring offer.`); return;
    }

    let pc;
    try { pc = this._createPeerConnection(remoteFp); }
    catch (e) { this._log('❌ ' + e.message); return; }

    pc.ondatachannel = (ev) => {
      try { this._setupChannel(ev.channel, remoteFp); }
      catch (e) { this._log('⚠ ondatachannel: ' + e.message); }
    };

    try { await pc.setRemoteDescription({ type: 'offer', sdp }); }
    catch (e) { this._log('❌ setRemoteDescription(offer): ' + e.message); return; }

    let answer;
    try {
      answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
    } catch (e) { this._log('❌ createAnswer: ' + e.message); return; }

    this._signal({ type: 'answer', from: this.identity.fingerprint, to: remoteFp, sdp: answer.sdp });
  }

  // ── Setup DataChannel ────────────────────────────────────────────────────────

  _setupChannel(ch, remoteFp) {
    if (!ch) { this._log('⚠ setupChannel: null channel.'); return; }
    this.channels.set(remoteFp, ch);

    ch.onopen = () => {
      this._log(`DataChannel open ↔ ${remoteFp.slice(0,8)} ✓`);

      // Notify app layer
      if (typeof this.onPeerConnected === 'function') {
        this.onPeerConnected(remoteFp);
      }

      // Send hello — now includes full fingerprint so receiver can identify us
      try {
        ch.send(JSON.stringify({
          type:        'hello',
          fingerprint: this.identity.fingerprint,
          shortId:     this.identity.shortId,
          payload:     { msg: 'Turquoise says hello' },
          ts:          Date.now(),
        }));
      } catch (e) {
        this._log('⚠ hello send failed: ' + e.message);
      }
    };

    ch.onmessage = (ev) => {
      let event;
      try { event = JSON.parse(ev.data); }
      catch (e) { this._log('⚠ bad peer message: ' + e.message); return; }
      try { this.onEvent(event); }
      catch (e) { this._log('⚠ onEvent threw: ' + e.message); }
    };

    ch.onclose = () => {
      this._log(`DataChannel closed: ${remoteFp.slice(0,8)}`);
      this.channels.delete(remoteFp);
      this.peers.delete(remoteFp);
      if (typeof this.onPeerDisconnected === 'function') {
        this.onPeerDisconnected(remoteFp);
      }
    };

    ch.onerror = (e) => {
      this._log(`⚠ channel error (${remoteFp.slice(0,8)}): ${e?.message || 'unknown'}`);
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _signal(msg) {
    if (!this.ws) { this._log('⚠ signal: no WebSocket.'); return; }
    if (this.ws.readyState !== WebSocket.OPEN) {
      this._log('⚠ signal: WebSocket not open.'); return;
    }
    try { this.ws.send(JSON.stringify(msg)); }
    catch (e) { this._log('⚠ signal send failed: ' + e.message); }
  }

  _log(text) {
    try { this.logFn(text); } catch { console.log('[Net]', text); }
  }
}
