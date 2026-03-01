/**
 * app.js — Turquoise Phase 5–7
 * Full UI controller: chat, files, voice/video, nickname editing
 * Same interface on every device — responsive via CSS, not separate code paths
 * Murphy's Law: null checks everywhere, every async step caught
 */

import { saveMessage, loadMessages, savePeer, loadPeers } from './messages.js';
import { FileTransfer } from './files.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s || '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmtSize = (b) => {
  if (!b || isNaN(b)) return '?';
  if (b < 1024)           return b + ' B';
  if (b < 1048576)        return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824)     return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
};
const now = () => new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});

// ── App ───────────────────────────────────────────────────────────────────────
export class TurquoiseApp {

  constructor(identity, network) {
    if (!identity?.fingerprint) throw new Error('App: identity.fingerprint required');
    if (!network?.sendCtrl)     throw new Error('App: network.sendCtrl required');

    this.identity = identity;
    this.network  = network;

    // State
    this.peers         = new Map(); // fp → {nick, connected, calling}
    this.sessions      = new Map(); // fp → message[]
    this.active        = null;      // fp | null
    this.unread        = new Map(); // fp → count
    this.incomingCalls = new Map(); // fp → {type:'audio'|'video'}

    // Active call state
    this.call = null; // {fp, localStream, remoteStream, video, muted, camOff}

    // Narrow screen state
    this.chatVisible = false;

    // File engine
    this.ft = new FileTransfer(
      (fp, msg)  => network.sendCtrl(fp, msg),
      (fp, buf)  => network.sendBinary(fp, buf),
      (fp)       => network.waitForBuffer(fp),
    );
    this.ft.onProgress  = (id, pct, dir, fp) => this._onFileProgress(id, pct, dir, fp);
    this.ft.onFileReady = (f)                 => this._onFileReady(f);
    this.ft.onError     = (id, msg, fp)       => this._onFileError(id, msg, fp);
  }

  // ── Mount ──────────────────────────────────────────────────────────────────────
  async mount() {
    // Identity header
    const nick = $('nick-display'), nickIn = $('nick-input'), fp = $('full-fp');
    if (nick)   nick.textContent   = this.identity.nickname;
    if (nickIn) nickIn.value       = this.identity.nickname;
    if (fp)     fp.textContent     = this.identity.fingerprint;

    // Load persisted peers
    try {
      const saved = await loadPeers();
      for (const p of saved) {
        this.peers.set(p.fingerprint, { nick: p.nickname || p.shortId || p.fingerprint.slice(0,8), connected: false, calling: false });
      }
    } catch (e) { this._log('⚠ peer history: ' + e.message, true); }

    this._renderPeerList();
    this._bindEvents();
    this._wireNetwork();
  }

  // ── Events ─────────────────────────────────────────────────────────────────────
  _bindEvents() {
    // Nickname editing
    const row = $('identity-row'), disp = $('nick-display'), inp = $('nick-input');
    if (row && disp && inp) {
      row.addEventListener('click', (e) => {
        if (inp.style.display !== 'none' && inp.style.display !== '') return;
        disp.classList.add('hidden');
        inp.classList.add('visible');
        inp.focus(); inp.select();
      });
      inp.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault();
          await this._saveNickname(inp.value);
          disp.classList.remove('hidden');
          inp.classList.remove('visible');
        }
      });
      inp.addEventListener('blur', async () => {
        await this._saveNickname(inp.value);
        disp.classList.remove('hidden');
        inp.classList.remove('visible');
      });
    }

    // Message input
    const msgIn = $('msg-input'), sendBtn = $('send-btn');
    if (msgIn) {
      msgIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._sendMessage(); }
      });
      msgIn.addEventListener('input', () => {
        msgIn.style.height = 'auto';
        msgIn.style.height = Math.min(msgIn.scrollHeight, 128) + 'px';
      });
    }
    sendBtn?.addEventListener('click', () => this._sendMessage());

    // File button
    const fileBtn = $('file-btn'), fileIn = $('__file-input');
    if (fileBtn && fileIn) {
      fileBtn.addEventListener('click', () => {
        if (!this.active) { this._sysMsg('Select a peer first', true); return; }
        fileIn.click();
      });
      fileIn.addEventListener('change', (e) => {
        Array.from(e.target.files || []).forEach(f => this._queueSend(f));
        fileIn.value = '';
      });
    }

    // Drag & drop
    const chatArea = $('chat-area');
    if (chatArea) {
      chatArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (this.active) chatArea.classList.add('drag-over');
      });
      chatArea.addEventListener('dragleave', () => chatArea.classList.remove('drag-over'));
      chatArea.addEventListener('drop', (e) => {
        e.preventDefault(); chatArea.classList.remove('drag-over');
        if (!this.active) { this._sysMsg('Select a peer first', true); return; }
        Array.from(e.dataTransfer?.files || []).forEach(f => this._queueSend(f));
      });
    }

    // Back button (narrow screens)
    $('back-btn')?.addEventListener('click', () => this._showSidebar());
  }

  // ── Nickname ────────────────────────────────────────────────────────────────────
  async _saveNickname(val) {
    try {
      const saved = await this.identity.saveNickname(val);
      this.identity.nickname = saved;
      const disp = $('nick-display'), inp = $('nick-input');
      if (disp) disp.textContent = saved;
      if (inp)  inp.value        = saved;
      // Notify connected peers
      for (const fp of this.network.getConnectedPeers()) {
        this.network.sendCtrl(fp, { type: 'nick-update', nick: saved });
      }
    } catch (e) { this._log('⚠ nick save: ' + e.message, true); }
  }

  // ── Wire network → app ──────────────────────────────────────────────────────────
  _wireNetwork() {
    const net = this.network;

    net.onPeerConnected = (fp, nick) => this._onPeerConnected(fp, nick);
    net.onPeerDisconnected = (fp)    => this._onPeerDisconnected(fp);

    net.onMessage = (fp, msg) => {
      try { this._handleMsg(fp, msg); }
      catch (e) { this._log('⚠ msg handler: ' + e.message, true); }
    };

    net.onBinaryChunk = (fp, buf) => {
      try { this.ft.handleBinary(fp, buf); }
      catch (e) { this._log('⚠ binary chunk: ' + e.message, true); }
    };

    net.onLog = (text, isErr) => this._log(text, isErr);
  }

  // ── Peer connected ──────────────────────────────────────────────────────────────
  _onPeerConnected(fp, nick) {
    const existing = this.peers.get(fp);
    const name = nick || existing?.nick || fp.slice(0,8);
    this.peers.set(fp, { nick: name, connected: true, calling: false });

    savePeer({ fingerprint: fp, shortId: fp.slice(0,8), nickname: name }).catch(() => {});

    if (!this.sessions.has(fp)) {
      loadMessages(fp).then(msgs => {
        this.sessions.set(fp, msgs);
        if (this.active === fp) this._renderMessages();
        this._renderPeerList();
      }).catch(() => this.sessions.set(fp, []));
    } else {
      this._renderPeerList();
    }

    if (this.active === fp) this._renderHeader();
    this._log(`✓ ${name || fp.slice(0,8)}`);
  }

  // ── Peer disconnected ───────────────────────────────────────────────────────────
  _onPeerDisconnected(fp) {
    const p = this.peers.get(fp);
    if (p) { p.connected = false; p.calling = false; }

    // End call if active
    if (this.call?.fp === fp) this._endCallLocal();

    this._renderPeerList();
    if (this.active === fp) this._renderHeader();
    this._log(`✗ ${p?.nick || fp.slice(0,8)} disconnected`);
  }

  // ── Message dispatcher ──────────────────────────────────────────────────────────
  _handleMsg(fp, msg) {
    const { type } = msg;

    if (type === 'hello') {
      const p = this.peers.get(fp);
      if (p && msg.nick) { p.nick = msg.nick; this._renderPeerList(); }
      return;
    }
    if (type === 'nick-update') {
      const p = this.peers.get(fp);
      if (p && msg.nick) { p.nick = msg.nick; this._renderPeerList(); savePeer({ fingerprint: fp, shortId: fp.slice(0,8), nickname: msg.nick }).catch(() => {}); }
      return;
    }
    if (type === 'chat')        { this._recvMessage(fp, msg); return; }
    if (type === 'file-meta' || type === 'file-end' || type === 'file-abort') {
      this.ft.handleCtrl(fp, msg); return;
    }
    if (type === 'call-invite')  { this._onCallInvite(fp, msg); return; }
    if (type === 'call-accept')  { this._onCallAccepted(fp, msg); return; }
    if (type === 'call-decline') { this._onCallDeclined(fp); return; }
    if (type === 'call-end')     { this._onCallEnd(fp); return; }
    if (type === 'offer-renegotiate') {
      // handled in webrtc.js directly (sets up remote stream)
      this._setupRemoteStream(fp); return;
    }
  }

  // ── Chat ─────────────────────────────────────────────────────────────────────────
  _recvMessage(fp, event) {
    if (!event.text) return;
    const msg = {
      id:        event.id || crypto.randomUUID(),
      sessionId: fp,
      from:      fp,
      fromNick:  event.nick || this.peers.get(fp)?.nick || fp.slice(0,8),
      text:      String(event.text),
      ts:        event.ts || Date.now(),
      type:      'text',
      own:       false,
    };
    if (!this.sessions.has(fp)) this.sessions.set(fp, []);
    this.sessions.get(fp).push(msg);
    saveMessage(msg).catch(() => {});

    if (this.active !== fp) {
      this.unread.set(fp, (this.unread.get(fp) || 0) + 1);
      this._renderPeerList();
    } else {
      this._appendMsg(msg);
      this._renderPeerList();
    }
  }

  _sendMessage() {
    const inp = $('msg-input');
    const text = inp?.value?.trim();
    if (!text || !this.active) return;

    const fp = this.active;
    const msg = {
      id: crypto.randomUUID(), sessionId: fp,
      from: this.identity.fingerprint, fromNick: this.identity.nickname,
      text, ts: Date.now(), type: 'text', own: true,
    };

    const ok = this.network.sendCtrl(fp, {
      type: 'chat', id: msg.id, nick: this.identity.nickname, text, ts: msg.ts,
    });
    if (!ok) { this._sysMsg('Peer offline', true); return; }

    if (!this.sessions.has(fp)) this.sessions.set(fp, []);
    this.sessions.get(fp).push(msg);
    saveMessage(msg).catch(() => {});
    this._appendMsg(msg);
    this._renderPeerList();

    if (inp) { inp.value = ''; inp.style.height = 'auto'; }
  }

  // ── File sending ──────────────────────────────────────────────────────────────
  _queueSend(file) {
    if (!file || !this.active) return;
    const fp     = this.active;
    const fileId = crypto.randomUUID();
    this._addFileCard(this.identity.nickname, fileId, file.name, file.size, true);
    this.ft.sendFile(file, fp, fileId).catch(e => this._onFileError(fileId, e.message, fp));
  }

  _onFileProgress(fileId, pct, dir, fp) {
    const fill = document.querySelector(`#fc-${fileId} .prog-fill`);
    if (fill) fill.style.width = (pct * 100).toFixed(1) + '%';
  }

  _onFileReady(file) {
    const card = document.getElementById(`fc-${file.fileId}`);
    if (!card) return;
    const prog = card.querySelector('.prog-track');
    if (prog) prog.remove();
    if (!card.querySelector('.dl-btn')) {
      const a = document.createElement('a');
      a.className  = 'dl-btn';
      a.href       = file.url;
      a.download   = file.name || 'download';
      a.textContent = '↓ ' + esc(file.name || 'download');
      card.appendChild(a);
    }
  }

  _onFileError(fileId, msg, fp) {
    const card = document.getElementById(`fc-${fileId}`);
    if (card) {
      const err = document.createElement('div');
      err.style.cssText = 'color:var(--err);font-size:.65rem;margin-top:4px';
      err.textContent = '⚠ ' + msg;
      card.appendChild(err);
    }
    this._sysMsg('File error: ' + msg, true);
  }

  // ── Voice / Video ─────────────────────────────────────────────────────────────
  _onCallInvite(fp, msg) {
    const p = this.peers.get(fp);
    if (!p) return;
    p.calling = true;
    this.incomingCalls.set(fp, { type: msg.callType || 'audio' });
    this._renderPeerList();
    this._showCallIncoming(fp, msg.callType || 'audio');
  }

  _showCallIncoming(fp, callType) {
    const panel = $('call-incoming');
    if (!panel) return;
    const p = this.peers.get(fp);
    const name = p?.nick || fp.slice(0,8);
    panel.innerHTML = `
      <div class="incoming-label">${callType} call</div>
      <div class="incoming-name">${esc(name)}</div>
      <div class="incoming-btns">
        <div class="incoming-btn accept" id="call-accept">accept</div>
        <div class="incoming-btn decline" id="call-decline">decline</div>
      </div>`;
    panel.classList.add('visible');

    $('call-accept')?.addEventListener('click', () => {
      this.incomingCalls.delete(fp);
      const p2 = this.peers.get(fp);
      if (p2) p2.calling = false;
      panel.classList.remove('visible');
      this._startCall(fp, callType, false);
    });
    $('call-decline')?.addEventListener('click', () => {
      this.incomingCalls.delete(fp);
      const p2 = this.peers.get(fp);
      if (p2) p2.calling = false;
      panel.classList.remove('visible');
      this.network.sendCtrl(fp, { type: 'call-decline' });
      this._renderPeerList();
    });
  }

  async _startCall(fp, callType, initiator = true) {
    if (this.call) await this._endCallLocal();

    try {
      if (initiator) {
        this.network.sendCtrl(fp, { type: 'call-invite', callType });
      }

      const video = callType === 'video';
      const localStream = await this.network.startMedia(fp, video);

      this.call = { fp, localStream, remoteStream: null, video, muted: false, camOff: false };

      // Watch for remote stream
      this.network.setRemoteStreamHandler(fp, (stream) => {
        if (this.call?.fp === fp) {
          this.call.remoteStream = stream;
          this._renderCallPanel();
        }
      });

      this._openSession(fp);
      this._renderCallPanel();

    } catch (e) {
      this._log('❌ Call failed: ' + e.message, true);
      this._sysMsg('Call failed: ' + e.message, true);
      this.call = null;
    }
  }

  _onCallAccepted(fp) {
    // Remote accepted — nothing needed, media renegotiation handles it
  }

  _onCallDeclined(fp) {
    if (this.call?.fp === fp) {
      this.call = null;
      this._renderCallPanel();
    }
    this._sysMsg('Call declined');
  }

  _onCallEnd(fp) {
    if (this.call?.fp === fp) {
      this._endCallLocal();
      this._sysMsg('Call ended');
    }
  }

  async _endCallLocal() {
    if (!this.call) return;
    const fp = this.call.fp;
    this.call.localStream?.getTracks().forEach(t => t.stop());
    await this.network.stopMedia(fp);
    this.call = null;
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

    const { localStream, remoteStream, video, muted, camOff } = this.call;
    panel.classList.add('visible');

    let videoHTML = '';
    if (video) {
      videoHTML = `<div class="video-grid">
        <div class="video-wrap" id="vw-remote">
          <video id="vid-remote" autoplay playsinline></video>
          <div class="video-label">${esc(this.peers.get(this.call.fp)?.nick || '?')}</div>
        </div>
        <div class="video-wrap local" id="vw-local">
          <video id="vid-local" autoplay playsinline muted></video>
          <div class="video-label">you</div>
        </div>
      </div>`;
    }

    panel.innerHTML = videoHTML + `
      <div class="call-controls">
        <div class="call-btn ${muted ? 'muted' : ''}" id="btn-mute" title="${muted ? 'unmute' : 'mute'}">🎙</div>
        ${video ? `<div class="call-btn ${camOff ? 'muted' : ''}" id="btn-cam" title="${camOff ? 'camera on' : 'camera off'}">📷</div>` : ''}
        <div class="call-btn end" id="btn-end">end</div>
      </div>`;

    // Attach streams
    const vidLocal  = $('vid-local');
    const vidRemote = $('vid-remote');
    if (vidLocal && localStream)  vidLocal.srcObject  = localStream;
    if (vidRemote && remoteStream) vidRemote.srcObject = remoteStream;

    $('btn-mute')?.addEventListener('click', () => {
      if (!this.call) return;
      this.call.muted = !this.call.muted;
      this.call.localStream?.getAudioTracks().forEach(t => t.enabled = !this.call.muted);
      this._renderCallPanel();
    });
    $('btn-cam')?.addEventListener('click', () => {
      if (!this.call) return;
      this.call.camOff = !this.call.camOff;
      this.call.localStream?.getVideoTracks().forEach(t => t.enabled = !this.call.camOff);
      this._renderCallPanel();
    });
    $('btn-end')?.addEventListener('click', () => {
      this.network.sendCtrl(this.call.fp, { type: 'call-end' });
      this._endCallLocal();
    });
  }

  _setupRemoteStream(fp) {
    this.network.setRemoteStreamHandler(fp, (stream) => {
      if (this.call?.fp === fp) {
        this.call.remoteStream = stream;
        this._renderCallPanel();
      }
    });
  }

  // ── Session ────────────────────────────────────────────────────────────────────
  async _openSession(fp) {
    if (!fp) return;
    this.active = fp;
    this.unread.delete(fp);

    if (!this.sessions.has(fp)) {
      try {
        const msgs = await loadMessages(fp);
        this.sessions.set(fp, msgs);
      } catch { this.sessions.set(fp, []); }
    }

    this._renderHeader();
    this._renderMessages();
    this._renderPeerList();
    this._renderCallPanel();

    const ib = $('input-bar');
    if (ib) ib.classList.add('visible');
    $('msg-input')?.focus();

    this._showChat(); // narrow screen: reveal chat panel
  }

  // ── Render: peer list ──────────────────────────────────────────────────────────
  _renderPeerList() {
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

    list.innerHTML = sorted.map(([fp, peer]) => {
      const active  = fp === this.active ? ' active' : '';
      const dot     = peer.calling ? 'calling' : peer.connected ? 'online' : 'offline';
      const unread  = this.unread.get(fp) || 0;
      const msgs    = this.sessions.get(fp) || [];
      const last    = msgs[msgs.length - 1];
      const preview = last ? (last.type === 'text' ? esc(last.text.slice(0,40)) : '📎 file') : '';
      const callBadge = peer.calling ? '<span class="peer-call-badge">calling</span>' : '';
      const badge   = unread ? `<div class="peer-badge">${unread > 9 ? '9+' : unread}</div>` : '';

      return `<div class="peer-tile${active}" data-fp="${fp}">
        <div class="peer-dot ${dot}"></div>
        <div class="peer-info">
          <div class="peer-nick">${esc(peer.nick || fp.slice(0,8))}</div>
          ${preview ? `<div class="peer-preview">${preview}</div>` : ''}
        </div>
        ${callBadge}${badge}
      </div>`;
    }).join('');

    list.querySelectorAll('.peer-tile').forEach(tile => {
      tile.addEventListener('click', () => {
        const fp = tile.dataset.fp;
        if (fp) this._openSession(fp);
      });
    });
  }

  // ── Render: header ─────────────────────────────────────────────────────────────
  _renderHeader() {
    const header = $('chat-header');
    if (!header) return;

    const fp   = this.active;
    const peer = fp ? this.peers.get(fp) : null;

    if (!fp || !peer) {
      header.innerHTML = '<span id="back-btn" style="display:none">←</span><span id="chat-placeholder">select a peer</span>';
      this._rebindBack(); return;
    }

    const dot   = this.call?.fp === fp ? 'calling' : peer.connected ? 'online' : 'offline';
    const inCall = this.call?.fp === fp;
    const isVideo = this.call?.video;

    header.innerHTML = `
      <span id="back-btn" style="display:none">←</span>
      <div class="peer-dot ${dot}"></div>
      <div class="chat-peer-info">
        <div class="chat-peer-name">${esc(peer.nick || fp.slice(0,8))}</div>
        <div class="chat-peer-fp">${fp}</div>
      </div>
      <div class="chat-actions">
        <div class="action-btn ${inCall && !isVideo ? 'active' : ''}" id="btn-audio-call" title="voice call">🎙</div>
        <div class="action-btn ${inCall && isVideo ? 'active' : ''}" id="btn-video-call" title="video call">📷</div>
      </div>`;

    this._rebindBack();

    $('btn-audio-call')?.addEventListener('click', () => {
      if (this.call?.fp === fp) { this.network.sendCtrl(fp, {type:'call-end'}); this._endCallLocal(); }
      else this._startCall(fp, 'audio', true);
    });
    $('btn-video-call')?.addEventListener('click', () => {
      if (this.call?.fp === fp) { this.network.sendCtrl(fp, {type:'call-end'}); this._endCallLocal(); }
      else this._startCall(fp, 'video', true);
    });
  }

  _rebindBack() {
    const bb = $('back-btn');
    if (!bb) return;
    // CSS handles visibility on narrow screens
    bb.addEventListener('click', () => this._showSidebar());
  }

  // ── Render: messages ───────────────────────────────────────────────────────────
  _renderMessages() {
    const msgs = $('messages');
    if (!msgs) return;
    msgs.innerHTML = '';

    const session = this.sessions.get(this.active) || [];
    if (!session.length) {
      msgs.innerHTML = '<div class="sys-msg">no messages yet</div>'; return;
    }
    const frag = document.createDocumentFragment();
    session.forEach(m => m.type === 'text' && frag.appendChild(this._buildMsgEl(m)));
    msgs.appendChild(frag);
    this._scroll();
  }

  _appendMsg(msg) {
    const msgs = $('messages');
    if (!msgs) return;
    const empty = msgs.querySelector('#empty-state,.sys-msg');
    if (empty && msgs.children.length === 1) empty.remove();
    msgs.appendChild(this._buildMsgEl(msg));
    this._scroll();
  }

  _buildMsgEl(msg) {
    const div      = document.createElement('div');
    div.className  = `msg ${msg.own ? 'own' : 'peer'}`;
    const time     = new Date(msg.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    const who      = msg.own ? 'you' : esc(msg.fromNick || '?');
    div.innerHTML  = `<div class="meta">${who} · ${time}</div><div class="bubble">${esc(msg.text)}</div>`;
    return div;
  }

  _addFileCard(fromNick, fileId, name, size, own) {
    const msgs = $('messages');
    if (!msgs) return;
    const empty = msgs.querySelector('#empty-state,.sys-msg');
    if (empty && msgs.children.length === 1) empty.remove();

    const wrapper     = document.createElement('div');
    wrapper.className = `msg ${own ? 'own' : 'peer'}`;
    wrapper.innerHTML = `
      <div class="meta">${esc(own ? 'you' : fromNick)} · ${now()}</div>
      <div class="file-card" id="fc-${fileId}">
        <div class="file-name">📎 ${esc(name || 'file')}</div>
        <div class="file-size">${fmtSize(size)}</div>
        <div class="prog-track"><div class="prog-fill" style="width:0%"></div></div>
      </div>`;
    msgs.appendChild(wrapper);
    this._scroll();
  }

  // ── Narrow screen panel management ────────────────────────────────────────────
  _showChat() {
    const sidebar = $('sidebar'), chat = $('chat-area');
    if (!sidebar || !chat) return;
    sidebar.classList.add('slide-left');
    chat.classList.add('slide-in');
    this.chatVisible = true;
  }

  _showSidebar() {
    const sidebar = $('sidebar'), chat = $('chat-area');
    if (!sidebar || !chat) return;
    sidebar.classList.remove('slide-left');
    chat.classList.remove('slide-in');
    this.chatVisible = false;
  }

  // ── Utilities ──────────────────────────────────────────────────────────────────
  _scroll() {
    const msgs = $('messages');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  }

  _sysMsg(text, isErr = false) {
    const msgs = $('messages');
    if (!msgs) { console.warn(text); return; }
    const div     = document.createElement('div');
    div.className = `sys-msg${isErr ? ' err' : ''}`;
    div.textContent = text;
    msgs.appendChild(div);
    this._scroll();
    setTimeout(() => { try { div.remove(); } catch {} }, 5000);
  }

  _log(text, isErr = false) {
    const log = $('net-log');
    if (!log) return;
    const div     = document.createElement('div');
    div.className = `entry${isErr ? ' err' : isErr === false && text.includes('✓') ? ' ok' : ''}`;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 120) log.removeChild(log.firstChild);
  }
}
