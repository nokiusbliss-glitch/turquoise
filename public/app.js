/**
 * app.js — Turquoise
 * UI orchestration: peers, chat, files, calls, mesh, nerdy stats, Tic-Tac-Toe.
 */

import {
  saveMessage,
  loadMessages,
  savePeer,
  loadPeers,
  clearMessages,
  clearAllData,
} from './messages.js';
import { resetIdentity } from './identity.js';
import { FileTransfer } from './files.js';

const $ = (id) => document.getElementById(id);
const MESH_ID = 'mesh';

const esc = (s) =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fmtBytes = (b) => {
  const n = Number(b || 0);
  if (n < 1024) return `${n.toFixed(0)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const fmtRate = (bps) => {
  const n = Number(bps || 0);
  if (n < 1) return '-- B/s';
  if (n < 1024) return `${n.toFixed(0)} B/s`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB/s`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB/s`;
};

const fmtEta = (sec) => {
  const s = Number(sec);
  if (!Number.isFinite(s) || s < 0) return '--';
  if (s < 60) return `${Math.ceil(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.ceil(s % 60);
  return `${m}m ${r}s`;
};

export class TurquoiseApp {
  constructor(identity, network) {
    if (!identity?.fingerprint) throw new Error('identity required');
    if (!network?.sendCtrl) throw new Error('network required');

    this.id = identity;
    this.net = network;

    this.peers = new Map(); // fp -> {nick, connected}
    this.sessions = new Map(); // sessionId -> messages[]
    this.active = null;
    this.unread = new Map();
    this.meshBlocked = new Set();

    this.call = null;
    this.meshCall = null;
    this.games = new Map(); // fp -> ttt state

    this._statusTimer = null;
    this._statsTimer = null;
    this._fileUrls = new Map(); // fileId -> file payload
    this._plusMenuOpen = false;

    this._audioEl = document.createElement('audio');
    this._audioEl.autoplay = true;
    this._audioEl.playsInline = true;
    this._audioEl.style.display = 'none';
    document.body.appendChild(this._audioEl);

    this.ft = new FileTransfer(
      (fp, msg) => network.sendCtrl(fp, msg),
      (fp, buf) => network.sendBinary(fp, buf),
      (fp) => network.waitForBuffer(fp)
    );

    this.ft.onProgress = (fileId, payload, dir, fp) => this._onFileProg(fileId, payload, dir, fp);
    this.ft.onFileReady = (file) => this._onFileReady(file);
    this.ft.onError = (fileId, msg, fp) => this._onFileErr(fileId, msg, fp);
  }

  async mount() {
    const nd = $('nick-display');
    const ni = $('nick-input');
    const fp = $('full-fp');

    if (nd) nd.textContent = this.id.nickname;
    if (ni) ni.value = this.id.nickname;
    if (fp) fp.textContent = this.id.fingerprint;

    try {
      const rows = await loadPeers();
      for (const p of rows) {
        this.peers.set(p.fingerprint, {
          nick: p.nickname || p.shortId || p.fingerprint.slice(0, 8),
          connected: false,
        });
      }
    } catch (e) {
      this._log('peer history load failed: ' + (e?.message || e), true);
    }

    try {
      this.sessions.set(MESH_ID, await loadMessages(MESH_ID));
    } catch {
      this.sessions.set(MESH_ID, []);
    }

    this._bind();
    this._wire();
    await this._openSession(MESH_ID);

    if (this.id.isNewUser) {
      this._status('welcome - tap your name to set nickname', 'info');
      setTimeout(() => this._triggerNickEdit(), 400);
    } else {
      this._status('connecting...', 'info');
    }
  }

  _bind() {
    const row = $('identity-row');
    const disp = $('nick-display');
    const inp = $('nick-input');

    if (row && disp && inp) {
      row.addEventListener('click', () => this._triggerNickEdit());

      const save = async () => {
        if (!inp.classList.contains('visible')) return;
        const saved = await this.id.saveNickname(inp.value).catch(() => this.id.nickname);
        this.id.nickname = saved;
        disp.textContent = saved;
        inp.value = saved;
        disp.classList.remove('hidden');
        inp.classList.remove('visible');

        this.net.getConnectedPeers().forEach((fp) => {
          this.net.sendCtrl(fp, { type: 'nick-update', nick: saved });
        });

        this._status(`name saved: ${saved}`, 'ok', 2500);
      };

      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault();
          save();
        }
      });

      inp.addEventListener('blur', save);
    }

    const mi = $('msg-input');
    const sendBtn = $('send-btn');
    if (mi) {
      mi.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this._send();
        }
      });
      mi.addEventListener('input', () => {
        mi.style.height = 'auto';
        mi.style.height = `${Math.min(mi.scrollHeight, 140)}px`;
      });
    }
    sendBtn?.addEventListener('click', () => this._send());

    const plusBtn = $('file-btn');
    const plusFiles = $('plus-files');
    const plusTtt = $('plus-ttt');
    const fileInput = $('__file-input');

    plusBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._togglePlusMenu();
    });

    plusFiles?.addEventListener('click', () => {
      this._togglePlusMenu(false);
      if (!this.active) {
        this._sys('select a session first', true);
        return;
      }
      if (this.active !== MESH_ID && !this.net.isReady(this.active)) {
        this._sys('peer offline', true);
        return;
      }
      fileInput?.click();
    });

    plusTtt?.addEventListener('click', () => {
      this._togglePlusMenu(false);
      this._startTtt();
    });

    fileInput?.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      files.forEach((f) => this._queueFile(f));
      fileInput.value = '';
    });

    document.addEventListener('click', (e) => {
      const menu = $('plus-menu');
      if (!menu || !this._plusMenuOpen) return;
      if (menu.contains(e.target) || e.target === plusBtn) return;
      this._togglePlusMenu(false);
    });

    const chatArea = $('chat-area');
    if (chatArea) {
      chatArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        chatArea.classList.add('drag-over');
      });

      chatArea.addEventListener('dragleave', () => {
        chatArea.classList.remove('drag-over');
      });

      chatArea.addEventListener('drop', (e) => {
        e.preventDefault();
        chatArea.classList.remove('drag-over');
        if (!this.active) {
          this._sys('select a session first', true);
          return;
        }
        Array.from(e.dataTransfer?.files || []).forEach((f) => this._queueFile(f));
      });
    }

    $('back-btn')?.addEventListener('click', () => this._showSidebar());
    $('reset-btn')?.addEventListener('click', () => this._confirmReset());
  }

  _triggerNickEdit() {
    const disp = $('nick-display');
    const inp = $('nick-input');
    if (!disp || !inp || inp.classList.contains('visible')) return;
    disp.classList.add('hidden');
    inp.classList.add('visible');
    inp.focus();
    inp.select();
  }

  _togglePlusMenu(force) {
    const menu = $('plus-menu');
    if (!menu) return;
    const next = typeof force === 'boolean' ? force : !this._plusMenuOpen;
    this._plusMenuOpen = next;
    menu.classList.toggle('visible', next);
  }

  _wire() {
    const n = this.net;
    n.onPeerConnected = (fp, nick) => this._onConnect(fp, nick);
    n.onPeerDisconnected = (fp) => this._onDisconnect(fp);
    n.onMessage = (fp, msg) => {
      try {
        this._dispatch(fp, msg);
      } catch (e) {
        this._log('message dispatch error: ' + (e?.message || e), true);
      }
    };
    n.onBinaryChunk = (fp, buf) => {
      try { this.ft.handleBinary(fp, buf); } catch {}
    };
    n.onLog = (t, isErr) => this._log(t, isErr);
    n.onSignalingConnected = () => this._status('signaling connected', 'ok', 3000);
    n.onSignalingDisconnected = () => this._status('signaling lost - reconnecting', 'warn');
  }

  _onConnect(fp, nick) {
    const prev = this.peers.get(fp);
    const name = nick || prev?.nick || fp.slice(0, 8);

    this.peers.set(fp, { nick: name, connected: true });
    savePeer({ fingerprint: fp, shortId: fp.slice(0, 8), nickname: name }).catch(() => {});

    if (!this.sessions.has(fp)) {
      loadMessages(fp)
        .then((rows) => {
          this.sessions.set(fp, rows);
          this._renderPeers();
          if (this.active === fp) this._renderMsgs();
        })
        .catch(() => this.sessions.set(fp, []));
    }

    this._renderPeers();
    if (this.active === fp) this._renderHeader();
    this._status(`${name} joined`, 'ok', 2600);
  }

  _onDisconnect(fp) {
    const p = this.peers.get(fp);
    if (p) p.connected = false;

    if (this.call?.fp === fp) this._endCallLocal(false);
    if (this.meshCall) this._removeMeshPeer(fp);

    this._renderPeers();
    if (this.active === fp) this._renderHeader();

    this._status(`${p?.nick || fp.slice(0, 8)} disconnected`, 'warn', 4000);
  }

  _dispatch(fp, msg) {
    const { type } = msg || {};
    if (!type) return;

    if (type === 'hello') {
      const p = this.peers.get(fp);
      if (p && msg.nick) {
        p.nick = msg.nick;
        this._renderPeers();
      }
      return;
    }

    if (type === 'nick-update') {
      const p = this.peers.get(fp);
      if (p && msg.nick) {
        p.nick = msg.nick;
        savePeer({ fingerprint: fp, shortId: fp.slice(0, 8), nickname: msg.nick }).catch(() => {});
        this._renderPeers();
        if (this.active === fp) this._renderHeader();
      }
      return;
    }

    if (type === 'chat') {
      msg.mesh ? this._recvMesh(fp, msg) : this._recv1to1(fp, msg);
      return;
    }

    if (type === 'file-meta') {
      const sessionId = msg.mesh ? MESH_ID : fp;
      const nick = this.peers.get(fp)?.nick || fp.slice(0, 8);

      if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, []);
      const rows = this.sessions.get(sessionId);

      const exists = rows.some((m) => m.type === 'file' && m.fileId === msg.fileId && !m.own);
      if (!exists) {
        const fileMsg = {
          id: `${sessionId}:${msg.fileId}:recv`,
          sessionId,
          from: fp,
          fromNick: nick,
          own: false,
          type: 'file',
          fileId: msg.fileId,
          name: msg.name || 'file',
          size: Number(msg.size || 0),
          mimeType: msg.mimeType || 'application/octet-stream',
          ts: Date.now(),
          status: 'receiving',
        };

        rows.push(fileMsg);
        saveMessage(fileMsg).catch(() => {});

        if (this.active === sessionId) this._appendFileCard(fileMsg);
        else {
          this.unread.set(sessionId, (this.unread.get(sessionId) || 0) + 1);
          this._renderPeers();
        }
      }

      this.ft.handleCtrl(fp, msg);
      this._status(`receiving ${msg.name || 'file'} from ${nick}`, 'info', 2800);
      return;
    }

    if (type === 'file-end' || type === 'file-abort') {
      this.ft.handleCtrl(fp, msg);
      return;
    }

    if (type === 'call-invite') {
      if (msg.meshCall) this._onMeshCallInvite(fp, msg);
      else this._onCallInvite(fp, msg);
      return;
    }

    if (type === 'call-accept') {
      if (msg.meshCall) this._onMeshCallAccepted(fp);
      else this._onCallAccepted(fp);
      return;
    }

    if (type === 'call-decline') {
      this._onCallDeclined(fp);
      return;
    }

    if (type === 'offer-reneg') {
      this._onOfferReneg(fp, msg);
      return;
    }

    if (type === 'call-end') {
      this._onCallEnd(fp);
      return;
    }

    if (type === 'permission-denied') {
      const nick = this.peers.get(fp)?.nick || fp.slice(0, 8);
      this._status(`${nick}: ${msg.media || 'microphone'} permission denied`, 'err', 7000);
      if (this.call?.fp === fp) this._endCallLocal(false);
      this._hideCallIncoming();
      return;
    }

    if (type === 'ttt') {
      this._onTtt(fp, msg);
    }
  }

  _recv1to1(fp, ev) {
    if (!ev.text) return;
    const msg = {
      id: `${fp}:${ev.id || crypto.randomUUID()}`,
      sessionId: fp,
      from: fp,
      fromNick: ev.nick || this.peers.get(fp)?.nick || fp.slice(0, 8),
      text: String(ev.text),
      ts: Number(ev.ts || Date.now()),
      type: 'text',
      own: false,
    };

    if (!this.sessions.has(fp)) this.sessions.set(fp, []);
    this.sessions.get(fp).push(msg);
    saveMessage(msg).catch(() => {});

    if (this.active !== fp) {
      this.unread.set(fp, (this.unread.get(fp) || 0) + 1);
      this._renderPeers();
    } else {
      this._appendMsg(msg);
    }
  }

  _recvMesh(fp, ev) {
    if (!ev.text || this.meshBlocked.has(fp)) return;
    const msg = {
      id: `${MESH_ID}:${ev.id || crypto.randomUUID()}`,
      sessionId: MESH_ID,
      from: fp,
      fromNick: ev.nick || this.peers.get(fp)?.nick || fp.slice(0, 8),
      text: String(ev.text),
      ts: Number(ev.ts || Date.now()),
      type: 'text',
      own: false,
    };

    if (!this.sessions.has(MESH_ID)) this.sessions.set(MESH_ID, []);
    this.sessions.get(MESH_ID).push(msg);
    saveMessage(msg).catch(() => {});

    if (this.active !== MESH_ID) {
      this.unread.set(MESH_ID, (this.unread.get(MESH_ID) || 0) + 1);
      this._renderPeers();
    } else {
      this._appendMsg(msg);
    }
  }

  _send() {
    const inp = $('msg-input');
    const text = inp?.value?.trim();
    if (!text || !this.active) return;

    const id = crypto.randomUUID();
    const ts = Date.now();

    if (this.active === MESH_ID) {
      const fps = this.net.getConnectedPeers().filter((fp) => !this.meshBlocked.has(fp));
      if (!fps.length) {
        this._sys('no peers in mesh', true);
        return;
      }

      fps.forEach((fp) => {
        this.net.sendCtrl(fp, {
          type: 'chat',
          mesh: true,
          id,
          nick: this.id.nickname,
          text,
          ts,
        });
      });

      const msg = {
        id: `${MESH_ID}:${id}`,
        sessionId: MESH_ID,
        from: this.id.fingerprint,
        fromNick: this.id.nickname,
        text,
        ts,
        type: 'text',
        own: true,
      };

      if (!this.sessions.has(MESH_ID)) this.sessions.set(MESH_ID, []);
      this.sessions.get(MESH_ID).push(msg);
      saveMessage(msg).catch(() => {});
      this._appendMsg(msg);
      this._renderPeers();
    } else {
      const fp = this.active;
      if (!this.net.isReady(fp)) {
        this._sys('peer offline - not sent', true);
        return;
      }

      const ok = this.net.sendCtrl(fp, {
        type: 'chat',
        id,
        nick: this.id.nickname,
        text,
        ts,
      });
      if (!ok) {
        this._sys('send failed', true);
        return;
      }

      const msg = {
        id: `${fp}:${id}`,
        sessionId: fp,
        from: this.id.fingerprint,
        fromNick: this.id.nickname,
        text,
        ts,
        type: 'text',
        own: true,
      };

      if (!this.sessions.has(fp)) this.sessions.set(fp, []);
      this.sessions.get(fp).push(msg);
      saveMessage(msg).catch(() => {});
      this._appendMsg(msg);
      this._renderPeers();
    }

    if (inp) {
      inp.value = '';
      inp.style.height = 'auto';
    }
  }

  _queueFile(file) {
    if (!file || !this.active) return;

    const sessionId = this.active;
    const peers = sessionId === MESH_ID
      ? this.net.getConnectedPeers().filter((fp) => !this.meshBlocked.has(fp))
      : (this.net.isReady(sessionId) ? [sessionId] : []);

    if (!peers.length) {
      this._sys(sessionId === MESH_ID ? 'no peers in mesh' : 'peer offline', true);
      return;
    }

    if (sessionId === MESH_ID) {
      const base = crypto.randomUUID();

      peers.forEach((fp) => {
        const fileId = `${base}:${fp.slice(0, 8)}`;
        const msg = {
          id: `${MESH_ID}:${fileId}:send`,
          sessionId: MESH_ID,
          from: this.id.fingerprint,
          fromNick: this.id.nickname,
          type: 'file',
          fileId,
          name: file.name,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          ts: Date.now(),
          own: true,
          status: 'sending',
          targetFp: fp,
        };

        if (!this.sessions.has(MESH_ID)) this.sessions.set(MESH_ID, []);
        this.sessions.get(MESH_ID).push(msg);
        saveMessage(msg).catch(() => {});
        if (this.active === MESH_ID) this._appendFileCard(msg);

        this.ft.send(file, fp, fileId, { mesh: true });
      });

      this._status(`sending ${file.name} to ${peers.length} mesh peer(s)...`, 'info');
      this._renderPeers();
      return;
    }

    const fp = sessionId;
    const fileId = crypto.randomUUID();
    const msg = {
      id: `${fp}:${fileId}:send`,
      sessionId: fp,
      from: this.id.fingerprint,
      fromNick: this.id.nickname,
      type: 'file',
      fileId,
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      ts: Date.now(),
      own: true,
      status: 'sending',
    };

    if (!this.sessions.has(fp)) this.sessions.set(fp, []);
    this.sessions.get(fp).push(msg);
    saveMessage(msg).catch(() => {});
    if (this.active === fp) this._appendFileCard(msg);

    this.ft.send(file, fp, fileId, { mesh: false });
    this._status(`sending ${file.name}...`, 'info');
    this._renderPeers();
  }

  _fileCards(fileId) {
    const safe = String(fileId).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return document.querySelectorAll(`[data-fcid="${safe}"]`);
  }

  _onFileProg(fileId, payload) {
    const p = payload || {};
    const pct = Math.max(0, Math.min(1, Number(p.pct || 0)));
    const meta = `${(pct * 100).toFixed(1)}% - ${fmtBytes(p.bytes || 0)} / ${fmtBytes(p.totalBytes || 0)} - ${fmtRate(p.bps || 0)} - ETA ${fmtEta(p.etaSec)}`;

    this._fileCards(fileId).forEach((card) => {
      const fill = card.querySelector('.prog-fill');
      if (fill) fill.style.width = `${(pct * 100).toFixed(1)}%`;

      const line = card.querySelector('.prog-meta');
      if (line) line.textContent = meta;
    });
  }

  _onFileReady(file) {
    this._fileUrls.set(file.fileId, file);

    for (const rows of this.sessions.values()) {
      const msg = rows.find((m) => m.fileId === file.fileId);
      if (msg) {
        msg.status = 'done';
        saveMessage(msg).catch(() => {});
        break;
      }
    }

    const cards = this._fileCards(file.fileId);
    cards.forEach((card) => {
      card.querySelector('.prog-track')?.remove();
      card.querySelector('.prog-meta')?.remove();

      if (!card.querySelector('.dl-btn')) {
        const a = document.createElement('a');
        a.className = 'dl-btn';
        a.href = file.url;
        a.download = file.name || 'file';
        a.textContent = `download ${file.name || 'file'}`;
        card.appendChild(a);
      }
    });

    if (!cards.length) {
      const nick = this.peers.get(file.from)?.nick || file.from?.slice(0, 8) || 'peer';
      this._status(`${file.name} received from ${nick}`, 'ok', 6000);
    } else {
      this._status(`${file.name} received`, 'ok', 3000);
    }
  }

  _onFileErr(fileId, errMsg) {
    for (const rows of this.sessions.values()) {
      const msg = rows.find((m) => m.fileId === fileId);
      if (msg) {
        msg.status = 'error';
        msg.error = errMsg;
        saveMessage(msg).catch(() => {});
      }
    }

    this._fileCards(fileId).forEach((card) => {
      card.querySelector('.prog-track')?.remove();
      const line = card.querySelector('.prog-meta');
      if (line) line.textContent = `error: ${errMsg}`;
      else {
        const d = document.createElement('div');
        d.className = 'prog-meta';
        d.textContent = `error: ${errMsg}`;
        card.appendChild(d);
      }
    });

    this._status('file error: ' + errMsg, 'err', 5000);
  }

  async _startCall(fp, callType) {
    if (!this.net.isReady(fp)) {
      this._sys('peer offline', true);
      return;
    }
    if (this.call) {
      this._sys('already in a call', true);
      return;
    }
    if (this.meshCall) {
      this._sys('end mesh call first', true);
      return;
    }

    const video = callType === 'stream';
    this._status(`getting ${video ? 'camera/mic' : 'mic'}...`, 'info');

    let localStream;
    try {
      localStream = await this.net.getLocalStream(video);
    } catch (e) {
      this._handleMediaError(e, fp);
      return;
    }

    this.call = {
      fp,
      type: callType,
      phase: 'inviting',
      localStream,
      remoteStream: null,
      muted: false,
      camOff: false,
      inviteSdp: null,
      inviteTimer: setTimeout(() => this._onCallTimeout(fp), 45_000),
    };

    this.net.sendCtrl(fp, { type: 'call-invite', callType, nick: this.id.nickname });
    this._status(`${callType} - calling ${this.net.getPeerNick(fp)}...`, 'info');
    this._renderHeader();
    this._renderCallPanel();
  }

  _onCallAccepted(fp) {
    if (!this.call || this.call.fp !== fp || this.call.phase !== 'inviting') return;

    clearTimeout(this.call.inviteTimer);
    this.call.phase = 'connecting';
    this._status(`${this.call.type} - connecting with ${this.net.getPeerNick(fp)}...`, 'info');

    this.net.offerWithStream(fp, this.call.localStream)
      .then(() => this._attachRemote1to1(fp))
      .catch((e) => {
        this._status('call setup failed: ' + (e?.message || e), 'err', 5000);
        this._endCallLocal(true);
      });

    this._renderCallPanel();
  }

  _onCallDeclined(fp) {
    if (!this.call || this.call.fp !== fp) return;

    clearTimeout(this.call.inviteTimer);
    this.call.localStream?.getTracks().forEach((t) => t.stop());
    this.call = null;

    this._renderCallPanel();
    this._renderHeader();
    this._maybeStopStatsLoop();

    this._status(`${this.net.getPeerNick(fp)} declined`, 'warn', 4500);
  }

  _onCallTimeout(fp) {
    if (!this.call || this.call.fp !== fp) return;

    this.call.localStream?.getTracks().forEach((t) => t.stop());
    this.call = null;

    this._renderCallPanel();
    this._renderHeader();
    this._maybeStopStatsLoop();

    this._status('no answer - timed out', 'warn', 4500);
  }

  _onCallInvite(fp, msg) {
    if (this.call && this.call.fp !== fp) {
      this.net.sendCtrl(fp, { type: 'call-decline' });
      return;
    }
    if (this.meshCall) {
      this.net.sendCtrl(fp, { type: 'call-decline' });
      return;
    }

    if (!this.call) {
      this.call = {
        fp,
        type: msg.callType === 'stream' ? 'stream' : 'walkie',
        phase: 'ringing',
        localStream: null,
        remoteStream: null,
        muted: false,
        camOff: false,
        inviteSdp: null,
        inviteTimer: null,
      };
    }

    this._showCallIncoming(fp, this.call.type, msg.nick, false);
  }

  async _acceptCall(fp) {
    if (!this.call || this.call.fp !== fp || this.call.phase !== 'ringing') return;
    this._hideCallIncoming();

    const video = this.call.type === 'stream';
    this._status(`getting ${video ? 'camera/mic' : 'mic'}...`, 'info');

    let localStream;
    try {
      localStream = await this.net.getLocalStream(video);
    } catch (e) {
      this.net.sendCtrl(fp, {
        type: 'permission-denied',
        media: video ? 'camera/mic' : 'microphone',
      });
      this.call = null;
      this._handleMediaError(e, fp);
      return;
    }

    this.call.localStream = localStream;
    this.call.phase = 'connecting';
    this.net.sendCtrl(fp, { type: 'call-accept' });
    this._status(`${this.call.type} - waiting for offer...`, 'info');

    if (this.call.inviteSdp) {
      this.net.answerWithStream(fp, this.call.inviteSdp, this.call.localStream)
        .then(() => this._attachRemote1to1(fp))
        .catch((e) => {
          this._status('call answer failed: ' + (e?.message || e), 'err', 5000);
          this._endCallLocal(true);
        });
      this.call.inviteSdp = null;
    }

    this._openSession(fp);
    this._renderCallPanel();
  }

  _declineCall(fp) {
    this._hideCallIncoming();
    if (this.call?.fp === fp) {
      this.call.localStream?.getTracks().forEach((t) => t.stop());
      this.call = null;
    }
    this.net.sendCtrl(fp, { type: 'call-decline' });
    this._renderCallPanel();
    this._renderHeader();
    this._maybeStopStatsLoop();
  }

  _onOfferReneg(fp, msg) {
    if (msg.meshCall) {
      this._onMeshOffer(fp, msg);
      return;
    }

    if (this.call?.fp === fp && (this.call.phase === 'connecting' || this.call.phase === 'ringing')) {
      if (!this.call.localStream) {
        this.call.inviteSdp = msg.sdp;
        return;
      }

      this.net.answerWithStream(fp, msg.sdp, this.call.localStream)
        .then(() => this._attachRemote1to1(fp))
        .catch((e) => {
          this._status('call answer failed: ' + (e?.message || e), 'err', 5000);
          this._endCallLocal(true);
        });
    }
  }

  _onMeshOffer(fp, msg) {
    if (!this.meshCall) {
      this._onMeshCallInvite(fp, msg);
      return;
    }

    if (!this.meshCall.localStream) {
      this.meshCall.pendingSdps.set(fp, msg.sdp);
      this._showCallIncoming(fp, this.meshCall.type, this.net.getPeerNick(fp), true);
      return;
    }

    this.net.answerWithStream(fp, msg.sdp, this.meshCall.localStream, {
      meshCall: true,
      callType: this.meshCall.type,
    }).then(() => {
      this._attachMeshRemote(fp);
      this.meshCall.phase = 'active';
      this._renderMeshCallPanel();
      this._renderHeader();
      this._startStatsLoop();
    }).catch((e) => {
      this._status('mesh answer failed: ' + (e?.message || e), 'err', 5000);
    });
  }

  _attachRemote1to1(fp) {
    this.net.setRemoteStreamHandler(fp, (stream) => {
      if (!stream) return;

      this._audioEl.srcObject = stream;
      this._audioEl.play().catch(() => {});

      if (this.call?.fp === fp) {
        this.call.remoteStream = stream;
        this.call.phase = 'active';
        this._renderCallPanel();
        this._renderHeader();
        this._status(`${this.call.type} active`, 'ok');
        this._startStatsLoop();
      }
    });
  }

  _onCallEnd(fp) {
    if (this.call?.fp === fp) {
      this._endCallLocal(false);
      this._status('call ended', 'info', 2200);
    }

    if (this.meshCall) {
      this._removeMeshPeer(fp);
    }

    this._hideCallIncoming();
  }

  async _endCallLocal(sendEnd = true) {
    if (!this.call) return;
    const fp = this.call.fp;

    clearTimeout(this.call.inviteTimer);
    this.call.localStream?.getTracks().forEach((t) => t.stop());
    this.call = null;

    if (sendEnd) await this.net.stopMedia(fp).catch(() => {});
    this._audioEl.srcObject = null;

    this._renderCallPanel();
    this._renderHeader();
    this._maybeStopStatsLoop();
  }

  _handleMediaError(e, fp) {
    const msg = String(e?.message || e);

    if (msg.startsWith('permission-denied:')) {
      const media = msg.split(':')[1];
      this._status(`${media} permission denied - allow in browser settings`, 'err', 7000);
      if (fp) this.net.sendCtrl(fp, { type: 'permission-denied', media });
    } else if (msg.startsWith('no-device:')) {
      this._status(`no ${msg.split(':')[1]} found`, 'err', 5000);
    } else {
      this._status(`media error: ${msg}`, 'err', 5000);
    }

    if (this.call) {
      this.call.localStream?.getTracks().forEach((t) => t.stop());
      this.call = null;
      this._renderCallPanel();
      this._renderHeader();
    }
  }

  async _startMeshCall(callType) {
    if (this.call) {
      this._sys('end 1:1 call first', true);
      return;
    }
    if (this.meshCall?.phase === 'active') {
      this._endMeshCall();
      return;
    }

    const fps = this.net.getConnectedPeers().filter((fp) => !this.meshBlocked.has(fp));
    if (!fps.length) {
      this._sys('no peers in mesh', true);
      return;
    }

    const video = callType === 'stream';
    this._status(`getting ${video ? 'camera/mic' : 'mic'} for mesh ${callType}...`, 'info');

    let localStream;
    try {
      localStream = await this.net.getLocalStream(video);
    } catch (e) {
      this._handleMediaError(e, null);
      return;
    }

    this.meshCall = {
      type: callType,
      phase: 'connecting',
      localStream,
      remoteStreams: new Map(),
      audioEls: new Map(),
      pendingSdps: new Map(),
      invited: new Set(fps),
      accepted: new Set(),
      muted: false,
      camOff: false,
    };

    fps.forEach((fp) => {
      this.net.sendCtrl(fp, {
        type: 'call-invite',
        callType,
        nick: this.id.nickname,
        meshCall: true,
      });
      this._attachMeshRemote(fp);
    });

    this._status(`mesh ${callType} invite sent to ${fps.length} peer(s)`, 'info', 3200);
    this._renderMeshCallPanel();
    this._renderHeader();
  }

  _onMeshCallInvite(fp, msg) {
    if (this.call) {
      this.net.sendCtrl(fp, { type: 'call-decline' });
      return;
    }

    const type = msg.callType === 'stream' ? 'stream' : 'walkie';

    if (!this.meshCall) {
      this.meshCall = {
        type,
        phase: 'ringing',
        localStream: null,
        remoteStreams: new Map(),
        audioEls: new Map(),
        pendingSdps: new Map(),
        invited: new Set([fp]),
        accepted: new Set(),
        muted: false,
        camOff: false,
      };
    }

    if (msg.sdp) this.meshCall.pendingSdps.set(fp, msg.sdp);
    this._showCallIncoming(fp, type, msg.nick, true);
  }

  async _acceptMeshCall(fp) {
    if (!this.meshCall) return;

    this._hideCallIncoming();
    const video = this.meshCall.type === 'stream';
    this._status(`getting ${video ? 'camera/mic' : 'mic'} for mesh...`, 'info');

    if (!this.meshCall.localStream) {
      try {
        this.meshCall.localStream = await this.net.getLocalStream(video);
      } catch (e) {
        this.net.sendCtrl(fp, {
          type: 'permission-denied',
          media: video ? 'camera/mic' : 'microphone',
        });
        this._handleMediaError(e, null);
        return;
      }
    }

    this.meshCall.phase = 'active';
    this.net.sendCtrl(fp, { type: 'call-accept', meshCall: true });
    this._attachMeshRemote(fp);

    const sdp = this.meshCall.pendingSdps.get(fp);
    if (sdp) {
      this.net.answerWithStream(fp, sdp, this.meshCall.localStream, {
        meshCall: true,
        callType: this.meshCall.type,
      }).catch((e) => this._status('mesh answer failed: ' + (e?.message || e), 'err', 5000));
      this.meshCall.pendingSdps.delete(fp);
    }

    this._renderMeshCallPanel();
    this._renderHeader();
    this._startStatsLoop();
    this._status(`mesh ${this.meshCall.type} active`, 'ok');
  }

  _declineMeshCall(fp) {
    this._hideCallIncoming();
    this.net.sendCtrl(fp, { type: 'call-decline' });

    if (this.meshCall?.remoteStreams.size === 0 && this.meshCall?.phase !== 'active') {
      this.meshCall = null;
      this._renderMeshCallPanel();
      this._renderHeader();
    }
  }

  _onMeshCallAccepted(fp) {
    if (!this.meshCall?.localStream) return;

    this.meshCall.accepted.add(fp);
    this.net.offerWithStream(fp, this.meshCall.localStream, {
      meshCall: true,
      callType: this.meshCall.type,
    }).catch((e) => this._status('mesh offer failed: ' + (e?.message || e), 'err', 5000));
  }

  _attachMeshRemote(fp) {
    this.net.setRemoteStreamHandler(fp, (stream) => {
      if (!stream || !this.meshCall) return;

      this.meshCall.remoteStreams.set(fp, stream);

      let el = this.meshCall.audioEls.get(fp);
      if (!el) {
        el = document.createElement('audio');
        el.autoplay = true;
        el.playsInline = true;
        el.style.display = 'none';
        document.body.appendChild(el);
        this.meshCall.audioEls.set(fp, el);
      }

      el.srcObject = stream;
      el.play().catch(() => {});

      this.meshCall.phase = 'active';
      this._renderMeshCallPanel();
      this._renderHeader();
      this._startStatsLoop();
    });
  }

  _removeMeshPeer(fp) {
    if (!this.meshCall) return;

    this.meshCall.remoteStreams.delete(fp);
    this.meshCall.pendingSdps.delete(fp);
    this.meshCall.invited.delete(fp);
    this.meshCall.accepted.delete(fp);

    const el = this.meshCall.audioEls.get(fp);
    if (el) {
      el.srcObject = null;
      try { el.remove(); } catch {}
      this.meshCall.audioEls.delete(fp);
    }

    if (this.meshCall.remoteStreams.size === 0 && this.meshCall.phase === 'active') {
      this._endMeshCall();
      return;
    }

    this._renderMeshCallPanel();
    this._renderHeader();
  }

  _endMeshCall() {
    if (!this.meshCall) return;

    this.meshCall.localStream?.getTracks().forEach((t) => t.stop());
    this.meshCall.audioEls.forEach((el) => {
      try {
        el.srcObject = null;
        el.remove();
      } catch {}
    });

    const peers = this.net.getConnectedPeers();
    peers.forEach((fp) => this.net.sendCtrl(fp, { type: 'call-end' }));
    peers.forEach((fp) => this.net.stopMedia(fp).catch(() => {}));

    this.meshCall = null;
    this._renderMeshCallPanel();
    this._renderHeader();
    this._maybeStopStatsLoop();
    this._status('mesh call ended', 'info', 2500);
  }

  _showCallIncoming(fp, callType, nick, isMesh = false) {
    const panel = $('call-incoming');
    if (!panel) return;

    const name = nick || this.net.getPeerNick(fp);
    const icon = callType === 'stream' ? 'video' : 'audio';

    panel.innerHTML = `
      <div class="ci-icon">${icon}</div>
      ${isMesh ? '<div class="ci-mesh">mesh</div>' : ''}
      <div class="ci-label">${esc(callType)}</div>
      <div class="ci-name">${esc(name)}</div>
      <div class="ci-sub">${isMesh ? 'invited you to mesh call' : 'wants to call you'}</div>
      <div class="ci-btns">
        <button class="ci-btn accept" id="ci-accept">accept</button>
        <button class="ci-btn decline" id="ci-decline">decline</button>
      </div>
    `;
    panel.classList.add('visible');

    $('ci-accept')?.addEventListener('click', () => {
      if (isMesh) this._acceptMeshCall(fp);
      else this._acceptCall(fp);
    });

    $('ci-decline')?.addEventListener('click', () => {
      if (isMesh) this._declineMeshCall(fp);
      else this._declineCall(fp);
    });
  }

  _hideCallIncoming() {
    $('call-incoming')?.classList.remove('visible');
  }

  _startTtt() {
    if (!this.active || this.active === MESH_ID) {
      this._sys('tic-tac-toe is 1:1 only', true);
      return;
    }

    const fp = this.active;
    if (!this.net.isReady(fp)) {
      this._sys('peer offline', true);
      return;
    }

    const state = {
      active: true,
      board: Array(9).fill(null),
      my: 'X',
      turn: 'X',
      winner: null,
      startedBy: this.id.nickname,
    };

    this.games.set(fp, state);
    this.net.sendCtrl(fp, { type: 'ttt', action: 'start', by: this.id.nickname, ts: Date.now() });
    this._renderGamePanel();
    this._status('tic-tac-toe started', 'ok', 2500);
  }

  _onTtt(fp, msg) {
    const action = msg.action;
    if (!action) return;

    if (action === 'start') {
      this.games.set(fp, {
        active: true,
        board: Array(9).fill(null),
        my: 'O',
        turn: 'X',
        winner: null,
        startedBy: msg.by || this.net.getPeerNick(fp),
      });

      if (this.active === fp) this._renderGamePanel();
      this._status(`tic-tac-toe started by ${this.net.getPeerNick(fp)}`, 'info', 3000);
      return;
    }

    const game = this.games.get(fp);
    if (!game || !game.active) return;

    if (action === 'move') {
      const idx = Number(msg.idx);
      const mark = msg.mark === 'O' ? 'O' : 'X';

      if (idx < 0 || idx > 8) return;
      if (game.winner || game.board[idx]) return;
      if (mark === game.my) return;
      if (mark !== game.turn) return;

      this._applyTttMove(game, idx, mark);
      if (this.active === fp) this._renderGamePanel();
      return;
    }

    if (action === 'reset') {
      this.games.set(fp, {
        ...game,
        board: Array(9).fill(null),
        turn: 'X',
        winner: null,
      });
      if (this.active === fp) this._renderGamePanel();
      this._status('tic-tac-toe reset', 'info', 1800);
    }
  }

  _tttClick(idx) {
    const fp = this.active;
    const game = this.games.get(fp);
    if (!game || !game.active || game.winner) return;
    if (game.turn !== game.my) return;
    if (game.board[idx]) return;

    this._applyTttMove(game, idx, game.my);
    this.net.sendCtrl(fp, { type: 'ttt', action: 'move', idx, mark: game.my, ts: Date.now() });
    this._renderGamePanel();
  }

  _resetTtt() {
    if (!this.active || this.active === MESH_ID) return;
    const fp = this.active;
    const game = this.games.get(fp);
    if (!game) return;

    this.games.set(fp, {
      ...game,
      board: Array(9).fill(null),
      turn: 'X',
      winner: null,
    });

    this.net.sendCtrl(fp, { type: 'ttt', action: 'reset', ts: Date.now() });
    this._renderGamePanel();
  }

  _applyTttMove(game, idx, mark) {
    game.board[idx] = mark;

    const winner = this._calcTttWinner(game.board);
    if (winner) {
      game.winner = winner;
      return;
    }

    if (game.board.every(Boolean)) {
      game.winner = 'draw';
      return;
    }

    game.turn = mark === 'X' ? 'O' : 'X';
  }

  _calcTttWinner(b) {
    const lines = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8],
      [0, 3, 6], [1, 4, 7], [2, 5, 8],
      [0, 4, 8], [2, 4, 6],
    ];

    for (const [a, c, d] of lines) {
      if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
    }
    return null;
  }

  _renderGamePanel() {
    const panel = $('game-panel');
    if (!panel) return;

    if (!this.active || this.active === MESH_ID) {
      panel.innerHTML = '';
      panel.classList.remove('visible');
      return;
    }

    const game = this.games.get(this.active);
    if (!game?.active) {
      panel.innerHTML = '';
      panel.classList.remove('visible');
      return;
    }

    const myTurn = game.turn === game.my;
    let status = `you: ${game.my} | turn: ${game.turn}`;
    if (game.winner === 'draw') status = 'draw';
    else if (game.winner) status = `${game.winner} won`;

    panel.innerHTML = `
      <div class="game-head">
        <div class="game-title">Tic-Tac-Toe</div>
        <button class="game-reset" id="ttt-reset">reset</button>
      </div>
      <div class="game-status">${esc(status)}${!game.winner ? (myTurn ? ' | your move' : ' | waiting') : ''}</div>
      <div class="ttt-grid">
        ${game.board.map((v, i) => `
          <button class="ttt-cell" data-i="${i}" ${v || game.winner || !myTurn ? 'disabled' : ''}>${v || ''}</button>
        `).join('')}
      </div>
    `;

    panel.classList.add('visible');

    $('ttt-reset')?.addEventListener('click', () => this._resetTtt());
    panel.querySelectorAll('.ttt-cell').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        this._tttClick(i);
      });
    });
  }

  _renderCallPanel() {
    const panel = $('call-panel');
    if (!panel) return;

    if (!this.call) {
      panel.innerHTML = '';
      panel.classList.remove('visible');
      return;
    }

    const { fp, type, phase, muted, camOff, localStream, remoteStream } = this.call;
    const peerName = this.net.getPeerNick(fp);
    const isStream = type === 'stream';

    panel.classList.add('visible');

    if (phase === 'inviting' || phase === 'connecting' || phase === 'ringing') {
      panel.innerHTML = `
        <div class="call-waiting">
          <div class="call-type-badge">${esc(type)}</div>
          <div class="call-state">${phase === 'inviting' ? `calling ${esc(peerName)}...` : 'connecting...'}</div>
          <div class="call-controls">
            <button class="call-btn end" id="cb-end">cancel</button>
          </div>
        </div>
      `;

      $('cb-end')?.addEventListener('click', () => {
        this.net.sendCtrl(fp, { type: 'call-end' });
        this._endCallLocal(false);
        this._status('cancelled', 'info', 1500);
      });
      return;
    }

    panel.innerHTML = `
      ${isStream
        ? `
        <div class="video-grid">
          <div class="video-wrap"><video id="vid-r" autoplay playsinline></video><div class="video-label">${esc(peerName)}</div></div>
          <div class="video-wrap local"><video id="vid-l" autoplay playsinline muted></video><div class="video-label">you</div></div>
        </div>
      `
        : `<div class="walkie-active">audio stream with ${esc(peerName)}</div>`
      }
      <div class="call-tech" id="call-tech">collecting link stats...</div>
      <div class="call-controls">
        <button class="call-btn ${muted ? 'muted' : ''}" id="cb-mute">${muted ? 'unmute' : 'mute'}</button>
        ${isStream ? `<button class="call-btn ${camOff ? 'muted' : ''}" id="cb-cam">${camOff ? 'camera off' : 'camera on'}</button>` : ''}
        <button class="call-btn end" id="cb-end">end</button>
      </div>
    `;

    const vr = $('vid-r');
    const vl = $('vid-l');
    if (vr && remoteStream) vr.srcObject = remoteStream;
    if (vl && localStream) vl.srcObject = localStream;

    $('cb-mute')?.addEventListener('click', () => {
      if (!this.call) return;
      this.call.muted = !this.call.muted;
      this.call.localStream?.getAudioTracks().forEach((t) => (t.enabled = !this.call.muted));
      this._renderCallPanel();
    });

    $('cb-cam')?.addEventListener('click', () => {
      if (!this.call) return;
      this.call.camOff = !this.call.camOff;
      this.call.localStream?.getVideoTracks().forEach((t) => (t.enabled = !this.call.camOff));
      this._renderCallPanel();
    });

    $('cb-end')?.addEventListener('click', () => {
      this.net.sendCtrl(fp, { type: 'call-end' });
      this._endCallLocal(false);
      this._status('call ended', 'info', 1500);
    });
  }

  _renderMeshCallPanel() {
    const panel = $('mesh-call-panel');
    if (!panel) return;

    if (!this.meshCall) {
      panel.innerHTML = '';
      panel.classList.remove('visible');
      return;
    }

    const { type, phase, muted, camOff, localStream, remoteStreams } = this.meshCall;
    const isStream = type === 'stream';

    panel.classList.add('visible');

    if (phase === 'connecting' || phase === 'ringing') {
      panel.innerHTML = `
        <div class="call-waiting">
          <div class="call-type-badge">mesh ${esc(type)}</div>
          <div class="call-state">inviting peers...</div>
          <div class="call-controls">
            <button class="call-btn end" id="mcb-end">end mesh call</button>
          </div>
        </div>
      `;
      $('mcb-end')?.addEventListener('click', () => this._endMeshCall());
      return;
    }

    let mediaHtml = '';
    if (isStream) {
      mediaHtml = `<div class="video-grid">
        <div class="video-wrap local"><video id="mvid-l" autoplay playsinline muted></video><div class="video-label">you</div></div>
        ${[...remoteStreams.entries()].map(([fp]) => {
          const key = fp.slice(0, 8);
          return `<div class="video-wrap"><video id="mvid-${key}" autoplay playsinline></video><div class="video-label">${esc(this.net.getPeerNick(fp))}</div></div>`;
        }).join('')}
      </div>`;
    } else {
      const names = [...remoteStreams.keys()].map((fp) => this.net.getPeerNick(fp)).join(', ') || 'waiting for peers';
      mediaHtml = `<div class="walkie-active">mesh audio: ${esc(names)}</div>`;
    }

    panel.innerHTML = `
      ${mediaHtml}
      <div class="call-tech" id="mesh-tech">collecting mesh stats...</div>
      <div class="call-controls">
        <button class="call-btn ${muted ? 'muted' : ''}" id="mcb-mute">${muted ? 'unmute' : 'mute'}</button>
        ${isStream ? `<button class="call-btn ${camOff ? 'muted' : ''}" id="mcb-cam">${camOff ? 'camera off' : 'camera on'}</button>` : ''}
        <button class="call-btn end" id="mcb-end">end mesh</button>
      </div>
    `;

    const vl = $('mvid-l');
    if (vl && localStream) vl.srcObject = localStream;

    remoteStreams.forEach((stream, fp) => {
      const v = $(`mvid-${fp.slice(0, 8)}`);
      if (v) v.srcObject = stream;
    });

    $('mcb-mute')?.addEventListener('click', () => {
      if (!this.meshCall) return;
      this.meshCall.muted = !this.meshCall.muted;
      this.meshCall.localStream?.getAudioTracks().forEach((t) => (t.enabled = !this.meshCall.muted));
      this._renderMeshCallPanel();
    });

    $('mcb-cam')?.addEventListener('click', () => {
      if (!this.meshCall) return;
      this.meshCall.camOff = !this.meshCall.camOff;
      this.meshCall.localStream?.getVideoTracks().forEach((t) => (t.enabled = !this.meshCall.camOff));
      this._renderMeshCallPanel();
    });

    $('mcb-end')?.addEventListener('click', () => this._endMeshCall());
  }

  async _openSession(fp) {
    if (!fp) return;
    this.active = fp;
    this.unread.delete(fp);

    if (!this.sessions.has(fp)) {
      try {
        this.sessions.set(fp, await loadMessages(fp));
      } catch {
        this.sessions.set(fp, []);
      }
    }

    this._renderHeader();
    this._renderGamePanel();
    this._renderMsgs();
    this._renderPeers();
    this._renderCallPanel();
    this._renderMeshCallPanel();

    $('input-bar')?.classList.add('visible');
    $('msg-input')?.focus();
    this._showChat();
  }

  async _clearChat(fp) {
    const label = fp === MESH_ID
      ? 'mesh chat'
      : `chat with ${this.net.getPeerNick(fp)}`;

    if (!confirm(`Clear ${label}?`)) return;

    try {
      await clearMessages(fp);
      this.sessions.set(fp, []);
      this._renderMsgs();
      this._renderPeers();
      this._status('chat cleared', 'ok', 2000);
    } catch (e) {
      this._status('clear failed: ' + (e?.message || e), 'err', 3500);
    }
  }

  async _confirmReset() {
    if (!confirm('Reset Turquoise?\n\n- New identity\n- Clear messages and peers\n- Clear caches\n\nThis cannot be undone.')) return;

    this._status('resetting...', 'warn');
    try {
      await clearAllData();
      await resetIdentity();
      this._revokeAllFileUrls();

      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (e) {
      console.warn('reset failed:', e);
    }

    location.reload();
  }

  _toggleMesh(fp, e) {
    e.stopPropagation();

    if (this.meshBlocked.has(fp)) this.meshBlocked.delete(fp);
    else this.meshBlocked.add(fp);

    this._renderPeers();
    this._status(
      `${this.net.getPeerNick(fp)} ${this.meshBlocked.has(fp) ? 'removed from' : 'added to'} mesh`,
      'info',
      1600
    );
  }

  _renderPeers() {
    const list = $('peer-list');
    if (!list) return;

    const meshOnline = this.net.getConnectedPeers().length > 0;
    const meshUnread = this.unread.get(MESH_ID) || 0;
    const meshMsgs = this.sessions.get(MESH_ID) || [];
    const meshLast = meshMsgs[meshMsgs.length - 1];
    const meshPrev = meshLast
      ? (meshLast.type === 'file' ? `file: ${meshLast.name || 'file'}` : String(meshLast.text || '').slice(0, 36))
      : 'group broadcast';
    const meshBadge = this.meshCall
      ? `<div class="peer-badge call-badge">${this.meshCall.type}</div>`
      : (meshUnread ? `<div class="peer-badge">${meshUnread > 9 ? '9+' : meshUnread}</div>` : '');

    const meshTile = `
      <div class="peer-tile mesh-tile ${this.active === MESH_ID ? 'active' : ''}" data-fp="${MESH_ID}">
        <div class="mesh-icon ${meshOnline ? 'online' : ''}">M</div>
        <div class="peer-info">
          <div class="peer-nick">mesh</div>
          <div class="peer-preview">${esc(meshPrev)}</div>
        </div>
        ${meshBadge}
      </div>
    `;

    const rows = [...this.peers.entries()].sort(([, a], [, b]) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return String(a.nick || '').localeCompare(String(b.nick || ''));
    });

    const peersHtml = rows.map(([fp, p]) => {
      const active = fp === this.active ? 'active' : '';
      const unread = this.unread.get(fp) || 0;
      const msgs = this.sessions.get(fp) || [];
      const last = msgs[msgs.length - 1];
      const prev = last
        ? (last.type === 'file' ? `file: ${last.name || 'file'}` : String(last.text || '').slice(0, 36))
        : '';
      const inCall = this.call?.fp === fp && this.call.phase === 'active';
      const badge = inCall
        ? `<div class="peer-badge call-badge">${this.call.type}</div>`
        : (unread ? `<div class="peer-badge">${unread > 9 ? '9+' : unread}</div>` : '');

      return `
        <div class="peer-tile ${active}" data-fp="${fp}">
          <div class="peer-dot ${p.connected ? 'online' : 'offline'}"></div>
          <div class="peer-info">
            <div class="peer-nick">${esc(p.nick || fp.slice(0, 8))}</div>
            ${prev ? `<div class="peer-preview">${esc(prev)}</div>` : ''}
          </div>
          <button class="mesh-toggle ${this.meshBlocked.has(fp) ? 'blocked' : ''}" data-fp="${fp}" title="toggle mesh">M</button>
          ${badge}
        </div>
      `;
    }).join('');

    list.innerHTML = meshTile + (rows.length ? peersHtml : '<div id="no-peers">waiting for peers...</div>');

    list.querySelectorAll('.peer-tile').forEach((el) => {
      el.addEventListener('click', () => {
        const fp = el.dataset.fp;
        if (fp) this._openSession(fp);
      });
    });

    list.querySelectorAll('.mesh-toggle').forEach((el) => {
      el.addEventListener('click', (e) => {
        const fp = el.dataset.fp;
        if (fp) this._toggleMesh(fp, e);
      });
    });
  }

  _renderHeader() {
    const h = $('chat-header');
    if (!h) return;

    const fp = this.active;

    if (fp === MESH_ID) {
      const connected = this.net.getConnectedPeers().length;
      const active = this.meshCall?.phase === 'active';

      h.innerHTML = `
        <button id="back-btn" class="back-btn">back</button>
        <div class="mesh-icon-hdr">M</div>
        <div class="chat-peer-info">
          <div class="chat-peer-name">mesh</div>
          <div class="chat-peer-fp">${connected} peer(s) connected</div>
        </div>
        <div class="chat-actions">
          <button class="action-btn ${active && this.meshCall?.type === 'walkie' ? 'active-call' : ''}" id="hbtn-mwalkie" title="mesh audio">audio</button>
          <button class="action-btn ${active && this.meshCall?.type === 'stream' ? 'active-call' : ''}" id="hbtn-mstream" title="mesh video">video</button>
          <button class="action-btn danger" id="hbtn-clear" title="clear mesh">clear</button>
        </div>
      `;

      $('back-btn')?.addEventListener('click', () => this._showSidebar());
      $('hbtn-mwalkie')?.addEventListener('click', () => {
        if (this.meshCall?.phase === 'active') this._endMeshCall();
        else this._startMeshCall('walkie');
      });
      $('hbtn-mstream')?.addEventListener('click', () => {
        if (this.meshCall?.phase === 'active') this._endMeshCall();
        else this._startMeshCall('stream');
      });
      $('hbtn-clear')?.addEventListener('click', () => this._clearChat(MESH_ID));
      return;
    }

    const p = fp ? this.peers.get(fp) : null;
    if (!fp || !p) {
      h.innerHTML = `
        <button id="back-btn" class="back-btn">back</button>
        <span id="chat-placeholder">select a peer</span>
      `;
      $('back-btn')?.addEventListener('click', () => this._showSidebar());
      return;
    }

    const inCall = this.call?.fp === fp && this.call.phase === 'active';
    h.innerHTML = `
      <button id="back-btn" class="back-btn">back</button>
      <div class="peer-dot ${p.connected ? 'online' : 'offline'}"></div>
      <div class="chat-peer-info">
        <div class="chat-peer-name">${esc(p.nick || fp.slice(0, 8))}</div>
        <div class="chat-peer-fp">${fp}</div>
      </div>
      <div class="chat-actions">
        <button class="action-btn ${inCall && this.call?.type === 'walkie' ? 'active-call' : ''}" id="hbtn-walkie" title="audio">audio</button>
        <button class="action-btn ${inCall && this.call?.type === 'stream' ? 'active-call' : ''}" id="hbtn-stream" title="video">video</button>
        <button class="action-btn danger" id="hbtn-clear" title="clear chat">clear</button>
      </div>
    `;

    $('back-btn')?.addEventListener('click', () => this._showSidebar());
    $('hbtn-walkie')?.addEventListener('click', () => {
      if (inCall) {
        this.net.sendCtrl(fp, { type: 'call-end' });
        this._endCallLocal(false);
      } else this._startCall(fp, 'walkie');
    });
    $('hbtn-stream')?.addEventListener('click', () => {
      if (inCall) {
        this.net.sendCtrl(fp, { type: 'call-end' });
        this._endCallLocal(false);
      } else this._startCall(fp, 'stream');
    });
    $('hbtn-clear')?.addEventListener('click', () => this._clearChat(fp));
  }

  _renderMsgs() {
    const box = $('messages');
    if (!box) return;
    box.innerHTML = '';

    const rows = this.sessions.get(this.active) || [];
    if (!rows.length) {
      box.innerHTML = `<div class="sys-msg">${this.active === MESH_ID ? 'mesh chat - broadcast to connected peers' : 'no messages yet'}</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    rows.forEach((m) => {
      if (m.type === 'text') frag.appendChild(this._msgEl(m));
      if (m.type === 'file') frag.appendChild(this._fileCardEl(m));
    });

    box.appendChild(frag);
    this._scroll();
  }

  _appendMsg(msg) {
    const box = $('messages');
    if (!box) return;
    const empty = box.querySelector('.sys-msg');
    if (empty && box.children.length === 1) empty.remove();
    box.appendChild(this._msgEl(msg));
    this._scroll();
  }

  _appendFileCard(msg) {
    const box = $('messages');
    if (!box || !msg?.fileId) return;

    const exists = this._fileCards(msg.fileId);
    if (exists.length) return;

    const empty = box.querySelector('.sys-msg');
    if (empty && box.children.length === 1) empty.remove();

    box.appendChild(this._fileCardEl(msg));
    this._scroll();
  }

  _msgEl(msg) {
    const d = document.createElement('div');
    d.className = `msg ${msg.own ? 'own' : 'peer'}`;

    const time = new Date(msg.ts || Date.now()).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });

    d.innerHTML = `
      <div class="meta">${msg.own ? 'you' : esc(msg.fromNick || '?')} - ${time}</div>
      <div class="bubble">${esc(msg.text || '')}</div>
    `;
    return d;
  }

  _fileCardEl(msg) {
    const w = document.createElement('div');
    w.className = `msg ${msg.own ? 'own' : 'peer'}`;

    const time = new Date(msg.ts || Date.now()).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });

    const ready = this._fileUrls.get(msg.fileId);

    let inner = `
      <div class="file-name">${esc(msg.name || 'file')}</div>
      <div class="file-size">${fmtBytes(msg.size || 0)}</div>
    `;

    if (ready && !msg.own) {
      inner += `<a class="dl-btn" href="${ready.url}" download="${esc(msg.name || 'file')}">download ${esc(msg.name || 'file')}</a>`;
    } else if (msg.status === 'error') {
      inner += `<div class="prog-meta">error: ${esc(msg.error || 'transfer failed')}</div>`;
    } else if (msg.status === 'done') {
      inner += `<div class="prog-meta">done</div>`;
    } else {
      inner += `
        <div class="prog-track"><div class="prog-fill" style="width:0%"></div></div>
        <div class="prog-meta">0.0% - 0 B / 0 B - -- B/s - ETA --</div>
      `;
    }

    w.innerHTML = `
      <div class="meta">${msg.own ? 'you' : esc(msg.fromNick || '?')} - ${time}</div>
      <div class="file-card" data-fcid="${esc(msg.fileId)}">${inner}</div>
    `;

    return w;
  }

  _showChat() {
    $('sidebar')?.classList.add('slide-left');
    $('chat-area')?.classList.add('slide-in');
  }

  _showSidebar() {
    $('sidebar')?.classList.remove('slide-left');
    $('chat-area')?.classList.remove('slide-in');
  }

  _startStatsLoop() {
    if (this._statsTimer) return;
    this._statsTimer = setInterval(() => {
      this._updateStats().catch(() => {});
    }, 1000);
  }

  _maybeStopStatsLoop() {
    if (this.call || this.meshCall) return;
    if (!this._statsTimer) return;
    clearInterval(this._statsTimer);
    this._statsTimer = null;
  }

  async _updateStats() {
    if (this.call?.phase === 'active') {
      const stats = await this.net.getPeerStats(this.call.fp);
      const el = $('call-tech');
      if (el) el.textContent = this._fmtCallStats(stats, this.call.type === 'stream');
      return;
    }

    if (this.meshCall?.phase === 'active') {
      const lines = [];
      for (const fp of this.meshCall.remoteStreams.keys()) {
        const st = await this.net.getPeerStats(fp);
        lines.push(`${this.net.getPeerNick(fp)}: ${this._fmtCallStats(st, this.meshCall.type === 'stream')}`);
      }
      const el = $('mesh-tech');
      if (el) el.textContent = lines.length ? lines.join(' | ') : 'waiting for mesh media stats...';
      return;
    }
  }

  _fmtCallStats(st, withVideo) {
    if (!st) return 'stats unavailable';

    const parts = [];
    parts.push(`rtt ${st.connection.rttMs ? st.connection.rttMs.toFixed(0) : '--'}ms`);
    parts.push(`audio up ${st.audio.outKbps.toFixed(1)}kbps`);
    parts.push(`audio down ${st.audio.inKbps.toFixed(1)}kbps`);
    if (st.audio.jitterMs != null) parts.push(`jitter ${st.audio.jitterMs.toFixed(1)}ms`);
    parts.push(`audio loss ${st.audio.lost}`);

    if (withVideo) {
      parts.push(`video up ${st.video.outKbps.toFixed(1)}kbps`);
      parts.push(`video down ${st.video.inKbps.toFixed(1)}kbps`);
      if (st.video.width && st.video.height) parts.push(`${st.video.width}x${st.video.height}`);
      if (st.video.fps) parts.push(`${st.video.fps.toFixed(0)}fps`);
      parts.push(`video loss ${st.video.lost}`);
    }

    if (st.connection.local || st.connection.remote) {
      parts.push(`path ${st.connection.local || '?'} -> ${st.connection.remote || '?'}`);
    }

    return parts.join(' | ');
  }

  _status(text, type = 'info', duration = 0) {
    const bar = $('status-bar');
    if (!bar) return;

    clearTimeout(this._statusTimer);
    bar.textContent = text;
    bar.className = `s-${type}`;

    if (duration) {
      this._statusTimer = setTimeout(() => {
        bar.className = '';
      }, duration);
    }
  }

  _scroll() {
    const box = $('messages');
    if (box) box.scrollTop = box.scrollHeight;
  }

  _sys(text, isErr = false) {
    const box = $('messages');
    if (!box) return;

    const d = document.createElement('div');
    d.className = `sys-msg${isErr ? ' err' : ''}`;
    d.textContent = text;
    box.appendChild(d);
    this._scroll();

    setTimeout(() => {
      try { d.remove(); } catch {}
    }, 5000);
  }

  _log(text, isErr = false) {
    const log = $('net-log');
    if (!log) return;

    const d = document.createElement('div');
    d.className = `entry${isErr ? ' err' : ''}`;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;

    while (log.children.length > 120) {
      log.removeChild(log.firstChild);
    }
  }

  _revokeFileUrl(fileId) {
    const f = this._fileUrls.get(fileId);
    if (!f?.url) return;
    try { URL.revokeObjectURL(f.url); } catch {}
    this._fileUrls.delete(fileId);
  }

  _revokeAllFileUrls() {
    for (const fileId of this._fileUrls.keys()) {
      this._revokeFileUrl(fileId);
    }
  }
}
