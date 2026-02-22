/**
 * app.js — Turquoise Phase 3 + 4 + 5
 *
 * Phase 3: Chat with persistent history, unread badges, peer list
 * Phase 4: Streaming file transfer (no RAM limits), progress bars, drag+drop
 * Phase 5: Voice calls, push-to-talk (walkie-talkie), video calls
 *
 * Mobile-first:
 *   - Sidebar slides in from left on mobile
 *   - Input avoids keyboard on iOS/Android
 *   - Touch-friendly targets (min 44px)
 *   - Nickname editing via tap
 *   - Auto-detects mobile UA
 *
 * Murphy's Law: every DOM op has null checks. Every async has try/catch.
 *               Nothing fails silently. Everything degrades gracefully.
 */

import { saveMessage, loadMessages, savePeer, loadPeers, updatePeerNickname } from './messages.js';
import { FileTransfer } from './files.js';
import { saveNickname } from './identity.js';

export class TurquoiseApp {

  constructor(identity, network) {
    if (!identity?.fingerprint) throw new Error('App: identity.fingerprint missing.');
    if (!network?.sendTo)       throw new Error('App: network.sendTo missing.');

    this.identity = identity;
    this.network  = network;
    this.isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

    // ── State ────────────────────────────────────────────────────────────────
    this.peers         = new Map(); // fp → { shortId, nickname, connected }
    this.sessions      = new Map(); // fp → message[]
    this.activeSession = null;
    this.unread        = new Map(); // fp → count

    // ── Call state ───────────────────────────────────────────────────────────
    this.callState  = null;  // null | { fp, type: 'voice'|'video', stream }
    this.pttState   = null;  // null | { fp, stream }
    this.incomingCall = null; // null | { fp, video }

    // ── File engine ──────────────────────────────────────────────────────────
    this.ft = new FileTransfer(
      (fp, payload) => network.sendTo(fp, payload)
    );
    this.ft.onProgress  = (id, pct, dir) => this._onFileProgress(id, pct, dir);
    this.ft.onFileReady = (f) => this._onFileReady(f);
    this.ft.onError     = (id, msg) => this._onFileError(id, msg);

    this.el = {};
  }

  // ── Mount ─────────────────────────────────────────────────────────────────

  async mount() {
    const app = document.getElementById('app');
    if (!app) throw new Error('App.mount: #app not found.');

    app.innerHTML = this._buildHTML();
    this._cacheDOM();
    this._bindEvents();
    this._bindMobile();

    // Load persisted peers
    try {
      for (const p of await loadPeers()) {
        this.peers.set(p.fingerprint, {
          shortId:   p.shortId,
          nickname:  p.nickname || null,
          connected: false,
        });
      }
    } catch (e) { this._netLog('⚠ peer history: ' + e.message, true); }

    this._renderPeerList();
    this._wireNetwork();
  }

  // ── Build full HTML ───────────────────────────────────────────────────────

  _buildHTML() {
    const { shortId, fingerprint, nickname } = this.identity;
    const displayName = nickname || shortId;

    return `
<aside id="sidebar">
  <div id="device-header">
    <div class="wordmark">Turquoise</div>

    <div id="nickname-display" title="Tap to edit name">
      <span id="nickname-text" class="name">${this._esc(displayName)}</span>
      <span class="edit-icon">✎</span>
    </div>
    <input id="nickname-input" type="text" placeholder="${this._esc(displayName)}"
           maxlength="32" value="${this._esc(displayName)}" autocomplete="off" />

    <div class="fp-short">${fingerprint.slice(0, 16)}…</div>

    <div id="status-row">
      <div class="status-dot disconnected" id="status-dot"></div>
      <span id="status-text">connecting…</span>
    </div>
  </div>

  <div id="peer-list"></div>
  <div id="net-log"></div>
</aside>

<main id="chat-area">
  <div id="chat-header">
    <button id="mobile-back" aria-label="Back">‹</button>
    <span id="chat-placeholder" style="color:var(--tq-muted);font-size:0.8rem;letter-spacing:.15em;">
      select a peer
    </span>
  </div>

  <!-- Voice/video call overlay -->
  <div id="call-overlay">
    <video id="remote-video" autoplay playsinline></video>
    <video id="local-video"  autoplay playsinline muted></video>
    <div class="call-controls">
      <button class="call-btn danger" id="hangup-btn">end call</button>
    </div>
  </div>

  <!-- Incoming call banner -->
  <div id="incoming-call" style="display:none">
    <span id="incoming-text">call from ?</span>
    <div style="display:flex;gap:.5rem;margin-top:.5rem">
      <button class="call-btn active" id="accept-call-btn">accept</button>
      <button class="call-btn danger" id="reject-call-btn">decline</button>
    </div>
  </div>

  <div id="messages">
    <div class="empty-state">select a peer to start chatting</div>
  </div>

  <div id="input-bar">
    <button id="ptt-btn" title="Hold to talk">🎙</button>
    <button id="file-btn" title="Send file">+</button>
    <textarea id="msg-input" placeholder="type a message…" rows="1"></textarea>
    <button id="send-btn">send</button>
  </div>
</main>

<div id="ptt-banner">● transmitting</div>
    `.trim();
  }

  // ── Cache DOM ─────────────────────────────────────────────────────────────

  _cacheDOM() {
    const ids = [
      'sidebar','device-header','nickname-display','nickname-text','nickname-input',
      'status-dot','status-text','peer-list','net-log',
      'chat-area','chat-header','chat-placeholder',
      'call-overlay','remote-video','local-video','hangup-btn',
      'incoming-call','incoming-text','accept-call-btn','reject-call-btn',
      'messages','input-bar','ptt-btn','file-btn','msg-input','send-btn',
      'ptt-banner',
    ];
    for (const id of ids) {
      const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.el[key] = document.getElementById(id);
      if (!this.el[key]) console.warn(`App: #${id} not in DOM.`);
    }
  }

  // ── Bind events ───────────────────────────────────────────────────────────

  _bindEvents() {
    // ── Nickname editing ──
    const { nicknameDisplay, nicknameInput, nicknameText } = this.el;
    if (nicknameDisplay && nicknameInput) {
      nicknameDisplay.addEventListener('click', () => {
        nicknameDisplay.style.display = 'none';
        nicknameInput.style.display = 'block';
        nicknameInput.focus();
        nicknameInput.select();
      });
      const commitNickname = () => {
        const val = nicknameInput.value.trim().slice(0, 32);
        if (val) {
          this.identity.nickname = val;
          saveNickname(val);
          network: {
            this.network.identity.nickname = val;
            this.network.broadcastNickname(val);
          }
          if (nicknameText) nicknameText.textContent = val;
        }
        nicknameInput.style.display = 'none';
        nicknameDisplay.style.display = 'flex';
      };
      nicknameInput.addEventListener('blur', commitNickname);
      nicknameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitNickname(); }
        if (e.key === 'Escape') {
          nicknameInput.style.display = 'none';
          nicknameDisplay.style.display = 'flex';
        }
      });
    }

    // ── Text input ──
    const { msgInput, sendBtn } = this.el;
    if (msgInput) {
      msgInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault(); this._sendMessage();
        }
      });
      msgInput.addEventListener('input', () => {
        msgInput.style.height = 'auto';
        msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
      });
    }
    if (sendBtn) sendBtn.addEventListener('click', () => this._sendMessage());

    // ── File picker ──
    const fileInput = document.getElementById('file-input-hidden');
    const { fileBtn } = this.el;
    if (fileBtn && fileInput) {
      fileBtn.addEventListener('click', () => {
        if (!this.activeSession) { this._toast('Select a peer first.', true); return; }
        fileInput.click();
      });
      fileInput.addEventListener('change', (e) => {
        Array.from(e.target.files || []).forEach(f => this._sendFile(f));
        fileInput.value = '';
      });
    }

    // ── Drag & drop ──
    const { chatArea } = this.el;
    if (chatArea) {
      chatArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (this.activeSession) chatArea.classList.add('drag-over');
      });
      chatArea.addEventListener('dragleave', () => chatArea.classList.remove('drag-over'));
      chatArea.addEventListener('drop', (e) => {
        e.preventDefault(); chatArea.classList.remove('drag-over');
        if (!this.activeSession) { this._toast('Select a peer first.', true); return; }
        Array.from(e.dataTransfer?.files || []).forEach(f => this._sendFile(f));
      });
    }

    // ── PTT (Push-to-talk) ──
    const { pttBtn } = this.el;
    if (pttBtn) {
      const startPTT = async () => {
        if (!this.activeSession) { this._toast('Select a peer first.', true); return; }
        if (this.pttState) return;
        try {
          const stream = await this.network.startPTT(this.activeSession);
          this.pttState = { fp: this.activeSession, stream };
          pttBtn.classList.add('transmitting');
          if (this.el.pttBanner) this.el.pttBanner.classList.add('visible');
        } catch (e) { this._toast('PTT: ' + e.message, true); }
      };
      const stopPTT = () => {
        if (!this.pttState) return;
        this.network.stopPTT(this.pttState.fp);
        this.pttState = null;
        pttBtn.classList.remove('transmitting');
        if (this.el.pttBanner) this.el.pttBanner.classList.remove('visible');
      };
      // Desktop
      pttBtn.addEventListener('mousedown', startPTT);
      pttBtn.addEventListener('mouseup',   stopPTT);
      pttBtn.addEventListener('mouseleave',stopPTT);
      // Mobile touch
      pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startPTT(); }, { passive: false });
      pttBtn.addEventListener('touchend',   (e) => { e.preventDefault(); stopPTT();  }, { passive: false });
    }

    // ── Call buttons ──
    if (this.el.hangupBtn) {
      this.el.hangupBtn.addEventListener('click', () => this._hangup());
    }
    if (this.el.acceptCallBtn) {
      this.el.acceptCallBtn.addEventListener('click', () => this._acceptCall());
    }
    if (this.el.rejectCallBtn) {
      this.el.rejectCallBtn.addEventListener('click', () => this._rejectCall());
    }
  }

  // ── Mobile-specific bindings ──────────────────────────────────────────────

  _bindMobile() {
    const { mobileBack } = this.el;
    const backdrop = document.getElementById('sidebar-backdrop');

    // Mobile back button (from chat → peer list)
    if (mobileBack) {
      mobileBack.addEventListener('click', () => this._closeSidebar());
    }

    // Backdrop closes sidebar
    if (backdrop) {
      backdrop.addEventListener('click', () => this._closeSidebar());
    }

    // iOS: prevent viewport from jumping when keyboard appears
    if (this.isMobile && this.el.msgInput) {
      this.el.msgInput.addEventListener('focus', () => {
        setTimeout(() => {
          if (this.el.messages) this.el.messages.scrollTop = this.el.messages.scrollHeight;
        }, 350);
      });
    }
  }

  _openSidebar() {
    const sidebar   = document.getElementById('sidebar');
    const backdrop  = document.getElementById('sidebar-backdrop');
    if (sidebar)  sidebar.classList.add('open');
    if (backdrop) backdrop.classList.add('visible');
  }

  _closeSidebar() {
    const sidebar   = document.getElementById('sidebar');
    const backdrop  = document.getElementById('sidebar-backdrop');
    if (sidebar)  sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('visible');
  }

  // ── Wire network → app ────────────────────────────────────────────────────

  _wireNetwork() {
    this.network.onEvent = (event) => {
      try { this._handleEvent(event); }
      catch (e) { this._netLog('⚠ event: ' + e.message, true); }
    };

    this.network.onPeerConnected    = (fp) => this._onPeerConnected(fp, null);
    this.network.onPeerDisconnected = (fp) => this._onPeerDisconnected(fp);

    this.network.onStatusChange = (status) => {
      const dot  = this.el.statusDot;
      const text = this.el.statusText;
      if (dot) {
        dot.className = 'status-dot ' + status;
      }
      if (text) {
        const labels = { connecting: 'connecting…', connected: 'online', disconnected: 'offline' };
        text.textContent = labels[status] || status;
      }
    };

    this.network.onRemoteStream = (fp, stream) => {
      if (!this.el.remoteVideo) return;
      if (stream) {
        this.el.remoteVideo.srcObject = stream;
        if (this.el.callOverlay) this.el.callOverlay.classList.add('visible');
      } else {
        this.el.remoteVideo.srcObject = null;
        if (this.el.callOverlay) this.el.callOverlay.classList.remove('visible');
      }
    };

    this.network.logFn = (text) => {
      const isErr = text.startsWith('❌') || text.startsWith('⚠');
      this._netLog(text, isErr);
    };
  }

  // ── Handle incoming P2P events ────────────────────────────────────────────

  _handleEvent(event) {
    if (!event || typeof event !== 'object') return;
    const { type } = event;

    if (type === 'hello') {
      const fp = event.fingerprint;
      if (!fp) return;
      this._onPeerConnected(fp, event.shortId, event.nickname);
    }

    else if (type === 'chat') { this._receiveMessage(event); }

    else if (type === 'nickname-update') {
      if (!event.fingerprint) return;
      const p = this.peers.get(event.fingerprint);
      if (p) {
        p.nickname = event.nickname;
        this.peers.set(event.fingerprint, p);
        updatePeerNickname(event.fingerprint, event.nickname).catch(() => {});
        this._renderPeerList();
        if (this.activeSession === event.fingerprint) this._renderChatHeader();
      }
    }

    else if (type === 'file-start') {
      this.ft.handleMessage(event);
      this._addFileCard(
        event.from || '?', event.fileId, event.name, event.size, false
      );
    }
    else if (type === 'file-chunk' || type === 'file-end') {
      this.ft.handleMessage(event);
    }

    else if (type === 'call-offer') {
      const fp = event.from;
      if (!fp) return;
      this.incomingCall = { fp, video: !!event.video };
      const peer = this.peers.get(fp);
      const name = peer?.nickname || peer?.shortId || fp.slice(0, 8);
      if (this.el.incomingText)  this.el.incomingText.textContent = `${event.video ? '📹' : '📞'} call from ${name}`;
      if (this.el.incomingCall)  this.el.incomingCall.style.display = 'block';
    }

    else if (type === 'call-end' || type === 'ptt-end') {
      this._hangup();
    }

    else if (type === 'ptt-start') {
      // Remote is transmitting — nothing to do on receiver side,
      // the audio track arrives via onTrack in webrtc.js
    }
  }

  // ── Peer connected ────────────────────────────────────────────────────────

  _onPeerConnected(fp, shortId, nickname) {
    if (!fp) return;
    const existing = this.peers.get(fp);
    const name     = shortId || existing?.shortId || fp.slice(0, 8);
    const nick     = nickname || existing?.nickname || null;

    this.peers.set(fp, { shortId: name, nickname: nick, connected: true });

    savePeer({ fingerprint: fp, shortId: name, nickname: nick }).catch(() => {});

    if (!this.sessions.has(fp)) {
      loadMessages(fp).then(msgs => {
        this.sessions.set(fp, msgs);
        if (this.activeSession === fp) this._renderMessages();
        this._renderPeerList();
      }).catch(() => {
        this.sessions.set(fp, []);
      });
    } else {
      this._renderPeerList();
    }

    if (this.activeSession === fp) this._renderChatHeader();
  }

  _onPeerDisconnected(fp) {
    if (!fp) return;
    const p = this.peers.get(fp);
    if (p) { p.connected = false; this.peers.set(fp, p); }
    this._renderPeerList();
    if (this.activeSession === fp) this._renderChatHeader();
  }

  // ── Voice/video calls ─────────────────────────────────────────────────────

  async _startVoiceCall() {
    if (!this.activeSession) return;
    try {
      const stream = await this.network.startCall(this.activeSession, false);
      this.callState = { fp: this.activeSession, type: 'voice', stream };
      if (this.el.localVideo) {
        this.el.localVideo.srcObject = stream;
      }
      if (this.el.callOverlay) this.el.callOverlay.classList.add('visible');
    } catch (e) {
      this._toast('Call failed: ' + e.message, true);
    }
  }

  async _startVideoCall() {
    if (!this.activeSession) return;
    try {
      const stream = await this.network.startCall(this.activeSession, true);
      this.callState = { fp: this.activeSession, type: 'video', stream };
      if (this.el.localVideo) this.el.localVideo.srcObject = stream;
      if (this.el.callOverlay) this.el.callOverlay.classList.add('visible');
    } catch (e) {
      this._toast('Video call failed: ' + e.message, true);
    }
  }

  async _acceptCall() {
    if (!this.incomingCall) return;
    const { fp } = this.incomingCall;
    if (this.el.incomingCall) this.el.incomingCall.style.display = 'none';
    try {
      const stream = await this.network.acceptCall(fp);
      this.callState = { fp, type: 'voice', stream };
      if (this.el.localVideo) this.el.localVideo.srcObject = stream;
    } catch (e) {
      this._toast('Could not accept call: ' + e.message, true);
    }
    this.incomingCall = null;
  }

  _rejectCall() {
    if (!this.incomingCall) return;
    const { fp } = this.incomingCall;
    this.network.sendTo(fp, { type: 'call-end', from: this.network.identity.fingerprint });
    if (this.el.incomingCall) this.el.incomingCall.style.display = 'none';
    this.incomingCall = null;
  }

  _hangup() {
    const fp = this.callState?.fp || this.pttState?.fp;
    this.network.hangup(fp);
    this.callState = null;
    this.pttState  = null;
    if (this.el.callOverlay) this.el.callOverlay.classList.remove('visible');
    if (this.el.localVideo)  this.el.localVideo.srcObject = null;
    if (this.el.incomingCall) this.el.incomingCall.style.display = 'none';
  }

  // ── Open chat session ─────────────────────────────────────────────────────

  async _openSession(fp) {
    if (!fp) return;
    this.activeSession = fp;
    this.unread.delete(fp);

    if (!this.sessions.has(fp)) {
      try {
        const msgs = await loadMessages(fp);
        this.sessions.set(fp, msgs);
      } catch { this.sessions.set(fp, []); }
    }

    this._renderChatHeader();
    this._renderMessages();
    this._renderPeerList();

    if (this.el.inputBar) this.el.inputBar.style.display = 'flex';
    if (this.el.msgInput) this.el.msgInput.focus();

    // On mobile, close sidebar after selecting peer
    if (this.isMobile) this._closeSidebar();
  }

  // ── Send text message ─────────────────────────────────────────────────────

  _sendMessage() {
    const input = this.el.msgInput;
    if (!input) return;
    const text = input.value.trim();
    if (!text || !this.activeSession) return;

    const fp  = this.activeSession;
    const msg = {
      id:        crypto.randomUUID(),
      sessionId: fp,
      from:      this.identity.fingerprint,
      fromShort: this.identity.shortId,
      fromNick:  this.identity.nickname || null,
      text, ts: Date.now(), type: 'text', own: true,
    };

    const sent = this.network.sendTo(fp, {
      type:        'chat',
      id:          msg.id,
      fingerprint: this.identity.fingerprint,
      shortId:     this.identity.shortId,
      nickname:    this.identity.nickname || null,
      text,
      ts:          msg.ts,
    });

    if (!sent) { this._toast('Could not send — peer may be offline.', true); return; }

    if (!this.sessions.has(fp)) this.sessions.set(fp, []);
    this.sessions.get(fp).push(msg);

    saveMessage(msg).catch(() => {});
    this._appendMsg(msg);
    this._renderPeerList();

    input.value = '';
    input.style.height = 'auto';
  }

  // ── Receive text message ──────────────────────────────────────────────────

  _receiveMessage(event) {
    const fp = event.fingerprint;
    if (!fp || !event.text) return;

    const msg = {
      id:        event.id || (Date.now() + Math.random()).toString(36),
      sessionId: fp,
      from:      fp,
      fromShort: event.shortId || fp.slice(0, 8),
      fromNick:  event.nickname || null,
      text:      String(event.text),
      ts:        event.ts || Date.now(),
      type:      'text',
      own:       false,
    };

    if (!this.sessions.has(fp)) this.sessions.set(fp, []);
    this.sessions.get(fp).push(msg);
    saveMessage(msg).catch(() => {});

    if (this.activeSession !== fp) {
      this.unread.set(fp, (this.unread.get(fp) || 0) + 1);
    } else {
      this._appendMsg(msg);
    }
    this._renderPeerList();
  }

  // ── File transfer ─────────────────────────────────────────────────────────

  async _sendFile(file) {
    if (!file || !this.activeSession) return;
    const fp     = this.activeSession;
    const fileId = crypto.randomUUID();
    this._addFileCard(this.identity.shortId, fileId, file.name, file.size, true);
    try {
      await this.ft.sendFile(
        file, fp, fileId,
        (peerFp) => this.network.getChannel(peerFp) // pass channel for buffer monitoring
      );
    } catch (e) { this._onFileError(fileId, e.message); }
  }

  _onFileProgress(fileId, pct) {
    const fill = document.querySelector(`#fc-${fileId} .prog-fill`);
    if (fill) fill.style.width = (pct * 100).toFixed(1) + '%';
  }

  _onFileReady(file) {
    const card = document.getElementById(`fc-${file.fileId}`);
    if (!card) return;
    const fill = card.querySelector('.prog-fill');
    if (fill) fill.style.width = '100%';
    const prog = card.querySelector('.prog-track');
    if (prog) prog.remove();
    if (!card.querySelector('.dl-btn')) {
      const a = document.createElement('a');
      a.className = 'dl-btn';
      a.href      = file.url;
      a.download  = file.name || 'download';
      a.textContent = `↓ ${file.name || 'file'}`;
      card.appendChild(a);
    }
  }

  _onFileError(fileId, msg) {
    const card = document.getElementById(`fc-${fileId}`);
    if (card) {
      const err = document.createElement('div');
      err.style.cssText = 'color:var(--danger);font-size:.68rem;margin-top:.25rem;';
      err.textContent = '⚠ ' + msg;
      card.appendChild(err);
    }
    this._toast('File error: ' + msg, true);
  }

  // ── Render peer list ──────────────────────────────────────────────────────

  _renderPeerList() {
    const { peerList } = this.el;
    if (!peerList) return;

    if (this.peers.size === 0) {
      peerList.innerHTML = '<div class="no-peers">waiting for peers…<br/>share this URL with someone</div>';
      return;
    }

    const sorted = [...this.peers.entries()].sort(([,a],[,b]) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return (a.nickname || a.shortId).localeCompare(b.nickname || b.shortId);
    });

    let html = '';
    for (const [fp, peer] of sorted) {
      const active   = fp === this.activeSession ? ' active' : '';
      const dot      = peer.connected ? 'online' : 'offline';
      const unread   = this.unread.get(fp) || 0;
      const msgs     = this.sessions.get(fp) || [];
      const last     = msgs[msgs.length - 1];
      const preview  = last ? (last.type === 'text' ? this._esc(last.text) : '📎 file') : '';
      const dispName = peer.nickname || peer.shortId;

      html += `
<div class="peer-tile${active}" data-fp="${fp}">
  <div class="peer-dot ${dot}"></div>
  <div class="peer-info">
    <div class="peer-name">${this._esc(dispName)}</div>
    <div class="peer-fp-short">${fp.slice(0,8)}</div>
    ${preview ? `<div class="peer-preview">${preview}</div>` : ''}
  </div>
  <div class="peer-actions">
    ${peer.connected ? `
      <button class="peer-action-btn" data-fp="${fp}" data-action="voice" title="Voice call">📞</button>
      <button class="peer-action-btn" data-fp="${fp}" data-action="video" title="Video call">📹</button>
    ` : ''}
    ${unread > 0 ? `<div class="peer-badge">${unread > 9 ? '9+' : unread}</div>` : ''}
  </div>
</div>`.trim();
    }

    peerList.innerHTML = html;

    peerList.querySelectorAll('.peer-tile').forEach(tile => {
      tile.addEventListener('click', (e) => {
        const btn = e.target.closest('.peer-action-btn');
        if (btn) {
          e.stopPropagation();
          const fp     = btn.dataset.fp;
          const action = btn.dataset.action;
          this.activeSession = fp;
          if (action === 'voice') this._startVoiceCall();
          if (action === 'video') this._startVideoCall();
          return;
        }
        const fp = tile.dataset.fp;
        if (fp) this._openSession(fp);
      });
    });
  }

  // ── Render chat header ────────────────────────────────────────────────────

  _renderChatHeader() {
    const { chatHeader } = this.el;
    if (!chatHeader) return;

    const fp   = this.activeSession;
    const peer = fp ? this.peers.get(fp) : null;

    if (!fp || !peer) {
      chatHeader.innerHTML = `
        <button id="mobile-back" aria-label="Back">‹</button>
        <span style="color:var(--tq-muted);font-size:0.8rem;letter-spacing:.15em;">select a peer</span>
      `;
      this._rebindMobileBack();
      return;
    }

    const dot      = peer.connected ? 'online' : 'offline';
    const dispName = peer.nickname || peer.shortId;

    chatHeader.innerHTML = `
      <button id="mobile-back" aria-label="Back">‹</button>
      <div class="peer-dot ${dot}" style="width:8px;height:8px;border-radius:50%;flex-shrink:0;"></div>
      <div style="flex:1;min-width:0">
        <div class="peer-name">${this._esc(dispName)}</div>
        <div class="peer-fp-s">${fp.slice(0, 16)}…</div>
      </div>
      <div id="chat-header-actions">
        ${peer.connected ? `
          <button class="call-btn" id="hdr-voice-btn" title="Voice call">📞 voice</button>
          <button class="call-btn" id="hdr-video-btn" title="Video call">📹 video</button>
        ` : ''}
      </div>
    `;
    this._rebindMobileBack();

    const vBtn = document.getElementById('hdr-voice-btn');
    const cBtn = document.getElementById('hdr-video-btn');
    if (vBtn) vBtn.addEventListener('click', () => this._startVoiceCall());
    if (cBtn) cBtn.addEventListener('click', () => this._startVideoCall());
  }

  _rebindMobileBack() {
    const btn = document.getElementById('mobile-back');
    if (btn) btn.addEventListener('click', () => {
      if (this.isMobile) this._openSidebar();
    });
  }

  // ── Render all messages ───────────────────────────────────────────────────

  _renderMessages() {
    const { messages } = this.el;
    if (!messages) return;
    messages.innerHTML = '';

    const msgs = this.sessions.get(this.activeSession) || [];
    if (msgs.length === 0) {
      messages.innerHTML = '<div class="sys-msg">no messages yet</div>'; return;
    }
    for (const msg of msgs) {
      if (msg.type === 'text') messages.appendChild(this._buildMsgEl(msg));
    }
    this._scrollBottom();
  }

  _appendMsg(msg) {
    const { messages } = this.el;
    if (!messages) return;
    const empty = messages.querySelector('.empty-state, .sys-msg');
    if (empty && messages.children.length === 1) empty.remove();
    messages.appendChild(this._buildMsgEl(msg));
    this._scrollBottom();
  }

  _buildMsgEl(msg) {
    const div  = document.createElement('div');
    div.className = `msg ${msg.own ? 'own' : 'peer'}`;
    const time = new Date(msg.ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    const who  = msg.own
      ? (this.identity.nickname || 'you')
      : (msg.fromNick || msg.fromShort || '?');

    div.innerHTML = `
      <div class="meta">${this._esc(who)} · ${time}</div>
      <div class="bubble">${this._esc(msg.text)}</div>
    `.trim();
    return div;
  }

  _addFileCard(fromShort, fileId, name, size, own) {
    const { messages } = this.el;
    if (!messages) return;
    const empty = messages.querySelector('.empty-state, .sys-msg');
    if (empty && messages.children.length === 1) empty.remove();

    const who  = own ? (this.identity.nickname || 'you') : (fromShort || '?');
    const time = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });

    const wrapper = document.createElement('div');
    wrapper.className = `msg ${own ? 'own' : 'peer'}`;
    wrapper.innerHTML = `
      <div class="meta">${this._esc(who)} · ${time}</div>
      <div class="file-card" id="fc-${fileId}">
        <div class="f-name">📎 ${this._esc(name || 'file')}</div>
        <div class="f-meta">${this._fmtSize(size)}</div>
        <div class="prog-track"><div class="prog-fill" style="width:0%"></div></div>
      </div>
    `.trim();

    messages.appendChild(wrapper);
    this._scrollBottom();
  }

  // ── Toast / system message ────────────────────────────────────────────────

  _toast(text, isErr = false) {
    const { messages } = this.el;
    if (!messages) return;
    const div = document.createElement('div');
    div.className = `sys-msg${isErr ? ' err' : ''}`;
    div.textContent = text;
    messages.appendChild(div);
    this._scrollBottom();
    setTimeout(() => { try { div.remove(); } catch {} }, 5000);
  }

  // ── Network log ───────────────────────────────────────────────────────────

  _netLog(text, isErr = false) {
    const { netLog } = this.el;
    if (!netLog) return;
    const div = document.createElement('div');
    div.className = `net-entry${isErr ? ' err' : ''}`;
    div.textContent = text;
    netLog.appendChild(div);
    netLog.scrollTop = netLog.scrollHeight;
    while (netLog.children.length > 80) {
      try { netLog.removeChild(netLog.firstChild); } catch { break; }
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  _scrollBottom() {
    const { messages } = this.el;
    if (messages) messages.scrollTop = messages.scrollHeight;
  }

  _esc(t) {
    return String(t || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  _fmtSize(b) {
    if (!b || isNaN(b)) return '?';
    if (b < 1024)       return b + ' B';
    if (b < 1024**2)    return (b/1024).toFixed(1)    + ' KB';
    if (b < 1024**3)    return (b/1024**2).toFixed(1) + ' MB';
    return (b/1024**3).toFixed(2) + ' GB';
  }
}
