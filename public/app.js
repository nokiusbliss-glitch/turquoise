/**
 * app.js — Turquoise v5
 * UI layer: peers, circles, global mesh, chat, file transfer,
 * walkie, live stream, tools, nick editing, live status bar.
 */

import { loadPeers, savePeer, loadMessages, saveMessage, clearAllData } from './messages.js';
import { resetIdentity } from './identity.js';
import { FileTransferEngine, fmtBytes, fmtRate, fmtEta } from './files.js';
import { TOOL_REGISTRY, getToolById } from './tools-registry.js';
import { createToolRuntime } from './tools-modules.js';

const CIRCLE_KEY_PREFIX = 'tq-circles:';
const MESH_SESSION_ID   = 'mesh:global';
const STATUS_LINGER_MS  = 3500;

export class TurquoiseApp {
  constructor(identity, network) {
    this.identity = identity;
    this.network  = network;

    this.peers   = new Map();
    this.circles = [];
    this.currentChat = { kind: 'none', id: null };

    this.pendingFileOffers   = new Map();
    this.transferViews       = new Map();
    this.pendingToolInvites  = new Map();
    this.outgoingToolInvites = new Map();
    this.toolSessions        = new Map();

    this.callState     = null;
    this.incomingCall  = null;
    this.walkieRecorder = null;
    this.walkieChunks  = [];

    this.statsTicker    = null;
    this.prevStats      = new Map();
    this._statusTimer   = null;
    this._sigState      = 'disconnected';
    this._totalUp       = 0;
    this._totalDown     = 0;

    this.$ = {};
  }

  /* ═══════════════════════════ BOOT ═══════════════════════════ */

  async mount() {
    this._cacheDom();
    this._bindUI();
    this._wireNetwork();

    this._renderNick();
    this.$fullFp.textContent = this.identity.fingerprint;

    await this._loadStoredPeers();
    this._loadCircles();
    this._renderSidebar();

    this.fileEngine = new FileTransferEngine(this.network, {
      onOffer:       (fp, offer) => this._onFileOffer(fp, offer),
      onProgress:    (p)         => this._onTransferProgress(p),
      onComplete:    (done)      => this._onTransferComplete(done),
      onStateChange: (s)         => this._onTransferStateChange(s),
      onError:       (err)       => this._onTransferError(err),
    });

    this._flash('ready', 2000);
    this._startStatsTicker();

    // First boot: prompt user to set a name
    if (this.identity.isNewUser) {
      setTimeout(() => this._editNick(), 600);
    }
  }

  /* ═══════════════════════════ DOM ═══════════════════════════ */

  _cacheDom() {
    const $ = (id) => document.getElementById(id);
    this.$app          = $('app');
    this.$sidebar      = $('sidebar');
    this.$peerList     = $('peer-list');
    this.$circlesList  = $('circles-list');
    this.$newCircleBtn = $('new-circle-btn');
    this.$netLog       = $('net-log');

    this.$nickDisplay  = $('nick-display');
    this.$nickEditBtn  = $('nick-edit-btn');
    this.$resetBtn     = $('reset-identity-btn');
    this.$fullFp       = $('full-fp');

    this.$chatHeader   = $('chat-header');
    this.$chatTitle    = $('chat-title');
    this.$chatSubtitle = $('chat-subtitle');
    this.$messages     = $('messages');
    this.$msgInput     = $('msg-input');
    this.$sendBtn      = $('send-btn');
    this.$statusLive   = $('status-live');
    this.$statusMsg    = $('status-msg');

    this.$fileBtn   = $('file-btn');
    this.$plusMenu  = $('plus-menu');
    this.$fileInput = $('__file-input');

    this.$backBtn      = $('back-btn');
    this.$walkieBtn    = $('walkie-btn');
    this.$videoCallBtn = $('video-call-btn');
    this.$callPanel    = $('call-panel');
    this.$callIncoming = $('call-incoming');

    this.$modalRoot = $('modal-root');
  }

  _bindUI() {
    this.$sendBtn.addEventListener('click', () => this._sendText());
    this.$msgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._sendText(); }
    });
    // Auto-resize textarea
    this.$msgInput.addEventListener('input', () => {
      this.$msgInput.style.height = 'auto';
      this.$msgInput.style.height = Math.min(this.$msgInput.scrollHeight, window.innerHeight * 0.28) + 'px';
    });

    this.$fileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.$plusMenu.classList.toggle('hidden');
    });

    this.$plusMenu.addEventListener('click', (e) => {
      const action = e.target?.dataset?.plus;
      if (!action) return;
      this.$plusMenu.classList.add('hidden');
      if (action === 'file')   this.$fileInput.click();
      if (action === 'tool')   this._openToolPicker();
      if (action === 'circle') this._openCircleEditor(null);
    });

    document.addEventListener('click', (e) => {
      if (!this.$plusMenu.contains(e.target) && e.target !== this.$fileBtn)
        this.$plusMenu.classList.add('hidden');
    });

    this.$fileInput.addEventListener('change', (e) => this._onPickFiles(e));
    this.$newCircleBtn.addEventListener('click', () => this._openCircleEditor(null));
    this.$backBtn.addEventListener('click', () => this.$sidebar.classList.remove('hidden-mobile'));

    this.$walkieBtn.addEventListener('click', () => this._toggleWalkie());
    this.$videoCallBtn.addEventListener('click', () => this._startCall('video'));

    this.$messages.addEventListener('click', (e) => this._onMessageActionClick(e));

    // Nick editing
    this.$nickDisplay.addEventListener('click', () => this._editNick());
    this.$nickEditBtn.addEventListener('click', () => this._editNick());

    // Reset identity
    this.$resetBtn.addEventListener('click', () => this._confirmReset());
  }

  /* ═════════════════════════ NETWORK WIRING ════════════════════ */

  _wireNetwork() {
    this.network.onPeerConnected = (fp, nick) => {
      this._upsertPeer(fp, nick || this.network.getPeerNick(fp), true);
      this._log(`peer up ${short(fp)}`);
      this._renderSidebar();
      savePeer({ fingerprint: fp, nickname: nick || null }).catch(() => {});
      this._updateLiveStats();
      this.fileEngine?.onPeerReconnected(fp);
    };

    this.network.onPeerDisconnected = (fp) => {
      const p = this.peers.get(fp);
      if (p) p.online = false;
      this._renderSidebar();
      this._log(`peer down ${short(fp)}`);
      this._detachCallPeer(fp);
      this._updateLiveStats();
      this.fileEngine?.onPeerDisconnected(fp);
      this.prevStats.delete(fp);
    };

    this.network.onMessage   = (fp, msg) => this._onCtrlMessage(fp, msg);
    this.network.onBinaryChunk = (fp, ab) => this.fileEngine?.handleBinary(fp, ab);

    this.network.onLog = (text, isErr) => {
      this._log(text, isErr);
      this._updateLiveStats();
    };

    this.network.onSignalingConnected = () => {
      this._sigState = 'connected';
      this._flash('signaling connected', 2000);
      this._updateLiveStats();
    };

    this.network.onSignalingDisconnected = () => {
      this._sigState = 'disconnected';
      this._flash('signaling disconnected');
      this._updateLiveStats();
    };
  }

  /* ═══════════════════════ IDENTITY / NICK ════════════════════ */

  _renderNick() {
    this.$nickDisplay.textContent = this.identity.nickname || short(this.identity.fingerprint);
  }

  async _editNick() {
    const current = this.identity.nickname || '';
    const box = document.createElement('div');
    box.className = 'modal';
    box.innerHTML = `
      <h3>Edit Display Name</h3>
      <div class="row">
        <input id="nick-input" type="text" maxlength="32" placeholder="your name…" value="${escapeAttr(current)}" autocomplete="off">
      </div>
      <div style="font-size:.62rem;color:var(--tx2);margin-bottom:8px;">
        Shown to peers. Max 32 chars. Leave blank to use your short ID.
      </div>
      <div class="actions">
        <button id="nick-cancel">cancel</button>
        <button id="nick-save">save</button>
      </div>
    `;

    const save = async () => {
      const val = box.querySelector('#nick-input').value.trim();
      try {
        const saved = await this.identity.saveNickname(val || this.identity.shortId);
        this.identity.nickname = saved;
        this._renderNick();
        // Re-announce to connected peers
        for (const fp of this.network.getConnectedPeers()) {
          this.network.sendCtrl(fp, {
            type: 'hello',
            fingerprint: this.identity.fingerprint,
            nick: saved,
          });
        }
        this._flash('name saved');
      } catch (e) {
        this._flash('save failed: ' + e.message);
      }
      this._closeModal();
    };

    box.querySelector('#nick-cancel').addEventListener('click', () => this._closeModal());
    box.querySelector('#nick-save').addEventListener('click', save);
    box.querySelector('#nick-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });

    this._openModal(box);
    setTimeout(() => box.querySelector('#nick-input')?.focus(), 50);
  }

  async _confirmReset() {
    const box = document.createElement('div');
    box.className = 'modal';
    box.innerHTML = `
      <h3>⚠ Reset Identity</h3>
      <div style="font-size:.72rem;color:var(--tx0);margin-bottom:10px;line-height:1.6">
        This will permanently delete:<br>
        <span style="color:var(--tx1)">· your keypair (fingerprint changes)<br>
        · your nickname<br>
        · all message history<br>
        · all known peers<br>
        · all circles</span>
      </div>
      <div style="font-size:.62rem;color:var(--err);margin-bottom:10px;">This cannot be undone.</div>
      <div class="actions">
        <button id="reset-cancel">cancel</button>
        <button id="reset-confirm" style="border-color:var(--err);color:var(--err);">delete everything</button>
      </div>
    `;

    box.querySelector('#reset-cancel').addEventListener('click', () => this._closeModal());
    box.querySelector('#reset-confirm').addEventListener('click', async () => {
      this._closeModal();
      try {
        clearInterval(this.statsTicker);
        await resetIdentity();
        await clearAllData();
        localStorage.clear();
        sessionStorage.clear();
        this._flash('clearing cache…', 0);
        // Clear all SW caches
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
        // Unregister service worker so fresh files load on reload
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
        this._flash('identity reset — loading fresh…', 0);
        setTimeout(() => location.reload(true), 600);
      } catch (e) {
        this._flash('reset failed: ' + e.message);
      }
    });

    this._openModal(box);
  }

  async _loadStoredPeers() {
    try {
      const rows = await loadPeers();
      for (const p of rows) {
        this.peers.set(p.fingerprint, {
          fingerprint: p.fingerprint,
          nick:    p.nickname || p.nick || short(p.fingerprint),
          online:  false,
          lastSeen: p.lastSeen || 0,
        });
      }
    } catch {}
  }

  _loadCircles() {
    try {
      const raw = localStorage.getItem(this._circleStorageKey());
      const arr = raw ? JSON.parse(raw) : [];
      this.circles = Array.isArray(arr) ? arr : [];
    } catch { this.circles = []; }
  }

  _saveCircles() {
    try {
      localStorage.setItem(this._circleStorageKey(), JSON.stringify(this.circles));
    } catch {}
  }

  _circleStorageKey() {
    return `${CIRCLE_KEY_PREFIX}${this.identity.fingerprint}`;
  }

  /* ═══════════════════════ SIDEBAR RENDER ═════════════════════ */

  _upsertPeer(fp, nick, online) {
    const prev = this.peers.get(fp);
    this.peers.set(fp, {
      fingerprint: fp,
      nick: nick || prev?.nick || short(fp),
      online: online ?? prev?.online ?? false,
      lastSeen: Date.now(),
    });
  }

  _renderSidebar() {
    /* ── Network Mesh (global, always first) ── */
    this.$peerList.innerHTML = '';

    const meshEl = document.createElement('div');
    const onlineCount = this.network.getConnectedPeers().length;
    const isMeshActive = this.currentChat.kind === 'mesh' && this.currentChat.id === 'global';
    meshEl.className = `peer-item${isMeshActive ? ' active' : ''} mesh-item`;
    meshEl.innerHTML = `
      <div class="peer-left">
        <span class="dot ${onlineCount > 0 ? 'on' : ''}"></span>
        <span class="peer-name">Network Mesh</span>
      </div>
      <span class="mini">${onlineCount} online</span>
    `;
    meshEl.addEventListener('click', () => this._openMeshChat());
    this.$peerList.appendChild(meshEl);

    /* ── Individual peers ── */
    const peers = [...this.peers.values()]
      .sort((a, b) => Number(b.online) - Number(a.online) || a.nick.localeCompare(b.nick));

    for (const p of peers) {
      const isActive    = this.currentChat.kind === 'peer' && this.currentChat.id === p.fingerprint;
      const inCall      = this.callState && (this.callState.targets.has(p.fingerprint) || this.callState.accepted.has(p.fingerprint));
      const el = document.createElement('div');
      el.className = `peer-item${isActive ? ' active' : ''}`;
      el.innerHTML = `
        <div class="peer-left">
          <span class="dot ${p.online ? 'on' : ''}"></span>
          <span class="peer-name">${escapeHtml(p.nick)}</span>
          ${inCall ? '<span class="call-badge">● live</span>' : ''}
        </div>
        <span class="mini">${short(p.fingerprint)}</span>
      `;
      el.addEventListener('click', () => this._openPeerChat(p.fingerprint));
      this.$peerList.appendChild(el);
    }

    /* ── Circles ── */
    this.$circlesList.innerHTML = '';
    for (const c of this.circles) {
      const isActive = this.currentChat.kind === 'circle' && this.currentChat.id === c.id;
      const onlineMembers = (c.members || []).filter(fp => this.network.isReady(fp)).length;
      const el = document.createElement('div');
      el.className = `circle-item${isActive ? ' active' : ''}`;
      el.innerHTML = `
        <div class="peer-left">
          <span class="dot ${onlineMembers > 0 ? 'on' : ''}"></span>
          <span class="peer-name">${escapeHtml(c.name)}</span>
        </div>
        <div>
          <span class="mini">${onlineMembers}/${(c.members || []).length}</span>
          <button class="circle-edit" title="edit" data-circle-edit="${c.id}">✎</button>
        </div>
      `;
      el.addEventListener('click', (e) => {
        if (e.target?.dataset?.circleEdit) return;
        this._openCircleChat(c.id);
      });
      el.querySelector('[data-circle-edit]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this._openCircleEditor(c.id);
      });
      this.$circlesList.appendChild(el);
    }
  }

  /* ═══════════════════════ CHAT SESSIONS ══════════════════════ */

  async _openMeshChat() {
    this.currentChat = { kind: 'mesh', id: 'global' };
    const count = this.network.getConnectedPeers().length;
    this.$chatTitle.textContent = 'Network Mesh';
    this.$chatSubtitle.textContent = `everyone · ${count} online`;
    this.$sidebar.classList.add('hidden-mobile');
    this._renderSidebar();
    await this._renderChatMessages();
    this._setActionEnabled(count > 0);
  }

  async _openPeerChat(fp) {
    this.currentChat = { kind: 'peer', id: fp };
    this.$chatTitle.textContent = this.peers.get(fp)?.nick || short(fp);
    this.$chatSubtitle.textContent = `${short(fp)} · direct`;
    this.$sidebar.classList.add('hidden-mobile');
    this._renderSidebar();
    await this._renderChatMessages();
    this._setActionEnabled(this.network.isReady(fp));
  }

  async _openCircleChat(circleId) {
    const c = this.circles.find(x => x.id === circleId);
    if (!c) return;
    this.currentChat = { kind: 'circle', id: circleId };
    this.$chatTitle.textContent = c.name;
    this.$chatSubtitle.textContent = `${c.members.length} members`;
    this.$sidebar.classList.add('hidden-mobile');
    this._renderSidebar();
    await this._renderChatMessages();
    this._setActionEnabled(true);
  }

  _setActionEnabled(ok) {
    this.$walkieBtn.disabled    = !ok;
    this.$videoCallBtn.disabled = !ok;
    this.$sendBtn.disabled      = !ok;
  }

  _sessionId() {
    if (this.currentChat.kind === 'peer')   return `peer:${this.currentChat.id}`;
    if (this.currentChat.kind === 'circle') return `circle:${this.currentChat.id}`;
    if (this.currentChat.kind === 'mesh')   return MESH_SESSION_ID;
    return null;
  }

  _targetPeers() {
    if (this.currentChat.kind === 'peer') return [this.currentChat.id].filter(fp => this.network.isReady(fp));

    if (this.currentChat.kind === 'circle') {
      const c = this.circles.find(x => x.id === this.currentChat.id);
      if (!c) return [];
      return c.members.filter(fp => this.network.isReady(fp));
    }

    if (this.currentChat.kind === 'mesh') {
      return this.network.getConnectedPeers();
    }

    return [];
  }

  /* ═══════════════════════════ CHAT ═══════════════════════════ */

  async _sendText() {
    const sessionId = this._sessionId();
    if (!sessionId) return;

    const text = this.$msgInput.value.trim();
    if (!text) return;
    this.$msgInput.value = '';
    this.$msgInput.style.height = '';

    const ts = Date.now();
    const localMsg = {
      id: crypto.randomUUID(),
      sessionId,
      kind: 'text',
      from: this.identity.fingerprint,
      text,
      ts,
      mine: true,
    };

    await this._saveAndRender(localMsg, true);

    const targets = this._targetPeers();

    if (this.currentChat.kind === 'peer') {
      if (targets[0]) this.network.sendCtrl(targets[0], { type: 'chat', text, ts, sessionId });
      return;
    }

    if (this.currentChat.kind === 'circle') {
      const circle = this.circles.find(c => c.id === this.currentChat.id);
      for (const fp of targets) {
        this.network.sendCtrl(fp, {
          type: 'circle-chat', circleId: circle.id,
          circleName: circle.name, members: circle.members, text, ts,
        });
      }
      return;
    }

    if (this.currentChat.kind === 'mesh') {
      for (const fp of targets) {
        this.network.sendCtrl(fp, { type: 'mesh-chat', text, ts });
      }
    }
  }

  async _onCtrlMessage(fp, msg) {
    if (!msg?.type) return;

    if (this.fileEngine?.handleCtrl(fp, msg)) return;

    if (msg.type === 'hello') {
      this._upsertPeer(fp, msg.nick, true);
      this._renderSidebar();
      return;
    }

    if (msg.type === 'chat') {
      const sid = msg.sessionId || `peer:${fp}`;
      await this._saveAndRender({
        id: crypto.randomUUID(), sessionId: `peer:${fp}`,
        kind: 'text', from: fp, text: msg.text || '', ts: msg.ts || Date.now(), mine: false,
      }, this._sessionId() === `peer:${fp}`);
      return;
    }

    if (msg.type === 'circle-chat') {
      this._upsertRemoteCircle(msg.circleId, msg.circleName, msg.members || []);
      const sid = `circle:${msg.circleId}`;
      await this._saveAndRender({
        id: crypto.randomUUID(), sessionId: sid,
        kind: 'text', from: fp, text: msg.text || '', ts: msg.ts || Date.now(), mine: false,
      }, this._sessionId() === sid);
      return;
    }

    if (msg.type === 'mesh-chat') {
      await this._saveAndRender({
        id: crypto.randomUUID(), sessionId: MESH_SESSION_ID,
        kind: 'text', from: fp, text: msg.text || '', ts: msg.ts || Date.now(), mine: false,
      }, this._sessionId() === MESH_SESSION_ID);
      return;
    }

    if (msg.type === 'tool-invite') {
      this.pendingToolInvites.set(msg.inviteId, { ...msg, from: fp });
      this._appendInviteMessage(fp, msg);
      return;
    }

    if (msg.type === 'tool-invite-response') { this._onToolInviteResponse(fp, msg); return; }
    if (msg.type === 'tool-start')           { this._openToolSession({ toolSessionId: msg.toolSessionId, toolId: msg.toolId, participants: msg.participants || [], chatContext: msg.chatContext }); return; }

    if (msg.type === 'tool-action') {
      const sess = this.toolSessions.get(msg.toolSessionId);
      if (sess?.runtime) sess.runtime.apply(msg.action);
      return;
    }

    if (msg.type === 'call-invite')  { this._showIncomingCall(fp, msg);        return; }
    if (msg.type === 'call-accept')  { await this._onCallAccepted(fp, msg);    return; }
    if (msg.type === 'call-decline') { this._onCallDeclined(fp, msg);          return; }
    if (msg.type === 'call-end')     { this._detachCallPeer(fp);               return; }
    if (msg.type === 'offer-reneg')  { await this._answerRenegOffer(fp, msg);  return; }
  }

  /* ═══════════════════════ MESSAGE DOM ════════════════════════ */

  async _renderChatMessages() {
    const sessionId = this._sessionId();
    this.$messages.innerHTML = '';
    if (!sessionId) {
      this.$messages.innerHTML = '<div class="sys-msg">select a peer, circle, or the mesh</div>';
      return;
    }

    let rows = [];
    try { rows = await loadMessages(sessionId); } catch {}

    if (!rows.length) {
      this.$messages.innerHTML = '<div class="sys-msg">no messages yet — say hello</div>';
    } else {
      for (const m of rows) this._appendMessageToDOM(m);
    }

    // Mount any tool sessions that belong to this chat
    for (const [, sess] of this.toolSessions) {
      if (this._sessionIdFromContext(sess.chatContext) === sessionId && !sess.mounted) {
        this._mountToolSessionToDOM(sess);
      }
    }

    this._scrollToBottom();
  }

  async _saveAndRender(msg, renderNow) {
    try { await saveMessage(msg); } catch {}
    if (renderNow) {
      this._appendMessageToDOM(msg);
      this._scrollToBottom();
    }
  }

  _appendMessageToDOM(m) {
    const row = document.createElement('div');
    row.className = `msg-row${m.mine ? ' mine' : ''}`;
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = `${m.mine ? 'you' : this._peerNick(m.from)}  ·  ${fmtTime(m.ts)}`;
    bubble.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'msg-text';
    if (m.kind === 'system') body.style.color = '#7ab8b2';
    body.textContent = m.text || (m.kind !== 'text' && m.kind !== 'system' ? `[${m.kind}]` : '');
    bubble.appendChild(body);

    row.appendChild(bubble);
    this.$messages.appendChild(row);
  }

  _appendInviteMessage(fromFp, invite) {
    const sessionId = invite.chatContext?.kind === 'circle'
      ? `circle:${invite.chatContext.id}`
      : invite.chatContext?.kind === 'mesh'
      ? MESH_SESSION_ID
      : `peer:${fromFp}`;

    const toolTitle = getToolById(invite.toolId)?.title || invite.toolId;

    if (this._sessionId() === sessionId) {
      const row = document.createElement('div');
      row.className = 'msg-row';
      row.innerHTML = `
        <div class="msg-bubble">
          <div class="msg-meta">${escapeHtml(this._peerNick(fromFp))} · invite</div>
          <div class="msg-text">${escapeHtml(this._peerNick(fromFp))} invited you to <b>${escapeHtml(toolTitle)}</b></div>
          <div class="msg-actions">
            <button data-invite-accept="${invite.inviteId}">accept</button>
            <button data-invite-reject="${invite.inviteId}">decline</button>
          </div>
        </div>
      `;
      this.$messages.appendChild(row);
      this._scrollToBottom();
    }

    this._saveAndRender({
      id: crypto.randomUUID(), sessionId,
      kind: 'system', from: fromFp,
      text: `${this._peerNick(fromFp)} invited you to ${toolTitle}`,
      ts: Date.now(), mine: false,
    }, false);
  }

  _onMessageActionClick(e) {
    const inviteAccept = e.target?.dataset?.inviteAccept;
    const inviteReject = e.target?.dataset?.inviteReject;
    const fileAccept   = e.target?.dataset?.fileAccept;
    const fileReject   = e.target?.dataset?.fileReject;
    const fsTarget     = e.target?.dataset?.fullscreen;
    const dlTarget     = e.target?.dataset?.download;

    if (inviteAccept)  { this._respondToolInvite(inviteAccept, true);  return; }
    if (inviteReject)  { this._respondToolInvite(inviteReject, false); return; }

    if (fileAccept) {
      const row = this.pendingFileOffers.get(fileAccept);
      if (row) this.fileEngine.acceptOffer(row.fp, fileAccept);
      this.pendingFileOffers.delete(fileAccept);
      e.target.closest('.msg-row')?.remove();
      return;
    }

    if (fileReject) {
      const row = this.pendingFileOffers.get(fileReject);
      if (row) this.fileEngine.rejectOffer(row.fp, fileReject);
      this.pendingFileOffers.delete(fileReject);
      e.target.closest('.msg-row')?.remove();
      return;
    }

    if (fsTarget) {
      document.getElementById(fsTarget)?.requestFullscreen?.();
      return;
    }

    if (dlTarget) {
      const view = this.transferViews.get(dlTarget);
      if (view?.downloadUrl) {
        const a = document.createElement('a');
        a.href     = view.downloadUrl;
        a.download = view.fileName || 'download';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    }
  }

  /* ═════════════════════════ FILE TRANSFER ═══════════════════ */

  async _onPickFiles(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;

    const targets   = this._targetPeers();
    const sessionId = this._sessionId();
    if (!targets.length || !sessionId) {
      this._flash('select a peer / circle first');
      return;
    }

    for (const file of files) {
      for (const fp of targets) {
        await this.fileEngine.sendFile(fp, file, { sessionId });
        this._flash(`offering ${file.name} to ${this._peerNick(fp)}…`);
      }
    }
  }

  _onFileOffer(fp, offer) {
    this.pendingFileOffers.set(offer.id, { fp, offer });

    const isAudio = (offer.mime || '').startsWith('audio/');
    const label   = isAudio ? '🎙 voice note' : '📎 file request';

    const row = document.createElement('div');
    row.className = 'msg-row';
    row.innerHTML = `
      <div class="msg-bubble">
        <div class="msg-meta">${escapeHtml(this._peerNick(fp))} · ${label}</div>
        <div class="msg-text file-name">${escapeHtml(offer.name)}</div>
        <div class="msg-text file-size">${fmtBytes(offer.size)}</div>
        <div class="msg-actions">
          <button data-file-accept="${offer.id}">accept</button>
          <button data-file-reject="${offer.id}">decline</button>
        </div>
      </div>
    `;

    if (this._sessionId() === (offer.sessionId || `peer:${fp}`)) {
      this.$messages.appendChild(row);
      this._scrollToBottom();
    }

    this._saveAndRender({
      id: crypto.randomUUID(), sessionId: offer.sessionId || `peer:${fp}`,
      kind: 'system', from: fp,
      text: `${this._peerNick(fp)} wants to send ${offer.name} (${fmtBytes(offer.size)})`,
      ts: Date.now(), mine: false,
    }, false);
  }

  _onTransferProgress(p) {
    let view = this.transferViews.get(p.transferId);
    if (!view) {
      view = this._createTransferView(p);
      this.transferViews.set(p.transferId, view);
    }
    if (view.fill) view.fill.style.width = `${p.pct.toFixed(2)}%`;
    if (view.nerd) {
      const dir = p.direction === 'send' ? '↑' : '↓';
      view.nerd.textContent =
        `${dir} ${fmtBytes(p.bytes)} / ${fmtBytes(p.total)}  ·  ${fmtRate(p.speed)}  ·  ETA ${fmtEta(p.etaSec)}`;
    }
    if (view.statusEl) { view.statusEl.textContent = 'transferring'; view.statusEl.className = 'tx-status tx-transferring'; }
    if (view.retryBtn) view.retryBtn.style.display = 'none';
  }

  _createTransferView(p) {
    const isAudio  = (p.mime || '').startsWith('audio/');
    const isImage  = (p.mime || '').startsWith('image/');
    const icon     = isAudio ? '🎙' : isImage ? '🖼' : '📁';
    const sender   = p.direction === 'send' ? 'you' : escapeHtml(this._peerNick(p.fp));
    const dirLabel = p.direction === 'send' ? '↑ sending' : '↓ receiving';

    const row = document.createElement('div');
    row.className = `msg-row${p.direction === 'send' ? ' mine' : ''}`;
    row.innerHTML = `
      <div class="msg-bubble">
        <div class="msg-meta">${sender} · ${icon} ${escapeHtml(p.fileName)}</div>
        <div class="transfer">
          <div class="tx-status-row">
            <span class="tx-status tx-transferring">${dirLabel}</span>
            <span class="tx-size">${fmtBytes(p.total)}</span>
          </div>
          <div class="transfer-bar"><div class="transfer-fill"></div></div>
          <div class="transfer-nerd"></div>
          <div class="transfer-actions"></div>
          <div class="transfer-media"></div>
        </div>
      </div>
    `;

    const fill    = row.querySelector('.transfer-fill');
    const nerd    = row.querySelector('.transfer-nerd');
    const media   = row.querySelector('.transfer-media');
    const actions = row.querySelector('.transfer-actions');
    const statusEl = row.querySelector('.tx-status');

    // Dismiss button — always visible, removes card after confirmation
    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = '✕ dismiss';
    dismissBtn.className   = 'tx-btn tx-dismiss';
    dismissBtn.addEventListener('click', () => {
      this.fileEngine?.dismiss(p.transferId);
      this.transferViews.delete(p.transferId);
      row.remove();
    });
    actions.appendChild(dismissBtn);

    // Retry button — only shown on fail/paused (send direction)
    let retryBtn = null;
    if (p.direction === 'send') {
      retryBtn = document.createElement('button');
      retryBtn.textContent = '↺ retry';
      retryBtn.className   = 'tx-btn tx-retry';
      retryBtn.style.display = 'none';
      retryBtn.addEventListener('click', () => {
        this.fileEngine?.retryOutgoing(p.transferId);
      });
      actions.appendChild(retryBtn);
    }

    const sessionId = p.sessionId || `peer:${p.fp}`;
    if (this._sessionId() === sessionId) {
      this.$messages.appendChild(row);
      this._scrollToBottom();
    }

    return { row, fill, nerd, media, actions, statusEl, retryBtn, sessionId, fileName: p.fileName, mime: p.mime };
  }

  _onTransferComplete(done) {
    const view = this.transferViews.get(done.transferId);
    if (view) {
      if (view.fill) view.fill.style.width = '100%';
      if (view.nerd) view.nerd.textContent = `✓ ${done.direction === 'send' ? 'sent' : 'received'}  ·  ${fmtBytes(done.size)}`;

      if (done.direction === 'recv' && done.blob && view.media) {
        const url        = URL.createObjectURL(done.blob);
        view.downloadUrl = url;

        const isAudio = done.blob.type?.startsWith('audio/');
        const isImage = done.blob.type?.startsWith('image/');

        if (isAudio) {
          const audio = document.createElement('audio');
          audio.controls = true;
          audio.src      = url;
          audio.style.cssText = 'width:100%;margin-top:6px;accent-color:var(--tq);';
          view.media.appendChild(audio);
        } else if (isImage) {
          const img = document.createElement('img');
          img.src   = url;
          img.style.cssText = 'max-width:100%;max-height:240px;margin-top:6px;border:1px solid var(--tq-low);';
          view.media.appendChild(img);
        }

        // Download button for non-auto-rendered types or as fallback
        const dlBtn = document.createElement('button');
        dlBtn.dataset.download  = done.transferId;
        dlBtn.style.cssText = 'border:1px solid var(--tq-mid);background:transparent;color:var(--tq);cursor:pointer;padding:3px 10px;font-size:.65rem;margin-top:6px;';
        dlBtn.textContent = `↓ save ${done.fileName}`;
        view.media.appendChild(dlBtn);

        // Don't auto-revoke — user might download later
        this.transferViews.get(done.transferId) && (this.transferViews.get(done.transferId).downloadUrl = url);
      }
    }

    this._saveAndRender({
      id: crypto.randomUUID(), sessionId: done.sessionId || `peer:${done.fp}`,
      kind: 'system',
      from: done.direction === 'send' ? this.identity.fingerprint : done.fp,
      text: `${done.direction === 'send' ? 'sent' : 'received'} ${done.fileName} (${fmtBytes(done.size)})`,
      ts: Date.now(), mine: done.direction === 'send',
    }, false);
  }

  _onTransferStateChange(s) {
    let view = this.transferViews.get(s.transferId);
    if (!view) {
      view = this._createTransferView(s);
      this.transferViews.set(s.transferId, view);
    }

    const { state, failReason, pct } = s;

    if (view.fill) view.fill.style.width = `${(pct||0).toFixed(2)}%`;

    if (view.statusEl) {
      const labels = {
        offering:     'waiting for accept…',
        transferring: s.direction === 'send' ? '↑ sending' : '↓ receiving',
        retrying:     '↺ reconnecting…',
        paused:       '⏸ paused — waiting for peer',
        complete:     s.direction === 'send' ? '✓ sent' : '✓ received',
        failed:       `✗ ${failReason || 'failed'}`,
      };
      view.statusEl.textContent = labels[state] || state;
      view.statusEl.className   = `tx-status tx-${state}`;
    }

    if (view.nerd && (state === 'complete' || state === 'failed' || state === 'paused')) {
      view.nerd.textContent = state === 'complete'
        ? `${fmtBytes(s.total)} — done`
        : state === 'paused'
        ? `${fmtBytes(s.bytes)} of ${fmtBytes(s.total)} transferred`
        : failReason || '';
    }

    // Show retry button for send failures / pauses
    if (view.retryBtn) {
      view.retryBtn.style.display = (state === 'failed' || state === 'paused') ? '' : 'none';
    }

    // On complete, dim dismiss button label
    if (state === 'complete' && view.actions) {
      const db = view.actions.querySelector('.tx-dismiss');
      if (db) db.textContent = '✕ clear';
    }
  }

  _onTransferError(err) {
    this._flash(`transfer ${err.direction === 'send' ? '↑' : '↓'} ${err.fileName}: ${err.error}`);
    const view = this.transferViews.get(err.transferId);
    if (view?.statusEl) {
      view.statusEl.textContent = `✗ ${err.error}`;
      view.statusEl.className   = 'tx-status tx-failed';
    }
  }

  /* ═══════════════════════════ TOOLS ══════════════════════════ */

  _openToolPicker() {
    const targets = this._targetPeers();
    if (!targets.length) { this._flash('no active targets in current chat'); return; }

    const box = document.createElement('div');
    box.className = 'modal';
    box.innerHTML = `<h3>Start game / tool</h3>`;

    for (const tool of TOOL_REGISTRY) {
      const it = document.createElement('div');
      it.className = 'tool-item';
      it.innerHTML = `
        <div style="font-size:.74rem;color:var(--tx0)">${escapeHtml(tool.title)}</div>
        <div style="font-size:.62rem;color:var(--tx1);margin-top:2px">${escapeHtml(tool.description)}</div>
        <div style="font-size:.58rem;color:var(--tx2);margin-top:4px">
          ${tool.minPeers}–${tool.maxPeers} peers · ${tool.implemented ? '<span style="color:var(--ok)">ready</span>' : '<span style="color:var(--tx2)">placeholder</span>'}
        </div>
      `;
      it.addEventListener('click', () => { this._closeModal(); this._inviteTool(tool.id); });
      box.appendChild(it);
    }

    this._openModal(box);
  }

  _inviteTool(toolId) {
    const tool = getToolById(toolId);
    if (!tool) return;

    const targets = this._targetPeers();
    if (targets.length < tool.minPeers - 1) {
      this._flash(`need ≥${tool.minPeers} peers for ${tool.title}`);
      return;
    }

    const inviteId   = crypto.randomUUID();
    const chatContext = { ...this.currentChat };
    const track = { toolId, chatContext, accepted: new Set(), declined: new Set(), started: false };
    this.outgoingToolInvites.set(inviteId, track);

    for (const fp of targets) {
      this.network.sendCtrl(fp, {
        type: 'tool-invite', inviteId, toolId,
        fromNick: this.identity.nickname, chatContext, ts: Date.now(),
      });
    }

    this._saveAndRender({
      id: crypto.randomUUID(), sessionId: this._sessionId(),
      kind: 'system', from: this.identity.fingerprint,
      text: `invited ${targets.length} peer(s) to ${tool.title}`,
      ts: Date.now(), mine: true,
    }, true);
  }

  _respondToolInvite(inviteId, accept) {
    const invite = this.pendingToolInvites.get(inviteId);
    if (!invite) return;
    this.pendingToolInvites.delete(inviteId);

    this.network.sendCtrl(invite.from, { type: 'tool-invite-response', inviteId, accept, ts: Date.now() });

    const sid = this._sessionId()
      || (invite.chatContext?.kind === 'circle' ? `circle:${invite.chatContext.id}`
       : invite.chatContext?.kind === 'mesh'   ? MESH_SESSION_ID
       : `peer:${invite.from}`);

    this._saveAndRender({
      id: crypto.randomUUID(), sessionId: sid, kind: 'system',
      from: this.identity.fingerprint,
      text: `${accept ? 'accepted' : 'declined'} ${getToolById(invite.toolId)?.title || invite.toolId}`,
      ts: Date.now(), mine: true,
    }, true);
  }

  _onToolInviteResponse(fp, msg) {
    const track = this.outgoingToolInvites.get(msg.inviteId);
    if (!track || track.started) return;

    if (msg.accept) track.accepted.add(fp);
    else            track.declined.add(fp);

    const tool = getToolById(track.toolId);
    if (!tool) return;

    if (track.accepted.size >= tool.minPeers - 1) {
      track.started = true;
      const participants  = [this.identity.fingerprint, ...track.accepted].slice(0, tool.maxPeers);
      const toolSessionId = `tool:${crypto.randomUUID()}`;

      for (const peer of participants) {
        if (peer === this.identity.fingerprint) continue;
        this.network.sendCtrl(peer, {
          type: 'tool-start', toolSessionId, toolId: track.toolId,
          participants, chatContext: track.chatContext, ts: Date.now(),
        });
      }

      this._openToolSession({ toolSessionId, toolId: track.toolId, participants, chatContext: track.chatContext });
    }
  }

  /**
   * Always creates the runtime so game state is maintained regardless of
   * which chat the user is currently viewing. DOM mounting happens
   * separately in _mountToolSessionToDOM.
   */
  _openToolSession(session) {
    if (this.toolSessions.has(session.toolSessionId)) return;

    const runtime = createToolRuntime(session.toolId, {
      selfId:      this.identity.fingerprint,
      participants: session.participants,
      broadcast:   (action) => this._broadcastToolAction(session, action),
    });

    const sess = { ...session, runtime, mounted: false, row: null };
    this.toolSessions.set(session.toolSessionId, sess);

    const targetSid = this._sessionIdFromContext(session.chatContext);
    if (this._sessionId() === targetSid) {
      this._mountToolSessionToDOM(sess);
    } else {
      this._flash(`tool session ready: ${getToolById(session.toolId)?.title || session.toolId}`);
    }
  }

  _mountToolSessionToDOM(sess) {
    if (sess.mounted) return;
    sess.mounted = true;

    const row = document.createElement('div');
    row.className = 'msg-row';
    row.innerHTML = `
      <div class="msg-bubble" style="width:100%;max-width:100%">
        <div class="msg-meta">tool · ${escapeHtml(getToolById(sess.toolId)?.title || sess.toolId)}</div>
        <div class="tool-wrap">
          <div class="tool-title">${escapeHtml(getToolById(sess.toolId)?.title || sess.toolId)}</div>
          <div class="tool-host"></div>
        </div>
      </div>
    `;

    const host = row.querySelector('.tool-host');
    sess.runtime.mount(host);
    sess.row = row;
    this.$messages.appendChild(row);
    this._scrollToBottom();
  }

  _broadcastToolAction(session, action) {
    const envelope = { type: 'tool-action', toolSessionId: session.toolSessionId, action, ts: Date.now() };
    for (const fp of session.participants) {
      if (fp === this.identity.fingerprint) continue;
      this.network.sendCtrl(fp, envelope);
    }
    // Do NOT re-apply locally — the caller (createTicTacToeRuntime) already applied via onLocalMove
  }

  /* ═══════════════════════════ WALKIE ════════════════════════ */

  async _toggleWalkie() {
    if (this.walkieRecorder) {
      this.walkieRecorder.stop();
      return;
    }

    const targets   = this._targetPeers();
    const sessionId = this._sessionId();
    if (!targets.length || !sessionId) { this._flash('select a peer / circle first'); return; }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this.walkieChunks    = [];
      this.$walkieBtn.classList.add('recording');

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';

      this.walkieRecorder = new MediaRecorder(stream, { mimeType });

      this.walkieRecorder.ondataavailable = (ev) => {
        if (ev.data?.size) this.walkieChunks.push(ev.data);
      };

      this.walkieRecorder.onstop = async () => {
        this.$walkieBtn.classList.remove('recording');
        const blob = new Blob(this.walkieChunks, { type: mimeType });
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: mimeType });

        for (const fp of targets) {
          await this.fileEngine.sendFile(fp, file, { sessionId });
        }

        stream.getTracks().forEach(t => t.stop());
        this.walkieRecorder = null;
        this.walkieChunks   = [];
        this._flash('voice note sent');
      };

      this.walkieRecorder.start();
      this._flash('recording… tap again to send');
    } catch (e) {
      this.$walkieBtn.classList.remove('recording');
      this._flash(`walkie error: ${e.message}`);
    }
  }

  /* ═══════════════════════════ CALLS ════════════════════════ */

  async _startCall(mode) {
    const targets = this._targetPeers();
    if (!targets.length) { this._flash('no active peers in this chat'); return; }
    if (this.callState)  { this._flash('already in a call'); return; }

    // Initialise call state immediately so panel shows "calling…"
    this.callState = {
      id:          `call:${crypto.randomUUID()}`,
      mode,
      targets:     new Set(targets),
      accepted:    new Set(),
      localStream: null,
      remote:      new Map(),
      calling:     true,  // outgoing, not yet accepted
    };

    // Render calling panel immediately (shows local preview + calling overlay)
    try {
      this.callState.localStream = await this.network.getLocalStream(mode === 'video');
    } catch (e) {
      this.callState = null;
      this._flash(`media error: ${e.message}`);
      return;
    }

    this._renderCallPanel();

    for (const fp of targets) {
      this.network.sendCtrl(fp, {
        type: 'call-invite', callId: this.callState.id, mode,
        chatContext: this.currentChat, ts: Date.now(),
      });
    }

    this._flash(`calling ${targets.length} peer(s)…`);
  }

  _showIncomingCall(fp, msg) {
    this.incomingCall = { from: fp, ...msg };

    this.$callIncoming.innerHTML = `
      <div class="ci-card">
        <div class="ci-title">incoming ${escapeHtml(msg.mode || 'stream')} call</div>
        <div class="ci-name">${escapeHtml(this._peerNick(fp))}</div>
        <div class="ci-btns">
          <button class="ci-accept" id="ci-accept">accept</button>
          <button class="ci-decline" id="ci-decline">decline</button>
        </div>
      </div>
    `;
    this.$callIncoming.classList.add('visible');

    // Single-shot listeners prevent double-accept
    const acceptBtn  = this.$callIncoming.querySelector('#ci-accept');
    const declineBtn = this.$callIncoming.querySelector('#ci-decline');

    const cleanup = () => {
      acceptBtn.disabled  = true;
      declineBtn.disabled = true;
      this.$callIncoming.classList.remove('visible');
    };

    acceptBtn.addEventListener('click', async () => {
      cleanup();
      await this._acceptIncomingCall();
    }, { once: true });

    declineBtn.addEventListener('click', () => {
      cleanup();
      this.network.sendCtrl(fp, { type: 'call-decline', callId: msg.callId, ts: Date.now() });
      this.incomingCall = null;
    }, { once: true });
  }

  async _acceptIncomingCall() {
    if (!this.incomingCall) return;
    const inc = this.incomingCall;
    this.incomingCall = null;

    if (this.callState) {
      // Already in a call, auto-decline
      this.network.sendCtrl(inc.from, { type: 'call-decline', callId: inc.callId, ts: Date.now() });
      return;
    }

    this.callState = {
      id:       inc.callId,
      mode:     inc.mode || 'video',
      targets:  new Set([inc.from]),
      accepted: new Set([inc.from]),
      localStream: null,
      remote:   new Map(),
      calling:  false,
    };

    try {
      this.callState.localStream = await this.network.getLocalStream(inc.mode === 'video');
      this.network.sendCtrl(inc.from, { type: 'call-accept', callId: inc.callId, mode: inc.mode, ts: Date.now() });
      this._attachCallPeer(inc.from);
      this._renderCallPanel();
      this._flash(`connecting to ${this._peerNick(inc.from)}…`);
    } catch (e) {
      this.network.sendCtrl(inc.from, { type: 'call-decline', callId: inc.callId, ts: Date.now() });
      this.callState = null;
      this._flash(`call failed: ${e.message}`);
    }
  }

  async _onCallAccepted(fp, msg) {
    if (!this.callState || this.callState.id !== msg.callId) return;

    this.callState.accepted.add(fp);
    this.callState.calling = false;

    try {
      await this.network.offerWithStream(fp, this.callState.localStream);
      this._attachCallPeer(fp);
      this._renderCallPanel();
      this._flash(`call connected: ${this._peerNick(fp)}`);
    } catch (e) {
      this._flash(`offer failed: ${e.message}`);
    }
  }

  _onCallDeclined(fp) {
    this._flash(`${this._peerNick(fp)} declined`);
    if (!this.callState) return;
    this.callState.targets.delete(fp);
    // If no one accepted and no one left to accept, cancel call
    if (this.callState.accepted.size === 0 && this.callState.targets.size === 0) {
      this._endCallLocalOnly();
    } else {
      this._renderCallPanel();
    }
  }

  async _answerRenegOffer(fp, msg) {
    const mode = msg.callType === 'stream' ? 'video' : 'audio';

    if (!this.callState) {
      this.callState = {
        id:          `call:${crypto.randomUUID()}`,
        mode,
        targets:     new Set([fp]),
        accepted:    new Set([fp]),
        localStream: null,
        remote:      new Map(),
        calling:     false,
      };
    }

    try {
      if (!this.callState.localStream) {
        this.callState.localStream = await this.network.getLocalStream(mode === 'video');
      }
      await this.network.answerWithStream(fp, msg.sdp, this.callState.localStream);
      this._attachCallPeer(fp);
      this._renderCallPanel();
    } catch (e) {
      this._flash(`answer failed: ${e.message}`);
    }
  }

  _attachCallPeer(fp) {
    this.network.setRemoteStreamHandler(fp, (stream) => {
      if (!this.callState) return;
      this.callState.remote.set(fp, stream);
      this._renderCallPanel();
    });
  }

  _detachCallPeer(fp) {
    if (!this.callState) return;
    this.callState.remote.delete(fp);
    this.callState.targets.delete(fp);
    this.callState.accepted.delete(fp);
    this.prevStats.delete(fp);

    if (this.callState.targets.size === 0 && this.callState.remote.size === 0) {
      this._endCallLocalOnly();
      return;
    }
    this._renderCallPanel();
    this._renderSidebar();
  }

  async _endCall() {
    if (!this.callState) return;
    const peers = new Set([...this.callState.targets, ...this.callState.accepted]);
    for (const fp of peers) {
      this.network.sendCtrl(fp, { type: 'call-end', callId: this.callState.id, ts: Date.now() });
      await this.network.stopMedia(fp).catch(() => {});
    }
    this._endCallLocalOnly();
  }

  _endCallLocalOnly() {
    if (this.callState?.localStream) {
      this.callState.localStream.getTracks().forEach(t => t.stop());
    }
    this.callState = null;
    this.$callPanel.classList.remove('active');
    this.$callPanel.innerHTML = '';
    this._flash('call ended');
    this._renderSidebar();
    this._updateLiveStats();
  }

  /* ════════════════════════ CALL PANEL ════════════════════════ */

  _renderCallPanel() {
    if (!this.callState) {
      this.$callPanel.classList.remove('active');
      this.$callPanel.innerHTML = '';
      return;
    }

    this.$callPanel.classList.add('active');

    const wrap = document.createElement('div');

    // ── top bar ──
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;';

    const statusText = this.callState.calling
      ? `calling ${[...this.callState.targets].map(fp => this._peerNick(fp)).join(', ')}…`
      : `${this.callState.mode === 'video' ? 'stream' : 'audio'} · ${this.callState.remote.size} connected`;

    top.innerHTML = `
      <div style="font-size:.65rem;letter-spacing:.14em;color:var(--tq);text-transform:uppercase">
        ${escapeHtml(statusText)}
      </div>
      <button id="call-end-btn" style="border:1px solid var(--err);background:transparent;color:var(--err);cursor:pointer;padding:4px 10px;font-size:.65rem;">
        end
      </button>
    `;
    wrap.appendChild(top);

    // ── calling overlay (waiting for answer) ──
    if (this.callState.calling && this.callState.accepted.size === 0) {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'padding:10px 0;font-size:.68rem;color:var(--tx1);letter-spacing:.08em;display:flex;align-items:center;gap:8px;';
      overlay.innerHTML = `<span class="calling-pulse"></span> ringing…`;
      wrap.appendChild(overlay);
    }

    // ── video grid ──
    const grid = document.createElement('div');
    grid.className = 'call-grid';
    wrap.appendChild(grid);

    if (this.callState.localStream) {
      grid.appendChild(this._makeCallTile({
        fp: this.identity.fingerprint, label: 'you',
        stream: this.callState.localStream, muted: true,
      }));
    }

    for (const [fp, stream] of this.callState.remote.entries()) {
      grid.appendChild(this._makeCallTile({
        fp, label: this._peerNick(fp), stream, muted: false,
      }));
    }

    // ── calling peers without stream yet ──
    if (!this.callState.calling) {
      for (const fp of this.callState.accepted) {
        if (!this.callState.remote.has(fp)) {
          const ph = document.createElement('div');
          ph.className = 'call-tile';
          ph.style.display = 'flex;align-items:center;justify-content:center;';
          ph.innerHTML = `
            <div class="call-label">${escapeHtml(this._peerNick(fp))}</div>
            <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:.65rem;color:var(--tx2);">connecting…</div>
          `;
          grid.appendChild(ph);
        }
      }
    }

    this.$callPanel.innerHTML = '';
    this.$callPanel.appendChild(wrap);
    this.$callPanel.querySelector('#call-end-btn')?.addEventListener('click', () => this._endCall());

    this._renderSidebar();
  }

  _makeCallTile({ fp, label, stream, muted }) {
    const id   = `tile-${fp}`;
    const tile = document.createElement('div');
    tile.className = 'call-tile';
    tile.id = id;

    const video    = document.createElement('video');
    video.className   = 'call-video';
    video.autoplay    = true;
    video.playsInline = true;
    video.muted       = !!muted;
    video.srcObject   = stream;
    tile.appendChild(video);

    const nameEl = document.createElement('div');
    nameEl.className = 'call-label';
    nameEl.textContent = label;
    tile.appendChild(nameEl);

    const actions = document.createElement('div');
    actions.className = 'call-actions';
    actions.innerHTML = `<button data-fullscreen="${id}" title="fullscreen">⤢</button>`;
    tile.appendChild(actions);

    const tech = document.createElement('div');
    tech.className   = 'call-tech';
    tech.dataset.fp  = fp;
    tech.textContent = 'rtt — ms  ↑ —  ↓ —';
    tile.appendChild(tech);

    return tile;
  }

  /* ══════════════════════ LIVE STATS ══════════════════════════ */

  _startStatsTicker() {
    clearInterval(this.statsTicker);
    this.statsTicker = setInterval(() => {
      this._refreshCallStats().catch(() => {});
      this._updateLiveStats();
    }, 1000);
  }

  _updateLiveStats() {
    const connected = this.network.getConnectedPeers().length;
    const sigDot    = this._sigState === 'connected' ? '<span style="color:var(--ok)">●</span>' : '<span style="color:var(--err)">○</span>';
    const sigLabel  = this._sigState === 'connected' ? 'sig' : 'disconnected';

    let parts = [`${sigDot} ${sigLabel}`, `${connected}p`];

    if (this.callState) {
      const remoteCount = this.callState.remote.size;
      if (this.callState.calling) {
        parts.push('calling…');
      } else {
        parts.push(`${this.callState.mode}:${remoteCount}`);
      }
    }

    // Aggregate stats from call tiles
    let totalRtt = null, totalUp = 0, totalDown = 0;
    let hasStats = false;
    for (const fp of (this.callState?.remote?.keys() || [])) {
      const prev = this.prevStats.get(fp);
      if (prev?.rtt != null) { totalRtt = (totalRtt ?? 0) + prev.rtt; hasStats = true; }
      if (prev?.upRate)   totalUp   += prev.upRate;
      if (prev?.downRate) totalDown += prev.downRate;
    }

    if (hasStats) {
      if (totalRtt != null) parts.push(`rtt ${Math.round(totalRtt)}ms`);
      if (totalUp > 0)      parts.push(`↑ ${fmtRate(totalUp)}`);
      if (totalDown > 0)    parts.push(`↓ ${fmtRate(totalDown)}`);
    }

    this.$statusLive.innerHTML = parts.join('<span class="stat-sep"> · </span>');
  }

  async _refreshCallStats() {
    if (!this.callState) return;
    for (const fp of this.callState.remote.keys()) {
      const stats = await this.network.getPeerStats(fp);
      if (!stats) continue;

      const prev = this.prevStats.get(fp) || {};
      this.prevStats.set(fp, {
        rtt:      stats.connection.rttMs,
        upRate:   (stats.audio.outKbps + stats.video.outKbps) * 125, // kbps -> B/s
        downRate: (stats.audio.inKbps  + stats.video.inKbps)  * 125,
        ...prev,
      });

      const tech = this.$callPanel.querySelector(`.call-tech[data-fp="${fp}"]`);
      if (tech) {
        const rtt = stats.connection.rttMs != null ? `rtt ${Math.round(stats.connection.rttMs)}ms` : 'rtt —';
        const up  = stats.audio.outKbps + stats.video.outKbps > 0 ? `↑ ${fmtRate((stats.audio.outKbps + stats.video.outKbps) * 125)}` : '↑ —';
        const dn  = stats.audio.inKbps  + stats.video.inKbps  > 0 ? `↓ ${fmtRate((stats.audio.inKbps  + stats.video.inKbps)  * 125)}` : '↓ —';
        const via = stats.connection.local || '—';
        tech.textContent = `${rtt}  ${up}  ${dn}  ${via}`;
      }
    }
  }

  /* ═══════════════════════ STATUS BAR ════════════════════════ */

  /** Show a transient message that fades after `ms` (default 3500). */
  _flash(text, ms = STATUS_LINGER_MS) {
    this.$statusMsg.textContent = text;
    clearTimeout(this._statusTimer);
    if (ms > 0) {
      this._statusTimer = setTimeout(() => { this.$statusMsg.textContent = ''; }, ms);
    }
  }

  /* ═════════════════════ CIRCLE EDITOR ════════════════════════ */

  _openCircleEditor(circleId) {
    const editing  = circleId ? this.circles.find(c => c.id === circleId) : null;
    const allPeers = [...this.peers.values()].filter(p => p.online);

    const box = document.createElement('div');
    box.className = 'modal';
    box.innerHTML = `
      <h3>${editing ? 'Edit' : 'New'} Short Mesh Circle</h3>
      <div class="row">
        <input id="circle-name" type="text" maxlength="40" placeholder="circle name…" value="${escapeAttr(editing?.name || '')}">
      </div>
      <div class="check-list" id="circle-checks"></div>
      <div class="actions">
        ${editing ? '<button id="circle-delete" style="color:var(--err);border-color:var(--err);">delete</button>' : ''}
        <button id="circle-cancel">cancel</button>
        <button id="circle-save">save</button>
      </div>
    `;

    const checks = box.querySelector('#circle-checks');
    if (!allPeers.length) {
      checks.innerHTML = '<div style="font-size:.68rem;color:var(--tx2);padding:4px">no online peers</div>';
    }
    for (const p of allPeers) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;gap:8px;align-items:center;font-size:.72rem;cursor:pointer;';
      label.innerHTML = `
        <input type="checkbox" value="${p.fingerprint}" ${editing?.members?.includes(p.fingerprint) ? 'checked' : ''}>
        <span>${escapeHtml(p.nick)} <span style="color:var(--tx2)">${short(p.fingerprint)}</span></span>
      `;
      checks.appendChild(label);
    }

    box.querySelector('#circle-cancel')?.addEventListener('click', () => this._closeModal());
    box.querySelector('#circle-delete')?.addEventListener('click', () => {
      this.circles = this.circles.filter(c => c.id !== circleId);
      this._saveCircles();
      this._renderSidebar();
      this._closeModal();
    });
    box.querySelector('#circle-save')?.addEventListener('click', () => {
      const name    = box.querySelector('#circle-name').value.trim();
      const members = [...checks.querySelectorAll('input[type="checkbox"]:checked')].map(x => x.value);
      if (!name)           return this._flash('circle name required');
      if (!members.length) return this._flash('select at least 1 member');

      if (editing) {
        editing.name    = name;
        editing.members = members;
      } else {
        this.circles.push({ id: `circle:${crypto.randomUUID()}`, name, members });
      }
      this._saveCircles();
      this._renderSidebar();
      this._closeModal();
      this._flash('circle saved');
    });

    this._openModal(box);
  }

  _upsertRemoteCircle(id, name, members) {
    if (!id) return;
    const ex = this.circles.find(c => c.id === id);
    if (ex) {
      ex.name = name || ex.name;
      if (members?.length) {
        // Merge: add new members, don't remove own fingerprint
        const set = new Set(ex.members);
        members.forEach(m => { if (m !== this.identity.fingerprint) set.add(m); });
        ex.members = [...set];
      }
    } else {
      const filtered = Array.isArray(members) ? members.filter(m => m !== this.identity.fingerprint) : [];
      this.circles.push({ id, name: name || `circle ${this.circles.length + 1}`, members: filtered });
    }
    this._saveCircles();
    this._renderSidebar();
  }

  /* ══════════════════════ MODAL HELPERS ════════════════════════ */

  _openModal(node) {
    this.$modalRoot.innerHTML = '';
    this.$modalRoot.appendChild(node);
    this.$modalRoot.classList.add('visible');
    this.$modalRoot.addEventListener('click', this._modalBg = (e) => {
      if (e.target === this.$modalRoot) this._closeModal();
    });
  }

  _closeModal() {
    this.$modalRoot.classList.remove('visible');
    this.$modalRoot.innerHTML = '';
    if (this._modalBg) {
      this.$modalRoot.removeEventListener('click', this._modalBg);
      this._modalBg = null;
    }
  }

  /* ═══════════════════════ LOG / HELPERS ══════════════════════ */

  _sessionIdFromContext(ctx) {
    if (!ctx) return null;
    if (ctx.kind === 'peer')   return `peer:${ctx.id}`;
    if (ctx.kind === 'circle') return `circle:${ctx.id}`;
    if (ctx.kind === 'mesh')   return MESH_SESSION_ID;
    return null;
  }

  _peerNick(fp) {
    if (fp === this.identity.fingerprint) return 'you';
    return this.peers.get(fp)?.nick || short(fp);
  }

  _log(text, isErr = false) {
    const line = document.createElement('div');
    line.textContent = `${new Date().toLocaleTimeString([], { hour12: false })} · ${text}`;
    line.style.color = isErr ? '#e05040' : '#1e6b64';
    this.$netLog.prepend(line);
    // Cap log at 80 entries
    while (this.$netLog.children.length > 80) this.$netLog.lastChild.remove();
  }

  _scrollToBottom() {
    this.$messages.scrollTop = this.$messages.scrollHeight;
  }
}

/* ═══════════════════════ PURE HELPERS ═══════════════════════ */

function short(v) { return (v || '?').slice(0, 8); }

function fmtTime(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function escapeAttr(s) { return escapeHtml(s ?? ''); }
