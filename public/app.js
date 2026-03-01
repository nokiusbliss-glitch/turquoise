/**
 * app.js — Turquoise
 * UI controller: mesh group chat, 1:1 chat, files, walkie, stream
 *
 * Render = website delivery + WebRTC signaling only.
 * After P2P handshake: ALL data is direct device-to-device over local WiFi.
 *
 * Mesh: broadcast channel, always at top of sidebar.
 *   All connected peers are in mesh by default.
 *   Peers can be removed from mesh (they won't send/receive mesh messages).
 *
 * Walkie (voice call) flow:
 *   1. Initiator clicks 🎙 → getUserMedia → send call-invite
 *   2. Receiver sees invite overlay → accept/decline
 *   3. Accept: receiver getUserMedia → send call-accept
 *   4. Initiator gets accept → offerWithStream → offer-reneg
 *   5. Receiver gets offer-reneg → answerWithStream → answer-reneg
 *   6. Both sides: remote stream attached → walkie active
 *
 * Stream (video call): same flow with video:true
 */

import { saveMessage, loadMessages, savePeer, loadPeers, clearMessages, clearAllData } from './messages.js';
import { resetIdentity } from './identity.js';
import { FileTransfer } from './files.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (b) => {
  if (!b) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
};
const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const MESH_ID = 'mesh'; // synthetic session ID for group chat

export class TurquoiseApp {
  constructor(identity, network) {
    if (!identity?.fingerprint) throw new Error('App: identity required');
    if (!network?.sendCtrl)     throw new Error('App: network required');
    this.id       = identity;
    this.net      = network;
    this.peers    = new Map();   // fp → {nick, connected}
    this.sessions = new Map();   // fp|'mesh' → msg[]
    this.active   = null;
    this.unread   = new Map();
    this.meshBlocked = new Set(); // peers excluded from mesh broadcast

    // Call state — null when idle
    this.call = null;
    /*  call = {
          fp, type ('walkie'|'stream'), phase ('inviting'|'ringing'|'connecting'|'active'),
          localStream, remoteStream, muted, camOff, inviteSdp (stored for receiver),
          inviteTimer (auto-decline timeout)
        }
    */

    // Hidden audio for remote voice — always loudspeaker
    this._audioEl = document.createElement('audio');
    this._audioEl.autoplay    = true;
    this._audioEl.playsInline = true;
    this._audioEl.controls    = false;
    this._audioEl.style.display = 'none';
    document.body.appendChild(this._audioEl);

    this.ft = new FileTransfer(
      (fp, msg) => network.sendCtrl(fp, msg),
      (fp, buf) => network.sendBinary(fp, buf),
      (fp)      => network.waitForBuffer(fp),
    );
    this.ft.onProgress  = (id, pct)  => this._onFileProg(id, pct);
    this.ft.onFileReady = (f)        => this._onFileReady(f);
    this.ft.onError     = (id, msg)  => this._onFileErr(id, msg);
  }

  // ── Mount ──────────────────────────────────────────────────────────────────
  async mount() {
    const nd = $('nick-display'), ni = $('nick-input'), fp = $('full-fp');
    if (nd) nd.textContent = this.id.nickname;
    if (ni) ni.value       = this.id.nickname;
    if (fp) fp.textContent = this.id.fingerprint;

    try {
      const saved = await loadPeers();
      for (const p of saved) {
        this.peers.set(p.fingerprint, {
          nick: p.nickname || p.shortId || p.fingerprint.slice(0, 8),
          connected: false,
        });
      }
    } catch (e) { this._log('⚠ peer history: ' + e.message, true); }

    // Load mesh chat history
    try {
      const meshMsgs = await loadMessages(MESH_ID);
      this.sessions.set(MESH_ID, meshMsgs);
    } catch { this.sessions.set(MESH_ID, []); }

    this._bind();
    this._wire();

    // Default: open mesh
    await this._openSession(MESH_ID);

    if (this.id.isNewUser) {
      this._status('welcome — set your name above', 'info');
      setTimeout(() => this._triggerNickEdit(), 500);
    } else {
      this._status('connecting to mesh…', 'info');
    }
  }

  // ── Event binding ──────────────────────────────────────────────────────────
  _bind() {
    const row = $('identity-row'), disp = $('nick-display'), inp = $('nick-input');
    if (row && disp && inp) {
      row.addEventListener('click', () => this._triggerNickEdit());
      const saveNick = async () => {
        if (!inp.classList.contains('visible')) return;
        const saved = await this.id.saveNickname(inp.value).catch(() => this.id.nickname);
        this.id.nickname = saved;
        if (disp) disp.textContent = saved;
        if (inp)  inp.value        = saved;
        disp.classList.remove('hidden'); inp.classList.remove('visible');
        this.net.getConnectedPeers().forEach(fp => this.net.sendCtrl(fp, { type: 'nick-update', nick: saved }));
        this._status('name saved: ' + saved, 'ok', 3000);
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); saveNick(); } });
      inp.addEventListener('blur', saveNick);
    }

    const mi = $('msg-input'), sb = $('send-btn');
    if (mi) {
      mi.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._send(); } });
      mi.addEventListener('input', () => { mi.style.height = 'auto'; mi.style.height = Math.min(mi.scrollHeight, 128) + 'px'; });
    }
    sb?.addEventListener('click', () => this._send());

    const fb = $('file-btn'), fi = $('__file-input');
    if (fb && fi) {
      fb.addEventListener('click', () => {
        if (!this.active || this.active === MESH_ID) { this._sys('select a peer to send files', true); return; }
        if (!this.net.isReady(this.active)) { this._sys('peer offline', true); return; }
        fi.click();
      });
      fi.addEventListener('change', (e) => { Array.from(e.target.files || []).forEach(f => this._queueFile(f)); fi.value = ''; });
    }

    const ca = $('chat-area');
    if (ca) {
      ca.addEventListener('dragover', (e) => { e.preventDefault(); if (this.active && this.active !== MESH_ID) ca.classList.add('drag-over'); });
      ca.addEventListener('dragleave', () => ca.classList.remove('drag-over'));
      ca.addEventListener('drop', (e) => {
        e.preventDefault(); ca.classList.remove('drag-over');
        if (!this.active || this.active === MESH_ID) { this._sys('select a peer to send files', true); return; }
        Array.from(e.dataTransfer?.files || []).forEach(f => this._queueFile(f));
      });
    }

    $('back-btn')?.addEventListener('click', () => this._showSidebar());
    $('reset-btn')?.addEventListener('click', () => this._confirmReset());
  }

  _triggerNickEdit() {
    const disp = $('nick-display'), inp = $('nick-input');
    if (!disp || !inp || inp.classList.contains('visible')) return;
    disp.classList.add('hidden'); inp.classList.add('visible'); inp.focus(); inp.select();
  }

  // ── Wire network ──────────────────────────────────────────────────────────
  _wire() {
    const n = this.net;
    n.onPeerConnected         = (fp, nick) => this._onConnect(fp, nick);
    n.onPeerDisconnected      = (fp)       => this._onDisconnect(fp);
    n.onMessage               = (fp, msg)  => { try { this._dispatch(fp, msg); } catch (e) { this._log('⚠ msg: ' + e.message, true); } };
    n.onBinaryChunk           = (fp, buf)  => { try { this.ft.handleBinary(fp, buf); } catch (e) { this._log('⚠ binary: ' + e.message, true); } };
    n.onLog                   = (t, e)     => this._log(t, e);
    n.onSignalingConnected    = () => this._status('signaling connected — searching for peers', 'ok', 4000);
    n.onSignalingDisconnected = () => this._status('signaling lost — reconnecting…', 'warn');
  }

  // ── Peer lifecycle ─────────────────────────────────────────────────────────
  _onConnect(fp, nick) {
    const ex   = this.peers.get(fp);
    const name = nick || ex?.nick || fp.slice(0, 8);
    this.peers.set(fp, { nick: name, connected: true });
    savePeer({ fingerprint: fp, shortId: fp.slice(0, 8), nickname: name }).catch(() => {});
    if (!this.sessions.has(fp)) {
      loadMessages(fp).then(msgs => {
        this.sessions.set(fp, msgs);
        if (this.active === fp) this._renderMsgs();
        this._renderPeers();
      }).catch(() => { this.sessions.set(fp, []); });
    } else { this._renderPeers(); }
    if (this.active === fp) this._renderHeader();
    this._status(`${name} joined`, 'ok', 3000);
    this._log(`✓ ${name} connected`);
  }

  _onDisconnect(fp) {
    const p    = this.peers.get(fp);
    const name = p?.nick || fp.slice(0, 8);
    if (p) p.connected = false;
    if (this.call?.fp === fp) this._endCallLocal(false);
    this._renderPeers();
    if (this.active === fp) this._renderHeader();
    this._status(`${name} disconnected — will reconnect`, 'warn', 6000);
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────
  _dispatch(fp, msg) {
    const { type } = msg;

    if (type === 'hello') {
      const p = this.peers.get(fp);
      if (p && msg.nick) { p.nick = msg.nick; this._renderPeers(); }
      return;
    }
    if (type === 'nick-update') {
      const p = this.peers.get(fp);
      if (p && msg.nick) {
        p.nick = msg.nick; this._renderPeers();
        if (this.active === fp) this._renderHeader();
        savePeer({ fingerprint: fp, shortId: fp.slice(0, 8), nickname: msg.nick }).catch(() => {});
      }
      return;
    }

    // Chat — 1:1 or mesh
    if (type === 'chat') {
      if (msg.mesh) this._recvMesh(fp, msg);
      else          this._recv(fp, msg);
      return;
    }

    // File transfer
    if (type === 'file-meta') {
      const nick = this.peers.get(fp)?.nick || fp.slice(0, 8);
      if (this.active === fp) this._addFileCard(nick, msg.fileId, msg.name, msg.size, false);
      else {
        this.unread.set(fp, (this.unread.get(fp) || 0) + 1);
        this._renderPeers();
      }
      this.ft.handleCtrl(fp, msg);
      this._status(`receiving ${msg.name} from ${nick}…`, 'info');
      return;
    }
    if (type === 'file-end' || type === 'file-abort') {
      this.ft.handleCtrl(fp, msg);
      return;
    }

    // Call: invite (show overlay, user decides)
    if (type === 'call-invite') {
      this._onCallInvite(fp, msg);
      return;
    }
    // Call: initiator gets accept — now do SDP exchange
    if (type === 'call-accept') {
      this._onCallAccepted(fp);
      return;
    }
    // Call: initiator gets decline
    if (type === 'call-decline') {
      this._onCallDeclined(fp);
      return;
    }
    // Receiver gets offer-reneg after accepting
    if (type === 'offer-reneg') {
      this._onOfferReneg(fp, msg);
      return;
    }
    if (type === 'call-end') {
      this._onCallEnd(fp);
      return;
    }

    // Permission error from remote device
    if (type === 'permission-denied') {
      const nick = this.peers.get(fp)?.nick || fp.slice(0, 8);
      this._status(`${nick}: ${msg.media || 'microphone'} permission denied on their device`, 'err', 8000);
      this._sys(`${nick} denied ${msg.media || 'mic'} permission`, true);
      if (this.call?.fp === fp) this._endCallLocal(false);
      this._hideCallIncoming();
      return;
    }
  }

  // ── 1:1 Chat ──────────────────────────────────────────────────────────────
  _recv(fp, ev) {
    if (!ev.text) return;
    const msg = {
      id: ev.id || crypto.randomUUID(), sessionId: fp, from: fp,
      fromNick: ev.nick || this.peers.get(fp)?.nick || fp.slice(0, 8),
      text: String(ev.text), ts: ev.ts || Date.now(), type: 'text', own: false,
    };
    if (!this.sessions.has(fp)) this.sessions.set(fp, []);
    this.sessions.get(fp).push(msg);
    saveMessage(msg).catch(() => {});
    if (this.active !== fp) { this.unread.set(fp, (this.unread.get(fp) || 0) + 1); }
    else { this._appendMsg(msg); }
    this._renderPeers();
  }

  // ── Mesh Chat ──────────────────────────────────────────────────────────────
  _recvMesh(fp, ev) {
    if (!ev.text || this.meshBlocked.has(fp)) return;
    const msg = {
      id: ev.id || crypto.randomUUID(), sessionId: MESH_ID, from: fp,
      fromNick: ev.nick || this.peers.get(fp)?.nick || fp.slice(0, 8),
      text: String(ev.text), ts: ev.ts || Date.now(), type: 'text', own: false,
    };
    if (!this.sessions.has(MESH_ID)) this.sessions.set(MESH_ID, []);
    this.sessions.get(MESH_ID).push(msg);
    saveMessage(msg).catch(() => {});
    if (this.active !== MESH_ID) { this.unread.set(MESH_ID, (this.unread.get(MESH_ID) || 0) + 1); }
    else { this._appendMsg(msg); }
    this._renderPeers();
  }

  _send() {
    const inp  = $('msg-input');
    const text = inp?.value?.trim();
    if (!text || !this.active) return;

    const id = crypto.randomUUID();
    const ts = Date.now();

    if (this.active === MESH_ID) {
      // Broadcast to all connected non-blocked peers
      const fps = this.net.getConnectedPeers().filter(fp => !this.meshBlocked.has(fp));
      if (!fps.length) { this._sys('no peers in mesh', true); return; }
      const payload = { type: 'chat', mesh: true, id, nick: this.id.nickname, text, ts };
      fps.forEach(fp => this.net.sendCtrl(fp, payload));
      const msg = { id, sessionId: MESH_ID, from: this.id.fingerprint, fromNick: this.id.nickname, text, ts, type: 'text', own: true };
      if (!this.sessions.has(MESH_ID)) this.sessions.set(MESH_ID, []);
      this.sessions.get(MESH_ID).push(msg);
      saveMessage(msg).catch(() => {});
      this._appendMsg(msg);
      this._renderPeers();
    } else {
      const fp = this.active;
      if (!this.net.isReady(fp)) { this._sys('peer offline — not sent', true); return; }
      const payload = { type: 'chat', id, nick: this.id.nickname, text, ts };
      if (!this.net.sendCtrl(fp, payload)) { this._sys('send failed', true); return; }
      const msg = { id, sessionId: fp, from: this.id.fingerprint, fromNick: this.id.nickname, text, ts, type: 'text', own: true };
      if (!this.sessions.has(fp)) this.sessions.set(fp, []);
      this.sessions.get(fp).push(msg);
      saveMessage(msg).catch(() => {});
      this._appendMsg(msg);
      this._renderPeers();
    }

    if (inp) { inp.value = ''; inp.style.height = 'auto'; }
  }

  // ── Files ──────────────────────────────────────────────────────────────────
  _queueFile(file) {
    if (!file || !this.active || this.active === MESH_ID) return;
    if (!this.net.isReady(this.active)) { this._sys('peer offline — cannot send', true); return; }
    const fileId = crypto.randomUUID();
    this._addFileCard(this.id.nickname, fileId, file.name, file.size, true);
    this._status(`sending ${file.name}…`, 'info');
    this.ft.send(file, this.active, fileId);
  }

  _onFileProg(fileId, pct) {
    const fill = document.querySelector(`[data-fcid="${fileId}"] .prog-fill`);
    if (fill) fill.style.width = (pct * 100).toFixed(1) + '%';
  }

  _onFileReady(f) {
    let card = document.querySelector(`[data-fcid="${f.fileId}"]`);
    if (!card) {
      const nick = this.peers.get(f.from)?.nick || f.from?.slice(0, 8) || '?';
      this._status(`file from ${nick}: ${f.name} — open chat to download`, 'ok', 8000);
      return;
    }
    card.querySelector('.prog-track')?.remove();
    if (!card.querySelector('.dl-btn')) {
      const a = document.createElement('a');
      a.className = 'dl-btn'; a.href = f.url; a.download = f.name || 'file';
      a.textContent = '↓ ' + esc(f.name || 'file');
      card.appendChild(a);
    }
    this._status(`${f.name} received`, 'ok', 4000);
  }

  _onFileErr(fileId, errMsg) {
    const card = document.querySelector(`[data-fcid="${fileId}"]`);
    if (card) {
      const d = document.createElement('div');
      d.style.cssText = 'color:var(--err);font-size:.65rem;margin-top:4px';
      d.textContent = '⚠ ' + errMsg; card.appendChild(d);
    }
    this._status('file error: ' + errMsg, 'err', 5000);
  }

  // ── Call: Initiator side ───────────────────────────────────────────────────
  async _startCall(fp, callType) {
    if (!this.net.isReady(fp)) { this._sys('peer offline', true); return; }
    if (this.call)              { this._sys('already in a call', true); return; }

    const peerName = this.peers.get(fp)?.nick || fp.slice(0, 8);
    const video    = callType === 'stream';

    this._status(`getting ${video ? 'camera/mic' : 'mic'}…`, 'info');

    // Step 1: Acquire local stream (permission prompt)
    let localStream;
    try {
      localStream = await this.net.getLocalStream(video);
    } catch (e) {
      return this._handleMediaError(e, video);
    }

    // Set up call state immediately
    this.call = {
      fp, type: callType, phase: 'inviting',
      localStream, remoteStream: null, muted: false, camOff: false,
      inviteTimer: setTimeout(() => this._onCallTimeout(fp), 45000),
    };

    // Step 2: Send invite — receiver decides
    this.net.sendCtrl(fp, { type: 'call-invite', callType, nick: this.id.nickname });
    this._status(`${callType} — calling ${peerName}…`, 'info');
    this._renderHeader(); // update call buttons
    this._renderCallPanel(); // show minimal calling state
  }

  // Initiator: received call-accept from receiver
  async _onCallAccepted(fp) {
    if (!this.call || this.call.fp !== fp || this.call.phase !== 'inviting') return;

    clearTimeout(this.call.inviteTimer);
    this.call.phase = 'connecting';
    const peerName = this.peers.get(fp)?.nick || fp.slice(0, 8);
    this._status(`${this.call.type} — connecting with ${peerName}…`, 'info');

    // Step 3: Add tracks and send SDP offer
    try {
      await this.net.offerWithStream(fp, this.call.localStream);
      // Attach remote stream handler now (before tracks arrive)
      this._attachRemote(fp);
    } catch (e) {
      this._log('offerWithStream failed: ' + e.message, true);
      this._status('call setup failed: ' + e.message, 'err', 5000);
      this._endCallLocal(true);
    }
  }

  // Initiator: receiver declined
  _onCallDeclined(fp) {
    if (!this.call || this.call.fp !== fp) return;
    clearTimeout(this.call.inviteTimer);
    this.call.localStream?.getTracks().forEach(t => t.stop());
    this.call = null;
    this._renderCallPanel();
    this._renderHeader();
    const peerName = this.peers.get(fp)?.nick || fp.slice(0, 8);
    this._status(`${peerName} declined the call`, 'warn', 5000);
    this._sys(`${peerName} declined`, true);
  }

  // Initiator: no response in 45s
  _onCallTimeout(fp) {
    if (!this.call || this.call.fp !== fp) return;
    this.call.localStream?.getTracks().forEach(t => t.stop());
    this.call = null;
    this._renderCallPanel();
    this._renderHeader();
    this._status('no answer — call timed out', 'warn', 5000);
  }

  // ── Call: Receiver side ────────────────────────────────────────────────────
  _onCallInvite(fp, msg) {
    // If already in a call with someone else, auto-decline
    if (this.call && this.call.fp !== fp) {
      this.net.sendCtrl(fp, { type: 'call-decline' });
      return;
    }
    // Store invite
    if (!this.call) {
      this.call = {
        fp, type: msg.callType === 'stream' ? 'stream' : 'walkie',
        phase: 'ringing', localStream: null, remoteStream: null,
        muted: false, camOff: false, inviteTimer: null, inviteSdp: null,
      };
    }
    this._showCallIncoming(fp, msg.callType || 'walkie', msg.nick);
  }

  // Receiver: user clicked accept
  async _acceptCall(fp) {
    if (!this.call || this.call.fp !== fp || this.call.phase !== 'ringing') return;
    this._hideCallIncoming();

    const video = this.call.type === 'stream';
    this._status(`accepting — getting ${video ? 'camera/mic' : 'mic'}…`, 'info');

    let localStream;
    try {
      localStream = await this.net.getLocalStream(video);
    } catch (e) {
      this.net.sendCtrl(fp, { type: 'permission-denied', media: video ? 'camera/mic' : 'microphone' });
      this.call = null;
      return this._handleMediaError(e, video);
    }

    this.call.localStream = localStream;
    this.call.phase = 'connecting';

    // Tell initiator we accepted — they will send offer-reneg next
    this.net.sendCtrl(fp, { type: 'call-accept' });
    const peerName = this.peers.get(fp)?.nick || fp.slice(0, 8);
    this._status(`${this.call.type} — waiting for ${peerName}…`, 'info');

    // Render call panel to show "connecting" state
    this._openSession(fp);
    this._renderCallPanel();
  }

  // Receiver: user clicked decline
  _declineCall(fp) {
    this._hideCallIncoming();
    if (this.call?.fp === fp) {
      this.call.localStream?.getTracks().forEach(t => t.stop());
      this.call = null;
    }
    this.net.sendCtrl(fp, { type: 'call-decline' });
    this._renderCallPanel();
  }

  // Receiver: gets offer-reneg from initiator (after sending call-accept)
  async _onOfferReneg(fp, msg) {
    // If we're in 'connecting' phase for this peer, answer with our stored stream
    if (this.call?.fp === fp && (this.call.phase === 'connecting' || this.call.phase === 'ringing')) {
      if (!this.call.localStream) {
        // Race: offer arrived before we got media — store it
        this.call.inviteSdp = msg.sdp;
        return;
      }
      this.call.phase = 'connecting';
      try {
        await this.net.answerWithStream(fp, msg.sdp, this.call.localStream);
        this._attachRemote(fp);
      } catch (e) {
        this._log('answerWithStream failed: ' + e.message, true);
        this._status('call answer failed: ' + e.message, 'err', 5000);
        this._endCallLocal(true);
      }
      return;
    }
    // No active call — ignore (could be a stale renegotiation)
  }

  _attachRemote(fp) {
    this.net.setRemoteStreamHandler(fp, (stream) => {
      if (!stream) return;
      // Audio always routed to loudspeaker
      this._audioEl.srcObject = stream;
      if (typeof this._audioEl.setSinkId === 'function') {
        this._audioEl.setSinkId('').catch(() => {});
      }
      this._audioEl.play().catch(() => {});

      if (this.call?.fp === fp) {
        this.call.remoteStream = stream;
        this.call.phase = 'active';
        this._renderCallPanel();
        const nick = this.peers.get(fp)?.nick || fp.slice(0, 8);
        this._status(`${this.call.type} on · ${nick}`, 'ok');
        this._renderHeader();
      }
    });
  }

  _onCallEnd(fp) {
    if (this.call?.fp === fp) {
      this._endCallLocal(false);
      this._status('call ended', 'info', 3000);
    }
    this._hideCallIncoming();
  }

  async _endCallLocal(sendEnd = true) {
    if (!this.call) return;
    const fp = this.call.fp;
    clearTimeout(this.call.inviteTimer);
    this.call.localStream?.getTracks().forEach(t => t.stop());
    this.call = null;
    if (sendEnd) await this.net.stopMedia(fp);
    else { this.net.stopMedia(fp).catch(() => {}); }
    this._audioEl.srcObject = null;
    this._renderCallPanel();
    this._renderHeader();
  }

  _handleMediaError(e, video) {
    if (e.message.startsWith('permission-denied:')) {
      const media = e.message.split(':')[1];
      this._status(`${media} permission denied — allow in browser settings`, 'err', 8000);
      this._sys(`allow ${media} access in browser settings`, true);
    } else if (e.message.startsWith('no-device:')) {
      this._status(`no ${e.message.split(':')[1]} found on this device`, 'err', 6000);
    } else {
      this._status('media error: ' + e.message, 'err', 5000);
    }
    if (this.call) { this.call.localStream?.getTracks().forEach(t=>t.stop()); this.call = null; }
    this._renderCallPanel(); this._renderHeader();
  }

  // ── Call incoming overlay ──────────────────────────────────────────────────
  _showCallIncoming(fp, callType, nick) {
    const panel = $('call-incoming'); if (!panel) return;
    const name = nick || this.peers.get(fp)?.nick || fp.slice(0, 8);
    const label = callType === 'stream' ? 'stream' : 'walkie';
    const icon  = callType === 'stream' ? '📷' : '🎙';

    panel.innerHTML = `
      <div class="ci-icon">${icon}</div>
      <div class="ci-label">${label}</div>
      <div class="ci-name">${esc(name)}</div>
      <div class="ci-sub">wants to ${label} with you</div>
      <div class="ci-btns">
        <div class="ci-btn accept" id="ci-accept">accept</div>
        <div class="ci-btn decline" id="ci-decline">decline</div>
      </div>`;
    panel.classList.add('visible');

    // Store fp on panel for button handlers
    panel.dataset.fp = fp;
    $('ci-accept')?.addEventListener('click', () => this._acceptCall(fp));
    $('ci-decline')?.addEventListener('click', () => this._declineCall(fp));
  }

  _hideCallIncoming() {
    const panel = $('call-incoming');
    if (panel) panel.classList.remove('visible');
  }

  // ── Call panel (active call UI) ───────────────────────────────────────────
  _renderCallPanel() {
    const panel = $('call-panel'); if (!panel) return;

    if (!this.call) { panel.innerHTML = ''; panel.classList.remove('visible'); return; }

    const { fp, type, phase, muted, camOff, localStream, remoteStream } = this.call;
    const peerName = this.peers.get(fp)?.nick || fp.slice(0, 8);
    panel.classList.add('visible');

    // Phases before active: show waiting state
    if (phase === 'inviting' || phase === 'connecting') {
      const phaseLabel = phase === 'inviting' ? `calling ${esc(peerName)}…` : `connecting…`;
      panel.innerHTML = `
        <div class="call-waiting">
          <div class="call-waiting-type">${type === 'stream' ? '📷 stream' : '🎙 walkie'}</div>
          <div class="call-waiting-label">${phaseLabel}</div>
          <div class="call-controls">
            <div class="call-btn end" id="cb-end">✕ cancel</div>
          </div>
        </div>`;
      $('cb-end')?.addEventListener('click', () => {
        this.net.sendCtrl(fp, { type: 'call-end' });
        this._endCallLocal(false);
        this._status('call cancelled', 'info', 3000);
      });
      return;
    }

    // Active call
    const isStream = type === 'stream';
    let videoHTML = '';
    if (isStream) {
      videoHTML = `
        <div class="video-grid">
          <div class="video-wrap" id="vw-remote">
            <video id="vid-remote" autoplay playsinline></video>
            <div class="video-label">${esc(peerName)}</div>
          </div>
          <div class="video-wrap local">
            <video id="vid-local" autoplay playsinline muted></video>
            <div class="video-label">you</div>
          </div>
        </div>`;
    } else {
      // Walkie: just show who you're connected to
      videoHTML = `<div class="walkie-active">🎙 walkie · <span class="walkie-peer">${esc(peerName)}</span></div>`;
    }

    panel.innerHTML = videoHTML + `
      <div class="call-controls">
        <div class="call-btn ${muted ? 'muted' : ''}" id="cb-mute">🎙 ${muted ? 'muted' : 'mic on'}</div>
        ${isStream ? `<div class="call-btn ${camOff ? 'muted' : ''}" id="cb-cam">📷 ${camOff ? 'cam off' : 'cam on'}</div>` : ''}
        ${isStream ? `<div class="call-btn" id="cb-fs">⛶ full</div>` : ''}
        <div class="call-btn end" id="cb-end">✕ end</div>
      </div>`;

    const vr = $('vid-remote'), vl = $('vid-local');
    if (vr && remoteStream) {
      vr.srcObject = remoteStream;
      vr.addEventListener('dblclick', () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else vr.requestFullscreen?.().catch(() => {});
      });
    }
    if (vl && localStream) vl.srcObject = localStream;

    $('cb-mute')?.addEventListener('click', () => {
      if (!this.call) return;
      this.call.muted = !this.call.muted;
      this.call.localStream?.getAudioTracks().forEach(t => { t.enabled = !this.call.muted; });
      this._renderCallPanel();
    });
    $('cb-cam')?.addEventListener('click', () => {
      if (!this.call) return;
      this.call.camOff = !this.call.camOff;
      this.call.localStream?.getVideoTracks().forEach(t => { t.enabled = !this.call.camOff; });
      this._renderCallPanel();
    });
    $('cb-fs')?.addEventListener('click', () => {
      const vr2 = $('vid-remote'); if (!vr2) return;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else vr2.requestFullscreen?.().catch(() => {});
    });
    $('cb-end')?.addEventListener('click', () => {
      this.net.sendCtrl(fp, { type: 'call-end' });
      this._endCallLocal(false);
      this._status('call ended', 'info', 3000);
    });
  }

  // ── Session ────────────────────────────────────────────────────────────────
  async _openSession(fp) {
    if (!fp) return;
    this.active = fp;
    this.unread.delete(fp);
    if (!this.sessions.has(fp)) {
      try { const m = await loadMessages(fp); this.sessions.set(fp, m); }
      catch { this.sessions.set(fp, []); }
    }
    this._renderHeader();
    this._renderMsgs();
    this._renderPeers();
    this._renderCallPanel();
    const ib = $('input-bar'); if (ib) ib.classList.add('visible');
    // Mesh: hide file button (mesh is text-only)
    const fb = $('file-btn');
    if (fb) fb.style.display = (fp === MESH_ID) ? 'none' : '';
    $('msg-input')?.focus();
    this._showChat();
  }

  // ── Clear chat ─────────────────────────────────────────────────────────────
  async _clearChat(fp) {
    if (!fp) return;
    const label = fp === MESH_ID ? 'mesh chat history' : `chat with ${this.peers.get(fp)?.nick || fp.slice(0, 8)}`;
    if (!confirm(`Clear ${label}?\nThis cannot be undone.`)) return;
    try {
      await clearMessages(fp);
      this.sessions.set(fp, []);
      this._renderMsgs();
      this._status('cleared', 'ok', 2000);
    } catch (e) { this._status('clear failed: ' + e.message, 'err', 4000); }
  }

  // ── Reset identity ─────────────────────────────────────────────────────────
  async _confirmReset() {
    if (!confirm('Reset Turquoise?\n\n• New cryptographic identity\n• All messages deleted\n• All peers forgotten\n\nThis cannot be undone.')) return;
    this._status('resetting…', 'warn');
    try {
      await clearAllData();
      await resetIdentity();
      if ('caches' in window) { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); }
    } catch (e) { console.warn('reset error:', e); }
    location.reload();
  }

  // ── Toggle peer mesh membership ───────────────────────────────────────────
  _toggleMesh(fp, e) {
    e.stopPropagation();
    if (this.meshBlocked.has(fp)) this.meshBlocked.delete(fp);
    else this.meshBlocked.add(fp);
    this._renderPeers();
    const name = this.peers.get(fp)?.nick || fp.slice(0, 8);
    const state = this.meshBlocked.has(fp) ? 'removed from' : 'added to';
    this._status(`${name} ${state} mesh`, 'info', 2000);
  }

  // ── Render: peer list ──────────────────────────────────────────────────────
  _renderPeers() {
    const list = $('peer-list'); if (!list) return;

    const meshOnline    = this.net.getConnectedPeers().length > 0;
    const meshUnread    = this.unread.get(MESH_ID) || 0;
    const meshMsgs      = this.sessions.get(MESH_ID) || [];
    const meshLast      = meshMsgs[meshMsgs.length - 1];
    const meshPreview   = meshLast ? esc(meshLast.text?.slice(0, 40) || '') : 'group · everyone';
    const meshActive    = this.active === MESH_ID ? ' active' : '';

    const meshTile = `<div class="peer-tile mesh-tile${meshActive}" data-fp="${MESH_ID}">
      <div class="mesh-icon${meshOnline ? ' online' : ''}">⬡</div>
      <div class="peer-info">
        <div class="peer-nick">mesh</div>
        <div class="peer-preview">${meshPreview}</div>
      </div>
      ${meshUnread ? `<div class="peer-badge">${meshUnread > 9 ? '9+' : meshUnread}</div>` : ''}
    </div>`;

    if (!this.peers.size) {
      list.innerHTML = meshTile + '<div id="no-peers">waiting for peers…</div>';
      list.querySelector('.mesh-tile')?.addEventListener('click', () => this._openSession(MESH_ID));
      return;
    }

    const sorted = [...this.peers.entries()].sort(([, a], [, b]) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return (a.nick || '').localeCompare(b.nick || '');
    });

    const peerTiles = sorted.map(([fp, p]) => {
      const active    = fp === this.active ? ' active' : '';
      const dot       = p.connected ? 'online' : 'offline';
      const unread    = this.unread.get(fp) || 0;
      const msgs      = this.sessions.get(fp) || [];
      const last      = msgs[msgs.length - 1];
      const preview   = last ? (last.type === 'text' ? esc(last.text.slice(0, 42)) : '📎 file') : '';
      const blocked   = this.meshBlocked.has(fp);
      const inCall    = this.call?.fp === fp;

      return `<div class="peer-tile${active}" data-fp="${fp}">
        <div class="peer-dot ${dot}"></div>
        <div class="peer-info">
          <div class="peer-nick">${esc(p.nick || fp.slice(0, 8))}${inCall ? ' <span class="in-call-badge">·' + this.call.type + '</span>' : ''}</div>
          ${preview ? `<div class="peer-preview">${preview}</div>` : ''}
        </div>
        <div class="mesh-toggle${blocked ? ' blocked' : ''}" data-fp="${fp}" title="${blocked ? 'add to mesh' : 'remove from mesh'}">⬡</div>
        ${unread ? `<div class="peer-badge">${unread > 9 ? '9+' : unread}</div>` : ''}
      </div>`;
    }).join('');

    list.innerHTML = meshTile + peerTiles;

    list.querySelectorAll('.peer-tile').forEach(t => {
      t.addEventListener('click', () => {
        const fp = t.dataset.fp; if (fp) this._openSession(fp);
      });
    });
    list.querySelectorAll('.mesh-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const fp = btn.dataset.fp; if (fp) this._toggleMesh(fp, e);
      });
    });
  }

  // ── Render: header ─────────────────────────────────────────────────────────
  _renderHeader() {
    const h = $('chat-header'); if (!h) return;
    const fp = this.active;

    // Mesh header
    if (fp === MESH_ID) {
      const connected = this.net.getConnectedPeers().length;
      h.innerHTML = `
        <span id="back-btn" style="display:none">←</span>
        <div class="mesh-icon-hdr">⬡</div>
        <div class="chat-peer-info">
          <div class="chat-peer-name">mesh</div>
          <div class="chat-peer-fp">${connected} peer${connected !== 1 ? 's' : ''} connected · everyone here</div>
        </div>
        <div class="chat-actions">
          <div class="action-btn danger" id="hbtn-clear" title="clear mesh history">🗑</div>
        </div>`;
      $('back-btn')?.addEventListener('click', () => this._showSidebar());
      $('hbtn-clear')?.addEventListener('click', () => this._clearChat(MESH_ID));
      return;
    }

    const p = fp ? this.peers.get(fp) : null;
    if (!fp || !p) {
      h.innerHTML = '<span id="back-btn" style="display:none">←</span><span id="chat-placeholder">select a peer</span>';
      $('back-btn')?.addEventListener('click', () => this._showSidebar());
      return;
    }

    const dot    = p.connected ? 'online' : 'offline';
    const inCall = !!(this.call?.fp === fp);
    h.innerHTML = `
      <span id="back-btn" style="display:none">←</span>
      <div class="peer-dot ${dot}"></div>
      <div class="chat-peer-info">
        <div class="chat-peer-name">${esc(p.nick || fp.slice(0, 8))}</div>
        <div class="chat-peer-fp">${fp}</div>
      </div>
      <div class="chat-actions">
        <div class="action-btn ${inCall ? 'active-call' : ''}" id="hbtn-walkie" title="walkie">🎙</div>
        <div class="action-btn ${inCall ? 'active-call' : ''}" id="hbtn-stream" title="stream">📷</div>
        <div class="action-btn danger" id="hbtn-clear" title="clear chat">🗑</div>
      </div>`;
    $('back-btn')?.addEventListener('click', () => this._showSidebar());
    $('hbtn-walkie')?.addEventListener('click', () => {
      if (inCall) { this.net.sendCtrl(fp, { type: 'call-end' }); this._endCallLocal(false); }
      else this._startCall(fp, 'walkie');
    });
    $('hbtn-stream')?.addEventListener('click', () => {
      if (inCall) { this.net.sendCtrl(fp, { type: 'call-end' }); this._endCallLocal(false); }
      else this._startCall(fp, 'stream');
    });
    $('hbtn-clear')?.addEventListener('click', () => this._clearChat(fp));
  }

  // ── Render: messages ───────────────────────────────────────────────────────
  _renderMsgs() {
    const msgs = $('messages'); if (!msgs) return;
    msgs.innerHTML = '';
    const session = this.sessions.get(this.active) || [];
    if (!session.length) {
      if (this.active === MESH_ID) {
        msgs.innerHTML = '<div class="sys-msg">mesh — send to everyone connected</div>';
      } else {
        msgs.innerHTML = '<div class="sys-msg">no messages yet</div>';
      }
      return;
    }
    const frag = document.createDocumentFragment();
    session.forEach(m => { if (m.type === 'text') frag.appendChild(this._msgEl(m)); });
    msgs.appendChild(frag);
    this._scroll();
  }

  _appendMsg(msg) {
    const msgs = $('messages'); if (!msgs) return;
    const e = msgs.querySelector('.sys-msg');
    if (e && msgs.children.length === 1) e.remove();
    msgs.appendChild(this._msgEl(msg));
    this._scroll();
  }

  _msgEl(msg) {
    const d = document.createElement('div');
    d.className = `msg ${msg.own ? 'own' : 'peer'}`;
    const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    d.innerHTML = `<div class="meta">${msg.own ? 'you' : esc(msg.fromNick || '?')} · ${time}</div><div class="bubble">${esc(msg.text)}</div>`;
    return d;
  }

  _addFileCard(fromNick, fileId, name, size, own) {
    const msgs = $('messages'); if (!msgs || !fileId) return;
    if (document.querySelector(`[data-fcid="${fileId}"]`)) return;
    const e = msgs.querySelector('.sys-msg');
    if (e && msgs.children.length === 1) e.remove();
    const w = document.createElement('div');
    w.className = `msg ${own ? 'own' : 'peer'}`;
    w.innerHTML = `
      <div class="meta">${esc(own ? 'you' : fromNick)} · ${clock()}</div>
      <div class="file-card" data-fcid="${fileId}">
        <div class="file-name">📎 ${esc(name || 'file')}</div>
        <div class="file-size">${fmt(size)}</div>
        <div class="prog-track"><div class="prog-fill" style="width:0%"></div></div>
      </div>`;
    msgs.appendChild(w);
    this._scroll();
  }

  // ── Narrow screen ──────────────────────────────────────────────────────────
  _showChat()    { $('sidebar')?.classList.add('slide-left');    $('chat-area')?.classList.add('slide-in'); }
  _showSidebar() { $('sidebar')?.classList.remove('slide-left'); $('chat-area')?.classList.remove('slide-in'); }

  // ── Status bar — always visible, updates text+colour in place ─────────────
  // duration: ms before reverting to neutral colour (0 = stays coloured)
  // The bar is never hidden — it's a permanent chrome element like a footer.
  _status(text, type = 'info', duration = 0) {
    const bar = $('status-bar'); if (!bar) return;
    clearTimeout(this._statusTimer);
    bar.textContent = text;
    bar.className   = `s-${type}`; // just the colour class — no show/hide
    if (duration) {
      this._statusTimer = setTimeout(() => {
        bar.className = ''; // revert to neutral (var(--tx2))
      }, duration);
    }
  }

  // ── Utilities ──────────────────────────────────────────────────────────────
  _scroll() { const m = $('messages'); if (m) m.scrollTop = m.scrollHeight; }

  _sys(text, isErr = false) {
    const msgs = $('messages'); if (!msgs) return;
    const d = document.createElement('div');
    d.className = `sys-msg${isErr ? ' err' : ''}`;
    d.textContent = text; msgs.appendChild(d);
    this._scroll();
    setTimeout(() => { try { d.remove(); } catch {} }, 5000);
  }

  _log(text, isErr = false) {
    const log = $('net-log'); if (!log) return;
    const d = document.createElement('div');
    d.className = `entry${isErr ? ' err' : ''}`;
    d.textContent = text; log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 120) log.removeChild(log.firstChild);
  }
}
