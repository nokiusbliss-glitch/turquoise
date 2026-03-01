/**
 * app.js — Turquoise
 * UI controller: chat, files, voice/video
 *
 * Render = website delivery + WebRTC signaling only.
 * After P2P handshake, ALL data is direct device-to-device over local WiFi.
 * No messages, files, audio, or video ever go through Render.
 *
 * Call flow (simplified — no accept/decline):
 *   Initiator clicks mic/camera → startMedia() → sends offer-reneg via P2P ctrl
 *   Receiver receives offer-reneg → answerMedia() auto-opens mic/camera → connected
 *   Either side clicks "end" → call-end message → both clean up
 *
 * File transfer:
 *   Sender:   _queueFile() → ft.send() → creates file card UI → sends binary chunks
 *   Receiver: file-meta ctrl msg → creates file card UI → receives chunks → download link
 *
 * Audio: always routed to loudspeaker (default device, setSinkId where supported)
 * Video: double-tap remote video to toggle fullscreen
 */

import { saveMessage, loadMessages, savePeer, loadPeers } from './messages.js';
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
const ts = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export class TurquoiseApp {
  constructor(identity, network) {
    if (!identity?.fingerprint) throw new Error('App: identity required');
    if (!network?.sendCtrl)     throw new Error('App: network required');
    this.id       = identity;
    this.net      = network;
    this.peers    = new Map();   // fp → {nick, connected}
    this.sessions = new Map();   // fp → msg[]
    this.active   = null;
    this.unread   = new Map();   // fp → count
    this.call     = null;        // {fp, video, muted, camOff, localStream, remoteStream}

    // Hidden audio element — always-on remote audio, loudspeaker by default
    this._audioEl = document.createElement('audio');
    this._audioEl.autoplay   = true;
    this._audioEl.playsInline = true;
    this._audioEl.controls   = false;
    this._audioEl.style.display = 'none';
    document.body.appendChild(this._audioEl);

    this.ft = new FileTransfer(
      (fp, msg) => network.sendCtrl(fp, msg),
      (fp, buf) => network.sendBinary(fp, buf),
      (fp)      => network.waitForBuffer(fp),
    );
    this.ft.onProgress  = (id, pct)   => this._onFileProg(id, pct);
    this.ft.onFileReady = (f)         => this._onFileReady(f);
    this.ft.onError     = (id, msg)   => this._onFileErr(id, msg);
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

    this._renderPeers();
    this._bind();
    this._wire();
  }

  // ── Event binding ──────────────────────────────────────────────────────────
  _bind() {
    // Nickname edit
    const row = $('identity-row'), disp = $('nick-display'), inp = $('nick-input');
    if (row && disp && inp) {
      row.addEventListener('click', () => {
        if (inp.classList.contains('visible')) return;
        disp.classList.add('hidden'); inp.classList.add('visible'); inp.focus(); inp.select();
      });
      const saveNick = async () => {
        const saved = await this.id.saveNickname(inp.value).catch(() => this.id.nickname);
        this.id.nickname = saved;
        if (disp) disp.textContent = saved;
        if (inp)  inp.value        = saved;
        disp.classList.remove('hidden'); inp.classList.remove('visible');
        this.net.getConnectedPeers().forEach(fp => this.net.sendCtrl(fp, { type: 'nick-update', nick: saved }));
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); saveNick(); } });
      inp.addEventListener('blur', saveNick);
    }

    // Message send
    const mi = $('msg-input'), sb = $('send-btn');
    if (mi) {
      mi.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._send(); } });
      mi.addEventListener('input', () => { mi.style.height = 'auto'; mi.style.height = Math.min(mi.scrollHeight, 128) + 'px'; });
    }
    sb?.addEventListener('click', () => this._send());

    // File button
    const fb = $('file-btn'), fi = $('__file-input');
    if (fb && fi) {
      fb.addEventListener('click', () => { if (!this.active) { this._sys('Select a peer first', true); return; } fi.click(); });
      fi.addEventListener('change', (e) => { Array.from(e.target.files || []).forEach(f => this._queueFile(f)); fi.value = ''; });
    }

    // Drag & drop
    const ca = $('chat-area');
    if (ca) {
      ca.addEventListener('dragover',  (e) => { e.preventDefault(); if (this.active) ca.classList.add('drag-over'); });
      ca.addEventListener('dragleave', () => ca.classList.remove('drag-over'));
      ca.addEventListener('drop', (e) => {
        e.preventDefault(); ca.classList.remove('drag-over');
        if (!this.active) { this._sys('Select a peer first', true); return; }
        Array.from(e.dataTransfer?.files || []).forEach(f => this._queueFile(f));
      });
    }

    // Back button (narrow)
    $('back-btn')?.addEventListener('click', () => this._showSidebar());
  }

  // ── Wire network callbacks ─────────────────────────────────────────────────
  _wire() {
    const n = this.net;
    n.onPeerConnected    = (fp, nick) => this._onConnect(fp, nick);
    n.onPeerDisconnected = (fp)       => this._onDisconnect(fp);
    n.onMessage          = (fp, msg)  => { try { this._dispatch(fp, msg); } catch (e) { this._log('⚠ msg: ' + e.message, true); } };
    n.onBinaryChunk      = (fp, buf)  => { try { this.ft.handleBinary(fp, buf); } catch (e) { this._log('⚠ binary: ' + e.message, true); } };
    n.onLog              = (t, e)     => this._log(t, e);
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
    this._log(`✓ ${name} connected`);
  }

  _onDisconnect(fp) {
    const p = this.peers.get(fp);
    if (p) p.connected = false;
    if (this.call?.fp === fp) this._endCallLocal();
    this._renderPeers();
    if (this.active === fp) this._renderHeader();
  }

  // ── Message dispatcher ─────────────────────────────────────────────────────
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
        savePeer({ fingerprint: fp, shortId: fp.slice(0, 8), nickname: msg.nick }).catch(() => {});
      }
      return;
    }
    if (type === 'chat') { this._recv(fp, msg); return; }

    // File transfer
    if (type === 'file-meta') {
      // Create card on receiver side so download link has somewhere to appear
      const nick = this.peers.get(fp)?.nick || fp.slice(0, 8);
      this._addFileCard(nick, msg.fileId, msg.name, msg.size, false);
      this.ft.handleCtrl(fp, msg);
      return;
    }
    if (type === 'file-end' || type === 'file-abort') {
      this.ft.handleCtrl(fp, msg);
      return;
    }

    // Call: receiver auto-answers (no invite/accept/decline UI)
    if (type === 'offer-reneg') {
      this._onIncomingMedia(fp, msg);
      return;
    }
    if (type === 'call-end') {
      this._onCallEnd(fp);
      return;
    }
  }

  // ── Chat ───────────────────────────────────────────────────────────────────
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

  _send() {
    const inp  = $('msg-input');
    const text = inp?.value?.trim();
    if (!text || !this.active) return;
    const fp  = this.active;
    const msg = {
      id: crypto.randomUUID(), sessionId: fp, from: this.id.fingerprint,
      fromNick: this.id.nickname, text, ts: Date.now(), type: 'text', own: true,
    };
    if (!this.net.sendCtrl(fp, { type: 'chat', id: msg.id, nick: this.id.nickname, text, ts: msg.ts })) {
      this._sys('Peer offline', true); return;
    }
    if (!this.sessions.has(fp)) this.sessions.set(fp, []);
    this.sessions.get(fp).push(msg);
    saveMessage(msg).catch(() => {});
    this._appendMsg(msg);
    this._renderPeers();
    if (inp) { inp.value = ''; inp.style.height = 'auto'; }
  }

  // ── Files ──────────────────────────────────────────────────────────────────
  _queueFile(file) {
    if (!file || !this.active) return;
    const fileId = crypto.randomUUID();
    this._addFileCard(this.id.nickname, fileId, file.name, file.size, true);
    this.ft.send(file, this.active, fileId);
  }

  _onFileProg(fileId, pct) {
    const fill = document.querySelector(`[data-fcid="${fileId}"] .prog-fill`);
    if (fill) fill.style.width = (pct * 100).toFixed(1) + '%';
  }

  _onFileReady(f) {
    const card = document.querySelector(`[data-fcid="${f.fileId}"]`);
    if (!card) return;
    card.querySelector('.prog-track')?.remove();
    if (!card.querySelector('.dl-btn')) {
      const a = document.createElement('a');
      a.className = 'dl-btn';
      a.href = f.url;
      a.download = f.name || 'file';
      a.textContent = '↓ ' + esc(f.name || 'file');
      card.appendChild(a);
    }
  }

  _onFileErr(fileId, errMsg) {
    const card = document.querySelector(`[data-fcid="${fileId}"]`);
    if (card) {
      const d = document.createElement('div');
      d.style.cssText = 'color:var(--err);font-size:.65rem;margin-top:4px';
      d.textContent = '⚠ ' + errMsg;
      card.appendChild(d);
    }
    this._sys('File error: ' + errMsg, true);
  }

  // ── Voice / Video ──────────────────────────────────────────────────────────

  // Initiator: called when user clicks mic/camera button
  async _startCall(fp, callType) {
    if (this.call) await this._endCallLocal();
    try {
      const video       = callType === 'video';
      const localStream = await this.net.startMedia(fp, video);
      this.call = { fp, video, muted: false, camOff: false, localStream, remoteStream: null };
      this._attachRemote(fp);
      this._openSession(fp);
      this._renderCallPanel();
    } catch (e) {
      this._log('❌ Call failed: ' + e.message, true);
      this._sys('Call failed: ' + e.message, true);
      this.call = null;
    }
  }

  // Receiver: auto-answers without any UI prompt
  async _onIncomingMedia(fp, msg) {
    // If already in a different call, ignore
    if (this.call && this.call.fp !== fp) return;
    try {
      const video       = msg.callType === 'video';
      const localStream = await this.net.answerMedia(fp, msg.sdp, video);
      this.call = { fp, video, muted: false, camOff: false, localStream, remoteStream: null };
      this._attachRemote(fp);
      this._openSession(fp);
      this._renderCallPanel();
    } catch (e) {
      this._log('❌ Answer failed: ' + e.message, true);
      this._sys('Could not open mic/camera: ' + e.message, true);
    }
  }

  _attachRemote(fp) {
    this.net.setRemoteStreamHandler(fp, (stream) => {
      if (!stream) return;

      // Wire audio to persistent element — loudspeaker default
      this._audioEl.srcObject = stream;
      // setSinkId('') = default output = loudspeaker on most devices
      if (typeof this._audioEl.setSinkId === 'function') {
        this._audioEl.setSinkId('').catch(() => {});
      }
      this._audioEl.play().catch(() => {});

      // Wire video if in a video call
      if (this.call?.fp === fp) {
        this.call.remoteStream = stream;
        this._renderCallPanel();
      }
    });
  }

  _onCallEnd(fp) {
    if (this.call?.fp === fp) {
      this._endCallLocal();
      this._sys('Call ended');
    }
  }

  async _endCallLocal() {
    if (!this.call) return;
    const fp = this.call.fp;
    this.call = null;
    await this.net.stopMedia(fp);
    this._audioEl.srcObject = null;
    this._renderCallPanel();
  }

  _renderCallPanel() {
    const panel = $('call-panel');
    if (!panel) return;

    if (!this.call) {
      panel.innerHTML = '';
      panel.classList.remove('visible');
      return;
    }

    const { fp, video, muted, camOff, localStream, remoteStream } = this.call;
    const peerName = this.peers.get(fp)?.nick || fp.slice(0, 8);
    panel.classList.add('visible');

    let videoHTML = '';
    if (video) {
      videoHTML = `
        <div class="video-grid" id="video-grid">
          <div class="video-wrap" id="vw-remote">
            <video id="vid-remote" autoplay playsinline></video>
            <div class="video-label">${esc(peerName)}</div>
          </div>
          <div class="video-wrap local">
            <video id="vid-local" autoplay playsinline muted></video>
            <div class="video-label">you</div>
          </div>
        </div>`;
    }

    panel.innerHTML = videoHTML + `
      <div class="call-controls">
        <div class="call-btn ${muted ? 'muted' : ''}" id="cb-mute">🎙 ${muted ? 'unmute' : 'mute'}</div>
        ${video ? `<div class="call-btn ${camOff ? 'muted' : ''}" id="cb-cam">📷 ${camOff ? 'cam off' : 'cam on'}</div>` : ''}
        ${video ? `<div class="call-btn" id="cb-fs">⛶ fullscreen</div>` : ''}
        <div class="call-btn end" id="cb-end">✕ end</div>
      </div>`;

    // Attach streams
    const vr = $('vid-remote'), vl = $('vid-local');
    if (vr && remoteStream) {
      vr.srcObject = remoteStream;
      // Double-tap/click for fullscreen
      vr.addEventListener('dblclick', () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else vr.requestFullscreen?.();
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
      const vr2 = $('vid-remote');
      if (!vr2) return;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else vr2.requestFullscreen?.();
    });
    $('cb-end')?.addEventListener('click', () => {
      if (this.call) this.net.sendCtrl(this.call.fp, { type: 'call-end' });
      this._endCallLocal();
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
    const ib = $('input-bar');
    if (ib) ib.classList.add('visible');
    $('msg-input')?.focus();
    this._showChat();
  }

  // ── Render: peer list ──────────────────────────────────────────────────────
  _renderPeers() {
    const list = $('peer-list');
    if (!list) return;
    if (!this.peers.size) {
      list.innerHTML = '<div id="no-peers">waiting for peers…</div>';
      return;
    }

    const sorted = [...this.peers.entries()].sort(([, a], [, b]) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return (a.nick || '').localeCompare(b.nick || '');
    });

    list.innerHTML = sorted.map(([fp, p]) => {
      const active  = fp === this.active ? ' active' : '';
      const dot     = p.connected ? 'online' : 'offline';
      const unread  = this.unread.get(fp) || 0;
      const msgs    = this.sessions.get(fp) || [];
      const last    = msgs[msgs.length - 1];
      const preview = last ? (last.type === 'text' ? esc(last.text.slice(0, 42)) : '📎 file') : '';
      return `<div class="peer-tile${active}" data-fp="${fp}">
        <div class="peer-dot ${dot}"></div>
        <div class="peer-info">
          <div class="peer-nick">${esc(p.nick || fp.slice(0, 8))}</div>
          ${preview ? `<div class="peer-preview">${preview}</div>` : ''}
        </div>
        ${unread ? `<div class="peer-badge">${unread > 9 ? '9+' : unread}</div>` : ''}
      </div>`;
    }).join('');

    list.querySelectorAll('.peer-tile').forEach(t => {
      t.addEventListener('click', () => { const fp = t.dataset.fp; if (fp) this._openSession(fp); });
    });
  }

  // ── Render: chat header ────────────────────────────────────────────────────
  _renderHeader() {
    const h = $('chat-header');
    if (!h) return;
    const fp = this.active, p = fp ? this.peers.get(fp) : null;
    if (!fp || !p) {
      h.innerHTML = '<span id="back-btn" style="display:none">←</span><span id="chat-placeholder">select a peer</span>';
      $('back-btn')?.addEventListener('click', () => this._showSidebar());
      return;
    }
    const dot = p.connected ? 'online' : 'offline';
    const inCall = this.call?.fp === fp;
    h.innerHTML = `
      <span id="back-btn" style="display:none">←</span>
      <div class="peer-dot ${dot}"></div>
      <div class="chat-peer-info">
        <div class="chat-peer-name">${esc(p.nick || fp.slice(0, 8))}</div>
        <div class="chat-peer-fp">${fp}</div>
      </div>
      <div class="chat-actions">
        <div class="action-btn ${inCall ? 'active-call' : ''}" id="hbtn-audio" title="voice call">🎙</div>
        <div class="action-btn ${inCall ? 'active-call' : ''}" id="hbtn-video" title="video call">📷</div>
      </div>`;
    $('back-btn')?.addEventListener('click', () => this._showSidebar());
    $('hbtn-audio')?.addEventListener('click', () => {
      if (this.call?.fp === fp) { this.net.sendCtrl(fp, { type: 'call-end' }); this._endCallLocal(); }
      else this._startCall(fp, 'audio');
    });
    $('hbtn-video')?.addEventListener('click', () => {
      if (this.call?.fp === fp) { this.net.sendCtrl(fp, { type: 'call-end' }); this._endCallLocal(); }
      else this._startCall(fp, 'video');
    });
  }

  // ── Render: messages ───────────────────────────────────────────────────────
  _renderMsgs() {
    const msgs = $('messages');
    if (!msgs) return;
    msgs.innerHTML = '';
    const session = this.sessions.get(this.active) || [];
    if (!session.length) { msgs.innerHTML = '<div class="sys-msg">no messages yet</div>'; return; }
    const frag = document.createDocumentFragment();
    session.forEach(m => { if (m.type === 'text') frag.appendChild(this._msgEl(m)); });
    msgs.appendChild(frag);
    this._scroll();
  }

  _appendMsg(msg) {
    const msgs = $('messages');
    if (!msgs) return;
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
    const msgs = $('messages');
    if (!msgs || !fileId) return;
    // Avoid duplicate cards
    if (document.querySelector(`[data-fcid="${fileId}"]`)) return;
    const e = msgs.querySelector('.sys-msg');
    if (e && msgs.children.length === 1) e.remove();
    const w = document.createElement('div');
    w.className = `msg ${own ? 'own' : 'peer'}`;
    w.innerHTML = `
      <div class="meta">${esc(own ? 'you' : fromNick)} · ${ts()}</div>
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

  // ── Utilities ──────────────────────────────────────────────────────────────
  _scroll() { const m = $('messages'); if (m) m.scrollTop = m.scrollHeight; }

  _sys(text, isErr = false) {
    const msgs = $('messages');
    if (!msgs) return;
    const d = document.createElement('div');
    d.className = `sys-msg${isErr ? ' err' : ''}`;
    d.textContent = text;
    msgs.appendChild(d);
    this._scroll();
    setTimeout(() => { try { d.remove(); } catch {} }, 4000);
  }

  _log(text, isErr = false) {
    const log = $('net-log');
    if (!log) return;
    const d = document.createElement('div');
    d.className = `entry${isErr ? ' err' : ''}`;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 120) log.removeChild(log.firstChild);
  }
}
