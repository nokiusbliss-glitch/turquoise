/**
 * app.js — Turquoise Phase 3 + 4
 *
 * Owns the UI and all application state.
 * Receives identity + network instances from main.js.
 *
 * Responsibilities:
 *   Phase 3 — Chat
 *     - Peer list with live connection status
 *     - Per-peer chat sessions with persistent history
 *     - Text messages sent/received over WebRTC DataChannel
 *     - Unread message badges
 *     - Network log in sidebar footer
 *
 *   Phase 4 — File Transfer
 *     - Drag & drop files onto chat
 *     - File button to browse and pick
 *     - Per-file progress bar (sending and receiving)
 *     - Download button on completion
 *
 * Murphy's Law: every DOM operation, every state mutation, every async
 * step has explicit null-checks and try/catch. Nothing fails silently.
 */

import { saveMessage, loadMessages, savePeer, loadPeers } from './messages.js';
import { FileTransfer } from './files.js';

export class TurquoiseApp {

  constructor(identity, network) {
    if (!identity?.fingerprint) throw new Error('App: identity missing fingerprint.');
    if (!network?.sendTo)       throw new Error('App: network missing sendTo method.');

    this.identity = identity;
    this.network  = network;

    // ── State ──────────────────────────────────────────────────────────────────
    this.peers         = new Map(); // fp → { shortId, connected, name }
    this.sessions      = new Map(); // fp → message[]
    this.activeSession = null;      // fp string | null
    this.unread        = new Map(); // fp → count

    // ── File engine ────────────────────────────────────────────────────────────
    this.ft = new FileTransfer((fp, payload) => network.sendTo(fp, payload));

    this.ft.onProgress = (fileId, pct, dir) => {
      this._onFileProgress(fileId, pct, dir);
    };
    this.ft.onFileReady = (file) => {
      this._onFileReady(file);
    };
    this.ft.onError = (fileId, msg) => {
      this._onFileError(fileId, msg);
    };

    // ── DOM cache ──────────────────────────────────────────────────────────────
    this.el = {};
  }

  // ── Mount ────────────────────────────────────────────────────────────────────

  async mount() {
    const app = document.getElementById('app');
    if (!app) throw new Error('App.mount: #app element not found.');

    // Build DOM
    app.innerHTML = this._html();
    this._cacheDOM(app);
    this._bindEvents();

    // Load persisted peers
    try {
      const saved = await loadPeers();
      for (const p of saved) {
        this.peers.set(p.fingerprint, {
          shortId:   p.shortId,
          connected: false,
          name:      p.name || p.shortId,
        });
      }
    } catch (e) {
      this._netLog('⚠ Could not load peer history: ' + e.message, true);
    }

    this._renderPeerList();

    // Wire network callbacks
    this._wireNetwork();
  }

  // ── HTML template ─────────────────────────────────────────────────────────

  _html() {
    const { shortId, fingerprint } = this.identity;
    return `
<aside id="sidebar">
  <div id="device-header">
    <div class="wordmark">Turquoise</div>
    <div class="short-id">${shortId}</div>
    <div class="full-fp">${fingerprint}</div>
  </div>
  <div id="peer-list"></div>
  <div id="net-log"></div>
</aside>

<main id="chat-area">
  <div id="chat-header">
    <span id="chat-placeholder">select a peer</span>
  </div>
  <div id="messages">
    <div id="empty-state">no peer selected</div>
  </div>
  <div id="input-bar">
    <button id="file-btn" title="Attach file">+</button>
    <textarea id="msg-input" placeholder="type a message…" rows="1"></textarea>
    <button id="send-btn">send</button>
  </div>
</main>
    `.trim();
  }

  // ── Cache DOM ─────────────────────────────────────────────────────────────

  _cacheDOM(root) {
    const ids = ['sidebar','device-header','peer-list','net-log',
                 'chat-area','chat-header','messages','input-bar',
                 'msg-input','send-btn','file-btn'];
    for (const id of ids) {
      const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.el[key] = root.querySelector('#' + id);
      if (!this.el[key]) console.error(`App: #${id} not found in DOM.`);
    }
  }

  // ── Bind events ───────────────────────────────────────────────────────────

  _bindEvents() {
    const { msgInput, sendBtn, fileBtn, chatArea } = this.el;

    // ── Keyboard ──
    if (msgInput) {
      msgInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this._sendMessage();
        }
      });
      msgInput.addEventListener('input', () => {
        msgInput.style.height = 'auto';
        msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
      });
    } else {
      console.error('App: msg-input not found.');
    }

    if (sendBtn) {
      sendBtn.addEventListener('click', () => this._sendMessage());
    }

    // ── File picker ──
    const hiddenInput = document.getElementById('file-input-hidden');
    if (fileBtn && hiddenInput) {
      fileBtn.addEventListener('click', () => {
        if (!this.activeSession) {
          this._sysMsg('Select a peer first.', true); return;
        }
        hiddenInput.click();
      });
      hiddenInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []);
        files.forEach(f => this._sendFile(f));
        hiddenInput.value = '';
      });
    } else {
      console.error('App: file-btn or file-input-hidden not found.');
    }

    // ── Drag & drop ──
    if (chatArea) {
      chatArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (this.activeSession) chatArea.classList.add('drag-over');
      });
      chatArea.addEventListener('dragleave', () => {
        chatArea.classList.remove('drag-over');
      });
      chatArea.addEventListener('drop', (e) => {
        e.preventDefault();
        chatArea.classList.remove('drag-over');
        if (!this.activeSession) { this._sysMsg('Select a peer first.', true); return; }
        Array.from(e.dataTransfer?.files || []).forEach(f => this._sendFile(f));
      });
    }
  }

  // ── Wire network → app ────────────────────────────────────────────────────

  _wireNetwork() {
    // Replace onEvent with our handler
    this.network.onEvent = (event) => {
      try { this._handleEvent(event); }
      catch (e) { this._netLog('⚠ event error: ' + e.message, true); }
    };

    // Peer lifecycle
    this.network.onPeerConnected = (fp) => {
      this._onPeerConnected(fp, null);
    };
    this.network.onPeerDisconnected = (fp) => {
      this._onPeerDisconnected(fp);
    };

    // Route network logs to sidebar footer
    this.network.logFn = (text) => {
      const isErr = text.startsWith('❌') || text.startsWith('⚠');
      this._netLog(text, isErr);
    };
  }

  // ── Handle incoming network event ─────────────────────────────────────────

  _handleEvent(event) {
    if (!event || typeof event !== 'object') return;

    const { type } = event;

    if (type === 'hello') {
      const fp = event.fingerprint;
      if (!fp) { console.warn('hello: no fingerprint'); return; }
      this._onPeerConnected(fp, event.shortId || fp.slice(0, 8));
    }

    else if (type === 'chat') {
      this._receiveMessage(event);
    }

    else if (type === 'file-start') {
      this.ft.handleMessage(event);
      this._addFileCard(event.from || '?', event.fileId, event.name, event.size, false);
    }
    else if (type === 'file-chunk' || type === 'file-end') {
      this.ft.handleMessage(event);
    }
  }

  // ── Peer connected ────────────────────────────────────────────────────────

  _onPeerConnected(fp, shortId) {
    if (!fp) return;

    const existing = this.peers.get(fp);
    const name = shortId || existing?.shortId || fp.slice(0, 8);

    this.peers.set(fp, { shortId: name, connected: true, name });

    // Persist peer
    savePeer({ fingerprint: fp, shortId: name })
      .catch(e => console.warn('savePeer failed:', e.message));

    // Load message history if first time
    if (!this.sessions.has(fp)) {
      loadMessages(fp).then(msgs => {
        this.sessions.set(fp, msgs);
        if (this.activeSession === fp) this._renderMessages();
        this._renderPeerList();
      }).catch(e => {
        console.warn('loadMessages failed:', e.message);
        this.sessions.set(fp, []);
      });
    } else {
      this._renderPeerList();
    }

    // If this is the active session, update header
    if (this.activeSession === fp) this._renderChatHeader();
  }

  // ── Peer disconnected ─────────────────────────────────────────────────────

  _onPeerDisconnected(fp) {
    if (!fp) return;
    const p = this.peers.get(fp);
    if (p) { p.connected = false; this.peers.set(fp, p); }
    this._renderPeerList();
    if (this.activeSession === fp) this._renderChatHeader();
  }

  // ── Receive text message ──────────────────────────────────────────────────

  _receiveMessage(event) {
    const fp = event.fingerprint;
    if (!fp)          { console.warn('chat: no fingerprint'); return; }
    if (!event.text)  { console.warn('chat: no text'); return; }

    const msg = {
      id:        event.id || (Date.now() + Math.random()).toString(36),
      sessionId: fp,
      from:      fp,
      fromShort: event.shortId || fp.slice(0, 8),
      text:      String(event.text),
      ts:        event.ts || Date.now(),
      type:      'text',
      own:       false,
    };

    if (!this.sessions.has(fp)) this.sessions.set(fp, []);
    this.sessions.get(fp).push(msg);

    saveMessage(msg).catch(e => console.warn('saveMessage failed:', e.message));

    if (this.activeSession !== fp) {
      this.unread.set(fp, (this.unread.get(fp) || 0) + 1);
    } else {
      this._appendMsgEl(msg);
    }

    this._renderPeerList();
  }

  // ── File progress update ──────────────────────────────────────────────────

  _onFileProgress(fileId, pct) {
    const fill = document.querySelector(`#fc-${fileId} .prog-fill`);
    if (fill) fill.style.width = (pct * 100).toFixed(1) + '%';
  }

  // ── File assembled and ready ──────────────────────────────────────────────

  _onFileReady(file) {
    if (!file?.fileId) { console.error('onFileReady: no fileId.'); return; }

    const card = document.getElementById(`fc-${file.fileId}`);
    if (!card) { console.warn('onFileReady: file card not in DOM:', file.fileId); return; }

    // Set progress to 100%
    const fill = card.querySelector('.prog-fill');
    if (fill) fill.style.width = '100%';

    // Remove progress bar, add download button
    const prog = card.querySelector('.prog-track');
    if (prog) prog.remove();

    if (!card.querySelector('.dl-btn')) {
      try {
        const a = document.createElement('a');
        a.className   = 'dl-btn';
        a.href        = file.url;
        a.download    = file.name || 'download';
        a.textContent = '↓ ' + (file.name || 'download');
        card.appendChild(a);
      } catch (e) {
        console.error('onFileReady: could not create download link:', e.message);
      }
    }
  }

  // ── File transfer error ───────────────────────────────────────────────────

  _onFileError(fileId, msg) {
    const card = document.getElementById(`fc-${fileId}`);
    if (card) {
      const err = document.createElement('div');
      err.style.cssText = 'color:var(--danger);font-size:0.68rem;margin-top:4px;';
      err.textContent   = '⚠ ' + msg;
      card.appendChild(err);
    }
    this._sysMsg('File error: ' + msg, true);
  }

  // ── Open a chat session ───────────────────────────────────────────────────

  async _openSession(fp) {
    if (!fp) return;

    this.activeSession = fp;
    this.unread.delete(fp);

    if (!this.sessions.has(fp)) {
      try {
        const msgs = await loadMessages(fp);
        this.sessions.set(fp, msgs);
      } catch (e) {
        console.warn('loadMessages failed:', e.message);
        this.sessions.set(fp, []);
      }
    }

    this._renderChatHeader();
    this._renderMessages();
    this._renderPeerList();

    if (this.el.inputBar) this.el.inputBar.style.display = 'flex';
    if (this.el.msgInput)  { this.el.msgInput.focus(); }
  }

  // ── Send text message ─────────────────────────────────────────────────────

  _sendMessage() {
    const input = this.el.msgInput;
    if (!input) return;

    const text = input.value.trim();
    if (!text)                { return; }
    if (!this.activeSession)  { this._sysMsg('Select a peer first.', true); return; }

    const fp = this.activeSession;

    const msg = {
      id:        crypto.randomUUID(),
      sessionId: fp,
      from:      this.identity.fingerprint,
      fromShort: this.identity.shortId,
      text,
      ts:        Date.now(),
      type:      'text',
      own:       true,
    };

    const sent = this.network.sendTo(fp, {
      type:        'chat',
      id:          msg.id,
      fingerprint: this.identity.fingerprint,
      shortId:     this.identity.shortId,
      text,
      ts:          msg.ts,
    });

    if (!sent) {
      this._sysMsg('Could not send — peer may be offline.', true); return;
    }

    if (!this.sessions.has(fp)) this.sessions.set(fp, []);
    this.sessions.get(fp).push(msg);

    saveMessage(msg).catch(e => console.warn('saveMessage failed:', e.message));
    this._appendMsgEl(msg);
    this._renderPeerList();

    input.value = '';
    input.style.height = 'auto';
  }

  // ── Send a file ───────────────────────────────────────────────────────────

  async _sendFile(file) {
    if (!file)               { this._sysMsg('No file provided.', true); return; }
    if (!this.activeSession) { this._sysMsg('Select a peer first.', true); return; }

    const fp     = this.activeSession;
    const fileId = crypto.randomUUID();

    // Show outgoing card immediately
    this._addFileCard(this.identity.shortId, fileId, file.name, file.size, true);

    try {
      await this.ft.sendFile(file, fp, fileId);
    } catch (e) {
      this._onFileError(fileId, e.message);
    }
  }

  // ── Render peer list ──────────────────────────────────────────────────────

  _renderPeerList() {
    const { peerList } = this.el;
    if (!peerList) return;

    if (this.peers.size === 0) {
      peerList.innerHTML = '<div id="no-peers">waiting for peers…</div>';
      return;
    }

    // Sort: online first, then alphabetical
    const sorted = [...this.peers.entries()].sort(([, a], [, b]) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return a.shortId.localeCompare(b.shortId);
    });

    let html = '';
    for (const [fp, peer] of sorted) {
      const active   = fp === this.activeSession ? ' active' : '';
      const dot      = peer.connected ? 'online' : 'offline';
      const unread   = this.unread.get(fp) || 0;
      const msgs     = this.sessions.get(fp) || [];
      const last     = msgs[msgs.length - 1];
      const preview  = last
        ? (last.type === 'text' ? this._esc(last.text) : '📎 file')
        : '';

      html += `
<div class="peer-tile${active}" data-fp="${fp}">
  <div class="peer-dot ${dot}"></div>
  <div class="peer-info">
    <div class="peer-short">${peer.shortId}</div>
    ${preview ? `<div class="peer-preview">${preview}</div>` : ''}
  </div>
  ${unread > 0 ? `<div class="peer-badge">${unread > 9 ? '9+' : unread}</div>` : ''}
</div>`.trim();
    }

    peerList.innerHTML = html;

    // Bind clicks
    peerList.querySelectorAll('.peer-tile').forEach(tile => {
      tile.addEventListener('click', () => {
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
      chatHeader.innerHTML = '<span id="chat-placeholder">select a peer</span>';
      return;
    }

    const dot = peer.connected ? 'online' : 'offline';
    chatHeader.innerHTML = `
      <div class="peer-dot ${dot}" style="flex-shrink:0;width:7px;height:7px;border-radius:50%;"></div>
      <div>
        <div class="peer-name">${peer.shortId}</div>
        <div class="peer-fp">${fp}</div>
      </div>
    `.trim();
  }

  // ── Render all messages for active session ────────────────────────────────

  _renderMessages() {
    const { messages } = this.el;
    if (!messages) return;

    messages.innerHTML = '';

    const msgs = this.sessions.get(this.activeSession) || [];

    if (msgs.length === 0) {
      messages.innerHTML = '<div class="sys-msg">no messages yet</div>';
      return;
    }

    for (const msg of msgs) {
      if (msg.type === 'text') {
        messages.appendChild(this._buildMsgEl(msg));
      }
    }

    this._scrollBottom();
  }

  // ── Append single message to active chat ──────────────────────────────────

  _appendMsgEl(msg) {
    const { messages } = this.el;
    if (!messages) return;

    // Remove empty state
    const empty = messages.querySelector('#empty-state, .sys-msg');
    if (empty && messages.children.length === 1) empty.remove();

    messages.appendChild(this._buildMsgEl(msg));
    this._scrollBottom();
  }

  // ── Build message DOM element ─────────────────────────────────────────────

  _buildMsgEl(msg) {
    const div = document.createElement('div');
    div.className = `msg ${msg.own ? 'own' : 'peer'}`;

    const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const who  = msg.own ? 'you' : (msg.fromShort || '?');

    div.innerHTML = `
      <div class="meta">${who} · ${time}</div>
      <div class="bubble">${this._esc(msg.text)}</div>
    `.trim();

    return div;
  }

  // ── Add file transfer card to active chat ─────────────────────────────────

  _addFileCard(fromShort, fileId, name, size, own) {
    const { messages } = this.el;
    if (!messages) return;

    // Remove empty state
    const empty = messages.querySelector('#empty-state, .sys-msg');
    if (empty && messages.children.length === 1) empty.remove();

    const sizeStr = this._fmtSize(size);
    const who     = own ? 'you' : (fromShort || '?');
    const time    = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const wrapper = document.createElement('div');
    wrapper.className = `msg ${own ? 'own' : 'peer'}`;
    wrapper.innerHTML = `
      <div class="meta">${who} · ${time}</div>
      <div class="file-card" id="fc-${fileId}">
        <div class="file-name">📎 ${this._esc(name || 'file')}</div>
        <div class="file-size">${sizeStr}</div>
        <div class="prog-track"><div class="prog-fill" style="width:0%"></div></div>
      </div>
    `.trim();

    messages.appendChild(wrapper);
    this._scrollBottom();
  }

  // ── System message ─────────────────────────────────────────────────────────

  _sysMsg(text, isErr = false) {
    const { messages } = this.el;
    if (!messages) { console.warn(text); return; }

    const div = document.createElement('div');
    div.className = `sys-msg${isErr ? ' err' : ''}`;
    div.textContent = text;
    messages.appendChild(div);
    this._scrollBottom();
    setTimeout(() => { try { div.remove(); } catch {} }, 5000);
  }

  // ── Network log (sidebar footer) ──────────────────────────────────────────

  _netLog(text, isErr = false) {
    const { netLog } = this.el;
    if (!netLog) { console.log(text); return; }

    const div = document.createElement('div');
    div.className = `entry${isErr ? ' err' : ''}`;
    div.textContent = text;
    netLog.appendChild(div);
    netLog.scrollTop = netLog.scrollHeight;

    // Cap log at 100 entries
    while (netLog.children.length > 100) {
      try { netLog.removeChild(netLog.firstChild); } catch { break; }
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  _scrollBottom() {
    const { messages } = this.el;
    if (messages) messages.scrollTop = messages.scrollHeight;
  }

  _esc(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _fmtSize(bytes) {
    if (!bytes || isNaN(bytes)) return '?';
    if (bytes < 1024)       return bytes + ' B';
    if (bytes < 1024 ** 2)  return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 ** 3)  return (bytes / 1024 ** 2).toFixed(1) + ' MB';
    return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  }
}
