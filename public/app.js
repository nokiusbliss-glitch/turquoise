/**
 * app.js — Turquoise v12
 *
 * Phase 2 changes over v11:
 *
 *   1. Tic-Tac-Toe: tqapps.js v6 fix propagates — no app.js change needed.
 *
 *   2. File cancel:
 *      - _queueFile: records which peer fps are receiving each fileId in
 *        _fileOwners (Map<fileId, {fps, own}>). Needed for circle transfers
 *        where one fileId is sent to N peers.
 *      - _cancelFile(msg): calls ft.cancelSend / ft.cancelRecv appropriately.
 *      - _fileCardEl / _appendFileCard: render a × cancel button on
 *        in-progress file cards; wired to _cancelFile via data-fcid.
 *      - _onFileErr: removes cancel button from errored cards.
 *
 *   3. Folder UX:
 *      - _folderCardEl: shows a compact file tree (nested paths) when the
 *        folder message carries a `manifest`. On receive completion the tree
 *        is expanded with per-file download links + zip/all buttons.
 *      - _onFolderReady: uses the new `download(fileId)` function from
 *        folder.js v2, renders a toggle-able file tree.
 *      - folder.js v2 no longer fetches blob URLs for ZIP — uses stored
 *        blobs directly, so downloadZip works even minutes after receipt.
 *
 *   4. Video call UI:
 *      - _renderCallPanel: video grid uses full available height. Local
 *        video rendered as a draggable PIP overlay instead of a grid item,
 *        with proper safe-area positioning. Controls row uses min-height 48px
 *        touch targets. Stats bar sits above controls.
 *      - Camera toggle: marks the local video as cam-off visually with an
 *        overlay and disables the track (sends black frames). True track
 *        replacement requires webrtc.js getSender API; kept as enabled-flag
 *        for now but the UI now clearly shows the off state with an overlay.
 *      - _renderCircleCallPanel: cam toggle button added for stream calls.
 *      - Both panels: cam-off state renders a black overlay on the local
 *        video tile so the user knows the camera is muted.
 *
 *   5. Other hardening (no changes needed from Phase 1 already covering these):
 *      - webrtc.js v2 heartbeat / reconnect: transparent to app.js.
 */

import {
  saveMessage, loadMessages, loadAllMessages,
  clearMessages, clearAllData,
  savePeer, loadPeers,
  restoreMessages, restorePeers,
} from './messages.js';
import { resetIdentity, importIdentityData } from './identity.js';
import { FileTransfer }  from './files.js';
import { FolderTransfer } from './folder.js';
import { TicTacToe, VoiceMemo } from './tqapps.js';

const $ = id => document.getElementById(id);
const esc = s => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = b => {
  if (!b || b < 1)          return '0 B';
  if (b < 1_024)            return b + ' B';
  if (b < 1_048_576)        return (b / 1_024).toFixed(1)      + ' KB';
  if (b < 1_073_741_824)    return (b / 1_048_576).toFixed(1)  + ' MB';
  return (b / 1_073_741_824).toFixed(2) + ' GB';
};
const fmtSpd = s => {
  if (!s || s < 1)          return '—';
  if (s < 1_024)            return s.toFixed(0) + ' B/s';
  if (s < 1_048_576)        return (s / 1_024).toFixed(1) + ' KB/s';
  return (s / 1_048_576).toFixed(2) + ' MB/s';
};
const fmtEta = s => {
  if (!s || s <= 0 || !isFinite(s)) return '—';
  return s < 60 ? Math.ceil(s) + 's' : Math.floor(s / 60) + 'm' + Math.ceil(s % 60) + 's';
};

const CIRCLE_ID      = 'circle';
const BLOB_URL_TTL_MS = 60_000;

export class TurquoiseApp {
  constructor(identity, network) {
    this.id  = identity;
    this.net = network;

    this.peers         = new Map();
    this.sessions      = new Map();
    this.active        = null;
    this.unread        = new Map();
    this.circleBlocked = new Set();

    this.call       = null;
    this.circleCall = null;

    this._fileUrls  = new Map();   // fileId → {url, blob, name, from, mimeType}
    // fileId → { fps: string[], own: boolean } — for cancel routing
    this._fileOwners = new Map();

    this._memo = null;

    this._audioEl = Object.assign(document.createElement('audio'), {
      autoplay: true, playsInline: true,
    });
    this._audioEl.style.display = 'none';
    document.body.appendChild(this._audioEl);

    this._statsTimer = null;
    this.games = new Map();

    // ── File transfer ──────────────────────────────────────────────────────
    this.ft = new FileTransfer(
      (fp, msg) => network.sendCtrl(fp, msg),
      (fp, buf) => network.sendBinary(fp, buf),
      (fp)      => network.waitForBuffer(fp),
    );
    this.ft.onProgress  = (id, pct, dir, fp, stats) => this._onFileProg(id, pct, stats);
    this.ft.onFileReady = (f)                        => this._onFileReady(f);
    this.ft.onError     = (id, msg)                  => this._onFileErr(id, msg);

    // ── Folder transfer ────────────────────────────────────────────────────
    this.folderTransfer = new FolderTransfer(
      this.ft,
      (fp, msg) => network.sendCtrl(fp, msg),
    );
    this.folderTransfer.onProgress    = (folderId, done, total, dir, fp) =>
      this._onFolderProg(folderId, done, total, dir, fp);
    this.folderTransfer.onFolderReady = (info) => this._onFolderReady(info);
    this.folderTransfer.onError       = (folderId, msg, fp) =>
      this._status('folder error: ' + msg, 'err', 5000);
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
          nick:      p.nickname || p.shortId || p.fingerprint.slice(0, 8),
          connected: false,
        });
      }
    } catch (e) { this._log('peer history load: ' + e.message, true); }

    try { this.sessions.set(CIRCLE_ID, await loadMessages(CIRCLE_ID)); }
    catch { this.sessions.set(CIRCLE_ID, []); }

    this._bind();
    this._wire();
    await this._openSession(CIRCLE_ID);

    if (this.id.isNewUser) {
      this._status('tap your name to set it', 'info');
      setTimeout(() => this._triggerNickEdit(), 500);
    } else {
      this._status('connecting…', 'info');
    }
  }

  // ── Bind UI ────────────────────────────────────────────────────────────────

  _bind() {
    const row = $('identity-row'), disp = $('nick-display'), inp = $('nick-input');
    if (row && disp && inp) {
      row.addEventListener('click', () => this._triggerNickEdit());
      const save = async () => {
        if (!inp.classList.contains('visible')) return;
        const saved = await this.id.saveNickname(inp.value).catch(() => this.id.nickname);
        this.id.nickname = saved;
        disp.textContent = saved; inp.value = saved;
        disp.classList.remove('hidden'); inp.classList.remove('visible');
        this.net.getConnectedPeers().forEach(fp =>
          this.net.sendCtrl(fp, { type: 'nick-update', nick: saved })
        );
        this._status('name: ' + saved, 'ok', 3000);
      };
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); save(); }
      });
      inp.addEventListener('blur', save);
    }

    const mi = $('msg-input'), sb = $('send-btn');
    if (mi) {
      mi.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._send(); }
      });
      mi.addEventListener('input', () => {
        mi.style.height = 'auto';
        mi.style.height = Math.min(mi.scrollHeight, 128) + 'px';
      });
    }
    sb?.addEventListener('click', () => this._send());

    $('plus-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      this._togglePlusMenu();
    });
    document.addEventListener('click', () => this._closePlusMenu());

    $('__file-input')?.addEventListener('change', e => {
      Array.from(e.target.files || []).forEach(f => this._queueFile(f));
      e.target.value = '';
    });

    $('__import-input')?.addEventListener('change', e => {
      const f = e.target.files?.[0];
      if (f) this._importState(f);
      e.target.value = '';
    });

    const ca = $('chat-area');
    if (ca) {
      ca.addEventListener('dragover',  e => { e.preventDefault(); ca.classList.add('drag-over'); });
      ca.addEventListener('dragleave', () => ca.classList.remove('drag-over'));
      ca.addEventListener('drop', e => {
        e.preventDefault(); ca.classList.remove('drag-over');
        if (!this.active) { this._sys('select a session first', true); return; }
        Array.from(e.dataTransfer?.files || []).forEach(f => this._queueFile(f));
      });
    }

    $('back-btn')?.addEventListener('click', () => this._showSidebar());
    $('reset-btn')?.addEventListener('click', () => this._confirmReset());
  }

  _triggerNickEdit() {
    const d = $('nick-display'), i = $('nick-input');
    if (!d || !i || i.classList.contains('visible')) return;
    d.classList.add('hidden'); i.classList.add('visible'); i.focus(); i.select();
  }

  _togglePlusMenu() {
    const m = $('plus-menu'); if (!m) return;
    const showing = m.classList.contains('visible');
    this._closePlusMenu();
    if (!showing) { this._buildPlusMenu(); m.classList.add('visible'); }
  }
  _closePlusMenu() { $('plus-menu')?.classList.remove('visible'); }

  _buildPlusMenu() {
    const menu = $('plus-menu'); if (!menu) return;
    const fp        = this.active;
    const isCircle  = fp === CIRCLE_ID;
    const peerOnline = !isCircle && this.net.isReady(fp || '');
    const anyOnline  = this.net.getConnectedPeers().length > 0;

    menu.innerHTML = `
      <div class="pm-item" id="pmi-file">📎  file</div>
      <div class="pm-item" id="pmi-folder">📁  folder</div>
      <div class="pm-item" id="pmi-memo">🎤  voice memo</div>
      <div class="pm-sep"></div>
      <div class="pm-label">◈ apps</div>
      <div class="pm-item${(!peerOnline || isCircle) ? ' pm-dim' : ''}" id="pmi-ttt">⊞  tic tac toe</div>
      <div class="pm-sep"></div>
      <div class="pm-label">session</div>
      <div class="pm-item pm-danger" id="pmi-export">⬇  export state</div>
      <div class="pm-item"           id="pmi-import">⬆  import state</div>`;

    const canSend = isCircle ? anyOnline : peerOnline;

    $('pmi-file')?.addEventListener('click', () => {
      this._closePlusMenu();
      if (!canSend) { this._sys('no peers available', true); return; }
      $('__file-input')?.click();
    });
    $('pmi-folder')?.addEventListener('click', () => {
      this._closePlusMenu();
      if (!canSend) { this._sys('no peers available', true); return; }
      this._sendFolder();
    });
    $('pmi-memo')?.addEventListener('click', () => {
      this._closePlusMenu();
      if (!canSend) { this._sys('no peers available', true); return; }
      this._startVoiceMemo();
    });
    $('pmi-ttt')?.addEventListener('click', () => {
      if (!isCircle && peerOnline) this._startGame(fp, 'ttt');
      else this._sys(isCircle ? 'games are 1:1 only' : 'peer offline', true);
    });
    $('pmi-export')?.addEventListener('click', () => { this._closePlusMenu(); this._exportState(); });
    $('pmi-import')?.addEventListener('click', () => { this._closePlusMenu(); $('__import-input')?.click(); });
  }

  // ── Wire network ───────────────────────────────────────────────────────────

  _wire() {
    const n = this.net;
    n.onPeerConnected         = (fp, nick) => this._onConnect(fp, nick);
    n.onPeerDisconnected      = (fp)       => this._onDisconnect(fp);
    n.onMessage               = (fp, msg)  => {
      try { this._dispatch(fp, msg); }
      catch (e) { this._log('dispatch error: ' + e.message, true); }
    };
    n.onBinaryChunk           = (fp, buf)  => {
      try { this.ft.handleBinary(fp, buf); }
      catch (e) { this._log('binary chunk: ' + e.message, true); }
    };
    n.onLog                   = (t, e)     => this._log(t, e);
    n.onSignalingConnected    = ()         => this._status('signaling ✓ — searching…', 'ok', 4000);
    n.onSignalingDisconnected = ()         => this._status('signaling lost — reconnecting…', 'warn');
  }

  _onConnect(fp, nick) {
    const ex   = this.peers.get(fp);
    const name = nick || ex?.nick || fp.slice(0, 8);
    this.peers.set(fp, { nick: name, connected: true });
    savePeer({ fingerprint: fp, shortId: fp.slice(0, 8), nickname: name }).catch(() => {});
    if (!this.sessions.has(fp)) {
      loadMessages(fp)
        .then(msgs => { this.sessions.set(fp, msgs); this._renderPeers(); if (this.active === fp) this._renderMsgs(); })
        .catch(() => this.sessions.set(fp, []));
    } else {
      this._renderPeers();
    }
    if (this.active === fp) this._renderHeader();
    this._status(name + ' joined', 'ok', 3000);
  }

  _onDisconnect(fp) {
    const p    = this.peers.get(fp);
    const name = p?.nick || fp.slice(0, 8);
    if (p) p.connected = false;
    if (this.call?.fp === fp)  this._endCallLocal(false);
    if (this.circleCall)       this._removeCirclePeer(fp);
    this.games.get(fp)?.destroy?.(); this.games.delete(fp);
    this._renderPeers();
    if (this.active === fp) this._renderHeader();
    this._status(name + ' disconnected', 'warn', 5000);
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
        p.nick = msg.nick;
        this._renderPeers();
        if (this.active === fp) this._renderHeader();
        savePeer({ fingerprint: fp, shortId: fp.slice(0, 8), nickname: msg.nick }).catch(() => {});
      }
      return;
    }

    if (type === 'chat') {
      msg.circle ? this._recvCircle(fp, msg) : this._recv1to1(fp, msg);
      return;
    }

    if (type === 'file-meta') {
      const sessionId = msg.circle ? CIRCLE_ID : fp;
      const nick      = this.peers.get(fp)?.nick || fp.slice(0, 8);
      const fileMsg   = {
        id: msg.fileId + '_recv', sessionId, from: fp, fromNick: nick, own: false,
        type: 'file', fileId: msg.fileId, name: msg.name || 'file', size: msg.size || 0,
        mimeType: msg.mimeType, ts: Date.now(), status: 'receiving',
      };
      if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, []);
      this.sessions.get(sessionId).push(fileMsg);
      if (this.active === sessionId) this._appendFileCard(fileMsg);
      else { this.unread.set(sessionId, (this.unread.get(sessionId) || 0) + 1); this._renderPeers(); }
      this.ft.handleCtrl(fp, msg);
      this._status('receiving ' + msg.name + ' from ' + nick + '…', 'info');
      return;
    }

    if (type === 'file-end' || type === 'file-abort') {
      this.ft.handleCtrl(fp, msg);
      return;
    }

    if (type === 'folder-manifest') {
      const sessionId = msg.circle ? CIRCLE_ID : fp;
      const nick      = this.peers.get(fp)?.nick || fp.slice(0, 8);
      this.folderTransfer.handleCtrl(fp, msg);
      const folderMsg = {
        id: msg.folderId + '_recv', sessionId, from: fp, fromNick: nick, own: false,
        type: 'folder', folderId: msg.folderId, name: msg.name || 'folder',
        totalSize: msg.totalSize || 0, fileCount: msg.files?.length || 0,
        manifest: msg.files || [],
        ts: Date.now(), status: 'receiving',
      };
      if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, []);
      this.sessions.get(sessionId).push(folderMsg);
      if (this.active === sessionId) this._appendFolderCard(folderMsg);
      else { this.unread.set(sessionId, (this.unread.get(sessionId) || 0) + 1); this._renderPeers(); }
      this._status(`receiving folder "${msg.name}" (${msg.files?.length || 0} files) from ${nick}…`, 'info');
      return;
    }

    if (type === 'call-invite')  { msg.circle ? this._onCircleCallInvite(fp, msg) : this._onCallInvite(fp, msg); return; }
    if (type === 'call-accept')  { msg.circle ? this._onCircleCallAccepted(fp)    : this._onCallAccepted(fp);    return; }
    if (type === 'call-decline') { msg.circle ? this._onCircleCallDeclined(fp)    : this._onCallDeclined(fp);    return; }
    if (type === 'offer-reneg')  { msg.circle ? this._onCircleOfferReneg(fp, msg) : this._onOfferReneg(fp, msg); return; }

    if (type === 'call-end') {
      if (this.circleCall) this._removeCirclePeer(fp);
      if (this.call?.fp === fp) { this._endCallLocal(false); this._status('call ended', 'info', 3000); }
      this._hideCallIncoming();
      return;
    }

    if (type === 'permission-denied') {
      const nick = this.peers.get(fp)?.nick || fp.slice(0, 8);
      this._status(nick + ': ' + (msg.media || 'mic') + ' permission denied', 'err', 8000);
      if (this.call?.fp === fp) this._endCallLocal(false);
      this._hideCallIncoming();
      return;
    }

    if (type === 'game') { this._dispatchGame(fp, msg); return; }
  }

  // ── Chat ──────────────────────────────────────────────────────────────────

  _recv1to1(fp, ev) {
    if (!ev.text) return;
    const msg = {
      id: ev.id || crypto.randomUUID(), sessionId: fp, from: fp,
      fromNick: ev.nick || this.peers.get(fp)?.nick || fp.slice(0, 8),
      text: String(ev.text), ts: ev.ts || Date.now(), type: 'text', own: false,
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

  _recvCircle(fp, ev) {
    if (!ev.text || this.circleBlocked.has(fp)) return;
    const msg = {
      id: ev.id || crypto.randomUUID(), sessionId: CIRCLE_ID, from: fp,
      fromNick: ev.nick || this.peers.get(fp)?.nick || fp.slice(0, 8),
      text: String(ev.text), ts: ev.ts || Date.now(), type: 'text', own: false,
    };
    if (!this.sessions.has(CIRCLE_ID)) this.sessions.set(CIRCLE_ID, []);
    this.sessions.get(CIRCLE_ID).push(msg);
    saveMessage(msg).catch(() => {});
    if (this.active !== CIRCLE_ID) {
      this.unread.set(CIRCLE_ID, (this.unread.get(CIRCLE_ID) || 0) + 1);
      this._renderPeers();
    } else {
      this._appendMsg(msg);
    }
  }

  _send() {
    const inp  = $('msg-input');
    const text = inp?.value?.trim();
    if (!text || !this.active) return;
    const id = crypto.randomUUID(), ts = Date.now();

    if (this.active === CIRCLE_ID) {
      const fps = this.net.getConnectedPeers().filter(fp => !this.circleBlocked.has(fp));
      if (!fps.length) { this._sys('no peers in circle', true); return; }
      fps.forEach(fp =>
        this.net.sendCtrl(fp, { type: 'chat', circle: true, id, nick: this.id.nickname, text, ts })
      );
      const msg = {
        id, sessionId: CIRCLE_ID, from: this.id.fingerprint,
        fromNick: this.id.nickname, text, ts, type: 'text', own: true,
      };
      if (!this.sessions.has(CIRCLE_ID)) this.sessions.set(CIRCLE_ID, []);
      this.sessions.get(CIRCLE_ID).push(msg);
      saveMessage(msg).catch(() => {});
      this._appendMsg(msg); this._renderPeers();
    } else {
      const fp = this.active;
      if (!this.net.isReady(fp)) { this._sys('peer offline — not sent', true); return; }
      if (!this.net.sendCtrl(fp, { type: 'chat', id, nick: this.id.nickname, text, ts })) {
        this._sys('send failed', true); return;
      }
      const msg = {
        id, sessionId: fp, from: this.id.fingerprint,
        fromNick: this.id.nickname, text, ts, type: 'text', own: true,
      };
      if (!this.sessions.has(fp)) this.sessions.set(fp, []);
      this.sessions.get(fp).push(msg);
      saveMessage(msg).catch(() => {});
      this._appendMsg(msg); this._renderPeers();
    }

    if (inp) { inp.value = ''; inp.style.height = 'auto'; }
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  _queueFile(file) {
    if (!file || !this.active) return;
    const sessionId = this.active;
    const isCircle  = sessionId === CIRCLE_ID;
    const peers = isCircle
      ? this.net.getConnectedPeers().filter(fp => !this.circleBlocked.has(fp))
      : (this.net.isReady(sessionId) ? [sessionId] : []);
    if (!peers.length) { this._sys(isCircle ? 'no peers in circle' : 'peer offline', true); return; }

    const fileId  = crypto.randomUUID();
    const fileMsg = {
      id: fileId + '_send', sessionId, from: this.id.fingerprint,
      fromNick: this.id.nickname, type: 'file', fileId,
      name: file.name, size: file.size, mimeType: file.type || 'application/octet-stream',
      ts: Date.now(), own: true, status: 'sending',
    };
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, []);
    this.sessions.get(sessionId).push(fileMsg);
    this._appendFileCard(fileMsg);
    this._status('sending ' + file.name + '…', 'info');

    // Track which peers are receiving this fileId (needed for circle cancel)
    this._fileOwners.set(fileId, { fps: [...peers], own: true });
    peers.forEach(fp => this.ft.send(file, fp, fileId));
  }

  /**
   * Cancel an in-progress file transfer (send or receive).
   * @param {object} msg - The session message object for this file
   */
  _cancelFile(msg) {
    const { fileId, own, from, sessionId } = msg;
    if (!fileId) return;

    if (own) {
      // Sending: cancel for each peer that's receiving
      const info = this._fileOwners.get(fileId);
      if (info) {
        info.fps.forEach(fp => this.ft.cancelSend(fileId, fp));
        this._fileOwners.delete(fileId);
      }
    } else {
      // Receiving: from is the sender's fp
      this.ft.cancelRecv(from, fileId);
    }
  }

  _onFileProg(fileId, pct, stats) {
    document.querySelectorAll(`[data-fcid="${fileId}"] .prog-fill`).forEach(el => {
      el.style.width = (pct * 100).toFixed(1) + '%';
    });
    document.querySelectorAll(`[data-fcid="${fileId}"] .file-stats`).forEach(el => {
      if (!stats) return;
      el.innerHTML = [
        `<span class="fs-pct">${(pct * 100).toFixed(1)}%</span>`,
        `<span class="fs-sep">·</span>`,
        `<span class="fs-bytes">${fmt(stats.bytesTransferred)} / ${fmt(stats.totalBytes)}</span>`,
        `<span class="fs-sep">·</span>`,
        `<span class="fs-spd">${fmtSpd(stats.speedBps)}</span>`,
        `<span class="fs-sep">·</span>`,
        `<span class="fs-eta">${fmtEta(stats.etaSec)}</span>`,
      ].join('');
    });
  }

  _onFileReady(f) {
    if (this.folderTransfer.claimFile(f)) return;

    this._fileUrls.set(f.fileId, f);
    setTimeout(() => {
      if (this._fileUrls.get(f.fileId) === f) URL.revokeObjectURL(f.url);
    }, BLOB_URL_TTL_MS);

    for (const msgs of this.sessions.values()) {
      const m = msgs.find(m => m.fileId === f.fileId);
      if (m) m.status = 'done';
    }
    this._fileOwners.delete(f.fileId);

    const cards = document.querySelectorAll(`[data-fcid="${f.fileId}"]`);
    cards.forEach(card => {
      card.querySelector('.prog-track')?.remove();
      card.querySelector('.file-stats')?.remove();
      card.querySelector('.file-cancel')?.remove(); // remove cancel btn when done

      if (!card.querySelector('.dl-btn, audio')) {
        const mime = f.mimeType || '';
        if (mime.startsWith('audio/')) {
          const au = document.createElement('audio');
          au.controls = true; au.src = f.url;
          au.style.cssText = 'max-width:100%;margin-top:4px;height:32px';
          card.appendChild(au);
          const a = document.createElement('a');
          a.className = 'dl-btn'; a.href = f.url;
          a.download = f.name || 'memo.webm';
          a.style.marginTop = '4px'; a.textContent = '↓ save';
          card.appendChild(a);
        } else {
          const a = document.createElement('a');
          a.className = 'dl-btn'; a.href = f.url;
          a.download = f.name || 'file';
          a.textContent = '↓ save';
          card.appendChild(a);
        }
      }
    });

    if (!cards.length) {
      const nick = this.peers.get(f.from)?.nick || f.from?.slice(0, 8) || '?';
      this._status(f.name + ' from ' + nick + ' — open chat to download', 'ok', 8000);
    } else {
      this._status(f.name + ' received', 'ok', 4000);
    }
  }

  _onFileErr(fileId, errMsg) {
    this._fileOwners.delete(fileId);
    for (const msgs of this.sessions.values()) {
      const m = msgs.find(m => m.fileId === fileId);
      if (m) { m.status = 'error'; m.error = errMsg; }
    }
    document.querySelectorAll(`[data-fcid="${fileId}"]`).forEach(card => {
      card.querySelector('.prog-track')?.remove();
      card.querySelector('.file-stats')?.remove();
      card.querySelector('.file-cancel')?.remove();
      const d = document.createElement('div');
      d.className = 'file-err'; d.textContent = '⚠ ' + errMsg;
      card.appendChild(d);
    });
    if (errMsg !== 'Cancelled') {
      this._status('file error: ' + errMsg, 'err', 5000);
    }
  }

  // ── Folder ────────────────────────────────────────────────────────────────

  async _sendFolder() {
    const sessionId = this.active;
    if (!sessionId) return;
    const isCircle = sessionId === CIRCLE_ID;
    const peers    = isCircle
      ? this.net.getConnectedPeers().filter(fp => !this.circleBlocked.has(fp))
      : (this.net.isReady(sessionId) ? [sessionId] : []);
    if (!peers.length) { this._sys(isCircle ? 'no peers in circle' : 'peer offline', true); return; }

    const folderId = crypto.randomUUID();
    let entries;
    try { entries = await FolderTransfer.pickFiles(); }
    catch (e) { this._sys('folder access failed: ' + e.message, true); return; }
    if (!entries?.length) return;

    const folderName = entries[0].relativePath.split('/')[0] || 'folder';
    let totalSize    = 0;
    const fileList   = entries.map((e, i) => {
      totalSize += e.file.size;
      return {
        fileId:       `${folderId}:${i}`,
        relativePath: e.relativePath,
        size:         e.file.size,
        mimeType:     e.file.type || 'application/octet-stream',
      };
    });

    const folderMsg = {
      id: folderId + '_send', sessionId, from: this.id.fingerprint,
      fromNick: this.id.nickname, type: 'folder', folderId,
      name: folderName, totalSize, fileCount: fileList.length,
      manifest: fileList,
      ts: Date.now(), own: true, status: 'sending',
    };
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, []);
    this.sessions.get(sessionId).push(folderMsg);
    this._appendFolderCard(folderMsg);
    this._status(`sending folder "${folderName}" (${fileList.length} files)…`, 'info');

    peers.forEach(fp => {
      this.net.sendCtrl(fp, {
        type: 'folder-manifest', folderId, name: folderName,
        totalSize, files: fileList,
        circle: isCircle || undefined,
      });
      entries.forEach((e, i) => this.ft.send(e.file, fp, fileList[i].fileId));
    });
  }

  _onFolderProg(folderId, done, total, dir, fp) {
    const card = document.querySelector(`[data-folderid="${folderId}"]`);
    if (!card) return;
    const pct = total > 0 ? done / total : 0;
    const fill = card.querySelector('.prog-fill');
    if (fill) fill.style.width = (pct * 100).toFixed(1) + '%';
    const label = card.querySelector('.folder-count');
    if (label) label.textContent = `${done} / ${total} files`;
  }

  _onFolderReady(info) {
    const { folderId, name, from, files, manifest, totalSize, downloadZip, downloadAll, download } = info;

    for (const msgs of this.sessions.values()) {
      const m = msgs.find(m => m.folderId === folderId);
      if (m) {
        m.status   = 'done';
        m.files    = files;    // enriched with urls/blobs
        m.manifest = manifest;
      }
    }

    const card = document.querySelector(`[data-folderid="${folderId}"]`);
    if (card) {
      card.querySelector('.prog-track')?.remove();
      card.querySelector('.folder-count')?.remove();

      if (!card.querySelector('.folder-dl')) {
        // File tree (collapsible list)
        const treeDiv = document.createElement('div');
        treeDiv.className   = 'folder-tree';
        treeDiv.style.cssText = 'margin:6px 0 4px;font-size:11px;max-height:120px;overflow-y:auto;';
        const tree = _buildFileTree(manifest || []);
        treeDiv.innerHTML = _renderFileTree(tree, download);
        card.appendChild(treeDiv);
        // Wire per-file download buttons
        treeDiv.querySelectorAll('[data-dl-fid]').forEach(btn => {
          btn.addEventListener('click', () => download(btn.dataset.dlFid));
        });

        // Action buttons row
        const btns = document.createElement('div');
        btns.className = 'folder-dl';
        btns.style.cssText = 'margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;';

        const zipBtn = document.createElement('button');
        zipBtn.className   = 'dl-btn';
        zipBtn.textContent = '↓ download .zip';
        zipBtn.style.cursor = 'pointer';
        zipBtn.addEventListener('click', () => {
          zipBtn.textContent = 'building zip…';
          zipBtn.disabled    = true;
          downloadZip().finally(() => {
            zipBtn.textContent = '↓ download .zip';
            zipBtn.disabled    = false;
          });
        });

        const allBtn = document.createElement('button');
        allBtn.className   = 'dl-btn';
        allBtn.textContent = '↓ save all files';
        allBtn.style.cursor = 'pointer';
        allBtn.addEventListener('click', () => downloadAll());

        btns.appendChild(zipBtn);
        btns.appendChild(allBtn);
        card.appendChild(btns);
      }
    }

    const nick = this.peers.get(from)?.nick || from?.slice(0, 8) || '?';
    this._status(`folder "${name}" from ${nick} ready — ${files.length} files, ${fmt(totalSize)}`, 'ok', 8000);
  }

  // ── Voice memo ─────────────────────────────────────────────────────────────

  _startVoiceMemo() {
    const panel = $('memo-panel'); if (!panel) return;
    if (this._memo) { this._memo.cancel(); this._memo = null; }
    panel.classList.add('visible');
    const memo = new VoiceMemo(
      (file) => {
        panel.classList.remove('visible'); panel.innerHTML = '';
        this._memo = null;
        this._queueFile(file);
        this._status('voice memo sent', 'ok', 3000);
      },
      () => {
        panel.classList.remove('visible'); panel.innerHTML = '';
        this._memo = null;
      }
    );
    this._memo = memo;
    memo.start(panel);
  }

  // ── 1:1 Call ───────────────────────────────────────────────────────────────

  async _startCall(fp, callType) {
    if (!this.net.isReady(fp)) { this._sys('peer offline', true); return; }
    if (this.call)             { this._sys('already in a call', true); return; }
    if (this.circleCall?.phase === 'active') { this._sys('end circle call first', true); return; }

    const peerName = this.peers.get(fp)?.nick || fp.slice(0, 8);
    const video    = callType === 'stream';
    this._status('getting ' + (video ? 'camera/mic' : 'mic') + '…', 'info');

    let s;
    try { s = await this.net.getLocalStream(video); }
    catch (e) { return this._handleMediaError(e, fp); }

    this.call = {
      fp, type: callType, phase: 'inviting',
      localStream: s, remoteStream: null,
      muted: false, camOff: false,
      inviteTimer: setTimeout(() => this._onCallTimeout(fp), 45_000),
    };
    this.net.sendCtrl(fp, { type: 'call-invite', callType, nick: this.id.nickname });
    this._status(callType + ' — calling ' + peerName + '…', 'info');
    this._renderHeader(); this._renderCallPanel();
  }

  _onCallInvite(fp, msg) {
    if (this.call && this.call.fp !== fp)      { this.net.sendCtrl(fp, { type: 'call-decline' }); return; }
    if (this.circleCall?.phase === 'active')   { this.net.sendCtrl(fp, { type: 'call-decline' }); return; }
    this.call = {
      fp, type: msg.callType === 'stream' ? 'stream' : 'walkie',
      phase: 'ringing', localStream: null, remoteStream: null, muted: false, camOff: false,
    };
    this._showCallIncoming(fp, msg.callType || 'walkie', msg.nick, false);
  }

  _onCallAccepted(fp) {
    if (!this.call || this.call.fp !== fp || this.call.phase !== 'inviting') return;
    clearTimeout(this.call.inviteTimer);
    this.call.phase = 'connecting';
    this._status(this.call.type + ' — connecting…', 'info');
    this.net.offerWithStream(fp, this.call.localStream, false)
      .then(() => this._attachRemote1to1(fp))
      .catch(e => { this._status('call setup failed: ' + e.message, 'err', 5000); this._endCallLocal(true); });
  }

  _onCallDeclined(fp) {
    if (!this.call || this.call.fp !== fp) return;
    clearTimeout(this.call.inviteTimer);
    this.call.localStream?.getTracks().forEach(t => t.stop());
    this.call = null;
    this._renderCallPanel(); this._renderHeader();
    this._status((this.peers.get(fp)?.nick || fp.slice(0, 8)) + ' declined', 'warn', 5000);
  }

  _onCallTimeout(fp) {
    if (!this.call || this.call.fp !== fp) return;
    this.call.localStream?.getTracks().forEach(t => t.stop());
    this.call = null;
    this._renderCallPanel(); this._renderHeader();
    this._status('no answer — timed out', 'warn', 5000);
  }

  async _acceptCall(fp) {
    if (!this.call || this.call.fp !== fp || this.call.phase !== 'ringing') return;
    this._hideCallIncoming();
    const video = this.call.type === 'stream';
    let s;
    try { s = await this.net.getLocalStream(video); }
    catch (e) {
      this.net.sendCtrl(fp, { type: 'permission-denied', media: video ? 'camera/mic' : 'microphone' });
      this.call = null;
      return this._handleMediaError(e, fp);
    }
    this.call.localStream = s;
    this.call.phase       = 'connecting';
    this.net.sendCtrl(fp, { type: 'call-accept' });
    this._status(this.call.type + ' — waiting for ' + (this.peers.get(fp)?.nick || fp.slice(0, 8)) + '…', 'info');
    await this._openSession(fp);
    this._renderCallPanel();
  }

  _declineCall(fp) {
    this._hideCallIncoming();
    if (this.call?.fp === fp) {
      this.call.localStream?.getTracks().forEach(t => t.stop());
      this.call = null;
    }
    this.net.sendCtrl(fp, { type: 'call-decline' });
    this._renderCallPanel();
  }

  _onOfferReneg(fp, msg) {
    if (this.call?.fp === fp && (this.call.phase === 'connecting' || this.call.phase === 'ringing')) {
      if (!this.call.localStream) { this.call.inviteSdp = msg.sdp; return; }
      this.net.answerWithStream(fp, msg.sdp, this.call.localStream)
        .then(() => this._attachRemote1to1(fp))
        .catch(e => { this._status('call answer failed: ' + e.message, 'err', 5000); this._endCallLocal(true); });
    }
  }

  _attachRemote1to1(fp) {
    this.net.setRemoteStreamHandler(fp, stream => {
      if (!stream) return;
      this._audioEl.srcObject = stream;
      if (typeof this._audioEl.setSinkId === 'function') this._audioEl.setSinkId('').catch(() => {});
      this._audioEl.play().catch(() => {});
      if (this.call?.fp === fp) {
        this.call.remoteStream = stream;
        this.call.phase        = 'active';
        this._renderCallPanel(); this._renderHeader();
        this._startStatsPolling(fp);
        this._status(this.call.type + ' on · ' + (this.peers.get(fp)?.nick || fp.slice(0, 8)), 'ok');
      }
    });
  }

  async _endCallLocal(sendEnd = true) {
    if (!this.call) return;
    const fp = this.call.fp;
    clearTimeout(this.call.inviteTimer);
    this.call.localStream?.getTracks().forEach(t => t.stop());
    this.call = null;
    this._stopStatsPolling();
    if (sendEnd) await this.net.stopMedia(fp).catch(() => {});
    this._audioEl.srcObject = null;
    this._renderCallPanel(); this._renderHeader();
  }

  // ── Circle Call ────────────────────────────────────────────────────────────

  async _startCircleCall(callType) {
    if (this.call)                           { this._sys('end 1:1 call first', true); return; }
    if (this.circleCall?.phase === 'active') { this._endCircleCall(); return; }
    const fps   = this.net.getConnectedPeers().filter(fp => !this.circleBlocked.has(fp));
    if (!fps.length)                         { this._sys('no peers in circle', true); return; }
    const video = callType === 'stream';
    this._status('getting ' + (video ? 'camera/mic' : 'mic') + ' for circle…', 'info');
    let s;
    try { s = await this.net.getLocalStream(video); }
    catch (e) { return this._handleMediaError(e, null); }
    this.circleCall = {
      type: callType, phase: 'connecting', localStream: s,
      remoteStreams: new Map(), audioEls: new Map(), muted: false, camOff: false,
    };
    fps.forEach(fp => {
      this.net.sendCtrl(fp, { type: 'call-invite', callType, nick: this.id.nickname, circle: true });
      this._attachCircleRemote(fp);
    });
    this._status('circle ' + callType + ' — inviting ' + fps.length + ' peer' + (fps.length > 1 ? 's' : '') + '…', 'info');
    this._renderCircleCallPanel(); this._renderHeader();
  }

  _onCircleCallInvite(fp, msg) {
    if (this.call) { this.net.sendCtrl(fp, { type: 'call-decline', circle: true }); return; }
    const callType = msg.callType === 'stream' ? 'stream' : 'walkie';
    if (!this.circleCall) {
      this.circleCall = {
        type: callType, phase: 'ringing', localStream: null,
        remoteStreams: new Map(), audioEls: new Map(), muted: false, camOff: false,
      };
    }
    const nick = msg.nick || this.peers.get(fp)?.nick || fp.slice(0, 8);
    this._showCallIncoming(fp, callType, nick, true);
  }

  async _acceptCircleCall(fp) {
    if (!this.circleCall) return;
    this._hideCallIncoming();
    const video = this.circleCall.type === 'stream';
    let s;
    if (this.circleCall.localStream) {
      s = this.circleCall.localStream;
    } else {
      try { s = await this.net.getLocalStream(video); }
      catch (e) {
        this.net.sendCtrl(fp, { type: 'permission-denied', media: video ? 'camera/mic' : 'microphone' });
        return this._handleMediaError(e, null);
      }
      this.circleCall.localStream = s;
    }
    this.circleCall.phase = 'active';
    this.net.sendCtrl(fp, { type: 'call-accept', circle: true });
    this._attachCircleRemote(fp);
    this._renderCircleCallPanel(); this._renderHeader();
    this._status('circle ' + this.circleCall.type + ' active', 'ok');
  }

  _declineCircleCall(fp) {
    this._hideCallIncoming();
    this.net.sendCtrl(fp, { type: 'call-decline', circle: true });
    if (this.circleCall?.remoteStreams.size === 0 && this.circleCall?.phase !== 'active') {
      this.circleCall = null; this._renderCircleCallPanel();
    }
  }

  _onCircleCallAccepted(fp) {
    if (!this.circleCall?.localStream) { this._log('circle accept but no local stream', true); return; }
    this.circleCall.phase = 'active';
    this.net.offerWithStream(fp, this.circleCall.localStream, true)
      .then(() => this._attachCircleRemote(fp))
      .catch(e => this._log('circle offer failed: ' + e.message, true));
    this._renderCircleCallPanel(); this._renderHeader();
  }

  _onCircleCallDeclined(fp) {
    const nick = this.peers.get(fp)?.nick || fp.slice(0, 8);
    this._status(nick + ' declined circle call', 'warn', 3000);
  }

  _onCircleOfferReneg(fp, msg) {
    if (!this.circleCall?.localStream) { this._log('circle offer-reneg but no local stream', true); return; }
    this.net.answerWithStream(fp, msg.sdp, this.circleCall.localStream)
      .then(() => this._attachCircleRemote(fp))
      .catch(e => this._status('circle answer failed: ' + e.message, 'err', 5000));
    this.circleCall.phase = 'active';
    this._renderCircleCallPanel(); this._renderHeader();
  }

  _attachCircleRemote(fp) {
    this.net.setRemoteStreamHandler(fp, stream => {
      if (!stream || !this.circleCall) return;
      this.circleCall.remoteStreams.set(fp, stream);
      let el = this.circleCall.audioEls.get(fp);
      if (!el) {
        el = Object.assign(document.createElement('audio'), { autoplay: true, playsInline: true });
        el.style.display = 'none';
        document.body.appendChild(el);
        this.circleCall.audioEls.set(fp, el);
      }
      el.srcObject = stream;
      if (typeof el.setSinkId === 'function') el.setSinkId('').catch(() => {});
      el.play().catch(() => {});
      this.circleCall.phase = 'active';
      this._renderCircleCallPanel(); this._renderHeader();
    });
  }

  _removeCirclePeer(fp) {
    if (!this.circleCall) return;
    this.circleCall.remoteStreams.delete(fp);
    const el = this.circleCall.audioEls.get(fp);
    if (el) { el.srcObject = null; try { el.remove(); } catch {} this.circleCall.audioEls.delete(fp); }
    if (this.circleCall.remoteStreams.size === 0) this._endCircleCall();
    else this._renderCircleCallPanel();
  }

  _endCircleCall() {
    if (!this.circleCall) return;
    this.circleCall.localStream?.getTracks().forEach(t => t.stop());
    this.circleCall.audioEls.forEach(el => { try { el.srcObject = null; el.remove(); } catch {} });
    this.net.getConnectedPeers().forEach(fp => {
      this.net.sendCtrl(fp, { type: 'call-end' });
      this.net.stopMedia(fp).catch(() => {});
    });
    this.circleCall = null;
    this._renderCircleCallPanel(); this._renderHeader();
    this._status('circle call ended', 'info', 3000);
  }

  // ── Games ──────────────────────────────────────────────────────────────────

  _startGame(fp, type) {
    if (!this.net.isReady(fp)) { this._sys('peer offline', true); return; }
    this._closePlusMenu();
    if (type === 'ttt') {
      this.games.get(fp)?.destroy?.();
      const g = new TicTacToe(
        fp, this.id.fingerprint,
        msg => this.net.sendCtrl(fp, { type: 'game', ...msg }),
        () => { this.games.delete(fp); this._renderGamePanel(fp); }
      );
      this.games.set(fp, g);
      this.net.sendCtrl(fp, { type: 'game', gameType: 'ttt', action: 'invite', nick: this.id.nickname });
      this._openSession(fp); this._renderGamePanel(fp);
      this._status('tic tac toe invite sent', 'info');
    }
  }

  _dispatchGame(fp, msg) {
    if (msg.gameType === 'ttt') {
      if (msg.action === 'invite') {
        const g = new TicTacToe(
          fp, this.id.fingerprint,
          m => this.net.sendCtrl(fp, { type: 'game', ...m }),
          () => { this.games.delete(fp); this._renderGamePanel(fp); }
        );
        this.games.set(fp, g); g.handleMsg(msg);
        this._openSession(fp); this._renderGamePanel(fp);
        this._status((this.peers.get(fp)?.nick || fp.slice(0, 8)) + ' challenges you to tic tac toe!', 'info', 5000);
        return;
      }
      const g = this.games.get(fp);
      if (g) { g.handleMsg(msg); if (this.active === fp) this._renderGamePanel(fp); }
    }
  }

  _renderGamePanel(fp) {
    const panel = $('game-panel'); if (!panel) return;
    const game  = this.games.get(fp);
    if (!game || this.active !== fp) {
      panel.innerHTML = ''; panel.classList.remove('visible'); return;
    }
    panel.classList.add('visible');
    game.render(panel);
  }

  // ── Incoming call overlay ──────────────────────────────────────────────────

  _showCallIncoming(fp, callType, nick, isCircle = false) {
    const panel = $('call-incoming'); if (!panel) return;
    const name  = nick || this.peers.get(fp)?.nick || fp.slice(0, 8);
    const icon  = callType === 'stream' ? '📷' : '🎙';
    panel.innerHTML = `
      <div class="ci-icon">${icon}</div>
      ${isCircle ? '<div class="ci-circle">◯ circle</div>' : ''}
      <div class="ci-label">${callType}</div>
      <div class="ci-name">${esc(name)}</div>
      <div class="ci-sub">${isCircle ? 'invited you to circle ' + callType : 'wants to ' + callType + ' with you'}</div>
      <div class="ci-btns">
        <div class="ci-btn accept"  id="ci-acc">accept</div>
        <div class="ci-btn decline" id="ci-dec">decline</div>
      </div>`;
    panel.classList.add('visible');
    $('ci-acc')?.addEventListener('click', () => isCircle ? this._acceptCircleCall(fp) : this._acceptCall(fp));
    $('ci-dec')?.addEventListener('click', () => isCircle ? this._declineCircleCall(fp) : this._declineCall(fp));
  }

  _hideCallIncoming() { $('call-incoming')?.classList.remove('visible'); }

  // ── Render: 1:1 call panel ─────────────────────────────────────────────────

  _renderCallPanel() {
    const panel = $('call-panel'); if (!panel) return;
    if (!this.call) { panel.innerHTML = ''; panel.classList.remove('visible'); return; }
    const { fp, type, phase, muted, camOff, localStream, remoteStream } = this.call;
    const peer = this.peers.get(fp)?.nick || fp.slice(0, 8);
    panel.classList.add('visible');

    if (phase === 'inviting' || phase === 'connecting') {
      const lbl = phase === 'inviting' ? 'calling ' + esc(peer) + '…' : 'connecting…';
      panel.innerHTML = `<div class="call-waiting">
        <div class="call-type-badge">${type === 'stream' ? '📷' : '🎙'} ${type}</div>
        <div class="call-state">${lbl}</div>
        <div class="call-controls">
          <div class="call-btn end" id="cb-end" style="min-height:48px;min-width:80px">✕ cancel</div>
        </div>
      </div>`;
      $('cb-end')?.addEventListener('click', () => {
        this.net.sendCtrl(fp, { type: 'call-end' });
        this._endCallLocal(false);
        this._status('cancelled', 'info', 2000);
      });
      return;
    }

    const isStream = type === 'stream';

    // Video layout: remote fills, local video is PIP overlay
    let videoHtml = '';
    if (isStream) {
      videoHtml = `
        <div class="video-grid" style="position:relative;flex:1;min-height:0;background:#000;overflow:hidden;border-radius:12px">
          <video id="vid-r" autoplay playsinline style="width:100%;height:100%;object-fit:cover;display:block"></video>
          <div class="video-label" style="position:absolute;bottom:8px;left:10px;font-size:11px;opacity:.75">${esc(peer)}</div>
          <div id="vid-stats" class="vid-stats-overlay" style="position:absolute;top:8px;left:10px;font-size:10px;opacity:.6"></div>
          <div id="local-pip" style="position:absolute;bottom:8px;right:8px;width:110px;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px #0006;cursor:pointer;touch-action:none">
            <video id="vid-l" autoplay playsinline muted style="width:100%;height:auto;display:block${camOff ? ';opacity:0' : ''}"></video>
            ${camOff ? '<div style="position:absolute;inset:0;background:#111;display:flex;align-items:center;justify-content:center;font-size:18px">📷<span style=\'font-size:10px;position:absolute;bottom:4px;left:0;right:0;text-align:center;color:#aaa\'>off</span></div>' : ''}
            <div class="video-label" style="position:absolute;bottom:2px;left:4px;font-size:9px;opacity:.7">${esc(this.id.nickname)}</div>
          </div>
        </div>`;
    } else {
      videoHtml = `<div class="walkie-active">
        <span class="wk-pulse">🎙</span> walkie · <span class="wk-peer">${esc(peer)}</span>
        <div class="waveform"><span></span><span></span><span></span><span></span><span></span></div>
      </div>`;
    }

    panel.innerHTML =
      videoHtml +
      `<div class="call-stats-bar" id="call-stats-bar" style="padding:4px 12px;font-size:10px;opacity:.6;text-align:center">connecting…</div>
       <div class="call-controls" style="display:flex;gap:8px;padding:8px 12px;justify-content:center;flex-wrap:wrap">
          <div class="call-btn${muted ? ' muted' : ''}" id="cb-mute" style="min-height:48px;min-width:64px;display:flex;align-items:center;justify-content:center;gap:4px">🎙 ${muted ? 'muted' : 'mic'}</div>
          ${isStream ? `<div class="call-btn${camOff ? ' muted' : ''}" id="cb-cam" style="min-height:48px;min-width:64px;display:flex;align-items:center;justify-content:center;gap:4px">📷 ${camOff ? 'off' : 'cam'}</div>
                        <div class="call-btn" id="cb-fs" style="min-height:48px;min-width:48px;display:flex;align-items:center;justify-content:center">⛶</div>` : ''}
          <div class="call-btn end" id="cb-end" style="min-height:48px;min-width:64px;display:flex;align-items:center;justify-content:center;gap:4px">✕ end</div>
       </div>`;

    const vr = $('vid-r'), vl = $('vid-l');
    if (vr && remoteStream) {
      vr.srcObject = remoteStream;
      vr.addEventListener('dblclick', () => {
        document.fullscreenElement
          ? document.exitFullscreen().catch(() => {})
          : vr.requestFullscreen?.().catch(() => {});
      });
    }
    if (vl && localStream) vl.srcObject = localStream;

    // Make local PIP draggable (within the grid)
    const pip = $('local-pip');
    if (pip) _makeDraggable(pip);

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
      const v = $('vid-r');
      if (v) document.fullscreenElement
        ? document.exitFullscreen().catch(() => {})
        : v.requestFullscreen?.().catch(() => {});
    });
    $('cb-end')?.addEventListener('click', () => {
      this.net.sendCtrl(fp, { type: 'call-end' });
      this._endCallLocal(false);
      this._status('call ended', 'info', 3000);
    });
  }

  // ── Render: circle call panel ──────────────────────────────────────────────

  _renderCircleCallPanel() {
    const panel = $('circle-call-panel'); if (!panel) return;
    if (!this.circleCall) { panel.innerHTML = ''; panel.classList.remove('visible'); return; }
    const { type, phase, muted, camOff, localStream, remoteStreams } = this.circleCall;
    panel.classList.add('visible');

    if (phase === 'connecting' || phase === 'ringing') {
      panel.innerHTML = `<div class="call-waiting">
        <div class="call-type-badge">◯ circle ${type === 'stream' ? '📷 stream' : '🎙 walkie'}</div>
        <div class="call-state">inviting peers…</div>
        <div class="call-controls" style="display:flex;gap:8px;justify-content:center">
          <div class="call-btn end" id="ccb-end" style="min-height:48px;min-width:64px;display:flex;align-items:center;justify-content:center">✕ end</div>
        </div>
      </div>`;
      $('ccb-end')?.addEventListener('click', () => this._endCircleCall());
      return;
    }

    const isStream = type === 'stream', count = remoteStreams.size;
    let html = '';
    if (isStream) {
      html = '<div class="video-grid" style="position:relative;display:grid;gap:4px;flex:1;min-height:0;background:#000;border-radius:12px;overflow:hidden;padding:4px">';
      // Dynamic column count based on peer count
      const cols = count <= 1 ? 1 : count <= 3 ? 2 : 3;
      html = `<div class="video-grid" style="position:relative;display:grid;grid-template-columns:repeat(${cols},1fr);gap:4px;flex:1;min-height:0;background:#000;border-radius:12px;overflow:hidden;padding:4px">`;
      remoteStreams.forEach((_, fp) => {
        const n = this.peers.get(fp)?.nick || fp.slice(0, 8);
        html += `<div style="position:relative;background:#111;border-radius:8px;overflow:hidden;min-height:80px">
          <video id="cvid-${fp.slice(0,8)}" autoplay playsinline style="width:100%;height:100%;object-fit:cover;display:block"></video>
          <div class="video-label" style="position:absolute;bottom:4px;left:6px;font-size:10px;opacity:.75">${esc(n)}</div>
        </div>`;
      });
      // Local video PIP in corner
      html += `<div id="local-pip-cc" style="position:absolute;bottom:8px;right:8px;width:90px;border-radius:6px;overflow:hidden;box-shadow:0 2px 8px #0006">
        <video id="cvid-l" autoplay playsinline muted style="width:100%;height:auto;display:block${camOff ? ';opacity:0' : ''}"></video>
        ${camOff ? '<div style="position:absolute;inset:0;background:#111;display:flex;align-items:center;justify-content:center;font-size:14px">📷</div>' : ''}
        <div class="video-label" style="position:absolute;bottom:2px;left:4px;font-size:9px;opacity:.7">${esc(this.id.nickname)}</div>
      </div>`;
      html += '</div>';
    } else {
      const names = [...remoteStreams.keys()].map(fp => this.peers.get(fp)?.nick || fp.slice(0, 8)).join(', ') || '—';
      html = `<div class="walkie-active">
        <span class="wk-pulse">◯🎙</span> circle · <span class="wk-peer">${count} peer${count !== 1 ? 's' : ''}: ${esc(names)}</span>
        <div class="waveform"><span></span><span></span><span></span><span></span><span></span></div>
      </div>`;
    }

    html += `<div class="call-controls" style="display:flex;gap:8px;padding:8px 12px;justify-content:center;flex-wrap:wrap">
      <div class="call-btn${muted ? ' muted' : ''}" id="ccb-mute" style="min-height:48px;min-width:64px;display:flex;align-items:center;justify-content:center;gap:4px">🎙 ${muted ? 'muted' : 'mic'}</div>
      ${isStream ? `<div class="call-btn${camOff ? ' muted' : ''}" id="ccb-cam" style="min-height:48px;min-width:64px;display:flex;align-items:center;justify-content:center;gap:4px">📷 ${camOff ? 'off' : 'cam'}</div>` : ''}
      <div class="call-btn end" id="ccb-end" style="min-height:48px;min-width:64px;display:flex;align-items:center;justify-content:center;gap:4px">✕ end</div>
    </div>`;
    panel.innerHTML = html;

    const vl = $('cvid-l');
    if (vl && localStream) vl.srcObject = localStream;
    remoteStreams.forEach((stream, fp) => {
      const v = $(`cvid-${fp.slice(0, 8)}`);
      if (v) v.srcObject = stream;
    });

    const pip = $('local-pip-cc');
    if (pip) _makeDraggable(pip);

    $('ccb-mute')?.addEventListener('click', () => {
      if (!this.circleCall) return;
      this.circleCall.muted = !this.circleCall.muted;
      this.circleCall.localStream?.getAudioTracks().forEach(t => { t.enabled = !this.circleCall.muted; });
      this._renderCircleCallPanel();
    });
    $('ccb-cam')?.addEventListener('click', () => {
      if (!this.circleCall) return;
      this.circleCall.camOff = !this.circleCall.camOff;
      this.circleCall.localStream?.getVideoTracks().forEach(t => { t.enabled = !this.circleCall.camOff; });
      this._renderCircleCallPanel();
    });
    $('ccb-end')?.addEventListener('click', () => this._endCircleCall());
  }

  // ── Stats polling ──────────────────────────────────────────────────────────

  _startStatsPolling(fp) {
    this._stopStatsPolling();
    this._statsTimer = setInterval(async () => {
      const s   = await this.net.getStats(fp); if (!s) return;
      const bar = $('call-stats-bar');          if (!bar) return;
      const parts = [];
      if (s.videoWidth)  parts.push(`${s.videoWidth}×${s.videoHeight} ${s.fps}fps`);
      if (s.videoKbps)   parts.push(`↓${s.videoKbps}kbps`);
      if (s.audioKbps)   parts.push(`🎙${s.audioKbps}kbps`);
      if (s.rttMs != null) parts.push(`rtt ${s.rttMs}ms`);
      if (s.bytesSent)   parts.push(`↑${fmt(s.bytesSent)}`);
      if (s.bytesRecv)   parts.push(`↓${fmt(s.bytesRecv)}`);
      bar.textContent = parts.join(' · ') || 'active';
    }, 2_000);
  }

  _stopStatsPolling() {
    clearInterval(this._statsTimer);
    this._statsTimer = null;
  }

  // ── Session ────────────────────────────────────────────────────────────────

  async _openSession(fp) {
    if (!fp) return;
    this.active = fp;
    this.unread.delete(fp);
    if (!this.sessions.has(fp)) {
      try { this.sessions.set(fp, await loadMessages(fp)); }
      catch { this.sessions.set(fp, []); }
    }
    this._renderHeader(); this._renderMsgs(); this._renderPeers();
    this._renderCallPanel(); this._renderCircleCallPanel();
    this._renderGamePanel(fp);
    const ib = $('input-bar'); if (ib) ib.classList.add('visible');
    $('msg-input')?.focus();
    this._showChat();
    this._buildPlusMenu();
  }

  async _clearChat(fp) {
    const lbl = fp === CIRCLE_ID ? 'circle' : ('chat with ' + (this.peers.get(fp)?.nick || fp.slice(0, 8)));
    if (!confirm('Clear ' + lbl + '?')) return;
    try {
      await clearMessages(fp);
      this.sessions.set(fp, []);
      this._renderMsgs();
      this._status('cleared', 'ok', 2000);
    } catch { this._status('clear failed', 'err', 4000); }
  }

  // ── State export / import ──────────────────────────────────────────────────

  async _exportState() {
    this._status('preparing export…', 'info');
    try {
      const keyData  = await this.id.exportKeyData();
      const messages = await loadAllMessages();
      const peers    = await loadPeers();
      const state = {
        tqVersion:  12,
        exportedAt: new Date().toISOString(),
        identity:   keyData
          ? { ...keyData, nickname: this.id.nickname, fingerprint: this.id.fingerprint }
          : null,
        peers,
        messages,
      };
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement('a'), {
        href: url,
        download: `turquoise-${this.id.shortId}-${Date.now()}.json`,
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      this._status('state exported ✓', 'ok', 4000);
    } catch (e) {
      this._status('export failed: ' + e.message, 'err', 5000);
    }
  }

  async _importState(file) {
    this._status('reading import file…', 'info');
    try {
      const text  = await file.text();
      const state = JSON.parse(text);
      if (!state?.tqVersion) throw new Error('Not a valid Turquoise state file');
      const confirmed = confirm(
        'Import Turquoise state?\n\n'
        + (state.identity ? '• Identity: ' + state.identity.fingerprint?.slice(0, 16) + '…\n' : '• No identity (messages only)\n')
        + '• ' + (state.messages?.length || 0) + ' messages\n'
        + '• ' + (state.peers?.length    || 0) + ' peers\n\n'
        + (state.identity
          ? 'This will REPLACE your current identity. Current data will be lost.\n'
          : 'Messages will be merged.')
        + '\nContinue?'
      );
      if (!confirmed) { this._status('import cancelled', 'info', 2000); return; }
      if (state.identity?.privJwk) {
        await clearAllData();
        await resetIdentity();
        await importIdentityData(state.identity);
      }
      if (state.messages?.length) await restoreMessages(state.messages);
      if (state.peers?.length)    await restorePeers(state.peers);
      this._status('import complete — reloading…', 'ok');
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      this._status('import failed: ' + e.message, 'err', 6000);
    }
  }

  async _confirmReset() {
    const choice = await this._resetDialog();
    if (choice === 'cancel') return;
    if (choice === 'export-reset') await this._exportState();
    this._status('resetting…', 'warn');
    try {
      await clearAllData(); await resetIdentity();
      if ('caches' in window) {
        const ks = await caches.keys();
        await Promise.all(ks.map(k => caches.delete(k)));
      }
    } catch (e) { console.warn('[TQ] reset cleanup:', e); }
    location.reload();
  }

  _resetDialog() {
    return new Promise(res => {
      const overlay = document.createElement('div');
      overlay.className = 'reset-overlay';
      overlay.innerHTML = `<div class="reset-box">
        <div class="reset-title">reset turquoise</div>
        <div class="reset-body">This will delete your identity and all messages.<br>Consider exporting your state first.</div>
        <div class="reset-btns">
          <div class="reset-btn cancel" id="rd-cancel">cancel</div>
          <div class="reset-btn export" id="rd-export">export then reset</div>
          <div class="reset-btn danger" id="rd-reset">reset without export</div>
        </div>
      </div>`;
      document.body.appendChild(overlay);
      const close = (val) => { overlay.remove(); res(val); };
      overlay.querySelector('#rd-cancel')?.addEventListener('click', () => close('cancel'));
      overlay.querySelector('#rd-export')?.addEventListener('click', () => close('export-reset'));
      overlay.querySelector('#rd-reset')?.addEventListener('click',  () => close('reset'));
    });
  }

  _toggleCircle(fp, e) {
    e.stopPropagation();
    this.circleBlocked.has(fp) ? this.circleBlocked.delete(fp) : this.circleBlocked.add(fp);
    this._renderPeers();
    const name = this.peers.get(fp)?.nick || fp.slice(0, 8);
    this._status(name + (this.circleBlocked.has(fp) ? ' removed from' : ' in') + ' circle', 'info', 2000);
  }

  // ── Render: peer list ─────────────────────────────────────────────────────

  _renderPeers() {
    const list = $('peer-list'); if (!list) return;
    const circleOnline = this.net.getConnectedPeers().length > 0;
    const cUnread = this.unread.get(CIRCLE_ID) || 0;
    const cMsgs   = this.sessions.get(CIRCLE_ID) || [];
    const cLast   = cMsgs[cMsgs.length - 1];
    const cPrev   = cLast
      ? (cLast.type === 'file'   ? '📎 ' + esc(cLast.name || 'file')
       : cLast.type === 'folder' ? '📁 ' + esc(cLast.name || 'folder')
       : esc(cLast.text?.slice(0, 42) || ''))
      : 'group · everyone';
    const cBadge  = this.circleCall
      ? `<div class="peer-badge call-badge">${this.circleCall.type === 'stream' ? '📷' : '🎙'}</div>`
      : cUnread
        ? `<div class="peer-badge">${cUnread > 9 ? '9+' : cUnread}</div>`
        : '';
    const cActive = this.active === CIRCLE_ID ? ' active' : '';
    const circleTile = `<div class="peer-tile circle-tile${cActive}" data-fp="${CIRCLE_ID}">
      <div class="circle-icon${circleOnline ? ' online' : ''}">◯</div>
      <div class="peer-info">
        <div class="peer-nick">circle</div>
        <div class="peer-preview">${cPrev}</div>
      </div>
      ${cBadge}
    </div>`;

    if (!this.peers.size) {
      list.innerHTML = circleTile + '<div id="no-peers">waiting for peers…</div>';
      list.querySelector('.circle-tile')?.addEventListener('click', () => this._openSession(CIRCLE_ID));
      return;
    }

    const sorted = [...this.peers.entries()].sort(([, a], [, b]) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return (a.nick || '').localeCompare(b.nick || '');
    });

    const peerTiles = sorted.map(([fp, p]) => {
      const active  = fp === this.active ? ' active' : '';
      const dot     = p.connected ? 'online' : 'offline';
      const unread  = this.unread.get(fp) || 0;
      const msgs    = this.sessions.get(fp) || [];
      const last    = msgs[msgs.length - 1];
      const prev    = last
        ? (last.type === 'file'   ? '📎 ' + esc(last.name || 'file')
         : last.type === 'folder' ? '📁 ' + esc(last.name || 'folder')
         : esc(last.text?.slice(0, 42) || ''))
        : '';
      const blocked = this.circleBlocked.has(fp);
      const inCall  = this.call?.fp === fp;
      const hasGame = this.games.has(fp);
      const badge   = inCall
        ? `<div class="peer-badge call-badge">${this.call.type === 'stream' ? '📷' : '🎙'}</div>`
        : hasGame
          ? `<div class="peer-badge game-badge">⊞</div>`
          : unread
            ? `<div class="peer-badge">${unread > 9 ? '9+' : unread}</div>`
            : '';
      return `<div class="peer-tile${active}" data-fp="${fp}">
        <div class="peer-dot ${dot}"></div>
        <div class="peer-info">
          <div class="peer-nick">${esc(p.nick || fp.slice(0, 8))}</div>
          ${prev ? `<div class="peer-preview">${prev}</div>` : ''}
        </div>
        <div class="circle-toggle${blocked ? ' blocked' : ''}" data-fp="${fp}"
          title="${blocked ? 'add to circle' : 'remove from circle'}">◯</div>
        ${badge}
      </div>`;
    }).join('');

    list.innerHTML = circleTile + peerTiles;
    list.querySelectorAll('.peer-tile').forEach(t =>
      t.addEventListener('click', () => { const fp = t.dataset.fp; if (fp) this._openSession(fp); })
    );
    list.querySelectorAll('.circle-toggle').forEach(b =>
      b.addEventListener('click', e => { const fp = b.dataset.fp; if (fp) this._toggleCircle(fp, e); })
    );
  }

  // ── Render: chat header ───────────────────────────────────────────────────

  _renderHeader() {
    const h = $('chat-header'); if (!h) return;
    const fp   = this.active;
    const back = '<span class="back-btn" id="back-btn">←</span>';

    if (fp === CIRCLE_ID) {
      const connected = this.net.getConnectedPeers().length;
      const ccActive  = this.circleCall?.phase === 'active';
      h.innerHTML = `${back}
        <div class="circle-icon-hdr">◯</div>
        <div class="chat-peer-info">
          <div class="chat-peer-name">circle</div>
          <div class="chat-peer-fp">${connected} peer${connected !== 1 ? 's' : ''} · broadcast</div>
        </div>
        <div class="chat-actions">
          <div class="action-btn${ccActive && this.circleCall?.type === 'walkie' ? ' active-call' : ''}" id="hbtn-cw" title="circle walkie">🎙</div>
          <div class="action-btn${ccActive && this.circleCall?.type === 'stream' ? ' active-call' : ''}" id="hbtn-cs" title="circle stream">📷</div>
          <div class="action-btn danger" id="hbtn-cl" title="clear circle">🗑</div>
        </div>`;
      $('back-btn')?.addEventListener('click', () => this._showSidebar());
      $('hbtn-cw')?.addEventListener('click', () => { if (ccActive) this._endCircleCall(); else this._startCircleCall('walkie'); });
      $('hbtn-cs')?.addEventListener('click', () => { if (ccActive) this._endCircleCall(); else this._startCircleCall('stream'); });
      $('hbtn-cl')?.addEventListener('click', () => this._clearChat(CIRCLE_ID));
      return;
    }

    const p = fp ? this.peers.get(fp) : null;
    if (!fp || !p) {
      h.innerHTML = `${back}<span id="chat-placeholder">select a peer</span>`;
      $('back-btn')?.addEventListener('click', () => this._showSidebar());
      return;
    }

    const inCall = this.call?.fp === fp && this.call.phase === 'active';
    h.innerHTML = `${back}
      <div class="peer-dot ${p.connected ? 'online' : 'offline'}"></div>
      <div class="chat-peer-info">
        <div class="chat-peer-name">${esc(p.nick || fp.slice(0, 8))}</div>
        <div class="chat-peer-fp">${fp}</div>
      </div>
      <div class="chat-actions">
        <div class="action-btn${inCall && this.call?.type === 'walkie' ? ' active-call' : ''}" id="hbtn-w" title="walkie">🎙</div>
        <div class="action-btn${inCall && this.call?.type === 'stream' ? ' active-call' : ''}" id="hbtn-s" title="stream">📷</div>
        <div class="action-btn danger" id="hbtn-cl" title="clear">🗑</div>
      </div>`;
    $('back-btn')?.addEventListener('click', () => this._showSidebar());
    $('hbtn-w')?.addEventListener('click',  () => {
      if (inCall) { this.net.sendCtrl(fp, { type: 'call-end' }); this._endCallLocal(false); }
      else this._startCall(fp, 'walkie');
    });
    $('hbtn-s')?.addEventListener('click',  () => {
      if (inCall) { this.net.sendCtrl(fp, { type: 'call-end' }); this._endCallLocal(false); }
      else this._startCall(fp, 'stream');
    });
    $('hbtn-cl')?.addEventListener('click', () => this._clearChat(fp));
  }

  // ── Render: messages ──────────────────────────────────────────────────────

  _renderMsgs() {
    const msgs = $('messages'); if (!msgs) return;
    msgs.innerHTML = '';
    const session = this.sessions.get(this.active) || [];
    if (!session.length) {
      msgs.innerHTML = `<div class="sys-msg">${
        this.active === CIRCLE_ID ? 'circle — messages go to everyone' : 'no messages yet'
      }</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    session.forEach(m => {
      if      (m.type === 'text')   frag.appendChild(this._msgEl(m));
      else if (m.type === 'file')   frag.appendChild(this._fileCardEl(m));
      else if (m.type === 'folder') frag.appendChild(this._folderCardEl(m));
    });
    msgs.appendChild(frag);
    this._scroll();
  }

  _appendMsg(msg) {
    const msgs = $('messages'); if (!msgs) return;
    const sys  = msgs.querySelector('.sys-msg');
    if (sys && msgs.children.length === 1) sys.remove();
    msgs.appendChild(this._msgEl(msg));
    this._scroll();
  }

  _appendFileCard(fileMsg) {
    const msgs = $('messages'); if (!msgs || !fileMsg?.fileId) return;
    if (document.querySelector(`[data-fcid="${fileMsg.fileId}"]`)) return;
    const sys = msgs.querySelector('.sys-msg');
    if (sys && msgs.children.length === 1) sys.remove();
    const el = this._fileCardEl(fileMsg);
    msgs.appendChild(el);
    // Wire cancel button
    el.querySelector('.file-cancel')?.addEventListener('click', e => {
      e.stopPropagation();
      this._cancelFile(fileMsg);
    });
    this._scroll();
  }

  _appendFolderCard(folderMsg) {
    const msgs = $('messages'); if (!msgs || !folderMsg?.folderId) return;
    if (document.querySelector(`[data-folderid="${folderMsg.folderId}"]`)) return;
    const sys = msgs.querySelector('.sys-msg');
    if (sys && msgs.children.length === 1) sys.remove();
    msgs.appendChild(this._folderCardEl(folderMsg));
    this._scroll();
  }

  _msgEl(msg) {
    const d    = document.createElement('div');
    d.className = 'msg ' + (msg.own ? 'own' : 'peer');
    const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const who  = esc(msg.own ? this.id.nickname : msg.fromNick || '?');
    d.innerHTML = `<div class="meta">${who} · ${time}</div><div class="bubble">${esc(msg.text)}</div>`;
    return d;
  }

  _fileCardEl(msg) {
    const w    = document.createElement('div');
    w.className = 'msg ' + (msg.own ? 'own' : 'peer');
    const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const who  = esc(msg.own ? this.id.nickname : msg.fromNick || '?');
    const cached = this._fileUrls.get(msg.fileId);
    const mime   = msg.mimeType || '';
    let inner = `<div class="file-name">📎 ${esc(msg.name || 'file')}</div><div class="file-size">${fmt(msg.size)}</div>`;

    if (cached) {
      if (mime.startsWith('audio/')) {
        inner += `<audio controls src="${cached.url}" style="max-width:100%;height:32px;margin-top:4px"></audio>`;
        inner += `<a class="dl-btn" href="${cached.url}" download="${esc(msg.name || 'memo.webm')}">↓ save</a>`;
      } else {
        inner += `<a class="dl-btn" href="${cached.url}" download="${esc(msg.name || 'file')}">↓ save</a>`;
      }
    } else if (msg.status === 'error') {
      inner += `<div class="file-err">⚠ ${esc(msg.error || 'failed')}</div>`;
    } else {
      // In-progress: show progress bar + cancel button
      inner += `<div class="prog-track"><div class="prog-fill" style="width:0%"></div></div>`;
      inner += `<div style="display:flex;align-items:center;gap:8px;margin-top:2px">`;
      inner += `<div class="file-stats" style="flex:1"><span class="fs-pct">0%</span> <span class="fs-sep">·</span> <span class="fs-bytes">—</span></div>`;
      inner += `<button class="file-cancel" title="cancel transfer" style="background:none;border:none;color:var(--tq-mid,#1e7068);cursor:pointer;font-size:14px;padding:2px 4px;line-height:1" data-fcid="${msg.fileId}">✕</button>`;
      inner += `</div>`;
    }

    w.innerHTML = `<div class="meta">${who} · ${time}</div><div class="file-card" data-fcid="${msg.fileId}">${inner}</div>`;

    // Wire cancel after DOM is ready
    w.querySelector('.file-cancel')?.addEventListener('click', e => {
      e.stopPropagation();
      this._cancelFile(msg);
    });
    return w;
  }

  _folderCardEl(msg) {
    const w    = document.createElement('div');
    w.className = 'msg ' + (msg.own ? 'own' : 'peer');
    const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const who  = esc(msg.own ? this.id.nickname : msg.fromNick || '?');

    let inner = `<div class="file-name">📁 ${esc(msg.name || 'folder')}</div>`;
    inner    += `<div class="file-size">${msg.fileCount || 0} files · ${fmt(msg.totalSize)}</div>`;

    if (msg.status === 'done' && msg.files) {
      // Render file tree with per-file downloads
      const tree = _buildFileTree(msg.manifest || msg.files || []);
      inner += `<div class="folder-tree" style="margin:6px 0 4px;font-size:11px;max-height:100px;overflow-y:auto">${_renderFileTree(tree, null)}</div>`;
    } else if (msg.status !== 'done') {
      inner += `<div class="prog-track"><div class="prog-fill" style="width:0%"></div></div>`;
      inner += `<div class="folder-count" style="font-size:11px;margin-top:2px;opacity:.7">0 / ${msg.fileCount || 0} files</div>`;
    }

    w.innerHTML = `<div class="meta">${who} · ${time}</div><div class="file-card" data-folderid="${msg.folderId}">${inner}</div>`;
    return w;
  }

  _handleMediaError(e, fp) {
    if (e.message.startsWith('permission-denied:')) {
      const media = e.message.split(':')[1];
      this._status(media + ' permission denied — allow in browser settings', 'err', 8000);
      if (fp) this.net.sendCtrl(fp, { type: 'permission-denied', media });
    } else if (e.message.startsWith('no-device:')) {
      this._status('no ' + e.message.split(':')[1] + ' found', 'err', 6000);
    } else {
      this._status('media error: ' + e.message, 'err', 5000);
    }
    if (this.call) { this.call.localStream?.getTracks().forEach(t => t.stop()); this.call = null; }
    this._renderCallPanel(); this._renderHeader();
  }

  // ── Narrow screen ─────────────────────────────────────────────────────────

  _showChat()    { $('sidebar')?.classList.add('slide-left');    $('chat-area')?.classList.add('slide-in'); }
  _showSidebar() { $('sidebar')?.classList.remove('slide-left'); $('chat-area')?.classList.remove('slide-in'); }

  // ── Status bar ────────────────────────────────────────────────────────────

  _status(text, type = 'info', duration = 0) {
    const bar = $('status-bar'); if (!bar) return;
    clearTimeout(this._statusTimer);
    bar.textContent = text; bar.className = 's-' + type;
    if (duration) this._statusTimer = setTimeout(() => { bar.className = ''; }, duration);
  }

  _scroll() {
    const m = $('messages');
    if (m) m.scrollTop = m.scrollHeight;
  }

  _sys(text, isErr = false) {
    const msgs = $('messages'); if (!msgs) return;
    const d = document.createElement('div');
    d.className = 'sys-msg' + (isErr ? ' err' : '');
    d.textContent = text;
    msgs.appendChild(d); this._scroll();
    setTimeout(() => { try { d.remove(); } catch {} }, 5_000);
  }

  _log(text, isErr = false) {
    const log = $('net-log'); if (!log) return;
    const d   = document.createElement('div');
    d.className = 'entry' + (isErr ? ' err' : '');
    d.textContent = text;
    log.appendChild(d); log.scrollTop = log.scrollHeight;
    while (log.children.length > 120) log.removeChild(log.firstChild);
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

/**
 * Build a nested tree structure from flat manifest entries.
 * @param {Array<{fileId?, relativePath, size?, mimeType?}>} entries
 * @returns {object} nested tree: { name, children:{}, files:[] }
 */
function _buildFileTree(entries) {
  const root = { name: '', children: {}, files: [] };
  for (const entry of entries) {
    const path  = entry.relativePath || entry.name || 'file';
    const parts = path.split('/');
    let node    = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!node.children[part]) node.children[part] = { name: part, children: {}, files: [] };
      node = node.children[part];
    }
    node.files.push({ ...entry, filename: parts[parts.length - 1] });
  }
  return root;
}

/**
 * Render a file tree as HTML.
 * @param {object} node - tree node from _buildFileTree
 * @param {Function|null} downloadFn - if provided, renders per-file download buttons
 * @param {number} depth
 */
function _renderFileTree(node, downloadFn, depth = 0) {
  let html = '';
  const indent = depth * 12;
  // Render subdirectories first
  for (const [name, child] of Object.entries(node.children)) {
    html += `<div style="padding-left:${indent}px;opacity:.7">📂 ${esc(name)}</div>`;
    html += _renderFileTree(child, downloadFn, depth + 1);
  }
  // Then files
  for (const f of node.files) {
    const fmtSize = f.size != null ? ` <span style="opacity:.5">${fmt(f.size)}</span>` : '';
    const dlBtn   = downloadFn && f.fileId
      ? ` <button data-dl-fid="${f.fileId}" style="background:none;border:none;color:var(--tq,#40e0d0);cursor:pointer;font-size:10px;padding:0 2px" title="download">↓</button>`
      : '';
    html += `<div style="padding-left:${indent}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">📄 ${esc(f.filename || f.name || 'file')}${fmtSize}${dlBtn}</div>`;
  }
  return html;
}

/**
 * Make a DOM element draggable within its offset parent.
 * Uses pointer events for touch + mouse compatibility.
 */
function _makeDraggable(el) {
  let startX = 0, startY = 0, origLeft = 0, origBottom = 0;
  const parent = el.offsetParent || el.parentElement;

  el.style.position = 'absolute';
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    startX    = e.clientX;
    startY    = e.clientY;
    origLeft  = el.offsetLeft;
    origBottom = parent.offsetHeight - el.offsetTop - el.offsetHeight;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', e => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const newLeft   = Math.max(0, Math.min(origLeft + dx, parent.offsetWidth  - el.offsetWidth));
    const newBottom = Math.max(0, Math.min(origBottom - dy, parent.offsetHeight - el.offsetHeight));
    el.style.left   = newLeft   + 'px';
    el.style.bottom = newBottom + 'px';
    el.style.right  = 'auto';
    el.style.top    = 'auto';
  });
}
