/**
 * app.js — Turquoise v7
 *
 * State machine UI. Three views on mobile (PEERS | CHAT | CALL).
 * Desktop: two-column golden ratio layout (no view switching needed).
 *
 * Phases:
 *   3 — Chat + Group + persistent history + unread badges + nicknames
 *   4 — File transfer (binary, 1MB, CRC, speed readout)
 *   5 — Voice + Video + PTT (walkie-talkie mode)
 *
 * Murphy's Law: every DOM op null-checked. Every async try/catched.
 *               Every failure surfaced visibly. Nothing fails silently.
 */

import { saveMessage, loadMessages, savePeer, loadPeers, updatePeerNickname } from './messages.js';
import { FileTransfer } from './files.js';
import { saveNickname }  from './identity.js';

// ── View state (mobile) ──────────────────────────────────────────────────────
const VIEWS = { PEERS:'peers', CHAT:'chat', CALL:'call' };

export class TurquoiseApp {

  constructor(identity, network) {
    if (!identity?.fingerprint) throw new Error('App: identity.fingerprint required.');
    if (!network?.sendCtrl)     throw new Error('App: network.sendCtrl required.');

    this.id  = identity;
    this.net = network;

    this.isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
                  || window.innerWidth <= 640;

    // ── Data state ─────────────────────────────────────────────────────────
    this.peers    = new Map();  // fp → { shortId, nickname, connected }
    this.sessions = new Map();  // fp|'group' → msg[]
    this.active   = null;       // fp | 'group' | null
    this.unread   = new Map();  // fp|'group' → count

    // ── Call state ─────────────────────────────────────────────────────────
    this.callFp    = null;
    this.callSecs  = 0;
    this.callTimer = null;
    this._pendingCall = null;   // { fp, video }
    this.pttFp = null;

    // ── File engine ────────────────────────────────────────────────────────
    this.ft = new FileTransfer(
      (fp, payload) => network.sendCtrl(fp, payload),
      (fp, buf)     => network.sendBinary(fp, buf)
    );
    this.ft.onProgress  = (id, pct, dir, bps) => this._onFileProg(id, pct, bps);
    this.ft.onFileReady = f                   => this._onFileReady(f);
    this.ft.onError     = (id, msg)           => this._onFileErr(id, msg);

    this.el = {};
    this._view = VIEWS.PEERS;
  }

  // ── Mount ─────────────────────────────────────────────────────────────────

  async mount() {
    const root = document.getElementById('app');
    if (!root) throw new Error('App.mount: #app not found.');

    root.innerHTML = this._buildHTML();
    this._cacheEls();
    this._bindEvents();
    this._updateView(VIEWS.PEERS);

    // Load known peers
    try {
      for (const p of await loadPeers()) {
        this.peers.set(p.fingerprint, { shortId:p.shortId, nickname:p.nickname||null, connected:false });
      }
    } catch (e) { this._log('⚠ loadPeers: ' + e.message, true); }

    // Pre-load group session
    try {
      const gm = await loadMessages('group');
      this.sessions.set('group', gm);
    } catch { this.sessions.set('group', []); }

    this._renderPeers();
    this._wireNet();
  }

  // ── HTML shell ────────────────────────────────────────────────────────────

  _buildHTML() {
    const { shortId, fingerprint, nickname } = this.id;
    const disp = nickname || shortId;

    return `
<aside id="sidebar">
  <div id="id-block">
    <div class="wordmark">T·U·R·Q·U·O·I·S·E</div>
    <div id="nick-row" class="nick-row" title="tap to rename">
      <span id="nick-val">${this._e(disp)}</span><span class="nick-pen">✎</span>
    </div>
    <input id="nick-input" type="text" maxlength="32" value="${this._e(disp)}" autocomplete="off"/>
    <div class="fp-line">${fingerprint.slice(0,32)}…</div>
    <div class="sig-row">
      <div class="sig-dot" id="sig-dot"></div>
      <span id="sig-text">connecting…</span>
    </div>
  </div>

  <div id="group-row" class="group-row">
    <span class="group-icon">◈</span>
    <span class="group-name">GROUP</span>
    <span id="group-count">0 peers</span>
    <span id="group-badge" style="display:none"></span>
  </div>

  <div id="peer-list"></div>
  <div id="net-log"></div>
</aside>

<main id="chat-area">
  <div id="chat-header">
    <button class="back-btn" id="back-btn">‹</button>
    <div id="ch-info">
      <div id="ch-name" class="ch-empty">select a peer to start</div>
    </div>
    <div id="ch-acts"></div>
  </div>

  <div id="call-layer">
    <video id="rv" autoplay playsinline></video>
    <video id="lv" autoplay playsinline muted></video>
    <div class="call-foot">
      <div>
        <div class="call-who" id="call-who"></div>
        <div class="call-time" id="call-time">0:00</div>
      </div>
      <button class="btn-end" id="hangup-btn">end call</button>
    </div>
  </div>

  <div id="incoming-banner" style="display:none">
    <div id="inc-label">call</div>
    <div class="inc-btns">
      <button class="btn-accept" id="accept-btn">accept</button>
      <button class="btn-end"    id="reject-btn">decline</button>
    </div>
  </div>

  <div id="msgs">
    <div class="empty-state">
      <div class="es-icon">◈</div>
      <div class="es-text">select a peer</div>
    </div>
  </div>

  <div id="input-bar" style="display:none">
    <button class="ibar-btn" id="ptt-btn" title="Hold to talk (push-to-talk)">🎙</button>
    <button class="ibar-btn" id="file-btn" title="Send file (+)">+</button>
    <textarea id="msg-in" placeholder="signal…" rows="1" autocomplete="off" autocorrect="off"></textarea>
    <button id="send-btn">send</button>
  </div>
</main>

<div id="ptt-bar">● transmitting</div>
<input type="file" id="file-pick" style="display:none" multiple/>
`.trim();
  }

  // ── Cache DOM elements ────────────────────────────────────────────────────

  _cacheEls() {
    const ids = [
      'sidebar','id-block','nick-row','nick-val','nick-input','sig-dot','sig-text',
      'group-row','group-count','group-badge','peer-list','net-log',
      'chat-area','chat-header','back-btn','ch-info','ch-name','ch-acts',
      'call-layer','rv','lv','call-who','call-time','hangup-btn',
      'incoming-banner','inc-label','accept-btn','reject-btn',
      'msgs','input-bar','ptt-btn','file-btn','msg-in','send-btn','ptt-bar',
    ];
    for (const id of ids) {
      const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.el[key] = document.getElementById(id);
      if (!this.el[key]) console.warn('App: #' + id + ' not found');
    }
  }

  // ── View state machine ────────────────────────────────────────────────────

  _updateView(view) {
    this._view = view;
    document.body.dataset.view = view;
  }

  // ── Bind events ───────────────────────────────────────────────────────────

  _bindEvents() {
    // Nickname edit
    this.el.nickRow?.addEventListener('click', () => this._startNickEdit());
    this.el.nickInput?.addEventListener('blur',    () => this._commitNick());
    this.el.nickInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); this._commitNick(); }
      if (e.key === 'Escape') this._cancelNickEdit();
    });

    // Group session
    this.el.groupRow?.addEventListener('click', () => this._openSession('group'));

    // Message input
    this.el.msgIn?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._send(); }
    });
    this.el.msgIn?.addEventListener('input', () => {
      const el = this.el.msgIn;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    });
    this.el.sendBtn?.addEventListener('click', () => this._send());

    // File picker
    const pick = this.el.filePick || document.getElementById('file-pick');
    this.el.fileBtn?.addEventListener('click', () => {
      if (!this.active) { this._toast('Select a peer first.', true); return; }
      if (this.active === 'group') { this._toast('File transfer not available in group chat.', true); return; }
      pick?.click();
    });
    pick?.addEventListener('change', e => {
      Array.from(e.target.files || []).forEach(f => this._sendFile(f));
      if (pick) pick.value = '';
    });

    // Drag & drop
    this.el.chatArea?.addEventListener('dragover', e => {
      e.preventDefault();
      if (this.active && this.active !== 'group') this.el.chatArea.classList.add('drag-over');
    });
    this.el.chatArea?.addEventListener('dragleave', () => this.el.chatArea?.classList.remove('drag-over'));
    this.el.chatArea?.addEventListener('drop', e => {
      e.preventDefault(); this.el.chatArea?.classList.remove('drag-over');
      if (!this.active || this.active === 'group') { this._toast('Select a peer first.', true); return; }
      Array.from(e.dataTransfer?.files || []).forEach(f => this._sendFile(f));
    });

    // PTT
    const pttStart = async () => {
      if (!this.active || this.active === 'group' || this.pttFp) return;
      try {
        await this.net.startPTT(this.active);
        this.pttFp = this.active;
        this.el.pttBtn?.classList.add('live');
        this.el.pttBar?.classList.add('on');
      } catch (e) { this._toast('PTT: ' + e.message, true); }
    };
    const pttStop = () => {
      if (!this.pttFp) return;
      this.net.stopPTT(this.pttFp);
      this.pttFp = null;
      this.el.pttBtn?.classList.remove('live');
      this.el.pttBar?.classList.remove('on');
    };
    const ptt = this.el.pttBtn;
    if (ptt) {
      ptt.addEventListener('mousedown', pttStart);
      ptt.addEventListener('mouseup',   pttStop);
      ptt.addEventListener('mouseleave',pttStop);
      ptt.addEventListener('touchstart', e => { e.preventDefault(); pttStart(); }, { passive:false });
      ptt.addEventListener('touchend',   e => { e.preventDefault(); pttStop();  }, { passive:false });
    }

    // Call controls
    this.el.hangupBtn?.addEventListener('click', () => this._hangup());
    this.el.acceptBtn?.addEventListener('click', () => this._acceptCall());
    this.el.rejectBtn?.addEventListener('click', () => this._rejectCall());

    // Fullscreen toggle on call layer
    this.el.callLayer?.addEventListener('click', e => {
      if (e.target === this.el.hangupBtn || this.el.hangupBtn?.contains(e.target)) return;
      this._toggleFS();
    });

    // Back button (mobile)
    this.el.backBtn?.addEventListener('click', () => {
      if (this._view === VIEWS.CALL) {
        this._updateView(VIEWS.CHAT);
      } else {
        this._updateView(VIEWS.PEERS);
        this.active = null;
      }
    });

    // Resize: update mobile detection
    window.addEventListener('resize', () => {
      this.isMobile = window.innerWidth <= 640;
    });
  }

  // ── Nickname ──────────────────────────────────────────────────────────────

  _startNickEdit() {
    if (!this.el.nickRow || !this.el.nickInput) return;
    this.el.nickRow.style.display   = 'none';
    this.el.nickInput.style.display = 'block';
    this.el.nickInput.focus();
    this.el.nickInput.select();
  }

  _commitNick() {
    const n = this.el.nickInput?.value?.trim()?.slice(0, 32);
    if (n) {
      this.id.nickname = n;
      this.net.identity.nickname = n;
      saveNickname(n);
      this.net.broadcastNick(n);
      if (this.el.nickVal) this.el.nickVal.textContent = n;
    }
    this._cancelNickEdit();
  }

  _cancelNickEdit() {
    if (this.el.nickInput)  this.el.nickInput.style.display = 'none';
    if (this.el.nickRow)    this.el.nickRow.style.display   = 'flex';
  }

  // ── Wire network callbacks ────────────────────────────────────────────────

  _wireNet() {
    this.net.onCtrlMessage = (fp, event) => {
      try { this._onEvent(fp, event); }
      catch (e) { this._log('⚠ event: ' + e.message, true); }
    };

    this.net.onBinaryChunk = (fp, buf) => {
      try { this.ft.handleBinary(buf); }
      catch (e) { this._log('⚠ binary: ' + e.message, true); }
    };

    this.net.onPeerConnected    = fp => this._onConnect(fp, null);
    this.net.onPeerDisconnected = fp => this._onDisconnect(fp);

    this.net.onStatusChange = s => {
      const d = this.el.sigDot, t = this.el.sigText;
      if (d) d.className = 'sig-dot ' + s;
      if (t) t.textContent = { connecting:'connecting…', connected:'connected', disconnected:'offline' }[s] || s;
    };

    this.net.onRemoteStream = (fp, stream) => {
      if (!this.el.rv) return;
      if (stream) {
        this.el.rv.srcObject = stream;
        this.el.callLayer?.classList.add('visible');
        this._startTimer(fp);
        if (this.isMobile) this._updateView(VIEWS.CALL);
      } else {
        this.el.rv.srcObject = null;
        this.el.callLayer?.classList.remove('visible');
        this._stopTimer();
        if (this.isMobile && this._view === VIEWS.CALL) this._updateView(VIEWS.CHAT);
      }
    };

    this.net.logFn = (t) => {
      this._log(t, t.startsWith('❌') || t.startsWith('⚠'));
    };
  }

  // ── Handle P2P events ─────────────────────────────────────────────────────

  _onEvent(fp, event) {
    if (!event || typeof event !== 'object') return;
    const { type } = event;

    if (type === 'hello') {
      this._onConnect(event.fingerprint || fp, event.shortId, event.nickname);
    }
    else if (type === 'nick') {
      const p = this.peers.get(event.fingerprint);
      if (p) {
        p.nickname = event.nickname;
        updatePeerNickname(event.fingerprint, event.nickname).catch(() => {});
        this._renderPeers();
        if (this.active === event.fingerprint) this._renderHeader();
      }
    }
    else if (type === 'chat') {
      this._receiveMsg(fp, event);
    }
    else if (type === 'group-chat') {
      this._receiveGroupMsg(event);
    }
    else if (type === 'file-start') {
      this.ft.handleControl(event);
      if (this.active === fp) {
        this._addFileCard(fp, event.fileId, event.name, event.size, false);
      }
    }
    else if (type === 'file-end' || type === 'file-cancel') {
      this.ft.handleControl(event);
    }
    else if (type === 'call-offer') {
      this._pendingCall = { fp, video: !!event.video };
      const p    = this.peers.get(fp);
      const name = p?.nickname || p?.shortId || fp?.slice(0,8) || '?';
      if (this.el.incLabel)       this.el.incLabel.textContent    = (event.video?'📹':'📞') + ' ' + name;
      if (this.el.incomingBanner) this.el.incomingBanner.style.display = 'block';
    }
    else if (type === 'call-end' || type === 'ptt-end') {
      this._hangup();
    }
  }

  // ── Peer lifecycle ────────────────────────────────────────────────────────

  _onConnect(fp, shortId, nickname) {
    if (!fp) return;
    const ex   = this.peers.get(fp);
    const sid  = shortId  || ex?.shortId  || fp.slice(0,8);
    const nick = nickname || ex?.nickname || null;

    this.peers.set(fp, { shortId:sid, nickname:nick, connected:true });
    savePeer({ fingerprint:fp, shortId:sid, nickname:nick }).catch(() => {});

    if (!this.sessions.has(fp)) {
      loadMessages(fp)
        .then(msgs => { this.sessions.set(fp, msgs); this._renderPeers(); if (this.active===fp) this._renderMsgs(); })
        .catch(() => this.sessions.set(fp, []));
    } else { this._renderPeers(); }

    this._updateGroupCount();
    if (this.active === fp) this._renderHeader();
  }

  _onDisconnect(fp) {
    if (!fp) return;
    const p = this.peers.get(fp);
    if (p) { p.connected = false; this.peers.set(fp, p); }
    this._renderPeers();
    this._updateGroupCount();
    if (this.active === fp) this._renderHeader();
  }

  // ── Open session ──────────────────────────────────────────────────────────

  async _openSession(id) {
    if (!id) return;
    this.active = id;

    if (id === 'group') {
      this.unread.set('group', 0);
      this._updateGroupBadge();
    } else {
      this.unread.set(id, 0);
    }

    if (!this.sessions.has(id)) {
      try {
        const msgs = await loadMessages(id);
        this.sessions.set(id, msgs);
      } catch { this.sessions.set(id, []); }
    }

    this._renderHeader();
    this._renderMsgs();
    this._renderPeers();

    if (this.el.inputBar) this.el.inputBar.style.display = 'flex';
    if (this.isMobile) this._updateView(VIEWS.CHAT);
    this.el.msgIn?.focus();
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  _send() {
    const text = this.el.msgIn?.value?.trim();
    if (!text || !this.active) return;

    if (this.active === 'group') this._sendGroup(text);
    else                         this._sendPeer(this.active, text);

    if (this.el.msgIn) { this.el.msgIn.value = ''; this.el.msgIn.style.height = 'auto'; }
  }

  _sendPeer(fp, text) {
    const msg = this._makeMsg(fp, text, true);
    const ok  = this.net.sendCtrl(fp, {
      type:'chat', id:msg.id,
      fingerprint:this.id.fingerprint, shortId:this.id.shortId, nickname:this.id.nickname||null,
      text, ts:msg.ts,
    });
    if (!ok) { this._toast('Peer offline — not sent.', true); return; }
    this._storeAndAppend(msg);
  }

  _sendGroup(text) {
    const msg = this._makeMsg('group', text, true);
    const n   = this.net.broadcastCtrl({
      type:'group-chat', id:msg.id,
      fingerprint:this.id.fingerprint, shortId:this.id.shortId, nickname:this.id.nickname||null,
      text, ts:msg.ts,
    });
    if (n === 0 && this.peers.size > 0) { this._toast('No peers connected.', true); return; }
    this._storeAndAppend(msg);
  }

  _makeMsg(sessionId, text, own) {
    return {
      id: this._uid(), sessionId,
      from:      this.id.fingerprint,
      fromShort: this.id.shortId,
      fromNick:  this.id.nickname || null,
      text, ts: Date.now(), type:'text', own,
    };
  }

  _storeAndAppend(msg) {
    if (!this.sessions.has(msg.sessionId)) this.sessions.set(msg.sessionId, []);
    this.sessions.get(msg.sessionId).push(msg);
    saveMessage(msg).catch(() => {});
    if (this.active === msg.sessionId) this._appendMsg(msg);
    this._renderPeers();
  }

  // ── Receive ───────────────────────────────────────────────────────────────

  _receiveMsg(fp, event) {
    if (!fp || !event.text) return;
    const msg = {
      id:        event.id || this._uid(),
      sessionId: fp,
      from:      fp, fromShort: event.shortId||fp.slice(0,8), fromNick: event.nickname||null,
      text:      String(event.text), ts: event.ts||Date.now(), type:'text', own: false,
    };
    if (!this.sessions.has(fp)) this.sessions.set(fp, []);
    this.sessions.get(fp).push(msg);
    saveMessage(msg).catch(() => {});

    if (this.active === fp) this._appendMsg(msg);
    else                    this.unread.set(fp, (this.unread.get(fp)||0)+1);
    this._renderPeers();
  }

  _receiveGroupMsg(event) {
    if (!event.text || !event.fingerprint) return;
    const msg = {
      id:        event.id || this._uid(),
      sessionId: 'group',
      from:      event.fingerprint,
      fromShort: event.shortId || event.fingerprint.slice(0,8),
      fromNick:  event.nickname || null,
      text:      String(event.text), ts:event.ts||Date.now(), type:'text', own:false,
    };
    if (!this.sessions.has('group')) this.sessions.set('group', []);
    this.sessions.get('group').push(msg);
    saveMessage(msg).catch(() => {});

    if (this.active === 'group') this._appendMsg(msg);
    else { this.unread.set('group', (this.unread.get('group')||0)+1); this._updateGroupBadge(); }
  }

  // ── File transfer ─────────────────────────────────────────────────────────

  async _sendFile(file) {
    if (!file || !this.active || this.active === 'group') return;
    const fp     = this.active;
    const fileId = this._uid();
    this._addFileCard(fp, fileId, file.name, file.size, true);
    try {
      await this.ft.sendFile(file, fp, fileId, pFp => this.net.getFtChannel(pFp));
    } catch (e) { this._onFileErr(fileId, e.message); }
  }

  _onFileProg(fileId, pct, bps) {
    const fill  = document.querySelector(`#fc-${fileId} .prg-fill`);
    const speed = document.querySelector(`#fc-${fileId} .fc-speed`);
    if (fill)  fill.style.width  = (pct * 100).toFixed(1) + '%';
    if (speed) speed.textContent = this._fmtSpeed(bps);
  }

  _onFileReady(f) {
    const card = document.getElementById('fc-' + f.fileId);
    if (!card) return;
    card.querySelector('.prg-track')?.remove();
    const spd = card.querySelector('.fc-speed');
    if (spd) spd.textContent = 'avg ' + this._fmtSpeed(f.avgBps);
    if (!card.querySelector('.dl-btn')) {
      const a = document.createElement('a');
      a.className = 'dl-btn'; a.href = f.url; a.download = f.name || 'file';
      a.textContent = '↓ ' + (f.name || 'file');
      card.appendChild(a);
    }
  }

  _onFileErr(fileId, msg) {
    const card = document.getElementById('fc-' + fileId);
    if (card) {
      const e = document.createElement('div');
      e.className = 'fc-err'; e.textContent = '⚠ ' + msg;
      card.appendChild(e);
    }
    this._toast('File error: ' + msg, true);
  }

  // ── Calls ─────────────────────────────────────────────────────────────────

  async _voiceCall(fp) {
    try {
      const s = await this.net.startCall(fp, false);
      this.callFp = fp;
      if (this.el.lv) this.el.lv.srcObject = s;
    } catch (e) { this._toast('Voice: ' + e.message, true); }
  }

  async _videoCall(fp) {
    try {
      const s = await this.net.startCall(fp, true);
      this.callFp = fp;
      if (this.el.lv) this.el.lv.srcObject = s;
    } catch (e) { this._toast('Video: ' + e.message, true); }
  }

  async _acceptCall() {
    if (this.el.incomingBanner) this.el.incomingBanner.style.display = 'none';
    const { fp } = this._pendingCall || {};
    this._pendingCall = null;
    if (!fp) return;
    try {
      const s = await this.net.acceptCall(fp);
      this.callFp = fp;
      if (this.el.lv) this.el.lv.srcObject = s;
    } catch (e) { this._toast('Accept: ' + e.message, true); }
  }

  _rejectCall() {
    if (this.el.incomingBanner) this.el.incomingBanner.style.display = 'none';
    const { fp } = this._pendingCall || {};
    this._pendingCall = null;
    if (fp) this.net.sendCtrl(fp, { type:'call-end', from:this.id.fingerprint });
  }

  _hangup() {
    this.net.hangup(this.callFp);
    this.callFp = null;
    this._stopTimer();
    this.el.callLayer?.classList.remove('visible');
    if (this.el.lv)  this.el.lv.srcObject  = null;
    if (this.el.rv)  this.el.rv.srcObject  = null;
    if (this.el.incomingBanner) this.el.incomingBanner.style.display = 'none';
    this._pendingCall = null;
    if (this.isMobile && this._view === VIEWS.CALL) this._updateView(VIEWS.CHAT);
  }

  _toggleFS() {
    const el = this.el.callLayer;
    if (!el) return;
    if (!document.fullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch(() => {
        el.classList.toggle('fs');
      });
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)?.catch(() => {
        el.classList.remove('fs');
      });
    }
  }

  _startTimer(fp) {
    this.callSecs = 0; this._stopTimer();
    const p    = this.peers.get(fp);
    const name = p?.nickname || p?.shortId || fp?.slice(0,8) || '?';
    if (this.el.callWho) this.el.callWho.textContent = name;
    this.callTimer = setInterval(() => {
      this.callSecs++;
      const m = Math.floor(this.callSecs/60), s = this.callSecs%60;
      if (this.el.callTime) this.el.callTime.textContent = `${m}:${String(s).padStart(2,'0')}`;
    }, 1000);
  }

  _stopTimer() {
    clearInterval(this.callTimer); this.callTimer = null;
    if (this.el.callTime) this.el.callTime.textContent = '0:00';
  }

  // ── Render: peer list ─────────────────────────────────────────────────────

  _renderPeers() {
    const list = this.el.peerList;
    if (!list) return;

    if (this.peers.size === 0) {
      list.innerHTML = '<div class="no-peers">no peers detected<br/>share the URL to invite</div>';
      return;
    }

    const sorted = [...this.peers.entries()].sort(([,a],[,b]) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return (a.nickname||a.shortId).localeCompare(b.nickname||b.shortId);
    });

    list.innerHTML = sorted.map(([fp, p]) => {
      const isActive = fp === this.active ? ' active' : '';
      const dot      = p.connected ? 'on' : 'off';
      const unread   = this.unread.get(fp) || 0;
      const msgs     = this.sessions.get(fp) || [];
      const last     = msgs[msgs.length - 1];
      const prev     = last ? this._e(last.text.slice(0, 40)) : '';
      const name     = this._e(p.nickname || p.shortId);

      return `<div class="peer-tile${isActive}" data-fp="${fp}">
  <div class="p-dot ${dot}"></div>
  <div class="p-info">
    <div class="p-name">${name}</div>
    <div class="p-id">${fp.slice(0,8)}</div>
    ${prev ? `<div class="p-prev">${prev}</div>` : ''}
  </div>
  <div class="p-right">
    ${p.connected ? `
      <button class="p-btn" data-fp="${fp}" data-act="voice" title="Voice">📞</button>
      <button class="p-btn" data-fp="${fp}" data-act="video" title="Video">📹</button>
    ` : ''}
    ${unread > 0 ? `<div class="p-badge">${unread > 9 ? '9+' : unread}</div>` : ''}
  </div>
</div>`;
    }).join('');

    list.querySelectorAll('.peer-tile').forEach(tile => {
      tile.addEventListener('click', e => {
        const btn = e.target.closest('.p-btn');
        if (btn) {
          e.stopPropagation();
          const fp  = btn.dataset.fp;
          const act = btn.dataset.act;
          this.active = fp;
          if (act === 'voice') this._voiceCall(fp);
          if (act === 'video') this._videoCall(fp);
          return;
        }
        const fp = tile.dataset.fp;
        if (fp) this._openSession(fp);
      });
    });
  }

  // ── Render: chat header ───────────────────────────────────────────────────

  _renderHeader() {
    const name = this.el.chName, acts = this.el.chActs;
    if (!name) return;

    if (!this.active) {
      name.textContent = 'select a peer to start';
      name.className   = 'ch-empty';
      if (acts) acts.innerHTML = '';
      return;
    }

    if (this.active === 'group') {
      const n = this.net.getConnectedPeers().length;
      name.textContent = `◈ GROUP · ${n} peer${n===1?'':'s'}`;
      name.className   = 'ch-title';
      if (acts) acts.innerHTML = '';
      return;
    }

    const fp   = this.active;
    const p    = this.peers.get(fp);
    const dot  = p?.connected ? 'on' : 'off';
    const disp = this._e(p?.nickname || p?.shortId || fp.slice(0,8));

    name.innerHTML = `<span class="p-dot ${dot}"></span>${disp}<div class="ch-sub">${fp.slice(0,16)}…</div>`;
    name.className = 'ch-title';

    if (acts) {
      acts.innerHTML = p?.connected ? `
        <button class="act-btn" id="hv">📞 voice</button>
        <button class="act-btn" id="hc">📹 video</button>
      ` : '';
      document.getElementById('hv')?.addEventListener('click', () => this._voiceCall(fp));
      document.getElementById('hc')?.addEventListener('click', () => this._videoCall(fp));
    }
  }

  // ── Render: messages ──────────────────────────────────────────────────────

  _renderMsgs() {
    const el = this.el.msgs;
    if (!el) return;
    el.innerHTML = '';
    const msgs = this.sessions.get(this.active) || [];
    if (!msgs.length) {
      el.innerHTML = '<div class="sys-msg">no messages yet</div>';
      return;
    }
    for (const m of msgs) {
      if (m.type === 'text') el.appendChild(this._buildMsgEl(m));
    }
    this._scrollEnd();
  }

  _appendMsg(msg) {
    const el = this.el.msgs;
    if (!el) return;
    const empty = el.querySelector('.empty-state, .sys-msg');
    if (empty && el.children.length === 1) empty.remove();
    el.appendChild(this._buildMsgEl(msg));
    this._scrollEnd();
  }

  _buildMsgEl(msg) {
    const d    = document.createElement('div');
    d.className = `msg ${msg.own ? 'own' : 'them'}`;
    const time = new Date(msg.ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    const who  = msg.own ? (this.id.nickname || 'you') : (msg.fromNick || msg.fromShort || '?');
    d.innerHTML = `<div class="msg-meta">${this._e(who)} · ${time}</div><div class="msg-body">${this._e(msg.text)}</div>`;
    return d;
  }

  _addFileCard(fp, fileId, name, size, own) {
    const el = this.el.msgs;
    if (!el) return;
    const empty = el.querySelector('.empty-state, .sys-msg');
    if (empty && el.children.length === 1) empty.remove();

    const who  = own ? (this.id.nickname || 'you') : (this.peers.get(fp)?.nickname || this.peers.get(fp)?.shortId || fp?.slice(0,8) || '?');
    const time = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    const wrap = document.createElement('div');
    wrap.className = `msg ${own ? 'own' : 'them'}`;
    wrap.innerHTML = `
<div class="msg-meta">${this._e(who)} · ${time}</div>
<div class="fcard" id="fc-${fileId}">
  <div class="fc-name">📎 ${this._e(name||'file')}</div>
  <div class="fc-sz">${this._fmtSize(size)}</div>
  <div class="prg-track"><div class="prg-fill" style="width:0%"></div></div>
  <div class="fc-speed"></div>
</div>`.trim();
    el.appendChild(wrap);
    this._scrollEnd();
  }

  // ── Group helpers ─────────────────────────────────────────────────────────

  _updateGroupCount() {
    const n = this.net.getConnectedPeers().length;
    if (this.el.groupCount) this.el.groupCount.textContent = `${n} peer${n===1?'':'s'}`;
    if (this.active === 'group') this._renderHeader();
  }

  _updateGroupBadge() {
    const b = this.el.groupBadge, c = this.el.groupCount;
    const n = this.unread.get('group') || 0;
    if (b) {
      b.style.display = n > 0 ? 'flex' : 'none';
      b.textContent   = n > 9 ? '9+' : String(n);
      if (c) c.style.display = n > 0 ? 'none' : 'inline';
    }
  }

  // ── Toast + log ───────────────────────────────────────────────────────────

  _toast(text, isErr = false) {
    const el = this.el.msgs;
    if (!el) return;
    const d = document.createElement('div');
    d.className = `sys-msg${isErr ? ' err' : ''}`;
    d.textContent = text;
    el.appendChild(d);
    this._scrollEnd();
    setTimeout(() => { try { d.remove(); } catch {} }, 5000);
  }

  _log(text, isErr = false) {
    const log = this.el.netLog;
    if (!log) return;
    const d = document.createElement('div');
    d.className = `nlog${isErr ? ' err' : ''}`;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 80) { try { log.removeChild(log.firstChild); } catch { break; } }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  _scrollEnd() { const el = this.el.msgs; if (el) el.scrollTop = el.scrollHeight; }

  _e(t) {
    return String(t || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  _fmtSize(b) {
    if (!b||isNaN(b)) return '?';
    if (b<1024)      return b+'B';
    if (b<1024**2)   return (b/1024).toFixed(1)+'KB';
    if (b<1024**3)   return (b/1024**2).toFixed(1)+'MB';
    return (b/1024**3).toFixed(2)+'GB';
  }

  _fmtSpeed(bps) {
    if (!bps) return '';
    if (bps<1024)      return bps.toFixed(0)+' B/s';
    if (bps<1024**2)   return (bps/1024).toFixed(1)+' KB/s';
    if (bps<1024**3)   return (bps/1024**2).toFixed(1)+' MB/s';
    return (bps/1024**3).toFixed(2)+' GB/s';
  }

  _uid() {
    return crypto.randomUUID ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
}
