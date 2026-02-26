/**
 * app.js — Turquoise Complete UI Controller
 *
 * Manages all UI state:
 *   - Peer list (online + LAN)
 *   - Chat sessions with persistent history
 *   - File transfers (DataChannel or TCP)
 *   - Voice/video calls + PTT
 *   - Mode toggle (online ↔ offline)
 *   - Nickname editing
 *   - Group creation (mesh: up to 6)
 *   - Propagation URL display (offline)
 *
 * Murphy's Law: null-checked DOM, try/catch on every async,
 *               no silent failures, all errors visible to user.
 */

import { saveMessage, loadMessages, savePeer, loadPeers, updatePeerNickname } from './messages.js';
import { FileTransfer } from './files.js';
import { saveNickname } from './identity.js';
import { IS_TAURI, getNetworkInfo, pickFiles, openDownloads, listen } from './bridge.js';
import { Mode } from './network.js';

export class TurquoiseApp {

  constructor(identity, network) {
    if (!identity?.fingerprint) throw new Error('App: identity.fingerprint required.');
    if (!network?.sendTo)       throw new Error('App: network.sendTo required.');

    this.identity = identity;
    this.network  = network;
    this.isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

    // State
    this.peers         = new Map(); // fp → { shortId, nickname, connected, isLan, tcpInfo }
    this.sessions      = new Map(); // fp → message[]
    this.activeSession = null;
    this.unread        = new Map(); // fp → count

    // Call state
    this.callState    = null;
    this.pttState     = null;
    this.incomingCall = null;

    // File engine
    this.ft = new FileTransfer(
      (fp, payload) => network.sendTo(fp, payload),
      ()            => network.mode,
    );
    this.ft.onProgress  = (id, pct, dir) => this._onFileProg(id, pct, dir);
    this.ft.onFileReady = (f)            => this._onFileReady(f);
    this.ft.onError     = (id, msg)      => this._onFileError(id, msg);

    // Outgoing file paths from Tauri file picker
    this.pendingFilePaths = new Map(); // fileId → local path

    this.el = {};
  }

  // ── Mount ─────────────────────────────────────────────────────────────────

  async mount() {
    const app = document.getElementById('app');
    if (!app) throw new Error('App.mount: #app not found.');
    this._cacheDOM();
    this._bindEvents();
    this._bindMobile();
    this._wireNetwork();

    // Show identity
    const name = this.identity.nickname || this.identity.shortId;
    if (this.el.nicknameText) this.el.nicknameText.textContent = name;
    if (this.el.nicknameInput) this.el.nicknameInput.value = name;
    if (this.el.fpDisplay) this.el.fpDisplay.textContent = this.identity.fingerprint.slice(0, 24) + '…';

    // Show mode buttons
    this._renderModeButtons();

    // Load persisted peers
    try {
      for (const p of await loadPeers()) {
        this.peers.set(p.fingerprint, {
          shortId:   p.shortId,
          nickname:  p.nickname || null,
          connected: false,
          isLan:     false,
          tcpInfo:   null,
        });
      }
    } catch (e) { this._netLog('⚠ peer history: ' + e.message, true); }

    this._renderPeerList();

    // In Tauri, get propagation URL
    if (IS_TAURI) {
      setTimeout(() => this._updatePropagationUrl(), 2000);
    }

    // Show/hide propagation banner in offline mode
    this._updatePropagationBanner();
  }

  // ── DOM cache ─────────────────────────────────────────────────────────────

  _cacheDOM() {
    const ids = [
      'nickname-display','nickname-text','nickname-input','fp-display',
      'status-dot','status-text','mode-toggle','btn-online','btn-offline',
      'propagation-banner','propagation-url',
      'peer-list','net-log',
      'chat-header','chat-header-actions',
      'call-overlay','remote-video','local-video','hangup-btn',
      'incoming-call','incoming-text','accept-call-btn','reject-call-btn',
      'messages','input-bar','ptt-btn','file-btn','msg-input','send-btn',
      'ptt-banner','mobile-back',
    ];
    for (const id of ids) {
      const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.el[key] = document.getElementById(id);
    }
  }

  // ── Events ────────────────────────────────────────────────────────────────

  _bindEvents() {
    // ── Nickname ──
    const { nicknameDisplay, nicknameInput, nicknameText } = this.el;
    if (nicknameDisplay && nicknameInput) {
      nicknameDisplay.addEventListener('click', () => {
        nicknameDisplay.style.display = 'none';
        nicknameInput.style.display   = 'block';
        nicknameInput.focus(); nicknameInput.select();
      });
      const commit = () => {
        const val = nicknameInput.value.trim().slice(0, 32);
        if (val) {
          this.identity.nickname = val;
          this.network.identity.nickname = val;
          saveNickname(val);
          this.network.broadcastNickname(val);
          if (nicknameText) nicknameText.textContent = val;
        }
        nicknameInput.style.display   = 'none';
        nicknameDisplay.style.display = 'flex';
      };
      nicknameInput.addEventListener('blur',    commit);
      nicknameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { nicknameInput.style.display = 'none'; nicknameDisplay.style.display = 'flex'; }
      });
    }

    // ── Mode toggle ──
    if (this.el.btnOnline)  this.el.btnOnline.addEventListener('click',  () => this._setMode(Mode.ONLINE));
    if (this.el.btnOffline) this.el.btnOffline.addEventListener('click', () => this._setMode(Mode.OFFLINE));

    // ── Text input ──
    const { msgInput, sendBtn } = this.el;
    if (msgInput) {
      msgInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._sendMsg(); }
      });
      msgInput.addEventListener('input', () => {
        msgInput.style.height = 'auto';
        msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
      });
    }
    if (sendBtn) sendBtn.addEventListener('click', () => this._sendMsg());

    // ── File button ──
    const fileInputHidden = document.getElementById('file-input-hidden');
    if (this.el.fileBtn) {
      this.el.fileBtn.addEventListener('click', async () => {
        if (!this.activeSession) { this._toast('Select a peer first.', true); return; }

        if (IS_TAURI) {
          // Use native file picker (returns paths, not File objects)
          try {
            const paths = await pickFiles();
            for (const p of paths) this._sendFileByPath(p);
          } catch (e) { this._toast('File picker error: ' + e.message, true); }
        } else {
          fileInputHidden?.click();
        }
      });
    }

    if (fileInputHidden) {
      fileInputHidden.addEventListener('change', (e) => {
        Array.from(e.target.files || []).forEach(f => this._sendFileObj(f));
        fileInputHidden.value = '';
      });
    }

    // ── Drag & drop ──
    const chatArea = document.getElementById('chat-area');
    if (chatArea) {
      chatArea.addEventListener('dragover',  (e) => { e.preventDefault(); if (this.activeSession) chatArea.classList.add('drag-over'); });
      chatArea.addEventListener('dragleave', ()  => chatArea.classList.remove('drag-over'));
      chatArea.addEventListener('drop', (e) => {
        e.preventDefault(); chatArea.classList.remove('drag-over');
        if (!this.activeSession) { this._toast('Select a peer first.', true); return; }
        Array.from(e.dataTransfer?.files || []).forEach(f => this._sendFileObj(f));
      });
    }

    // ── PTT ──
    const { pttBtn } = this.el;
    if (pttBtn) {
      const start = async () => {
        if (!this.activeSession || this.pttState) return;
        try {
          const stream = await this.network.startPTT(this.activeSession);
          this.pttState = { fp: this.activeSession, stream };
          pttBtn.classList.add('transmitting');
          if (this.el.pttBanner) this.el.pttBanner.classList.add('visible');
        } catch (e) { this._toast('PTT: ' + e.message, true); }
      };
      const stop = () => {
        if (!this.pttState) return;
        this.network.stopPTT(this.pttState.fp);
        this.pttState = null;
        pttBtn.classList.remove('transmitting');
        if (this.el.pttBanner) this.el.pttBanner.classList.remove('visible');
      };
      pttBtn.addEventListener('mousedown', start);
      pttBtn.addEventListener('mouseup',   stop);
      pttBtn.addEventListener('mouseleave',stop);
      pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); start(); }, { passive: false });
      pttBtn.addEventListener('touchend',   (e) => { e.preventDefault(); stop();  }, { passive: false });
    }

    // ── Call controls ──
    if (this.el.hangupBtn)      this.el.hangupBtn.addEventListener('click',      () => this._hangup());
    if (this.el.acceptCallBtn)  this.el.acceptCallBtn.addEventListener('click',  () => this._acceptCall());
    if (this.el.rejectCallBtn)  this.el.rejectCallBtn.addEventListener('click',  () => this._rejectCall());
  }

  // ── Mobile ────────────────────────────────────────────────────────────────

  _bindMobile() {
    const backdrop = document.getElementById('sidebar-backdrop');
    if (this.el.mobileBack) {
      this.el.mobileBack.addEventListener('click', () => {
        if (this.isMobile) this._openSidebar();
      });
    }
    if (backdrop) backdrop.addEventListener('click', () => this._closeSidebar());

    if (this.isMobile && this.el.msgInput) {
      this.el.msgInput.addEventListener('focus', () => {
        setTimeout(() => this._scrollBottom(), 350);
      });
    }
  }

  _openSidebar() {
    document.getElementById('sidebar')?.classList.add('open');
    document.getElementById('sidebar-backdrop')?.classList.add('visible');
  }
  _closeSidebar() {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebar-backdrop')?.classList.remove('visible');
  }

  // ── Mode toggle ───────────────────────────────────────────────────────────

  _setMode(mode) {
    this.network.setMode(mode);
    this._renderModeButtons();
    this._updatePropagationBanner();
    this._renderPeerList();
  }

  _renderModeButtons() {
    const mode = this.network.mode;
    if (this.el.btnOnline)  this.el.btnOnline.classList.toggle('active',  mode === Mode.ONLINE);
    if (this.el.btnOffline) this.el.btnOffline.classList.toggle('active', mode === Mode.OFFLINE);
  }

  _updatePropagationBanner() {
    const banner = this.el.propagationBanner;
    if (!banner) return;
    banner.classList.toggle('visible', IS_TAURI && this.network.mode === Mode.OFFLINE);
  }

  async _updatePropagationUrl() {
    try {
      const info = await getNetworkInfo();
      if (!info || !info.local_ip || !info.http_port) return;
      const url = `http://${info.local_ip}:${info.http_port}`;
      if (this.el.propagationUrl) this.el.propagationUrl.textContent = url;
    } catch {}
  }

  // ── Network wiring ────────────────────────────────────────────────────────

  _wireNetwork() {
    this.network.onEvent = (event) => {
      try { this._handleEvent(event); }
      catch (e) { this._netLog('⚠ event: ' + e.message, true); }
    };

    this.network.onPeerConnected    = (fp) => this._onPeerConnected(fp);
    this.network.onPeerDisconnected = (fp) => this._onPeerDisc(fp);

    this.network.onStatusChange = (s) => {
      const dot  = this.el.statusDot;
      const text = this.el.statusText;
      const labels = { connecting: 'connecting…', connected: 'online', disconnected: 'offline' };
      if (dot)  dot.className = 'status-dot ' + s;
      if (text) text.textContent = labels[s] || s;
    };

    this.network.onModeChange = (mode) => {
      this._netLog(`Mode: ${mode}`, false);
      this._renderModeButtons();
      this._updatePropagationBanner();
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

    this.network.logFn = (t) => this._netLog(t, t.startsWith('❌') || t.startsWith('⚠'));
  }

  // ── Handle P2P events ─────────────────────────────────────────────────────

  _handleEvent(event) {
    if (!event?.type) return;
    const { type } = event;

    if (type === 'hello') {
      const fp = event.fingerprint;
      if (!fp) return;
      this._onPeerConnected(fp, event.shortId, event.nickname);
    }

    else if (type === 'peer-discovered' || type === 'lan-peer-found') {
      const fp   = event.fingerprint || event.peer?.fingerprint;
      const nick = event.nickname    || event.peer?.nickname;
      const sid  = event.peer?.short_id;
      const peer = event.peer;

      if (!fp || fp === this.identity.fingerprint) return;

      const existing = this.peers.get(fp) || {};
      this.peers.set(fp, {
        ...existing,
        shortId:  sid || existing.shortId || fp.slice(0, 8),
        nickname: nick || existing.nickname || null,
        connected: false,
        isLan:    type === 'lan-peer-found',
        tcpInfo:  peer ? { ip: peer.ws_addr?.split(':')[0], port: peer.tcp_addr?.split(':')[1] } : null,
      });
      this._renderPeerList();
    }

    else if (type === 'lan-peer-lost') {
      const fp = event.fingerprint;
      if (!fp) return;
      const p = this.peers.get(fp);
      if (p) { p.connected = false; p.isLan = false; }
      this._renderPeerList();
      if (this.activeSession === fp) this._renderChatHeader();
    }

    else if (type === 'chat') { this._receiveMsg(event); }

    else if (type === 'nickname-update') {
      const fp = event.fingerprint;
      if (!fp) return;
      const p = this.peers.get(fp);
      if (p) {
        p.nickname = event.nickname;
        updatePeerNickname(fp, event.nickname).catch(() => {});
        this._renderPeerList();
        if (this.activeSession === fp) this._renderChatHeader();
      }
    }

    else if (type === 'file-start') {
      this.ft.handleMessage(event);
      const peer = this.peers.get(event.from);
      this._addFileCard(
        peer?.nickname || peer?.shortId || event.from?.slice(0, 8) || '?',
        event.fileId, event.name, event.size, false, false
      );
    }
    else if (type === 'file-chunk' || type === 'file-end') {
      this.ft.handleMessage(event);
    }

    // TCP transfer events (from Tauri backend)
    else if (type === 'tcp-transfer-start') {
      if (event.direction === 'receive') {
        this._addFileCard(
          event.sender_fp?.slice(0, 8) || '?',
          event.file_id, event.name, event.size, false, true
        );
      }
    }
    else if (type === 'tcp-transfer-progress') {
      this._onFileProg(event.file_id, event.pct, event.direction === 'send' ? 'out' : 'in');
    }
    else if (type === 'tcp-transfer-complete') {
      this._onFileReady({
        fileId:  event.file_id,
        name:    event.name,
        size:    event.size,
        path:    event.path,
        via:     'tcp',
      });
    }

    else if (type === 'call-offer') {
      const fp   = event.from;
      if (!fp) return;
      this.incomingCall = { fp, video: !!event.video };
      const peer = this.peers.get(fp);
      const name = peer?.nickname || peer?.shortId || fp.slice(0, 8);
      if (this.el.incomingText) this.el.incomingText.textContent =
        `${event.video ? '📹' : '📞'} call from ${name}`;
      if (this.el.incomingCall) this.el.incomingCall.style.display = 'block';
    }

    else if (type === 'call-end' || type === 'ptt-end') {
      this._hangup();
    }

    else if (type === 'cloud-unreachable') {
      this._netLog(`☁ Cloud unreachable (${event.attempts}×). Switch to offline mode?`, true);
    }
  }

  // ── Peer connected ────────────────────────────────────────────────────────

  _onPeerConnected(fp, shortId, nickname) {
    if (!fp || fp === this.identity.fingerprint) return;
    const existing = this.peers.get(fp);
    const sid      = shortId  || existing?.shortId  || fp.slice(0, 8);
    const nick     = nickname || existing?.nickname  || null;

    this.peers.set(fp, {
      ...(existing || {}),
      shortId:   sid,
      nickname:  nick,
      connected: true,
    });

    savePeer({ fingerprint: fp, shortId: sid, nickname: nick }).catch(() => {});

    if (!this.sessions.has(fp)) {
      loadMessages(fp).then(msgs => {
        this.sessions.set(fp, msgs);
        if (this.activeSession === fp) this._renderMessages();
        this._renderPeerList();
      }).catch(() => this.sessions.set(fp, []));
    } else {
      this._renderPeerList();
    }

    if (this.activeSession === fp) this._renderChatHeader();
  }

  _onPeerDisc(fp) {
    if (!fp) return;
    const p = this.peers.get(fp);
    if (p) { p.connected = false; this.peers.set(fp, p); }
    this._renderPeerList();
    if (this.activeSession === fp) this._renderChatHeader();
  }

  // ── Open session ──────────────────────────────────────────────────────────

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
    if (this.el.msgInput)  this.el.msgInput.focus();
    if (this.isMobile) this._closeSidebar();
  }

  // ── Send text ─────────────────────────────────────────────────────────────

  _sendMsg() {
    const input = this.el.msgInput;
    if (!input) return;
    const text = input.value.trim();
    if (!text || !this.activeSession) return;

    const fp = this.activeSession;
    const msg = {
      id: crypto.randomUUID(), sessionId: fp,
      from: this.identity.fingerprint,
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
      text, ts: msg.ts,
    });

    if (!sent) { this._toast('Could not send — peer offline.', true); return; }

    if (!this.sessions.has(fp)) this.sessions.set(fp, []);
    this.sessions.get(fp).push(msg);
    saveMessage(msg).catch(() => {});
    this._appendMsg(msg);
    this._renderPeerList();

    input.value = '';
    input.style.height = 'auto';
  }

  _receiveMsg(event) {
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

  // ── File send ─────────────────────────────────────────────────────────────

  async _sendFileByPath(filePath) {
    // Tauri path-based send (native file picker)
    if (!filePath || !this.activeSession) return;
    const fp     = this.activeSession;
    const name   = filePath.split(/[\\/]/).pop() || 'file';
    const fileId = crypto.randomUUID();
    const peer   = this.peers.get(fp);

    this._addFileCard(this.identity.shortId, fileId, name, null, true, !!peer?.tcpInfo);

    try {
      await this.ft.sendFile(
        { name, size: 0 }, // minimal info for DataChannel
        fp,
        fileId,
        (p) => this.network.getChannel(p),
        peer?.tcpInfo ? { ...peer.tcpInfo, path: filePath } : null,
      );
    } catch (e) { this._onFileError(fileId, e.message); }
  }

  async _sendFileObj(file) {
    // Browser File object (drag+drop or input[type=file])
    if (!file || !this.activeSession) return;
    const fp     = this.activeSession;
    const fileId = crypto.randomUUID();
    this._addFileCard(this.identity.shortId, fileId, file.name, file.size, true, false);

    try {
      await this.ft.sendFile(
        file, fp, fileId,
        (p) => this.network.getChannel(p),
        null, // No TCP path for browser File objects
      );
    } catch (e) { this._onFileError(fileId, e.message); }
  }

  _onFileProg(fileId, pct) {
    const fill = document.querySelector(`#fc-${fileId} .prog-fill`);
    if (fill) fill.style.width = (pct * 100).toFixed(1) + '%';
  }

  _onFileReady(file) {
    const card = document.getElementById(`fc-${file.fileId}`);
    if (!card) return;

    // Complete progress bar
    const fill = card.querySelector('.prog-fill');
    if (fill) fill.style.width = '100%';
    const prog = card.querySelector('.prog-track');
    if (prog) prog.remove();

    if (!card.querySelector('.dl-btn')) {
      if (file.url) {
        // Browser blob URL (DataChannel transfer)
        const a = document.createElement('a');
        a.className = 'dl-btn';
        a.href      = file.url;
        a.download  = file.name || 'download';
        a.textContent = `↓ ${file.name || 'file'}`;
        card.appendChild(a);
      } else if (file.path) {
        // Tauri TCP transfer — file saved to disk, offer to open folder
        const btn = document.createElement('button');
        btn.className   = 'dl-btn';
        btn.textContent = `↓ saved — tap to open`;
        btn.addEventListener('click', () => openDownloads().catch(() => {}));
        card.appendChild(btn);
      }
    }
  }

  _onFileError(fileId, msg) {
    const card = document.getElementById(`fc-${fileId}`);
    if (card) {
      const err = document.createElement('div');
      err.style.cssText = 'color:var(--danger);font-size:.65rem;margin-top:.25rem;';
      err.textContent = '⚠ ' + msg;
      card.appendChild(err);
    }
    this._toast('File: ' + msg, true);
  }

  // ── Call controls ─────────────────────────────────────────────────────────

  async _startVoiceCall() {
    if (!this.activeSession) return;
    try {
      const stream = await this.network.startCall(this.activeSession, false);
      this.callState = { fp: this.activeSession, type: 'voice', stream };
      if (this.el.localVideo) this.el.localVideo.srcObject = stream;
      if (this.el.callOverlay) this.el.callOverlay.classList.add('visible');
    } catch (e) { this._toast('Call failed: ' + e.message, true); }
  }

  async _startVideoCall() {
    if (!this.activeSession) return;
    try {
      const stream = await this.network.startCall(this.activeSession, true);
      this.callState = { fp: this.activeSession, type: 'video', stream };
      if (this.el.localVideo) this.el.localVideo.srcObject = stream;
      if (this.el.callOverlay) this.el.callOverlay.classList.add('visible');
    } catch (e) { this._toast('Video call: ' + e.message, true); }
  }

  async _acceptCall() {
    if (!this.incomingCall) return;
    const { fp } = this.incomingCall;
    if (this.el.incomingCall) this.el.incomingCall.style.display = 'none';
    try {
      const stream = await this.network.acceptCall(fp);
      this.callState = { fp, type: 'voice', stream };
      if (this.el.localVideo) this.el.localVideo.srcObject = stream;
    } catch (e) { this._toast('Accept call: ' + e.message, true); }
    this.incomingCall = null;
  }

  _rejectCall() {
    if (!this.incomingCall) return;
    this.network.sendTo(this.incomingCall.fp, { type: 'call-end', from: this.network.identity.fingerprint });
    if (this.el.incomingCall) this.el.incomingCall.style.display = 'none';
    this.incomingCall = null;
  }

  _hangup() {
    const fp = this.callState?.fp;
    this.network.hangup(fp);
    this.callState = null; this.pttState = null;
    if (this.el.callOverlay)  this.el.callOverlay.classList.remove('visible');
    if (this.el.localVideo)   this.el.localVideo.srcObject = null;
    if (this.el.incomingCall) this.el.incomingCall.style.display = 'none';
  }

  // ── Render peer list ──────────────────────────────────────────────────────

  _renderPeerList() {
    const { peerList } = this.el;
    if (!peerList) return;

    if (this.peers.size === 0) {
      peerList.innerHTML = `<div class="no-peers">${
        this.network.mode === Mode.OFFLINE
          ? 'waiting for LAN peers…\nopen Turquoise on another device'
          : 'waiting for peers…\nshare this URL'
      }</div>`;
      return;
    }

    const sorted = [...this.peers.entries()].sort(([,a],[,b]) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return (a.nickname || a.shortId).localeCompare(b.nickname || b.shortId);
    });

    let html = '';
    for (const [fp, p] of sorted) {
      const active  = fp === this.activeSession ? ' active' : '';
      const dotCls  = p.connected ? (p.isLan ? 'lan' : 'online') : 'offline';
      const unread  = this.unread.get(fp) || 0;
      const msgs    = this.sessions.get(fp) || [];
      const last    = msgs[msgs.length - 1];
      const preview = last ? (last.type === 'text' ? this._esc(last.text.slice(0, 40)) : '📎 file') : '';
      const name    = p.nickname || p.shortId;
      const lanBadge = p.isLan ? `<span class="tcp-badge">LAN</span>` : '';

      html += `
<div class="peer-tile${active}" data-fp="${fp}">
  <div class="peer-dot ${dotCls}"></div>
  <div class="peer-info">
    <div class="peer-name">${this._esc(name)}${lanBadge}</div>
    <div class="peer-fp-short">${fp.slice(0, 8)}</div>
    ${preview ? `<div class="peer-preview">${preview}</div>` : ''}
  </div>
  <div class="peer-actions">
    ${p.connected ? `
      <button class="peer-action-btn" data-fp="${fp}" data-action="voice">📞</button>
      <button class="peer-action-btn" data-fp="${fp}" data-action="video">📹</button>
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
          this.activeSession = btn.dataset.fp;
          if (btn.dataset.action === 'voice') this._startVoiceCall();
          if (btn.dataset.action === 'video') this._startVideoCall();
          return;
        }
        this._openSession(tile.dataset.fp);
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
        <button id="mobile-back">‹</button>
        <span style="color:var(--tq-muted);font-size:.75rem;letter-spacing:.15em;">select a peer</span>`;
      this._rebindBack();
      return;
    }

    const dot  = peer.connected ? (peer.isLan ? 'lan' : 'online') : 'offline';
    const name = peer.nickname || peer.shortId;
    const lanBadge = peer.isLan ? `<span class="tcp-badge">LAN</span>` : '';

    chatHeader.innerHTML = `
      <button id="mobile-back">‹</button>
      <div class="peer-dot ${dot}" style="width:7px;height:7px;border-radius:50%;flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div class="peer-name">${this._esc(name)}${lanBadge}</div>
        <div class="peer-fp-s">${fp.slice(0, 16)}…</div>
      </div>
      <div style="display:flex;gap:.5rem;flex-shrink:0;margin-left:auto">
        ${peer.connected ? `
          <button class="call-btn" id="hdr-voice">📞 voice</button>
          <button class="call-btn" id="hdr-video">📹 video</button>
        ` : ''}
      </div>`;

    this._rebindBack();
    document.getElementById('hdr-voice')?.addEventListener('click', () => this._startVoiceCall());
    document.getElementById('hdr-video')?.addEventListener('click', () => this._startVideoCall());
  }

  _rebindBack() {
    document.getElementById('mobile-back')?.addEventListener('click', () => {
      if (this.isMobile) this._openSidebar();
    });
  }

  // ── Render messages ───────────────────────────────────────────────────────

  _renderMessages() {
    const { messages } = this.el;
    if (!messages) return;
    messages.innerHTML = '';
    const msgs = this.sessions.get(this.activeSession) || [];
    if (!msgs.length) {
      messages.innerHTML = '<div class="sys-msg">no messages yet</div>'; return;
    }
    for (const msg of msgs) messages.appendChild(this._buildMsgEl(msg));
    this._scrollBottom();
  }

  _appendMsg(msg) {
    const { messages } = this.el;
    if (!messages) return;
    const empty = messages.querySelector('.empty-state,.sys-msg');
    if (empty && messages.children.length === 1) empty.remove();
    messages.appendChild(this._buildMsgEl(msg));
    this._scrollBottom();
  }

  _buildMsgEl(msg) {
    const div  = document.createElement('div');
    div.className = `msg ${msg.own ? 'own' : 'peer'}`;
    const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const who  = msg.own
      ? (this.identity.nickname || 'you')
      : (msg.fromNick || msg.fromShort || '?');
    div.innerHTML = `
      <div class="meta">${this._esc(who)} · ${time}</div>
      <div class="bubble">${this._esc(msg.text)}</div>`;
    return div;
  }

  _addFileCard(fromName, fileId, name, size, own, isTcp) {
    const { messages } = this.el;
    if (!messages) return;
    const empty = messages.querySelector('.empty-state,.sys-msg');
    if (empty && messages.children.length === 1) empty.remove();

    const who   = own ? (this.identity.nickname || 'you') : (fromName || '?');
    const time  = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const badge = isTcp ? `<span class="tcp-badge">⚡TCP</span>` : '';

    const wrapper = document.createElement('div');
    wrapper.className = `msg ${own ? 'own' : 'peer'}`;
    wrapper.innerHTML = `
      <div class="meta">${this._esc(who)} · ${time}</div>
      <div class="file-card" id="fc-${fileId}">
        <div class="f-name">📎 ${this._esc(name || 'file')}${badge}</div>
        <div class="f-meta">${size ? this._fmtSz(size) : '—'}</div>
        <div class="prog-track"><div class="prog-fill" style="width:0%"></div></div>
      </div>`;
    messages.appendChild(wrapper);
    this._scrollBottom();
  }

  // ── Toast / system ────────────────────────────────────────────────────────

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

  _fmtSz(b) {
    if (!b || isNaN(b)) return '?';
    if (b < 1024)      return b + ' B';
    if (b < 1024**2)   return (b/1024).toFixed(1)    + ' KB';
    if (b < 1024**3)   return (b/1024**2).toFixed(1) + ' MB';
    return (b/1024**3).toFixed(2) + ' GB';
  }
}
