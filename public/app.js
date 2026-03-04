import { loadPeers, savePeer, loadMessages, saveMessage } from './messages.js';
import { FileTransferEngine, fmtBytes, fmtRate, fmtEta } from './files.js';
import { TOOL_REGISTRY, getToolById } from './tools-registry.js';
import { createToolRuntime } from './tools-modules.js';

const CIRCLE_KEY_PREFIX = 'tq-circles:';

export class TurquoiseApp {
  constructor(identity, network) {
    this.identity = identity;
    this.network = network;

    this.peers = new Map();
    this.circles = [];
    this.currentChat = { kind: 'none', id: null };

    this.pendingFileOffers = new Map();
    this.transferViews = new Map();

    this.pendingToolInvites = new Map();
    this.outgoingToolInvites = new Map();
    this.toolSessions = new Map();

    this.callState = null; // { id, mode, targets:Set, accepted:Set, localStream, remote:Map }
    this.incomingCall = null;
    this.walkieRecorder = null;
    this.walkieChunks = [];
    this.statsTicker = null;
    this.prevStats = new Map();

    this.$ = {};
  }

  async mount() {
    this._cacheDom();
    this._bindUI();
    this._wireNetwork();

    this.$nickDisplay.textContent = this.identity.nickname || 'anonymous';
    this.$fullFp.textContent = this.identity.fingerprint;

    await this._loadStoredPeers();
    this._loadCircles();
    this._renderSidebar();

    this.fileEngine = new FileTransferEngine(this.network, {
      onOffer: (fp, offer) => this._onFileOffer(fp, offer),
      onProgress: (p) => this._onTransferProgress(p),
      onComplete: (done) => this._onTransferComplete(done),
      onError: (err) => this._setStatus(`file error: ${err.error}`),
    });

    this._setStatus('ready');
    this._startStatsTicker();
  }

  _cacheDom() {
    this.$app = document.getElementById('app');
    this.$sidebar = document.getElementById('sidebar');
    this.$peerList = document.getElementById('peer-list');
    this.$circlesList = document.getElementById('circles-list');
    this.$newCircleBtn = document.getElementById('new-circle-btn');
    this.$netLog = document.getElementById('net-log');

    this.$nickDisplay = document.getElementById('nick-display');
    this.$fullFp = document.getElementById('full-fp');

    this.$chatTitle = document.getElementById('chat-title');
    this.$chatSubtitle = document.getElementById('chat-subtitle');
    this.$messages = document.getElementById('messages');
    this.$msgInput = document.getElementById('msg-input');
    this.$sendBtn = document.getElementById('send-btn');
    this.$statusBar = document.getElementById('status-bar');

    this.$fileBtn = document.getElementById('file-btn');
    this.$plusMenu = document.getElementById('plus-menu');
    this.$fileInput = document.getElementById('__file-input');

    this.$backBtn = document.getElementById('back-btn');
    this.$walkieBtn = document.getElementById('walkie-btn');
    this.$audioCallBtn = document.getElementById('audio-call-btn');
    this.$videoCallBtn = document.getElementById('video-call-btn');
    this.$callPanel = document.getElementById('call-panel');
    this.$callIncoming = document.getElementById('call-incoming');

    this.$modalRoot = document.getElementById('modal-root');
  }

  _bindUI() {
    this.$sendBtn.addEventListener('click', () => this._sendText());
    this.$msgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._sendText();
      }
    });

    this.$fileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.$plusMenu.classList.toggle('hidden');
    });

    this.$plusMenu.addEventListener('click', (e) => {
      const action = e.target?.dataset?.plus;
      if (!action) return;
      this.$plusMenu.classList.add('hidden');

      if (action === 'file') this.$fileInput.click();
      if (action === 'tool') this._openToolPicker();
      if (action === 'circle') this._openCircleEditor(null);
    });

    document.addEventListener('click', (e) => {
      if (!this.$plusMenu.contains(e.target) && e.target !== this.$fileBtn) {
        this.$plusMenu.classList.add('hidden');
      }
    });

    this.$fileInput.addEventListener('change', (e) => this._onPickFiles(e));
    this.$newCircleBtn.addEventListener('click', () => this._openCircleEditor(null));
    this.$backBtn.addEventListener('click', () => this.$sidebar.classList.remove('hidden-mobile'));

    this.$walkieBtn.addEventListener('click', () => this._toggleWalkie());
    this.$audioCallBtn.addEventListener('click', () => this._startCall('audio'));
    this.$videoCallBtn.addEventListener('click', () => this._startCall('video'));

    this.$messages.addEventListener('click', (e) => this._onMessageActionClick(e));
  }

  _wireNetwork() {
    this.network.onPeerConnected = (fp, nick) => {
      this._upsertPeer(fp, nick || this.network.getPeerNick(fp), true);
      this._log(`peer up ${short(fp)}`);
      this._renderSidebar();
      savePeer({ fingerprint: fp, nick: nick || null }).catch(() => {});
    };

    this.network.onPeerDisconnected = (fp) => {
      const p = this.peers.get(fp);
      if (p) p.online = false;
      this._renderSidebar();
      this._log(`peer down ${short(fp)}`);
      this._detachCallPeer(fp);
    };

    this.network.onMessage = (fp, msg) => this._onCtrlMessage(fp, msg);
    this.network.onBinaryChunk = (fp, ab) => this.fileEngine?.handleBinary(fp, ab);

    this.network.onLog = (text, isErr) => this._log(text, isErr);
    this.network.onSignalingConnected = () => this._setStatus('signaling connected');
    this.network.onSignalingDisconnected = () => this._setStatus('signaling disconnected');
  }

  async _loadStoredPeers() {
    try {
      const rows = await loadPeers();
      for (const p of rows) {
        this.peers.set(p.fingerprint, {
          fingerprint: p.fingerprint,
          nick: p.nick || short(p.fingerprint),
          online: false,
          lastSeen: p.lastSeen || 0,
        });
      }
    } catch {}
  }

  _loadCircles() {
    const raw = localStorage.getItem(this._circleStorageKey());
    if (!raw) {
      this.circles = [];
      return;
    }
    try {
      const arr = JSON.parse(raw);
      this.circles = Array.isArray(arr) ? arr : [];
    } catch {
      this.circles = [];
    }
  }

  _saveCircles() {
    localStorage.setItem(this._circleStorageKey(), JSON.stringify(this.circles));
  }

  _circleStorageKey() {
    return `${CIRCLE_KEY_PREFIX}${this.identity.fingerprint}`;
  }

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
    this.$peerList.innerHTML = '';
    const peers = [...this.peers.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.nick.localeCompare(b.nick));

    for (const p of peers) {
      const el = document.createElement('div');
      el.className = `peer-item${this.currentChat.kind === 'peer' && this.currentChat.id === p.fingerprint ? ' active' : ''}`;
      el.innerHTML = `
        <div class="peer-left">
          <span class="dot ${p.online ? 'on' : ''}"></span>
          <span class="peer-name">${escapeHtml(p.nick)}</span>
        </div>
        <span class="mini">${short(p.fingerprint)}</span>
      `;
      el.addEventListener('click', () => this._openPeerChat(p.fingerprint));
      this.$peerList.appendChild(el);
    }

    this.$circlesList.innerHTML = '';
    for (const c of this.circles) {
      const el = document.createElement('div');
      el.className = `circle-item${this.currentChat.kind === 'circle' && this.currentChat.id === c.id ? ' active' : ''}`;
      el.innerHTML = `
        <div class="peer-left">
          <span class="dot on"></span>
          <span class="peer-name">${escapeHtml(c.name)}</span>
        </div>
        <div>
          <span class="mini">${(c.members || []).length} members</span>
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

  async _openPeerChat(fp) {
    this.currentChat = { kind: 'peer', id: fp };
    this.$chatTitle.textContent = this.peers.get(fp)?.nick || short(fp);
    this.$chatSubtitle.textContent = `${short(fp)} · direct`;
    this.$sidebar.classList.add('hidden-mobile');
    this._renderSidebar();
    await this._renderChatMessages();
    this._setActionEnabled(true);
  }

  async _openCircleChat(circleId) {
    const c = this.circles.find(x => x.id === circleId);
    if (!c) return;

    this.currentChat = { kind: 'circle', id: circleId };
    this.$chatTitle.textContent = c.name;
    this.$chatSubtitle.textContent = `${c.members.length} selected peers`;
    this.$sidebar.classList.add('hidden-mobile');
    this._renderSidebar();
    await this._renderChatMessages();
    this._setActionEnabled(true);
  }

  _setActionEnabled(ok) {
    this.$walkieBtn.disabled = !ok;
    this.$audioCallBtn.disabled = !ok;
    this.$videoCallBtn.disabled = !ok;
    this.$sendBtn.disabled = !ok;
  }

  _sessionId() {
    if (this.currentChat.kind === 'peer') return `peer:${this.currentChat.id}`;
    if (this.currentChat.kind === 'circle') return `circle:${this.currentChat.id}`;
    return null;
  }

  _targetPeers() {
    if (this.currentChat.kind === 'peer') return [this.currentChat.id];

    if (this.currentChat.kind === 'circle') {
      const c = this.circles.find(x => x.id === this.currentChat.id);
      if (!c) return [];
      return c.members.filter(fp => this.network.isReady(fp));
    }

    return [];
  }

  async _sendText() {
    const sessionId = this._sessionId();
    if (!sessionId) return;

    const text = this.$msgInput.value.trim();
    if (!text) return;
    this.$msgInput.value = '';

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
      this.network.sendCtrl(targets[0], { type: 'chat', text, ts });
    } else {
      const circle = this.circles.find(c => c.id === this.currentChat.id);
      for (const fp of targets) {
        this.network.sendCtrl(fp, {
          type: 'circle-chat',
          circleId: circle.id,
          circleName: circle.name,
          members: circle.members,
          text,
          ts,
        });
      }
    }
  }

  async _onCtrlMessage(fp, msg) {
    if (!msg?.type) return;

    if (this.fileEngine?.handleCtrl(fp, msg)) return;

    if (msg.type === 'chat') {
      const entry = {
        id: crypto.randomUUID(),
        sessionId: `peer:${fp}`,
        kind: 'text',
        from: fp,
        text: msg.text || '',
        ts: msg.ts || Date.now(),
        mine: false,
      };
      await this._saveAndRender(entry, this._sessionId() === entry.sessionId);
      return;
    }

    if (msg.type === 'circle-chat') {
      this._upsertRemoteCircle(msg.circleId, msg.circleName, msg.members || []);
      const entry = {
        id: crypto.randomUUID(),
        sessionId: `circle:${msg.circleId}`,
        kind: 'text',
        from: fp,
        text: msg.text || '',
        ts: msg.ts || Date.now(),
        mine: false,
      };
      await this._saveAndRender(entry, this._sessionId() === entry.sessionId);
      return;
    }

    if (msg.type === 'tool-invite') {
      this.pendingToolInvites.set(msg.inviteId, { ...msg, from: fp });
      this._appendInviteMessage(fp, msg);
      return;
    }

    if (msg.type === 'tool-invite-response') {
      this._onToolInviteResponse(fp, msg);
      return;
    }

    if (msg.type === 'tool-start') {
      this._openToolSession({
        toolSessionId: msg.toolSessionId,
        toolId: msg.toolId,
        participants: msg.participants || [],
        chatContext: msg.chatContext,
      });
      return;
    }

    if (msg.type === 'tool-action') {
      const sess = this.toolSessions.get(msg.toolSessionId);
      sess?.runtime?.apply(msg.action);
      return;
    }

    if (msg.type === 'call-invite') {
      this._showIncomingCall(fp, msg);
      return;
    }

    if (msg.type === 'call-accept') {
      await this._onCallAccepted(fp, msg);
      return;
    }

    if (msg.type === 'call-decline') {
      this._setStatus(`${this._peerNick(fp)} declined call`);
      return;
    }

    if (msg.type === 'call-end') {
      this._detachCallPeer(fp);
      return;
    }

    if (msg.type === 'offer-reneg') {
      await this._answerRenegOffer(fp, msg);
      return;
    }
  }

  async _renderChatMessages() {
    const sessionId = this._sessionId();
    this.$messages.innerHTML = '';
    if (!sessionId) {
      this.$messages.innerHTML = '<div class="sys-msg">no peer selected</div>';
      return;
    }

    let rows = [];
    try {
      rows = await loadMessages(sessionId);
    } catch {}

    if (!rows.length) {
      this.$messages.innerHTML = '<div class="sys-msg">no messages yet</div>';
      return;
    }

    for (const m of rows) this._appendMessageToDOM(m);
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
    meta.textContent = `${m.mine ? 'you' : this._peerNick(m.from)} · ${new Date(m.ts || Date.now()).toLocaleTimeString()}`;
    bubble.appendChild(meta);

    if (m.kind === 'text') {
      const body = document.createElement('div');
      body.className = 'msg-text';
      body.textContent = m.text || '';
      bubble.appendChild(body);
    } else if (m.kind === 'system') {
      const body = document.createElement('div');
      body.className = 'msg-text';
      body.style.color = '#7ab8b2';
      body.textContent = m.text || '';
      bubble.appendChild(body);
    } else {
      const body = document.createElement('div');
      body.className = 'msg-text';
      body.textContent = m.text || `[${m.kind}]`;
      bubble.appendChild(body);
    }

    row.appendChild(bubble);
    this.$messages.appendChild(row);
  }

  _appendInviteMessage(fromFp, invite) {
    const sessionId = invite.chatContext?.kind === 'circle'
      ? `circle:${invite.chatContext.id}`
      : `peer:${fromFp}`;

    const row = document.createElement('div');
    row.className = 'msg-row';
    row.innerHTML = `
      <div class="msg-bubble">
        <div class="msg-meta">${escapeHtml(this._peerNick(fromFp))} · game/tool request</div>
        <div class="msg-text">
          ${escapeHtml(this._peerNick(fromFp))} invited you to <b>${escapeHtml(getToolById(invite.toolId)?.title || invite.toolId)}</b>
        </div>
        <div class="msg-actions">
          <button data-invite-accept="${invite.inviteId}">accept</button>
          <button data-invite-reject="${invite.inviteId}">decline</button>
        </div>
      </div>
    `;
    if (this._sessionId() === sessionId) {
      this.$messages.appendChild(row);
      this._scrollToBottom();
    }

    this._saveAndRender({
      id: crypto.randomUUID(),
      sessionId,
      kind: 'system',
      from: fromFp,
      text: `${this._peerNick(fromFp)} invited you to ${getToolById(invite.toolId)?.title || invite.toolId}`,
      ts: Date.now(),
      mine: false,
    }, false);
  }

  _onMessageActionClick(e) {
    const acceptInvite = e.target?.dataset?.inviteAccept;
    const rejectInvite = e.target?.dataset?.inviteReject;
    const acceptFile = e.target?.dataset?.fileAccept;
    const rejectFile = e.target?.dataset?.fileReject;
    const fsTile = e.target?.dataset?.fullscreen;

    if (acceptInvite) {
      this._respondToolInvite(acceptInvite, true);
      return;
    }
    if (rejectInvite) {
      this._respondToolInvite(rejectInvite, false);
      return;
    }
    if (acceptFile) {
      const row = this.pendingFileOffers.get(acceptFile);
      if (row) this.fileEngine.acceptOffer(row.fp, acceptFile);
      this.pendingFileOffers.delete(acceptFile);
      e.target.closest('.msg-row')?.remove();
      return;
    }
    if (rejectFile) {
      const row = this.pendingFileOffers.get(rejectFile);
      if (row) this.fileEngine.rejectOffer(row.fp, rejectFile);
      this.pendingFileOffers.delete(rejectFile);
      e.target.closest('.msg-row')?.remove();
      return;
    }
    if (fsTile) {
      const tile = document.getElementById(fsTile);
      tile?.requestFullscreen?.();
    }
  }

  async _onPickFiles(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;

    const targets = this._targetPeers();
    const sessionId = this._sessionId();
    if (!targets.length || !sessionId) {
      this._setStatus('select a peer/circle first');
      return;
    }

    for (const file of files) {
      for (const fp of targets) {
        await this.fileEngine.sendFile(fp, file, { sessionId });
      }
    }
  }

  _onFileOffer(fp, offer) {
    this.pendingFileOffers.set(offer.id, { fp, offer });

    const row = document.createElement('div');
    row.className = 'msg-row';
    row.innerHTML = `
      <div class="msg-bubble">
        <div class="msg-meta">${escapeHtml(this._peerNick(fp))} · file request</div>
        <div class="msg-text">${escapeHtml(offer.name)} (${fmtBytes(offer.size)})</div>
        <div class="msg-actions">
          <button data-file-accept="${offer.id}">accept</button>
          <button data-file-reject="${offer.id}">decline</button>
        </div>
      </div>
    `;

    if (this._sessionId() === offer.sessionId) {
      this.$messages.appendChild(row);
      this._scrollToBottom();
    }

    this._saveAndRender({
      id: crypto.randomUUID(),
      sessionId: offer.sessionId || `peer:${fp}`,
      kind: 'system',
      from: fp,
      text: `${this._peerNick(fp)} wants to send ${offer.name} (${fmtBytes(offer.size)})`,
      ts: Date.now(),
      mine: false,
    }, false);
  }

  _onTransferProgress(p) {
    let view = this.transferViews.get(p.transferId);
    if (!view) {
      view = this._createTransferView(p);
      this.transferViews.set(p.transferId, view);
    }

    view.fill.style.width = `${p.pct.toFixed(2)}%`;
    view.nerd.textContent =
      `${p.direction} · ${fmtBytes(p.bytes)}/${fmtBytes(p.total)} · ${fmtRate(p.speed)} · ETA ${fmtEta(p.etaSec)} · ${p.pct.toFixed(1)}%`;
  }

  _createTransferView(p) {
    const row = document.createElement('div');
    row.className = `msg-row${p.direction === 'send' ? ' mine' : ''}`;
    row.innerHTML = `
      <div class="msg-bubble">
        <div class="msg-meta">${p.direction === 'send' ? 'you' : this._peerNick(p.fp)} · transfer · ${escapeHtml(p.fileName)}</div>
        <div class="transfer">
          <div class="transfer-bar"><div class="transfer-fill"></div></div>
          <div class="transfer-nerd"></div>
        </div>
      </div>
    `;
    const fill = row.querySelector('.transfer-fill');
    const nerd = row.querySelector('.transfer-nerd');

    if (this._sessionId() === p.sessionId) {
      this.$messages.appendChild(row);
      this._scrollToBottom();
    }

    return { row, fill, nerd, sessionId: p.sessionId };
  }

  _onTransferComplete(done) {
    const view = this.transferViews.get(done.transferId);
    if (view) {
      view.fill.style.width = '100%';
      view.nerd.textContent = `${done.direction} complete · ${fmtBytes(done.size)}`;
    }

    if (done.direction === 'recv' && done.blob) {
      const url = URL.createObjectURL(done.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = done.fileName || 'download.bin';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    this._saveAndRender({
      id: crypto.randomUUID(),
      sessionId: done.sessionId || `peer:${done.fp}`,
      kind: 'system',
      from: done.direction === 'send' ? this.identity.fingerprint : done.fp,
      text: `${done.direction === 'send' ? 'sent' : 'received'} ${done.fileName} (${fmtBytes(done.size)})`,
      ts: Date.now(),
      mine: done.direction === 'send',
    }, false);
  }

  _openToolPicker() {
    const targets = this._targetPeers();
    if (!targets.length) {
      this._setStatus('no active targets in current chat');
      return;
    }

    const box = document.createElement('div');
    box.className = 'modal';
    box.innerHTML = `<h3>Start game / tool</h3>`;

    for (const tool of TOOL_REGISTRY) {
      const it = document.createElement('div');
      it.className = 'tool-item';
      it.innerHTML = `
        <div style="font-size:.74rem;color:#c4e8e4">${escapeHtml(tool.title)}</div>
        <div style="font-size:.62rem;color:#7ab8b2">${escapeHtml(tool.description)}</div>
        <div style="margin-top:4px;font-size:.58rem;color:#3d7a74">Peers: ${tool.minPeers}..${tool.maxPeers} · ${tool.implemented ? 'ready' : 'placeholder'}</div>
      `;
      it.addEventListener('click', () => {
        this._closeModal();
        this._inviteTool(tool.id);
      });
      box.appendChild(it);
    }

    this._openModal(box);
  }

  _inviteTool(toolId) {
    const tool = getToolById(toolId);
    if (!tool) return;

    const targets = this._targetPeers();
    if (targets.length < tool.minPeers - 1) {
      this._setStatus(`need at least ${tool.minPeers} peers for ${tool.title}`);
      return;
    }

    const inviteId = crypto.randomUUID();
    const chatContext = { ...this.currentChat };
    const inviteTrack = { toolId, chatContext, accepted: new Set(), declined: new Set(), started: false };
    this.outgoingToolInvites.set(inviteId, inviteTrack);

    for (const fp of targets) {
      this.network.sendCtrl(fp, {
        type: 'tool-invite',
        inviteId,
        toolId,
        fromNick: this.identity.nickname,
        chatContext,
        ts: Date.now(),
      });
    }

    this._saveAndRender({
      id: crypto.randomUUID(),
      sessionId: this._sessionId(),
      kind: 'system',
      from: this.identity.fingerprint,
      text: `invited ${targets.length} peer(s) to ${tool.title}`,
      ts: Date.now(),
      mine: true,
    }, true);
  }

  _respondToolInvite(inviteId, accept) {
    const invite = this.pendingToolInvites.get(inviteId);
    if (!invite) return;
    this.pendingToolInvites.delete(inviteId);

    this.network.sendCtrl(invite.from, {
      type: 'tool-invite-response',
      inviteId,
      accept,
      ts: Date.now(),
    });

    this._saveAndRender({
      id: crypto.randomUUID(),
      sessionId: this._sessionId() || (invite.chatContext?.kind === 'circle' ? `circle:${invite.chatContext.id}` : `peer:${invite.from}`),
      kind: 'system',
      from: this.identity.fingerprint,
      text: `${accept ? 'accepted' : 'declined'} ${getToolById(invite.toolId)?.title || invite.toolId}`,
      ts: Date.now(),
      mine: true,
    }, true);
  }

  _onToolInviteResponse(fp, msg) {
    const track = this.outgoingToolInvites.get(msg.inviteId);
    if (!track || track.started) return;

    if (msg.accept) track.accepted.add(fp);
    else track.declined.add(fp);

    const tool = getToolById(track.toolId);
    if (!tool) return;

    if (track.accepted.size >= tool.minPeers - 1) {
      track.started = true;

      const participants = [this.identity.fingerprint, ...track.accepted].slice(0, tool.maxPeers);
      const toolSessionId = `tool:${crypto.randomUUID()}`;

      for (const peer of participants) {
        if (peer === this.identity.fingerprint) continue;
        this.network.sendCtrl(peer, {
          type: 'tool-start',
          toolSessionId,
          toolId: track.toolId,
          participants,
          chatContext: track.chatContext,
          ts: Date.now(),
        });
      }

      this._openToolSession({
        toolSessionId,
        toolId: track.toolId,
        participants,
        chatContext: track.chatContext,
      });
    }
  }

  _openToolSession(session) {
    if (this.toolSessions.has(session.toolSessionId)) return;

    const shouldShow = this._sessionId() === this._sessionIdFromContext(session.chatContext);
    if (!shouldShow) {
      this._setStatus(`tool session ready: ${getToolById(session.toolId)?.title || session.toolId}`);
      return;
    }

    const row = document.createElement('div');
    row.className = 'msg-row';
    row.innerHTML = `
      <div class="msg-bubble">
        <div class="msg-meta">tool session · ${escapeHtml(getToolById(session.toolId)?.title || session.toolId)}</div>
        <div class="tool-wrap">
          <div class="tool-title">${escapeHtml(getToolById(session.toolId)?.title || session.toolId)}</div>
          <div class="tool-host"></div>
        </div>
      </div>
    `;
    this.$messages.appendChild(row);

    const host = row.querySelector('.tool-host');
    const runtime = createToolRuntime(session.toolId, {
      selfId: this.identity.fingerprint,
      participants: session.participants,
      broadcast: (action) => this._broadcastToolAction(session, action),
    });

    runtime.mount(host);
    this.toolSessions.set(session.toolSessionId, { ...session, runtime, row });

    this._scrollToBottom();
  }

  _broadcastToolAction(session, action) {
    const envelope = {
      type: 'tool-action',
      toolSessionId: session.toolSessionId,
      action,
      ts: Date.now(),
    };

    for (const fp of session.participants) {
      if (fp === this.identity.fingerprint) continue;
      this.network.sendCtrl(fp, envelope);
    }

    const local = this.toolSessions.get(session.toolSessionId);
    local?.runtime?.apply(action);
  }

  async _toggleWalkie() {
    if (this.walkieRecorder) {
      this.walkieRecorder.stop();
      return;
    }

    const targets = this._targetPeers();
    const sessionId = this._sessionId();
    if (!targets.length || !sessionId) {
      this._setStatus('select a peer/circle first');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this.walkieChunks = [];
      this.walkieRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

      this.walkieRecorder.ondataavailable = (ev) => {
        if (ev.data?.size) this.walkieChunks.push(ev.data);
      };

      this.walkieRecorder.onstop = async () => {
        const blob = new Blob(this.walkieChunks, { type: 'audio/webm' });
        const file = new File([blob], `walkie-${Date.now()}.webm`, { type: 'audio/webm' });

        for (const fp of targets) {
          await this.fileEngine.sendFile(fp, file, { sessionId });
        }

        stream.getTracks().forEach(t => t.stop());
        this.walkieRecorder = null;
        this.walkieChunks = [];
        this._setStatus('walkie note sent');
      };

      this.walkieRecorder.start();
      this._setStatus('walkie recording... tap again to send');
    } catch (e) {
      this._setStatus(`walkie failed: ${e.message}`);
    }
  }

  async _startCall(mode) {
    const targets = this._targetPeers();
    if (!targets.length) {
      this._setStatus('no active peers in this chat');
      return;
    }

    if (!this.callState) {
      this.callState = {
        id: `call:${crypto.randomUUID()}`,
        mode,
        targets: new Set(targets),
        accepted: new Set(),
        localStream: null,
        remote: new Map(),
      };
    }

    for (const fp of targets) {
      this.network.sendCtrl(fp, {
        type: 'call-invite',
        callId: this.callState.id,
        mode,
        chatContext: this.currentChat,
        ts: Date.now(),
      });
    }

    this._setStatus(`calling ${targets.length} peer(s)...`);
  }

  _showIncomingCall(fp, msg) {
    this.incomingCall = { from: fp, ...msg };

    this.$callIncoming.innerHTML = `
      <div class="ci-card">
        <div class="ci-title">incoming ${escapeHtml(msg.mode || 'audio')} call</div>
        <div class="ci-name">${escapeHtml(this._peerNick(fp))}</div>
        <div class="ci-btns">
          <button class="ci-accept" id="ci-accept">accept</button>
          <button class="ci-decline" id="ci-decline">decline</button>
        </div>
      </div>
    `;
    this.$callIncoming.classList.add('visible');

    this.$callIncoming.querySelector('#ci-accept')?.addEventListener('click', async () => {
      this.$callIncoming.classList.remove('visible');
      await this._acceptIncomingCall();
    });

    this.$callIncoming.querySelector('#ci-decline')?.addEventListener('click', () => {
      this.$callIncoming.classList.remove('visible');
      this.network.sendCtrl(fp, { type: 'call-decline', callId: msg.callId, ts: Date.now() });
      this.incomingCall = null;
    });
  }

  async _acceptIncomingCall() {
    if (!this.incomingCall) return;
    const inc = this.incomingCall;
    this.incomingCall = null;

    if (!this.callState) {
      this.callState = {
        id: inc.callId,
        mode: inc.mode || 'audio',
        targets: new Set([inc.from]),
        accepted: new Set([inc.from]),
        localStream: null,
        remote: new Map(),
      };
    }

    try {
      if (!this.callState.localStream) {
        this.callState.localStream = await this.network.getLocalStream(inc.mode === 'video');
      }

      this.network.sendCtrl(inc.from, { type: 'call-accept', callId: inc.callId, mode: inc.mode, ts: Date.now() });
      this._attachCallPeer(inc.from);
      this._renderCallPanel();
    } catch (e) {
      this._setStatus(`call failed: ${e.message}`);
      this.network.sendCtrl(inc.from, { type: 'call-decline', callId: inc.callId, ts: Date.now() });
    }
  }

  async _onCallAccepted(fp, msg) {
    if (!this.callState || this.callState.id !== msg.callId) return;

    this.callState.accepted.add(fp);
    this._attachCallPeer(fp);

    try {
      if (!this.callState.localStream) {
        this.callState.localStream = await this.network.getLocalStream((this.callState.mode || msg.mode) === 'video');
      }

      await this.network.offerWithStream(fp, this.callState.localStream);
      this._renderCallPanel();
      this._setStatus(`call connected: ${this._peerNick(fp)}`);
    } catch (e) {
      this._setStatus(`offer failed: ${e.message}`);
    }
  }

  async _answerRenegOffer(fp, msg) {
    const mode = msg.callType === 'video' ? 'video' : 'audio';

    if (!this.callState) {
      this.callState = {
        id: `call:${crypto.randomUUID()}`,
        mode,
        targets: new Set([fp]),
        accepted: new Set([fp]),
        localStream: null,
        remote: new Map(),
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
      this._setStatus(`answer failed: ${e.message}`);
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
  }

  async _endCall() {
    if (!this.callState) return;
    const peers = new Set([...this.callState.targets, ...this.callState.accepted]);

    for (const fp of peers) {
      this.network.sendCtrl(fp, { type: 'call-end', callId: this.callState.id, ts: Date.now() });
      await this.network.stopMedia(fp);
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
    this._setStatus('call ended');
  }

  _renderCallPanel() {
    if (!this.callState) {
      this.$callPanel.classList.remove('active');
      this.$callPanel.innerHTML = '';
      return;
    }

    this.$callPanel.classList.add('active');

    const wrap = document.createElement('div');
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;';
    top.innerHTML = `
      <div style="font-size:.66rem;letter-spacing:.16em;color:#40e0d0;text-transform:uppercase">
        ${this.callState.mode} call · peers ${this.callState.remote.size}
      </div>
      <button id="call-end-btn" style="border:1px solid #e05040;background:transparent;color:#e05040;cursor:pointer;padding:4px 10px;">end call</button>
    `;
    wrap.appendChild(top);

    const grid = document.createElement('div');
    grid.className = 'call-grid';
    wrap.appendChild(grid);

    if (this.callState.localStream) {
      grid.appendChild(this._makeCallTile({
        fp: this.identity.fingerprint,
        label: 'you',
        stream: this.callState.localStream,
        muted: true,
      }));
    }

    for (const [fp, stream] of this.callState.remote.entries()) {
      grid.appendChild(this._makeCallTile({
        fp,
        label: this._peerNick(fp),
        stream,
        muted: false,
      }));
    }

    this.$callPanel.innerHTML = '';
    this.$callPanel.appendChild(wrap);

    this.$callPanel.querySelector('#call-end-btn')?.addEventListener('click', () => this._endCall());
  }

  _makeCallTile({ fp, label, stream, muted }) {
    const id = `tile-${fp}`;
    const tile = document.createElement('div');
    tile.className = 'call-tile';
    tile.id = id;

    const video = document.createElement('video');
    video.className = 'call-video';
    video.autoplay = true;
    video.playsInline = true;
    video.muted = !!muted;
    video.srcObject = stream;
    tile.appendChild(video);

    const name = document.createElement('div');
    name.className = 'call-label';
    name.textContent = label;
    tile.appendChild(name);

    const actions = document.createElement('div');
    actions.className = 'call-actions';
    actions.innerHTML = `<button data-fullscreen="${id}" title="fullscreen">⤢</button>`;
    tile.appendChild(actions);

    const tech = document.createElement('div');
    tech.className = 'call-tech';
    tech.dataset.fp = fp;
    tech.textContent = 'RTT - | up - | down -';
    tile.appendChild(tech);

    return tile;
  }

  _startStatsTicker() {
    this.statsTicker = setInterval(() => this._refreshCallStats().catch(() => {}), 1000);
  }

  async _refreshCallStats() {
    if (!this.callState) return;
    for (const fp of this.callState.remote.keys()) {
      const ps = this.network.peers?.get(fp);
      const pc = ps?.pc;
      if (!pc) continue;

      const stats = await pc.getStats();
      let rtt = null;
      let upBytes = 0;
      let downBytes = 0;

      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && typeof r.currentRoundTripTime === 'number') {
          rtt = Math.round(r.currentRoundTripTime * 1000);
        }
        if (r.type === 'outbound-rtp' && !r.isRemote && typeof r.bytesSent === 'number') {
          upBytes += r.bytesSent;
        }
        if (r.type === 'inbound-rtp' && !r.isRemote && typeof r.bytesReceived === 'number') {
          downBytes += r.bytesReceived;
        }
      });

      const prev = this.prevStats.get(fp);
      const now = performance.now();
      let upRate = 0;
      let downRate = 0;

      if (prev) {
        const dt = Math.max(0.001, (now - prev.t) / 1000);
        upRate = Math.max(0, (upBytes - prev.upBytes) / dt);
        downRate = Math.max(0, (downBytes - prev.downBytes) / dt);
      }
      this.prevStats.set(fp, { t: now, upBytes, downBytes });

      const tech = this.$callPanel.querySelector(`.call-tech[data-fp="${fp}"]`);
      if (tech) {
        tech.textContent = `RTT ${rtt ?? '-'} ms | up ${fmtRate(upRate)} | down ${fmtRate(downRate)}`;
      }
    }
  }

  _openCircleEditor(circleId) {
    const editing = circleId ? this.circles.find(c => c.id === circleId) : null;
    const allPeers = [...this.peers.values()].filter(p => p.online);

    const box = document.createElement('div');
    box.className = 'modal';
    box.innerHTML = `
      <h3>${editing ? 'Edit' : 'Create'} Short Mesh Circle</h3>
      <div class="row">
        <input id="circle-name" type="text" maxlength="40" placeholder="circle name" value="${escapeAttr(editing?.name || '')}">
      </div>
      <div class="check-list" id="circle-checks"></div>
      <div class="actions">
        <button id="circle-cancel">cancel</button>
        <button id="circle-save">save</button>
      </div>
    `;

    const checks = box.querySelector('#circle-checks');
    for (const p of allPeers) {
      const id = `ck-${p.fingerprint}`;
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;font-size:.72rem;';
      row.innerHTML = `
        <input id="${id}" type="checkbox" value="${p.fingerprint}" ${editing?.members?.includes(p.fingerprint) ? 'checked' : ''}>
        <span>${escapeHtml(p.nick)} <span style="color:#3d7a74">(${short(p.fingerprint)})</span></span>
      `;
      checks.appendChild(row);
    }

    box.querySelector('#circle-cancel')?.addEventListener('click', () => this._closeModal());
    box.querySelector('#circle-save')?.addEventListener('click', () => {
      const name = box.querySelector('#circle-name').value.trim();
      const members = [...checks.querySelectorAll('input[type="checkbox"]:checked')].map(x => x.value);

      if (!name) return this._setStatus('circle name required');
      if (!members.length) return this._setStatus('select at least 1 member');

      if (editing) {
        editing.name = name;
        editing.members = members;
      } else {
        this.circles.push({ id: `circle:${crypto.randomUUID()}`, name, members });
      }

      this._saveCircles();
      this._renderSidebar();
      this._closeModal();
      this._setStatus('circle saved');
    });

    this._openModal(box);
  }

  _upsertRemoteCircle(id, name, members) {
    if (!id) return;
    const ex = this.circles.find(c => c.id === id);
    if (ex) {
      ex.name = name || ex.name;
      ex.members = members?.length ? members : ex.members;
    } else {
      this.circles.push({
        id,
        name: name || `circle ${this.circles.length + 1}`,
        members: Array.isArray(members) ? members : [],
      });
    }
    this._saveCircles();
    this._renderSidebar();
  }

  _openModal(contentNode) {
    this.$modalRoot.innerHTML = '';
    this.$modalRoot.appendChild(contentNode);
    this.$modalRoot.classList.add('visible');
    this.$modalRoot.addEventListener('click', this._modalCloseHandler = (e) => {
      if (e.target === this.$modalRoot) this._closeModal();
    });
  }

  _closeModal() {
    this.$modalRoot.classList.remove('visible');
    this.$modalRoot.innerHTML = '';
    if (this._modalCloseHandler) {
      this.$modalRoot.removeEventListener('click', this._modalCloseHandler);
      this._modalCloseHandler = null;
    }
  }

  _sessionIdFromContext(ctx) {
    if (!ctx) return null;
    if (ctx.kind === 'peer') return `peer:${ctx.id}`;
    if (ctx.kind === 'circle') return `circle:${ctx.id}`;
    return null;
  }

  _peerNick(fp) {
    return this.peers.get(fp)?.nick || short(fp);
  }

  _setStatus(text) {
    this.$statusBar.textContent = text;
  }

  _log(text, isErr = false) {
    const line = document.createElement('div');
    line.textContent = `${new Date().toLocaleTimeString()} · ${text}`;
    line.style.color = isErr ? '#e05040' : '#3d7a74';
    this.$netLog.prepend(line);
  }

  _scrollToBottom() {
    this.$messages.scrollTop = this.$messages.scrollHeight;
  }
}

function short(v) {
  return (v || '?').slice(0, 8);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s ?? '');
}
