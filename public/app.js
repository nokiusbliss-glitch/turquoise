/**
 * app.js — Turquoise v7.1
 *
 * Fixes over v7:
 *   - net.peers internal Map access replaced with net.isReady(fp) everywhere (×5)
 *   - loadAllMessages static import (no dynamic import hack)
 *   - _renderCallPanel / _renderCircleCallPanel: remove old PIP before appending new one
 *   - _makePIPDraggable: returns cleanup fn; cleanup called when call ends
 *   - _attachRemote1to1 / _attachCircleRemote: use net.setRemoteStreamHandler()
 *     instead of overwriting ps.pc.ontrack
 *   - _onOfferReneg / _onCircleOfferReneg: pass sdp to answerWithStream (new sig)
 *   - Dead _appendToolEmbed and type==='tool' branch removed
 *   - clearMessages import removed (not used)
 *   - Folder history reload: _finalizeFolderCard only called when download fns
 *     exist (live transfer); history cards shown as read-only with no broken btns
 *   - _sendFolder deduplication: delegates to FolderTransfer.sendFolder()
 *   - Status bar moved out of netlog panel into #main so it's visible on mobile
 *   - Back button closes sidebar overlay + taps backdrop
 */

import { saveMessage, loadMessages, loadAllMessages, clearAllData,
         savePeer, loadPeers, restoreMessages, restorePeers } from './messages.js';
import { resetIdentity, importIdentityData } from './identity.js';
import { TQLog } from './tqlog.js';
import { FileTransfer }   from './files.js';
import { FolderTransfer } from './folder.js';
import { TicTacToe, VoiceMemo } from './tqapps.js';

const $ = id => document.getElementById(id);
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmt  = b => !b ? '0 B' : b < 1024 ? b+' B' : b < 1_048_576 ? (b/1024).toFixed(1)+' KB' : b < 1_073_741_824 ? (b/1_048_576).toFixed(1)+' MB' : (b/1_073_741_824).toFixed(2)+' GB';
const fmtSpd = s => !s ? '—' : s < 1024 ? s.toFixed(0)+' B/s' : s < 1_048_576 ? (s/1024).toFixed(1)+' KB/s' : (s/1_048_576).toFixed(2)+' MB/s';
const fmtEta = s => !s||s<=0||!isFinite(s) ? '—' : s<60 ? Math.ceil(s)+'s' : Math.floor(s/60)+'m'+Math.ceil(s%60)+'s';

const CIRCLE = 'circle';
const TTL    = 60_000;

function msgStyle(id='') {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const shape = h % 8;
  const rot   = ((h >> 8) % 51 - 25) / 10;
  return { shape, rot };
}

function _buildFileTree(manifest) {
  const tree = {};
  (manifest||[]).forEach(f => {
    const parts = (f.relativePath||f.name||'file').split('/');
    let node = tree;
    parts.slice(0,-1).forEach(d => { node[d] = node[d] || {}; node = node[d]; });
    node[parts.at(-1)] = f.fileId || null;
  });
  return tree;
}

function _renderFolderTree(tree, depth=0) {
  let html = '';
  for (const [name, val] of Object.entries(tree)) {
    if (val && typeof val === 'object') {
      html += `<div class="ft-dir" style="padding-left:${depth*8}px">▸ ${esc(name)}/</div>`;
      html += _renderFolderTree(val, depth+1);
    } else {
      html += `<div class="ft-file" style="padding-left:${depth*8}px">
        <span style="color:var(--dim)">·</span> <span>${esc(name)}</span>
        ${val ? `<button class="ft-dl" data-dl-fid="${esc(val)}">↓</button>` : ''}
      </div>`;
    }
  }
  return html;
}

export class TurquoiseApp {
  constructor(identity, network) {
    this.id  = identity;
    this.net = network;
    this._log = TQLog.get();

    this.peers     = new Map();
    this.sessions  = new Map();
    this.active    = null;
    this.unread    = new Map();
    this.circleBlocked = new Set();

    this.call       = null;
    this.circleCall = null;
    this._fileUrls  = new Map();
    this._memo      = null;
    this._statsTimer= null;
    this._pipCleanup= null;   // cleanup fn for PIP drag listeners
    this.games      = new Map();
    this._transferMeta = new Map();
    this._outTransfers = new Map();

    this._audioEl = Object.assign(document.createElement('audio'), {autoplay:true, playsInline:true, style:'display:none'});
    document.body.appendChild(this._audioEl);

    this.ft = new FileTransfer(
      (fp,m) => {
        const meta = m.fileId ? this._transferMeta.get(m.fileId) : null;
        const extra = meta ? {
          sessionId:   meta.sessionId,
          sessionKind: meta.sessionKind,
          transferId:  meta.transferId,
        } : {};
        return network.sendCtrl(fp, {...extra, ...m});
      },
      (fp,b) => network.sendBinary(fp,b),
      fp     => network.waitForBuffer(fp)
    );
    this.ft.onProgress  = (id,pct,_dir,_fp,s) => this._onFileProg(id,pct,s);
    this.ft.onFileReady = f => this._onFileReady(f);
    this.ft.onError     = (id,m,fp) => this._onFileErr(id,m,fp);

    this.folder = new FolderTransfer(this.ft, (fp,m) => network.sendCtrl(fp,m));
    this.folder.onProgress    = (fid,d,t) => this._onFolderProg(fid,d,t);
    this.folder.onFolderReady = info => this._onFolderReady(info);
    this.folder.onError       = (_,m) => this._status(m,'err',5000);
  }

  // ── Mount ──────────────────────────────────────────────────────────────────

  async mount() {
    const {nickname, fingerprint} = this.id;
    const nd=$('nick-display'), ni=$('nick-input'), fp=$('full-fp');
    if (nd) nd.textContent = nickname;
    if (ni) ni.value = nickname;
    if (fp) fp.textContent = fingerprint;

    try {
      for (const p of await loadPeers()) {
        const nick = p.nickname || p.fingerprint.slice(0,8);
        this.peers.set(p.fingerprint, {nick});
        this.net.addKnownPeer(p.fingerprint, nick);
      }
    } catch {}
    try { this.sessions.set(CIRCLE, await loadMessages(CIRCLE)); } catch { this.sessions.set(CIRCLE,[]); }

    this._bindUI();
    this._wireNetwork();
    this._mountLog();
    await this._openSession(CIRCLE);

    if (this.id.isNewUser) {
      this._status('tap your name to set it','info');
      setTimeout(() => this._startNickEdit(), 500);
    } else {
      this._status('connecting…','info');
    }
  }

  // ── Log panel ──────────────────────────────────────────────────────────────

  _mountLog() {
    const log = TQLog.get();
    const netLog = $('net-log');
    if (netLog) this._unmountLog = log.liveViewer(netLog, 200);
    $('netlog-export')?.addEventListener('click', () => log.exportToFile(this.id.fingerprint));
    $('netlog-clear')?.addEventListener('click', () => { if(netLog) netLog.innerHTML=''; });
  }

  // ── UI binding ─────────────────────────────────────────────────────────────

  _bindUI() {
    const row=$('identity-row'), nd=$('nick-display'), ni=$('nick-input');
    if (row && nd && ni) {
      row.addEventListener('click', () => this._startNickEdit());
      const save = async () => {
        if (!ni.classList.contains('visible')) return;
        const saved = await this.id.saveNickname(ni.value).catch(() => this.id.nickname);
        nd.textContent = saved; ni.value = saved;
        nd.classList.remove('hidden'); ni.classList.remove('visible');
        this.net.listPresentPeers().forEach(fp => this.net.sendCtrl(fp,{type:'nick-update',nick:saved}));
        this._status('name: '+saved,'ok',3000);
      };
      ni.addEventListener('keydown', e => { if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();save();} });
      ni.addEventListener('blur', save);
    }

    const mi=$('msg-input');
    if (mi) {
      mi.addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();this._send();} });
      mi.addEventListener('input', () => { mi.style.height='auto'; mi.style.height=Math.min(mi.scrollHeight,128)+'px'; });
    }
    $('send-btn')?.addEventListener('click', () => this._send());
    $('plus-btn')?.addEventListener('click', e => { e.stopPropagation(); this._togglePlus(); });
    document.addEventListener('click', () => this._closePlus());

    $('__file-input')?.addEventListener('change', e => { [...(e.target.files||[])].forEach(f=>this._queueFile(f)); e.target.value=''; });
    $('__import-input')?.addEventListener('change', e => { const f=e.target.files?.[0]; if(f) this._importState(f); e.target.value=''; });

    const ca=$('chat-area');
    if (ca) {
      ca.addEventListener('dragover',  e => { e.preventDefault(); ca.classList.add('drag-over'); });
      ca.addEventListener('dragleave', () => ca.classList.remove('drag-over'));
      ca.addEventListener('drop', e => {
        e.preventDefault(); ca.classList.remove('drag-over');
        if (!this.active) return;
        [...(e.dataTransfer?.files||[])].forEach(f=>this._queueFile(f));
      });
    }

    $('back-btn')?.addEventListener('click', () => this._showSidebar());
    $('sidebar-backdrop')?.addEventListener('click', () => this._hideSidebar());
    $('reset-btn')?.addEventListener('click', () => this._confirmReset());

    $('btn-walkie')?.addEventListener('click', () => {
      if (this.active && this.active!==CIRCLE) this._startCall(this.active,'walkie');
      else this._startCircleCall('walkie');
    });
    $('btn-stream')?.addEventListener('click', () => {
      if (this.active && this.active!==CIRCLE) this._startCall(this.active,'stream');
      else this._startCircleCall('stream');
    });
    $('ctrl-mute')?.addEventListener('click', () => this._toggleMute());
    $('ctrl-cam')?.addEventListener('click',  () => this._toggleCam());
    $('ctrl-end')?.addEventListener('click',  () => { if(this.circleCall) this._endCircleCall(); else this._endCallLocal(true); });
    $('ci-accept')?.addEventListener('click',  () => {
      const d=$('call-incoming'), fp=d?.dataset.callFp;
      if (fp) { if(d?.dataset.circle==='1') this._acceptCircleCall(fp); else this._acceptCall(fp); }
    });
    $('ci-decline')?.addEventListener('click', () => {
      const d=$('call-incoming'), fp=d?.dataset.callFp;
      if (fp) { if(d?.dataset.circle==='1') this._declineCircleCall(fp); else this._declineCall(fp); }
    });
  }

  _startNickEdit() {
    const d=$('nick-display'), i=$('nick-input');
    if (!d||!i||i.classList.contains('visible')) return;
    d.classList.add('hidden'); i.classList.add('visible'); i.focus(); i.select();
  }

  _togglePlus() {
    const m=$('plus-menu'), btn=$('plus-btn');
    if (!m||!btn) return;
    const was = m.classList.contains('visible');
    this._closePlus();
    if (!was) {
      // Position above the plus button using fixed coords so the menu works
      // regardless of parent overflow context (#main is overflow:hidden).
      const r = btn.getBoundingClientRect();
      m.style.left   = r.left + 'px';
      m.style.bottom = (window.innerHeight - r.top + 4) + 'px';
      m.style.top    = '';
      this._buildPlus();
      m.classList.add('visible');
    }
  }
  _closePlus() { $('plus-menu')?.classList.remove('visible'); }

  _buildPlus() {
    const menu=$('plus-menu'); if(!menu) return;
    const fp       = this.active;
    const isCircle = fp===CIRCLE;
    const online   = !isCircle && this._canReach(fp||'');
    const anyOnline= this._listCirclePeers().length > 0;
    const canSend  = isCircle ? anyOnline : online;
    // Games need a single known opponent, not a broadcast group
    const canGame  = online && !isCircle;

    menu.innerHTML = `
      <div class="pm-item" id="pmi-file">📎  file</div>
      <div class="pm-item" id="pmi-folder">📁  folder</div>
      <div class="pm-item" id="pmi-memo">🎤  voice memo</div>
      <div class="pm-sep"></div>
      <div class="pm-label">◈ apps</div>
      <div class="pm-item${canGame?'':' pm-dim'}" id="pmi-ttt">⊞  tic tac toe</div>
      <div class="pm-sep"></div>
      <div class="pm-item pm-danger" id="pmi-export">⬇  export state</div>
      <div class="pm-item" id="pmi-import">⬆  import state</div>`;

    const guard = fn => () => { this._closePlus(); if (!canSend) { this._sys('no peers available',true); return; } fn(); };
    $('pmi-file')?.addEventListener('click',   guard(() => $('__file-input')?.click()));
    $('pmi-folder')?.addEventListener('click', guard(() => this._sendFolder()));
    $('pmi-memo')?.addEventListener('click',   guard(() => this._startVoiceMemo()));
    $('pmi-ttt')?.addEventListener('click', () => {
      this._closePlus();
      if (canGame) { this._startGame(fp,'ttt'); }
      else if (isCircle) {
        // In circle: pick a peer to play with
        const gamePeers=this._listCirclePeers();
        if (!gamePeers.length) { this._sys('no peers in circle',true); return; }
        if (gamePeers.length===1) { this._startGame(gamePeers[0],'ttt'); }
        else {
          const picked=gamePeers[0]; // pick first connected peer for now
          this._sys('starting game with '+(this.peers.get(picked)?.nick||picked.slice(0,8)),'info',3000);
          this._startGame(picked,'ttt');
        }
      }
      else this._sys('peer offline',true);
    });
    $('pmi-export')?.addEventListener('click', () => { this._closePlus(); this._exportState(); });
    $('pmi-import')?.addEventListener('click', () => { this._closePlus(); $('__import-input')?.click(); });
  }

  _showSidebar() {
    $('sidebar')?.classList.add('show');
    $('sidebar-backdrop')?.classList.add('visible');
  }
  _hideSidebar() {
    $('sidebar')?.classList.remove('show');
    $('sidebar-backdrop')?.classList.remove('visible');
  }

  _sessionMeta(sessionId=this.active) {
    const sid = sessionId || CIRCLE;
    return sid === CIRCLE
      ? { sessionId:CIRCLE, sessionKind:'circle' }
      : { sessionId:sid, sessionKind:'direct' };
  }

  _resolveSessionId(fp, msg) {
    if (msg?.sessionId) return msg.sessionId;
    if (msg?.sessionKind === 'circle' || msg?.circle) return CIRCLE;
    return fp;
  }

  _canReach(fp) {
    return !!fp && this.net.transportState(fp) !== 'offline';
  }

  _listCirclePeers() {
    return this.net.listPresentPeers().filter(fp => !this.circleBlocked.has(fp));
  }

  _listSessionPeers(sessionId) {
    return sessionId === CIRCLE
      ? this._listCirclePeers()
      : (this._canReach(sessionId) ? [sessionId] : []);
  }

  _findMessage(match) {
    for (const msgs of this.sessions.values()) {
      const msg = msgs.find(match);
      if (msg) return msg;
    }
    return null;
  }

  _setMessageStatus(match, status, extra={}) {
    const msg = this._findMessage(match);
    if (!msg) return null;
    msg.status = status;
    Object.assign(msg, extra);
    saveMessage(msg).catch(()=>{});
    if (this.active === msg.sessionId) this._renderMsgs();
    return msg;
  }

  // ── Network wiring ─────────────────────────────────────────────────────────

  _wireNetwork() {
    const n = this.net;
    n.onPeerPresenceChanged   = (fp,nick,present) => present ? this._onConnect(fp,nick) : this._onDisconnect(fp);
    n.onPeerConnected         = fp        => this._onTransportChanged(fp);
    n.onPeerDisconnected      = fp        => this._onTransportChanged(fp);
    n.onTransportStateChanged = fp        => this._onTransportChanged(fp);
    n.onMessage               = (fp,msg)  => { try { this._dispatch(fp,msg); } catch(e) { this._log.warn('app','dispatch',e.message); } };
    n.onBinaryChunk           = (fp,buf)  => { try { this.ft.handleBinary(fp,buf); } catch {} };
    n.onLog                   = t         => this._log.info('app','net',t);
    n.onSignalingConnected    = ()        => this._setConnStatus('ok','signaling ✓');
    n.onSignalingDisconnected = ()        => this._setConnStatus('warn','reconnecting…');
  }

  _setConnStatus(cls, text) {
    const el=$('conn-status'); if(!el) return;
    el.className=''; el.classList.add(cls); el.textContent=text;
  }

  _onConnect(fp, nick) {
    const name = nick || this.peers.get(fp)?.nick || fp.slice(0,8);
    this.peers.set(fp, {nick:name});
    savePeer({fingerprint:fp, shortId:fp.slice(0,8), nickname:name}).catch(()=>{});
    if (!this.sessions.has(fp)) {
      loadMessages(fp).then(msgs => { this.sessions.set(fp,msgs); this._renderPeers(); if(this.active===fp) this._renderMsgs(); }).catch(() => this.sessions.set(fp,[]));
    } else this._renderPeers();
    if (this.call?.fp===fp && this.call.phase==='reconnecting' && this.call.localStream) this._resumeDirectCall(fp);
    if (this.circleCall?.localStream) this._resumeCirclePeer(fp);
    this._resumeTransfersForPeer(fp);
    if (this.active===fp || this.active===CIRCLE) this._renderHeader();
    this._status(name+' reachable','ok',3000);
  }

  _onDisconnect(fp) {
    const p=this.peers.get(fp); const name=p?.nick||fp.slice(0,8);
    if (this.call?.fp===fp) {
      this.call.remoteStream = null;
      this.call.phase = 'reconnecting';
      this._renderCallPanel();
    }
    if (this.circleCall) this._removeCirclePeer(fp, true);
    this.games.get(fp)?.destroy?.(); this.games.delete(fp);
    this._renderPeers();
    if (this.active===fp || this.active===CIRCLE) this._renderHeader();
    this._status(name+' unreachable','warn',5000);
  }

  _onTransportChanged(fp) {
    this._renderPeers();
    if (this.active===fp || this.active===CIRCLE) this._renderHeader();
    if (this.call?.fp===fp) this._renderCallPanel();
    if (this.circleCall?.members?.has(fp)) this._renderCircleCallPanel();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  _renderPeers() {
    const list=$('peers-list'); if(!list) return;
    const frag = document.createDocumentFragment();

    const circleEl = document.createElement('div');
    circleEl.className = 'peer-item circle' + (this.active===CIRCLE?' active':'');
    const unread = this.unread.get(CIRCLE)||0;
    circleEl.innerHTML = `<span class="peer-dot"></span><span class="peer-nick">◉ circle</span>${unread?`<span class="peer-badge">${unread}</span>`:''}`;
    circleEl.addEventListener('click', () => { this._hideSidebar(); this._openSession(CIRCLE); });
    frag.appendChild(circleEl);

    const sorted = [...this.peers.entries()].sort(([afp,a],[bfp,b]) => {
      const aOnline = this._canReach(afp);
      const bOnline = this._canReach(bfp);
      return (bOnline?1:0)-(aOnline?1:0) || a.nick.localeCompare(b.nick);
    });
    for (const [fp, p] of sorted) {
      const el = document.createElement('div');
      const ur = this.unread.get(fp)||0;
      const tier = this.net.transportState(fp);
      const online = tier !== 'offline';
      const tierLabel = tier === 'p2p' ? 'p2p' : tier === 'relay' ? 'relay' : tier === 'connecting' ? 'connecting' : '';
      el.className = 'peer-item' + (online?' online':'') + (this.active===fp?' active':'');
      el.innerHTML = `<span class="peer-dot"></span><span class="peer-nick">${esc(p.nick)}</span>${tierLabel?`<span class="peer-tier ${tier==='p2p'?'p2p':''}">${tierLabel}</span>`:''}${ur?`<span class="peer-badge">${ur}</span>`:''}`;
      el.addEventListener('click', () => { this._hideSidebar(); this._openSession(fp); });
      frag.appendChild(el);
    }
    list.innerHTML=''; list.appendChild(frag);
    const cnt=$('peer-count'); if(cnt) cnt.textContent=`(${this.peers.size})`;
  }

  _renderHeader() {
    const fp = this.active;
    const isCircle = fp===CIRCLE;
    const p = this.peers.get(fp)||{};
    const el=$('chat-peer-name'); if(el) el.textContent= isCircle ? '◉ circle' : (p.nick || fp?.slice(0,8) || '—');
    const fpe=$('chat-peer-fp');
    if (fpe) {
      if (isCircle) {
        const n = this._listCirclePeers().length;
        fpe.textContent = n === 0 ? 'no peers online' : n === 1 ? '1 peer online' : `${n} peers online`;
      } else {
        const tier = this.net.transportState(fp);
        fpe.textContent = tier === 'p2p'
          ? 'p2p · direct'
          : tier === 'relay'
            ? 'relay'
            : tier === 'connecting'
              ? 'reconnecting…'
              : fp ? fp.slice(0,16)+'…' : '';
      }
    }
    const bw=$('btn-walkie'), bv=$('btn-stream');
    if(bw) bw.textContent = isCircle ? '☎ walkie circle' : '☎ walkie';
    if(bv) bv.textContent = isCircle ? '⬡ video circle'  : '⬡ video';
  }

  async _openSession(fp) {
    this.active = fp;
    this.unread.delete(fp);
    this._renderPeers();
    this._renderHeader();
    this._renderMsgs();
  }

  _renderMsgs() {
    const ca=$('chat-area'); if(!ca) return;
    ca.innerHTML='';
    const msgs = this.sessions.get(this.active)||[];
    msgs.forEach(m => this._appendAny(m));
    ca.scrollTop = ca.scrollHeight;
  }

  _appendAny(msg) {
    if (msg.type==='text')   return this._appendMsg(msg);
    if (msg.type==='file')   return this._appendFileCard(msg);
    if (msg.type==='folder') return this._appendFolderCard(msg);
  }

  _appendMsg(msg) {
    const ca=$('chat-area'); if(!ca) return;
    const isSys = msg.type==='system';
    const { shape, rot } = msgStyle(msg.id||String(msg.ts)||'');
    const el = document.createElement('div');
    el.className = isSys ? 'msg sys'+(msg.err?' err':'') : ('msg '+(msg.own?'sent':'recv'));
    if (!isSys) { el.dataset.shape=shape; el.style.transform=`rotate(${rot}deg)`; }
    if (!msg.own && !isSys) el.innerHTML = `<div class="sender">${esc(msg.fromNick||'?')}</div>`;
    const t = document.createElement('span'); t.textContent=msg.text; el.appendChild(t);
    if (!isSys) {
      const ts=document.createElement('span'); ts.className='ts';
      ts.textContent=new Date(msg.ts||Date.now()).toTimeString().slice(0,5); el.appendChild(ts);
    }
    ca.appendChild(el); ca.scrollTop=ca.scrollHeight;
  }

  _appendFileCard(msg) {
    const ca=$('chat-area'); if(!ca) return;
    const el = document.createElement('div');
    el.className='file-card'+(msg.own?' sent':'');
    el.dataset.fcid=msg.fileId;
    const inProg = msg.status==='sending'||msg.status==='receiving'||msg.status==='retrying';
    const statusText = msg.deliveryText || (msg.status && !['sending','receiving','done'].includes(msg.status) ? msg.status : '');
    el.innerHTML=`
      <div class="fname">${esc(msg.name||'file')}</div>
      <div class="fsize">${fmt(msg.size||0)} · ${esc(msg.mimeType||'')}</div>
      ${!msg.own?`<div style="font-size:9px;color:var(--dim)">from ${esc(msg.fromNick||'?')}</div>`:''}
      ${statusText?`<div class="file-state">${esc(statusText)}</div>`:''}
      ${inProg?`<div class="prog-track"><div class="prog-fill"></div></div><div class="file-stats"></div>`:''}`;
    if (inProg) {
      const btn=document.createElement('button'); btn.className='file-cancel'; btn.textContent='✕ cancel';
      btn.addEventListener('click',()=>this._cancelFile(msg)); el.appendChild(btn);
    } else if (msg.status==='done') {
      const f=this._fileUrls.get(msg.fileId); if(f) this._attachDownload(el,f);
    }
    ca.appendChild(el); ca.scrollTop=ca.scrollHeight;
  }

  _appendFolderCard(msg) {
    const ca=$('chat-area'); if(!ca) return;
    const el=document.createElement('div');
    el.className='folder-card'+(msg.own?' sent':'');
    el.dataset.folderid=msg.folderId;
    const inProg=msg.status==='sending'||msg.status==='receiving'||msg.status==='retrying';
    const statusText = msg.deliveryText || (msg.status && !['sending','receiving','done'].includes(msg.status) ? msg.status : '');
    el.innerHTML=`
      <div class="fname">📁 ${esc(msg.name||'folder')}</div>
      <div class="fsize">${fmt(msg.totalSize||0)} · ${msg.fileCount||0} files</div>
      ${!msg.own?`<div style="font-size:9px;color:var(--dim)">from ${esc(msg.fromNick||'?')}</div>`:''}
      ${statusText?`<div class="file-state">${esc(statusText)}</div>`:''}
      ${inProg?`<div class="folder-count">0 / ${msg.fileCount||0} files</div><div class="prog-track"><div class="prog-fill"></div></div>`:''}`;
    // Only wire download buttons when live transfer data is present.
    // History reloads have no download fns — show "files no longer available" instead.
    if (msg.status==='done' && msg._downloadFns) {
      this._finalizeFolderCard(el, msg._downloadFns);
    } else if (msg.status==='done') {
      const note=document.createElement('div'); note.style.cssText='font-size:9px;color:var(--mute);margin-top:4px';
      note.textContent='files not available after reload'; el.appendChild(note);
    }
    ca.appendChild(el); ca.scrollTop=ca.scrollHeight;
  }

  _attachDownload(card, f) {
    const mime=f.mimeType||'';
    if (mime.startsWith('audio/')) {
      const au=Object.assign(document.createElement('audio'),{controls:true,src:f.url});
      au.style.cssText='max-width:100%;margin-top:4px;height:32px'; card.appendChild(au);
    }
    card.appendChild(Object.assign(document.createElement('a'),{className:'dl-btn',href:f.url,download:f.name||'file',textContent:'↓ save'}));
  }

  _sys(text, err=false) {
    const ca=$('chat-area'); if(!ca) return;
    const el=document.createElement('div'); el.className='msg sys'+(err?' err':''); el.textContent=text;
    ca.appendChild(el); ca.scrollTop=ca.scrollHeight;
  }

  _status(text, cls='', ms=0) {
    const el=$('status-line'); if(!el) return;
    el.textContent=text; el.className=cls;
    if (ms) setTimeout(()=>{ if(el.textContent===text){el.textContent='';el.className='';} }, ms);
  }

  _registerTransferMeta(fileId, meta) {
    if (!fileId) return;
    this._transferMeta.set(fileId, { ...meta, fileId });
  }

  _registerOutgoingTransfer(record) {
    this._outTransfers.set(record.transferId, record);
    if (record.folderId) this._transferMeta.set(record.folderId, {
      transferId: record.transferId,
      sessionId: record.sessionId,
      sessionKind: record.sessionKind,
      kind: record.kind,
      folderId: record.folderId,
      own: true,
    });
    (record.fileIds || []).forEach(fileId => this._registerTransferMeta(fileId, {
      transferId:  record.transferId,
      sessionId:   record.sessionId,
      sessionKind: record.sessionKind,
      kind:        record.kind,
      folderId:    record.folderId || null,
      own:         true,
    }));
  }

  _cleanupTransfer(transferId) {
    const record = this._outTransfers.get(transferId);
    if (!record) return;
    if (record.folderId) this._transferMeta.delete(record.folderId);
    (record.fileIds || []).forEach(fileId => this._transferMeta.delete(fileId));
    this._outTransfers.delete(transferId);
  }

  _syncTransferMessage(transferId) {
    const record = this._outTransfers.get(transferId);
    if (!record) return;
    const states = [...record.targets.values()];
    const delivered = states.filter(s => s === 'received').length;
    const total = states.length || 1;
    let status = 'sending';
    if (states.every(s => s === 'received')) status = 'sent';
    else if (states.some(s => s === 'retrying')) status = 'retrying';
    else if (states.some(s => s === 'failed')) status = 'failed';
    else if (states.some(s => s === 'cancelled')) status = 'cancelled';
    this._setMessageStatus(
      m => m.transferId === transferId || m.fileId === transferId || m.folderId === transferId,
      status,
      { deliveryText: total > 1 ? `${delivered}/${total} delivered` : status }
    );
    if (status === 'sent' || status === 'cancelled') this._cleanupTransfer(transferId);
  }

  _markTransferPeerState(fileId, fp, state) {
    const meta = this._transferMeta.get(fileId);
    if (!meta?.own) return;
    const record = this._outTransfers.get(meta.transferId);
    if (!record || !record.targets.has(fp)) return;
    record.targets.set(fp, state);
    this._syncTransferMessage(meta.transferId);
  }

  _requeueTransferToPeer(record, fp) {
    if (!record || !this._canReach(fp)) return;
    record.targets.set(fp, 'sending');
    if (record.kind === 'file') {
      this.ft.send(record.file, fp, record.fileIds[0]);
    } else {
      this.net.sendCtrl(fp, {
        type:        'folder-manifest',
        folderId:    record.folderId,
        transferId:  record.transferId,
        sessionId:   record.sessionId,
        sessionKind: record.sessionKind,
        name:        record.name,
        totalSize:   record.totalSize,
        files:       record.manifest,
      });
      record.entries.forEach((entry, i) => this.ft.send(entry.file, fp, record.manifest[i].fileId));
    }
    this._syncTransferMessage(record.transferId);
  }

  _resumeTransfersForPeer(fp) {
    for (const record of this._outTransfers.values()) {
      if (record.targets.get(fp) === 'retrying') this._requeueTransferToPeer(record, fp);
    }
  }

  _onDeliveryAck(_fp, msg) {
    if (!msg?.messageId) return;
    this._setMessageStatus(m => m.id === msg.messageId, 'sent');
  }

  _onTransferState(fp, msg) {
    const transferId = msg.transferId || msg.folderId || msg.fileId;
    if (!transferId) return;
    const record = this._outTransfers.get(transferId);
    if (!record || !record.targets.has(fp)) return;
    record.targets.set(fp, msg.state || 'received');
    this._syncTransferMessage(transferId);
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────

  _dispatch(fp, msg) {
    const {type}=msg;
    if (type==='nick-update') {
      const p=this.peers.get(fp); if(p&&msg.nick){p.nick=msg.nick;this._renderPeers();if(this.active===fp)this._renderHeader();savePeer({fingerprint:fp,shortId:fp.slice(0,8),nickname:msg.nick}).catch(()=>{});}
      return;
    }
    if (type==='delivery-ack')    { this._onDeliveryAck(fp,msg); return; }
    if (type==='transfer-state')  { this._onTransferState(fp,msg); return; }
    if (type==='call-state')      { this._onCallState(fp,msg); return; }
    if (type==='chat')            { (msg.sessionKind==='circle'||msg.circle)?this._recvCircle(fp,msg):this._recv1to1(fp,msg); return; }
    if (type==='file-meta')       {
      const sid=this._resolveSessionId(fp,msg);
      const sk = msg.sessionKind || (sid===CIRCLE?'circle':'direct');
      this._registerTransferMeta(msg.fileId, { transferId:msg.transferId||msg.fileId, sessionId:sid, sessionKind:sk, kind:'file', own:false, from:fp });
      const fmsg={id:msg.fileId+'_recv',transferId:msg.transferId||msg.fileId,sessionId:sid,from:fp,fromNick:this.peers.get(fp)?.nick||fp.slice(0,8),own:false,type:'file',fileId:msg.fileId,name:msg.name||'file',size:msg.size||0,mimeType:msg.mimeType,ts:Date.now(),status:'receiving'};
      this._pushMsg(sid,fmsg,()=>this._appendFileCard(fmsg));
      this.ft.handleCtrl(fp,msg); return;
    }
    if (type==='file-end'||type==='file-abort') { this.ft.handleCtrl(fp,msg); return; }
    if (type==='folder-manifest')  {
      const sid=this._resolveSessionId(fp,msg);
      const sk = msg.sessionKind || (sid===CIRCLE?'circle':'direct');
      this._transferMeta.set(msg.folderId, { transferId:msg.transferId||msg.folderId, sessionId:sid, sessionKind:sk, kind:'folder', folderId:msg.folderId, own:false, from:fp });
      (msg.files||[]).forEach(file => this._registerTransferMeta(file.fileId, {
        transferId:msg.transferId||msg.folderId,
        sessionId:sid,
        sessionKind:sk,
        kind:'folder',
        folderId:msg.folderId,
        own:false,
        from:fp,
      }));
      const fmsg={id:msg.folderId+'_recv',transferId:msg.transferId||msg.folderId,sessionId:sid,from:fp,fromNick:this.peers.get(fp)?.nick||fp.slice(0,8),own:false,type:'folder',folderId:msg.folderId,name:msg.name||'folder',totalSize:msg.totalSize||0,fileCount:msg.files?.length||0,manifest:msg.files||[],ts:Date.now(),status:'receiving'};
      this._pushMsg(sid,fmsg,()=>this._appendFolderCard(fmsg));
      this.folder.handleCtrl(fp,msg); return;
    }
    const isCircleCall = msg.sessionKind==='circle' || msg.sessionId===CIRCLE || msg.circle;
    if (type==='call-invite')  { isCircleCall?this._onCircleCallInvite(fp,msg):this._onCallInvite(fp,msg); return; }
    if (type==='call-accept')  { isCircleCall?this._onCircleCallAccepted(fp,msg):this._onCallAccepted(fp,msg); return; }
    if (type==='call-decline') { isCircleCall?this._onCircleCallDeclined(fp,msg):this._onCallDeclined(fp,msg); return; }
    if (type==='offer-reneg')  { isCircleCall?this._onCircleOfferReneg(fp,msg):this._onOfferReneg(fp,msg); return; }
    if (type==='answer-reneg') { /* SDP answer handled by webrtc.js _onAnswer via net — no app action needed */ return; }
    if (type==='call-end')     {
      if(isCircleCall && this.circleCall) this._removeCirclePeer(fp, false);
      if(!isCircleCall && this.call?.fp===fp){this._endCallLocal(false);this._status('call ended','info',3000);}
      this._hideCallIncoming(); return;
    }
    if (type==='permission-denied') {
      const nick=this.peers.get(fp)?.nick||fp.slice(0,8);
      this._status(nick+': '+(msg.media||'mic')+' permission denied','err',8000);
      if(!isCircleCall && this.call?.fp===fp) this._endCallLocal(false);
      if(isCircleCall && this.circleCall) {
        const member=this._ensureCircleMember(fp);
        if (member) member.status='permission-denied';
        this._renderCircleCallPanel();
      }
      this._hideCallIncoming(); return;
    }
    if (type==='game') { this._dispatchGame(fp,msg); return; }
  }

  _pushMsg(sessionId, msg, renderFn) {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId,[]);
    this.sessions.get(sessionId).push(msg);
    if (this.active===sessionId) renderFn();
    else { this.unread.set(sessionId,(this.unread.get(sessionId)||0)+1); this._renderPeers(); }
  }

  // ── Chat ───────────────────────────────────────────────────────────────────

  _recv1to1(fp, ev) {
    if (!ev.text) return;
    const sessionId = this._resolveSessionId(fp, ev);
    const msg={id:ev.id||crypto.randomUUID(),sessionId,from:fp,fromNick:ev.nick||this.peers.get(fp)?.nick||fp.slice(0,8),text:String(ev.text),ts:ev.ts||Date.now(),type:'text',own:false,status:'sent'};
    this._pushMsg(sessionId,msg,()=>this._appendMsg(msg)); saveMessage(msg).catch(()=>{});
    this.net.sendCtrl(fp,{type:'delivery-ack',messageId:msg.id,sessionId,sessionKind:'direct'});
  }

  _recvCircle(fp, ev) {
    if (!ev.text||this.circleBlocked.has(fp)) return;
    const msg={id:ev.id||crypto.randomUUID(),sessionId:CIRCLE,from:fp,fromNick:ev.nick||this.peers.get(fp)?.nick||fp.slice(0,8),text:String(ev.text),ts:ev.ts||Date.now(),type:'text',own:false,status:'sent'};
    this._pushMsg(CIRCLE,msg,()=>this._appendMsg(msg)); saveMessage(msg).catch(()=>{});
    this.net.sendCtrl(fp,{type:'delivery-ack',messageId:msg.id,sessionId:CIRCLE,sessionKind:'circle'});
  }

  _send() {
    const inp=$('msg-input'), text=inp?.value?.trim();
    if (!text||!this.active) return;
    const id=crypto.randomUUID(), ts=Date.now();
    if (this.active===CIRCLE) {
      const fps=this._listCirclePeers();
      if (!fps.length) { this._sys('no peers in circle',true); return; }
      fps.forEach(fp=>this.net.sendCtrl(fp,{type:'chat',sessionId:CIRCLE,sessionKind:'circle',id,nick:this.id.nickname,text,ts}));
      const msg={id,sessionId:CIRCLE,from:this.id.fingerprint,fromNick:this.id.nickname,text,ts,type:'text',own:true,status:'sending'};
      this._pushMsg(CIRCLE,msg,()=>this._appendMsg(msg)); saveMessage(msg).catch(()=>{});
    } else {
      const fp=this.active;
      if (!this._canReach(fp)) { this._sys('peer offline — message not sent',true); return; }
      if (!this.net.sendCtrl(fp,{type:'chat',sessionId:fp,sessionKind:'direct',id,nick:this.id.nickname,text,ts})) { this._sys('send failed',true); return; }
      const msg={id,sessionId:fp,from:this.id.fingerprint,fromNick:this.id.nickname,text,ts,type:'text',own:true,status:'sending'};
      this._pushMsg(fp,msg,()=>this._appendMsg(msg)); saveMessage(msg).catch(()=>{});
    }
    if (inp) { inp.value=''; inp.style.height='auto'; }
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  _queueFile(file) {
    if (!file||!this.active) return;
    const sid=this.active;
    const { sessionId, sessionKind } = this._sessionMeta(sid);
    const fps=this._listSessionPeers(sid);
    const isCircle = sid===CIRCLE;
    if (!fps.length) { this._sys(isCircle?'no peers in circle':'peer offline',true); return; }
    const fileId=crypto.randomUUID();
    const fmsg={id:fileId+'_send',transferId:fileId,sessionId:sid,from:this.id.fingerprint,fromNick:this.id.nickname,type:'file',fileId,name:file.name,size:file.size,mimeType:file.type||'application/octet-stream',ts:Date.now(),own:true,status:'sending',deliveryText:isCircle?`0/${fps.length} delivered`:'sending'};
    this._pushMsg(sid,fmsg,()=>this._appendFileCard(fmsg));
    this._registerOutgoingTransfer({
      transferId: fileId,
      kind: 'file',
      sessionId,
      sessionKind,
      file,
      fileIds: [fileId],
      folderId: null,
      targets: new Map(fps.map(fp => [fp, 'sending'])),
    });
    fps.forEach(fp=>this.ft.send(file,fp,fileId));
    this._status('sending '+file.name+'…','info');
  }

  _cancelFile(msg) {
    const {fileId,own,from}=msg; if(!fileId) return;
    if (own) {
      const record=this._outTransfers.get(msg.transferId||fileId);
      if(record){
        record.targets.forEach((_state,fp)=>{ this.ft.cancelSend(fileId,fp); record.targets.set(fp,'cancelled'); });
        this._syncTransferMessage(record.transferId);
      }
    }
    else this.ft.cancelRecv(from,fileId);
  }

  _onFileProg(fileId, pct, stats) {
    document.querySelectorAll(`[data-fcid="${fileId}"] .prog-fill`).forEach(el=>el.style.width=(pct*100).toFixed(1)+'%');
    document.querySelectorAll(`[data-fcid="${fileId}"] .file-stats`).forEach(el=>{
      if(!stats) return;
      el.innerHTML=`<span>${(pct*100).toFixed(1)}%</span><span style="color:var(--mute)">·</span><span>${fmt(stats.bytesTransferred)}/${fmt(stats.totalBytes)}</span><span style="color:var(--mute)">·</span><span>${fmtSpd(stats.speedBps)}</span><span style="color:var(--mute)">·</span><span>${fmtEta(stats.etaSec)}</span>`;
    });
  }

  _onFileReady(f) {
    if (this.folder.claimFile(f)) return;
    this._fileUrls.set(f.fileId, f);
    setTimeout(()=>{ if(this._fileUrls.get(f.fileId)===f) URL.revokeObjectURL(f.url); }, TTL);
    for (const msgs of this.sessions.values()) {
      const m=msgs.find(m=>m.fileId===f.fileId);
      if(m) { m.status='done'; saveMessage(m).catch(()=>{}); }
    }
    const meta = this._transferMeta.get(f.fileId);
    const cards=document.querySelectorAll(`[data-fcid="${f.fileId}"]`);
    cards.forEach(card=>{
      card.querySelector('.prog-track')?.remove(); card.querySelector('.file-stats')?.remove(); card.querySelector('.file-cancel')?.remove();
      if (!card.querySelector('.dl-btn,audio')) this._attachDownload(card,f);
    });
    if (meta && !meta.own) {
      this.net.sendCtrl(f.from,{type:'transfer-state',transferId:meta.transferId,fileId:f.fileId,sessionId:meta.sessionId,sessionKind:meta.sessionKind,state:'received'});
    }
    const nick=this.peers.get(f.from)?.nick||f.from?.slice(0,8)||'?';
    this._status(f.name+(cards.length?' received':' from '+nick+' — open chat to download'),'ok',6000);
  }

  _onFileErr(fileId, errMsg, fp) {
    const meta = this._transferMeta.get(fileId);
    if (fp && meta?.own) {
      this._markTransferPeerState(fileId, fp, errMsg==='Cancelled' ? 'cancelled' : 'retrying');
      if (errMsg !== 'Cancelled') {
        this._status('transfer paused — retrying when peer reconnects','warn',5000);
        return;
      }
    }
    document.querySelectorAll(`[data-fcid="${fileId}"]`).forEach(card=>{
      card.querySelector('.prog-track')?.remove(); card.querySelector('.file-stats')?.remove(); card.querySelector('.file-cancel')?.remove();
      const d=document.createElement('div'); d.className='file-err'; d.textContent='⚠ '+errMsg; card.appendChild(d);
    });
    if (errMsg!=='Cancelled') this._status('file error: '+errMsg,'err',5000);
  }

  // ── Folder ─────────────────────────────────────────────────────────────────

  async _sendFolder() {
    if (!this.active) return;
    const sid=this.active, isCircle=sid===CIRCLE;
    const { sessionId, sessionKind } = this._sessionMeta(sid);
    const fps=this._listSessionPeers(sid);
    if (!fps.length) { this._sys(isCircle?'no peers in circle':'peer offline',true); return; }

    const folderId=crypto.randomUUID();
    let entries; try { entries=await FolderTransfer.pickFiles(); } catch(e){ this._sys('folder error: '+e.message,true); return; }
    if (!entries?.length) return;

    const folderName=entries[0].relativePath.split('/')[0]||'folder';
    let totalSize=0;
    const fileList=entries.map((e,i)=>{ totalSize+=e.file.size; return {fileId:`${folderId}:${i}`,relativePath:e.relativePath,size:e.file.size,mimeType:e.file.type||'application/octet-stream'}; });

    const fmsg={id:folderId+'_send',transferId:folderId,sessionId:sid,from:this.id.fingerprint,fromNick:this.id.nickname,type:'folder',folderId,name:folderName,totalSize,fileCount:fileList.length,manifest:fileList,ts:Date.now(),own:true,status:'sending',deliveryText:isCircle?`0/${fps.length} delivered`:'sending'};
    this._pushMsg(sid,fmsg,()=>this._appendFolderCard(fmsg));
    this._registerOutgoingTransfer({
      transferId: folderId,
      kind: 'folder',
      sessionId,
      sessionKind,
      folderId,
      name: folderName,
      totalSize,
      entries,
      manifest: fileList,
      fileIds: fileList.map(f => f.fileId),
      targets: new Map(fps.map(fp => [fp, 'sending'])),
    });

    fps.forEach(fp=>{
      this.net.sendCtrl(fp,{type:'folder-manifest',folderId,transferId:folderId,sessionId,sessionKind,name:folderName,totalSize,files:fileList});
      entries.forEach((e,i)=>this.ft.send(e.file,fp,fileList[i].fileId));
    });
    this._status(`sending folder "${folderName}" (${fileList.length} files)…`,'info');
  }

  _onFolderProg(folderId, done, total) {
    const card=document.querySelector(`[data-folderid="${folderId}"]`); if(!card) return;
    const fill=card.querySelector('.prog-fill'); if(fill) fill.style.width=((total>0?done/total:0)*100).toFixed(1)+'%';
    const lbl=card.querySelector('.folder-count'); if(lbl) lbl.textContent=`${done} / ${total} files`;
  }

  _onFolderReady(info) {
    const {folderId,name,from,files,manifest,totalSize,downloadZip,downloadAll,download}=info;
    for (const msgs of this.sessions.values()) {
      const m=msgs.find(m=>m.folderId===folderId);
      if (m) {
        m.status='done';
        m.files=files;
        m.manifest=manifest;
        m._downloadFns={downloadZip,downloadAll,download};
        saveMessage(m).catch(()=>{});
      }
    }
    const card=document.querySelector(`[data-folderid="${folderId}"]`);
    if (card) {
      card.querySelector('.prog-track')?.remove(); card.querySelector('.folder-count')?.remove();
      if (!card.querySelector('.folder-dl')) this._finalizeFolderCard(card,{manifest,downloadZip,downloadAll,download});
    }
    const meta = this._transferMeta.get(folderId);
    if (meta && !meta.own) {
      this.net.sendCtrl(from,{type:'transfer-state',transferId:meta.transferId,folderId,sessionId:meta.sessionId,sessionKind:meta.sessionKind,state:'received'});
    }
    const nick=this.peers.get(from)?.nick||from?.slice(0,8)||'?';
    this._status(`folder "${name}" from ${nick} — ${files.length} files, ${fmt(totalSize)}`,'ok',8000);
  }

  _finalizeFolderCard(card, {manifest,downloadZip,downloadAll,download}) {
    if (manifest) {
      const td=document.createElement('div'); td.className='folder-tree';
      td.innerHTML=_renderFolderTree(_buildFileTree(manifest));
      td.querySelectorAll('[data-dl-fid]').forEach(btn=>btn.addEventListener('click',()=>download?.(btn.dataset.dlFid)));
      card.appendChild(td);
    }
    const row=document.createElement('div'); row.className='folder-dl'; row.style.cssText='display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;';
    const zipBtn=document.createElement('button'); zipBtn.className='dl-btn'; zipBtn.textContent='↓ .zip';
    zipBtn.addEventListener('click',()=>{ zipBtn.disabled=true; zipBtn.textContent='building…'; downloadZip?.().finally(()=>{ zipBtn.disabled=false; zipBtn.textContent='↓ .zip'; }); });
    const allBtn=document.createElement('button'); allBtn.className='dl-btn'; allBtn.textContent='↓ all files';
    allBtn.addEventListener('click',()=>downloadAll?.());
    row.appendChild(zipBtn); row.appendChild(allBtn); card.appendChild(row);
  }

  // ── Voice Memo ─────────────────────────────────────────────────────────────

  _startVoiceMemo() {
    const panel=$('memo-panel'); if(!panel) return;
    if (this._memo) { this._memo.cancel(); this._memo=null; }
    panel.classList.add('visible');
    const memo=new VoiceMemo(
      file => { panel.classList.remove('visible'); panel.innerHTML=''; this._memo=null; this._queueFile(file); this._status('voice memo sent','ok',3000); },
      ()   => { panel.classList.remove('visible'); panel.innerHTML=''; this._memo=null; }
    );
    this._memo=memo; memo.start(panel);
  }

  // ── Games ──────────────────────────────────────────────────────────────────

  _startGame(fp, gameType) {
    if (gameType!=='ttt') return;
    this._openSession(fp).then(()=>{
      let game=this.games.get(fp);
      if (!game) {
        game=new TicTacToe(fp,this.id.fingerprint,m=>this.net.sendCtrl(fp,{type:'game',...m}),()=>this.games.delete(fp));
        this.games.set(fp,game);
      }
      this.net.sendCtrl(fp,{type:'game',gameType:'ttt',action:'invite'});
      const ca=$('chat-area'); if(!ca) return;
      const embed=document.createElement('div'); embed.className='tool-embed sent';
      ca.appendChild(embed); ca.scrollTop=ca.scrollHeight; game.render(embed);
    });
  }

  _dispatchGame(fp, msg) {
    let game=this.games.get(fp);
    if (!game&&msg.action==='invite') {
      this._openSession(fp).then(()=>{
        game=new TicTacToe(fp,this.id.fingerprint,m=>this.net.sendCtrl(fp,{type:'game',...m}),()=>this.games.delete(fp));
        this.games.set(fp,game);
        const ca=$('chat-area'); if(!ca) return;
        const embed=document.createElement('div'); embed.className='tool-embed';
        ca.appendChild(embed); ca.scrollTop=ca.scrollHeight; game.render(embed); game.handleMsg(msg);
      });
    } else { game?.handleMsg(msg); }
  }

  // ── 1:1 Calls ──────────────────────────────────────────────────────────────

  _callPayload(call, extra={}) {
    return { callId:call.callId, sessionId:call.sessionId, sessionKind:call.sessionKind, ...extra };
  }

  _callPeers(call=this.call||this.circleCall) {
    if (!call) return [];
    return call.sessionKind === 'circle' ? [...call.members.keys()] : [call.fp];
  }

  _broadcastCallState(state, extra={}) {
    const call=this.call||this.circleCall; if(!call) return;
    this._callPeers(call).forEach(fp => {
      if (this._canReach(fp)) this.net.sendCtrl(fp, { type:'call-state', ...this._callPayload(call, { state, ...extra }) });
    });
  }

  _resumeDirectCall(fp) {
    if (!this.call?.localStream || this.call.fp !== fp || !this._canReach(fp)) return;
    this.net.ensurePeer(fp, this.peers.get(fp)?.nick);
    this.call.phase = 'connecting';
    this.net.sendCtrl(fp, {
      type:'call-invite',
      callType:this.call.type,
      nick:this.id.nickname,
      reconnecting:true,
      ...this._callPayload(this.call),
    });
    this._renderCallPanel();
  }

  _onCallState(fp, msg) {
    const isCircle = msg.sessionKind === 'circle' || msg.sessionId === CIRCLE || msg.circle;
    if (isCircle) { this._onCircleCallState(fp, msg); return; }
    if (!this.call || this.call.fp !== fp || (msg.callId && this.call.callId !== msg.callId)) return;
    if (msg.state === 'muted') this.call.remoteMuted = true;
    if (msg.state === 'unmuted') this.call.remoteMuted = false;
    if (msg.state === 'camera-off') this.call.remoteCamOff = true;
    if (msg.state === 'camera-on') this.call.remoteCamOff = false;
    if (msg.state === 'reconnecting') this.call.phase = 'reconnecting';
    if (msg.state === 'rejoined' && this.call.phase === 'reconnecting') this.call.phase = 'connecting';
    if (msg.state === 'ended') this._endCallLocal(false);
    this._renderCallPanel();
  }

  async _startCall(fp, callType) {
    if (!this._canReach(fp)) { this._sys('peer offline',true); return; }
    if (this.call || this.circleCall) { this._sys('already in a call',true); return; }
    const video=callType==='stream';
    let s; try { s=await navigator.mediaDevices.getUserMedia({audio:true,video}); } catch(e){ this._handleMediaError(e); return; }
    this.net.ensurePeer(fp, this.peers.get(fp)?.nick);
    this.call={callId:crypto.randomUUID(),sessionId:fp,sessionKind:'direct',fp,type:callType,phase:'inviting',localStream:s,remoteStream:null,muted:false,camOff:false,remoteMuted:false,remoteCamOff:false,inviteTimer:setTimeout(()=>this._onCallTimeout(fp),45_000)};
    this.net.sendCtrl(fp,{type:'call-invite',callType,nick:this.id.nickname,...this._callPayload(this.call)});
    this._status(callType+' — calling '+(this.peers.get(fp)?.nick||fp.slice(0,8))+'…','info');
    this._renderCallPanel();
  }

  _onCallInvite(fp, msg) {
    const incomingId = msg.callId || crypto.randomUUID();
    if (this.circleCall) { this.net.sendCtrl(fp,{type:'call-decline',reason:'busy',callId:incomingId,sessionId:fp,sessionKind:'direct'}); return; }
    if (this.call?.fp===fp && this.call.callId===incomingId && this.call.localStream) {
      this.call.phase='connecting';
      this.net.sendCtrl(fp,{type:'call-accept',...this._callPayload(this.call)});
      this._renderCallPanel();
      return;
    }
    if (this.call&&this.call.fp!==fp) { this.net.sendCtrl(fp,{type:'call-decline',reason:'busy',callId:incomingId,sessionId:fp,sessionKind:'direct'}); return; }
    this.call={callId:incomingId,sessionId:fp,sessionKind:'direct',fp,type:msg.callType==='stream'?'stream':'walkie',phase:'ringing',localStream:null,remoteStream:null,muted:false,camOff:false,remoteMuted:false,remoteCamOff:false};
    this._showCallIncoming(fp,msg.callType||'walkie',msg.nick,false);
    this._renderCallPanel();
  }

  _onCallAccepted(fp, msg) {
    if (!this.call||this.call.fp!==fp) return;
    if (msg?.callId && this.call.callId !== msg.callId) return;
    clearTimeout(this.call.inviteTimer); this.call.phase='connecting';
    this.net.ensurePeer(fp, this.peers.get(fp)?.nick);
    this.net.offerWithStream(fp,this.call.localStream,this._callPayload(this.call))
      .then(()=>this._attachRemote1to1(fp))
      .catch(e=>{ this._status('call failed: '+e.message,'err',5000); this._endCallLocal(true); });
  }

  _onCallDeclined(fp, msg) {
    if (!this.call||this.call.fp!==fp) return;
    if (msg?.callId && this.call.callId !== msg.callId) return;
    clearTimeout(this.call.inviteTimer);
    this.net.stopMedia(fp);
    this.call.localStream?.getTracks().forEach(t=>t.stop()); this.call=null; this._renderCallPanel();
    this._status((this.peers.get(fp)?.nick||fp.slice(0,8))+' declined','warn',5000);
  }

  _onCallTimeout(fp) {
    if (!this.call||this.call.fp!==fp) return;
    this.net.stopMedia(fp);
    this.call.localStream?.getTracks().forEach(t=>t.stop()); this.call=null; this._renderCallPanel();
    this._status('no answer — timed out','warn',5000);
  }

  async _acceptCall(fp) {
    if (!this.call||this.call.fp!==fp||this.call.phase!=='ringing') return;
    this._hideCallIncoming();
    const video=this.call.type==='stream';
    let s; try { s=await navigator.mediaDevices.getUserMedia({audio:true,video}); }
    catch(e){ this.net.sendCtrl(fp,{type:'permission-denied',media:video?'camera/mic':'microphone',...this._callPayload(this.call)}); this.call=null; this._renderCallPanel(); this._handleMediaError(e); return; }
    this.call.localStream=s; this.call.phase='connecting';
    this.net.ensurePeer(fp, this.peers.get(fp)?.nick);
    this.net.sendCtrl(fp,{type:'call-accept',...this._callPayload(this.call)});
    await this._openSession(fp); this._renderCallPanel();
  }

  _declineCall(fp) {
    this._hideCallIncoming();
    if (this.call?.fp===fp) {
      this.net.sendCtrl(fp,{type:'call-decline',...this._callPayload(this.call)});
      this.call.localStream?.getTracks().forEach(t=>t.stop()); this.call=null;
    }
    this._renderCallPanel();
  }

  _onOfferReneg(fp, msg) {
    if (!this.call||this.call.fp!==fp||!this.call.localStream) return;
    if (msg?.callId && this.call.callId !== msg.callId) return;
    this.net.answerWithStream(fp, msg.sdp, this.call.localStream, this._callPayload(this.call))
      .then(()=>this._attachRemote1to1(fp))
      .catch(e=>{ this._status('call answer failed: '+e.message,'err',5000); this._endCallLocal(true); });
  }

  _attachRemote1to1(fp) {
    this.net.setRemoteStreamHandler(fp, stream => {
      if (!stream) return;
      this._audioEl.srcObject=stream; this._audioEl.play().catch(()=>{});
      if (this.call?.fp===fp) {
        this.call.remoteStream=stream; this.call.phase='active';
        this._renderCallPanel();
        this._startStatsPolling(fp);
        this.net.sendCtrl(fp,{type:'call-state',...this._callPayload(this.call,{state:'rejoined'})});
        this._status(this.call.type+' on · '+(this.peers.get(fp)?.nick||fp.slice(0,8)),'ok');
      }
    });
  }

  async _endCallLocal(sendEnd=true) {
    if (!this.call) return;
    const fp=this.call.fp;
    clearTimeout(this.call.inviteTimer);
    if (sendEnd && this._canReach(fp)) this.net.sendCtrl(fp,{type:'call-end',...this._callPayload(this.call)});
    this.net.stopMedia(fp);
    this.call.localStream?.getTracks().forEach(t=>t.stop());
    this.call=null; this._stopStatsPolling();
    this._audioEl.srcObject=null; this._renderCallPanel();
  }

  // ── Circle calls ───────────────────────────────────────────────────────────

  _ensureCircleMember(fp, nick) {
    if (!this.circleCall) return null;
    if (!this.circleCall.members) this.circleCall.members = new Map();
    if (!this.circleCall.members.has(fp)) {
      this.circleCall.members.set(fp, {
        nick: nick || this.peers.get(fp)?.nick || fp.slice(0,8),
        status: 'connecting',
        muted: false,
        camOff: false,
      });
    }
    const member = this.circleCall.members.get(fp);
    if (nick) member.nick = nick;
    return member;
  }

  _resumeCirclePeer(fp) {
    if (!this.circleCall?.localStream || !this._canReach(fp) || this.circleBlocked.has(fp)) return;
    const member = this._ensureCircleMember(fp);
    if (!member) return;
    member.status = 'connecting';
    this.net.ensurePeer(fp, member.nick);
    this.net.sendCtrl(fp, {
      type:'call-invite',
      callType:this.circleCall.type,
      nick:this.id.nickname,
      reconnecting:true,
      circle:true,
      ...this._callPayload(this.circleCall),
    });
    this._renderCircleCallPanel();
  }

  _onCircleCallState(fp, msg) {
    if (!this.circleCall || (msg.callId && this.circleCall.callId !== msg.callId)) return;
    const member = this._ensureCircleMember(fp);
    if (!member) return;
    if (msg.state === 'muted') member.muted = true;
    if (msg.state === 'unmuted') member.muted = false;
    if (msg.state === 'camera-off') member.camOff = true;
    if (msg.state === 'camera-on') member.camOff = false;
    if (msg.state === 'reconnecting') member.status = 'reconnecting';
    if (msg.state === 'rejoined' && member.status === 'reconnecting') member.status = 'connecting';
    if (msg.state === 'ended') member.status = 'ended';
    if (msg.state === 'reconnecting' && !this.circleCall.remoteStreams.size) this.circleCall.phase = 'reconnecting';
    if (msg.state === 'rejoined') this.circleCall.phase = 'connecting';
    this._renderCircleCallPanel();
  }

  async _startCircleCall(callType) {
    if (this.call || this.circleCall) { this._sys('already in a call',true); return; }
    const fps=this._listCirclePeers();
    if (!fps.length) { this._sys('no peers in circle',true); return; }
    const video=callType==='stream';
    let s; try { s=await navigator.mediaDevices.getUserMedia({audio:true,video}); } catch(e){ this._handleMediaError(e); return; }
    this.circleCall={callId:crypto.randomUUID(),sessionId:CIRCLE,sessionKind:'circle',type:callType,phase:'connecting',localStream:s,remoteStreams:new Map(),audioEls:new Map(),members:new Map(),muted:false,camOff:false};
    fps.forEach(fp=>{
      const member=this._ensureCircleMember(fp);
      member.status='invited';
      this.net.ensurePeer(fp, member.nick);
      this.net.sendCtrl(fp,{type:'call-invite',callType,nick:this.id.nickname,circle:true,...this._callPayload(this.circleCall)});
      this._attachCircleRemote(fp);
    });
    this._renderCircleCallPanel();
  }

  _onCircleCallInvite(fp, msg) {
    if (this.call) { this.net.sendCtrl(fp,{type:'call-decline',reason:'busy',circle:true,callId:msg.callId,sessionId:CIRCLE,sessionKind:'circle'}); return; }
    const callType=msg.callType==='stream'?'stream':'walkie';
    if (this.circleCall?.localStream && this.circleCall.callId === msg.callId) {
      const member=this._ensureCircleMember(fp, msg.nick);
      member.status='connecting';
      this.net.sendCtrl(fp,{type:'call-accept',circle:true,...this._callPayload(this.circleCall)});
      this._attachCircleRemote(fp); this._renderCircleCallPanel(); return;
    }
    if (this.circleCall?.localStream && this.circleCall.callId !== msg.callId) {
      this.net.sendCtrl(fp,{type:'call-decline',reason:'busy',circle:true,callId:msg.callId,sessionId:CIRCLE,sessionKind:'circle'});
      return;
    }
    if (!this.circleCall) this.circleCall={callId:msg.callId||crypto.randomUUID(),sessionId:CIRCLE,sessionKind:'circle',type:callType,phase:'ringing',localStream:null,remoteStreams:new Map(),audioEls:new Map(),members:new Map(),muted:false,camOff:false};
    const member=this._ensureCircleMember(fp, msg.nick);
    member.status='ringing';
    this._showCallIncoming(fp,callType,msg.nick,true);
    this._renderCircleCallPanel();
  }

  async _acceptCircleCall(fp) {
    if (!this.circleCall) return;
    this._hideCallIncoming();
    const video=this.circleCall.type==='stream';
    let s=this.circleCall.localStream;
    if (!s) {
      try { s=await navigator.mediaDevices.getUserMedia({audio:true,video}); }
      catch(e){
        this.net.sendCtrl(fp,{type:'permission-denied',media:video?'camera/mic':'microphone',circle:true,...this._callPayload(this.circleCall)});
        this.circleCall=null;
        this._renderCircleCallPanel();
        this._handleMediaError(e);
        return;
      }
      this.circleCall.localStream=s;
    }
    this.circleCall.phase='connecting';
    const member=this._ensureCircleMember(fp);
    member.status='connecting';
    this.net.ensurePeer(fp, member.nick);
    this.net.sendCtrl(fp,{type:'call-accept',circle:true,...this._callPayload(this.circleCall)});
    this._attachCircleRemote(fp);
    this._listCirclePeers()
      .filter(p=>p!==fp && !this.circleCall.members.has(p))
      .forEach(p=>{
        const m=this._ensureCircleMember(p);
        m.status='invited';
        this.net.ensurePeer(p, m.nick);
        this.net.sendCtrl(p,{type:'call-invite',callType:this.circleCall.type,nick:this.id.nickname,circle:true,...this._callPayload(this.circleCall)});
        this._attachCircleRemote(p);
      });
    this._renderCircleCallPanel();
  }

  _declineCircleCall(fp) {
    if (!this.circleCall) return;
    this._hideCallIncoming();
    this.net.sendCtrl(fp,{type:'call-decline',circle:true,...this._callPayload(this.circleCall)});
    this.circleCall = null;
    this._renderCircleCallPanel();
  }

  _onCircleCallAccepted(fp, msg) {
    if (!this.circleCall?.localStream) return;
    if (msg?.callId && this.circleCall.callId !== msg.callId) return;
    const member=this._ensureCircleMember(fp);
    member.status='connecting';
    this.circleCall.phase='connecting';
    this.net.ensurePeer(fp, member.nick);
    this.net.offerWithStream(fp,this.circleCall.localStream,this._callPayload(this.circleCall)).then(()=>this._attachCircleRemote(fp)).catch(()=>{ member.status='reconnecting'; this._renderCircleCallPanel(); });
    this._renderCircleCallPanel();
  }

  _onCircleCallDeclined(fp, msg) {
    if (!this.circleCall || (msg?.callId && this.circleCall.callId !== msg.callId)) return;
    const member=this._ensureCircleMember(fp);
    member.status='declined';
    this._status((this.peers.get(fp)?.nick||fp.slice(0,8))+' declined circle call','warn',3000);
    this._renderCircleCallPanel();
  }

  _onCircleOfferReneg(fp, msg) {
    if (!this.circleCall?.localStream||!msg.sdp) return;
    if (msg?.callId && this.circleCall.callId !== msg.callId) return;
    const member=this._ensureCircleMember(fp);
    member.status='connecting';
    this.net.answerWithStream(fp, msg.sdp, this.circleCall.localStream, this._callPayload(this.circleCall)).catch(()=>{ member.status='reconnecting'; });
    this.circleCall.phase='connecting'; this._renderCircleCallPanel();
  }

  _attachCircleRemote(fp) {
    this.net.setRemoteStreamHandler(fp, stream => {
      if (!stream||!this.circleCall) return;
      const member=this._ensureCircleMember(fp);
      this.circleCall.remoteStreams.set(fp,stream);
      let el=this.circleCall.audioEls.get(fp);
      if (!el) { el=Object.assign(document.createElement('audio'),{autoplay:true,playsInline:true,style:'display:none'}); document.body.appendChild(el); this.circleCall.audioEls.set(fp,el); }
      el.srcObject=stream; el.play().catch(()=>{});
      member.status='active';
      this.circleCall.phase='active';
      this.net.sendCtrl(fp,{type:'call-state',circle:true,...this._callPayload(this.circleCall,{state:'rejoined'})});
      this._renderCircleCallPanel();
    });
  }

  _removeCirclePeer(fp, reconnecting=false) {
    if (!this.circleCall) return;
    this.circleCall.remoteStreams.delete(fp);
    const el=this.circleCall.audioEls.get(fp);
    if (el) { el.srcObject=null; try{el.remove();}catch{} this.circleCall.audioEls.delete(fp); }
    const member=this._ensureCircleMember(fp);
    if (member) member.status = reconnecting ? 'reconnecting' : 'ended';
    this.circleCall.phase = reconnecting && !this.circleCall.remoteStreams.size ? 'reconnecting' : (this.circleCall.remoteStreams.size ? 'active' : 'connecting');
    this._renderCircleCallPanel();
  }

  _endCircleCall() {
    if (!this.circleCall) return;
    this.circleCall.localStream?.getTracks().forEach(t=>t.stop());
    this.circleCall.audioEls.forEach(el=>{ try{el.srcObject=null;el.remove();}catch{} });
    [...this.circleCall.members.keys()].forEach(fp=>{ if (this._canReach(fp)) this.net.sendCtrl(fp,{type:'call-end',circle:true,...this._callPayload(this.circleCall)}); this.net.stopMedia(fp); });
    this.circleCall=null; this._renderCircleCallPanel();
    this._status('circle call ended','info',3000);
  }

  // ── Call UI ────────────────────────────────────────────────────────────────

  _callPhaseText(call) {
    if (!call) return '';
    if (call.sessionKind === 'circle') {
      if (call.phase === 'ringing') return 'incoming circle call…';
      if (call.phase === 'connecting') return 'joining circle…';
      if (call.phase === 'reconnecting') return 'reconnecting circle…';
      return call.remoteStreams?.size ? 'circle live' : 'waiting for peers to join…';
    }
    if (call.phase === 'ringing') return 'incoming call…';
    if (call.phase === 'inviting') return 'calling…';
    if (call.phase === 'reconnecting') return 'reconnecting…';
    if (call.phase === 'connecting') return 'connecting…';
    return 'call live';
  }

  _renderCallBanner(call) {
    const banner=$('call-banner'); if(!banner) return;
    banner.textContent = call ? this._callPhaseText(call) : '';
  }

  _renderParticipantMeta(call) {
    const wrap=$('call-participants'); if(!wrap) return;
    wrap.innerHTML='';
    if (!call) return;
    const peers = call.sessionKind === 'circle'
      ? [...call.members.entries()].map(([fp,m]) => ({ fp, nick:m.nick||this.peers.get(fp)?.nick||fp.slice(0,8), status:m.status, muted:m.muted, camOff:m.camOff }))
      : [{ fp:call.fp, nick:this.peers.get(call.fp)?.nick||call.fp.slice(0,8), status:call.phase, muted:call.remoteMuted, camOff:call.remoteCamOff }];
    peers.forEach(p => {
      const chip=document.createElement('div');
      chip.className='call-chip';
      chip.textContent = `${p.nick} · ${p.status}${p.muted?' · muted':''}${p.camOff?' · cam off':''}`;
      wrap.appendChild(chip);
    });
  }

  _renderCallPanel() {
    const panel=$('call-panel'); if(!panel) return;
    const c=this.call;
    // Clean up previous PIP and its listeners before re-rendering
    this._pipCleanup?.(); this._pipCleanup=null;
    panel.querySelectorAll('.call-pip').forEach(el=>el.remove());
    if (!c) { panel.classList.remove('visible'); this._stopStatsPolling(); this._renderCallBanner(null); this._renderParticipantMeta(null); return; }
    panel.classList.add('visible');
    this._renderCallBanner(c);
    this._renderParticipantMeta(c);
    const vids=$('call-videos'); if(!vids) return;
    vids.innerHTML='';

    const remote=document.createElement('div');
    remote.className='call-video-tile'+(c.remoteCamOff?' media-off':'');
    if (c.type === 'stream' && c.remoteStream && !c.remoteCamOff) {
      const v=document.createElement('video'); v.autoplay=true; v.playsInline=true; v.srcObject=c.remoteStream; remote.appendChild(v);
    } else {
      const ph=document.createElement('div'); ph.className='call-placeholder';
      ph.textContent = c.type==='walkie' ? 'walkie connected' : (c.remoteCamOff ? 'camera off' : this._callPhaseText(c));
      remote.appendChild(ph);
    }
    const lbl=document.createElement('div'); lbl.className='vtile-label'; lbl.textContent=(this.peers.get(c.fp)?.nick||c.fp.slice(0,8))+(c.remoteMuted?' · muted':''); remote.appendChild(lbl);
    vids.appendChild(remote);
    const pip=document.createElement('div'); pip.className='call-pip'+(c.camOff?' cam-off':'');
    if (c.localStream&&c.type==='stream'&&!c.camOff) { const v=document.createElement('video'); v.autoplay=true; v.playsInline=true; v.muted=true; v.srcObject=c.localStream; pip.appendChild(v); }
    panel.appendChild(pip);
    this._pipCleanup=this._makePIPDraggable(pip);
    const mu=$('ctrl-mute'); if(mu) { mu.textContent=c.muted?'unmute':'mute'; mu.classList.toggle('active',!!c.muted); }
    const cam=$('ctrl-cam');
    if (cam) {
      cam.style.display = c.type==='walkie' ? 'none' : '';
      cam.textContent = c.camOff?'cam on':'cam off';
      cam.classList.toggle('active', !!c.camOff);
    }
  }

  _renderCircleCallPanel() {
    const panel=$('call-panel'); if(!panel) return;
    this._pipCleanup?.(); this._pipCleanup=null;
    panel.querySelectorAll('.call-pip').forEach(el=>el.remove());
    const cc=this.circleCall;
    if (!cc) { panel.classList.remove('visible'); this._renderCallBanner(null); this._renderParticipantMeta(null); return; }
    panel.classList.add('visible');
    this._renderCallBanner(cc);
    this._renderParticipantMeta(cc);
    const vids=$('call-videos'); if(!vids) return;
    vids.innerHTML='';

    if (!cc.members.size) {
      const ph = document.createElement('div');
      ph.className='call-placeholder solo';
      ph.textContent='waiting for peers to join…';
      vids.appendChild(ph);
    }

    cc.members.forEach((member, fp) => {
      const tile = document.createElement('div');
      tile.className = 'call-video-tile'+(member.camOff?' media-off':'');
      const stream = cc.remoteStreams.get(fp);
      if (cc.type === 'stream' && stream && !member.camOff) {
        const v = document.createElement('video');
        v.autoplay=true; v.playsInline=true; v.muted=false; v.srcObject=stream;
        tile.appendChild(v);
      } else {
        const ph = document.createElement('div');
        ph.className='call-placeholder';
        ph.textContent = cc.type==='walkie' ? (member.status==='active'?'walkie live':member.status) : (member.camOff?'camera off':member.status);
        tile.appendChild(ph);
      }
      const lbl = document.createElement('div');
      lbl.className = 'vtile-label';
      lbl.textContent = (member.nick || this.peers.get(fp)?.nick || fp.slice(0,8)) + (member.muted?' · muted':'');
      tile.appendChild(lbl);
      vids.appendChild(tile);
    });

    const pip = document.createElement('div');
    pip.className = 'call-pip' + (cc.camOff?' cam-off':'');
    if (cc.localStream && cc.type === 'stream' && !cc.camOff) {
      const v = document.createElement('video');
      v.autoplay=true; v.playsInline=true; v.muted=true; v.srcObject=cc.localStream;
      pip.appendChild(v);
    }
    panel.appendChild(pip);
    this._pipCleanup = this._makePIPDraggable(pip);

    const mu = $('ctrl-mute'); if (mu) { mu.textContent = cc.muted ? 'unmute' : 'mute'; mu.classList.toggle('active', !!cc.muted); }
    const cam = $('ctrl-cam');
    if (cam) {
      cam.style.display = cc.type === 'walkie' ? 'none' : '';
      cam.textContent = cc.camOff ? 'cam on' : 'cam off';
      cam.classList.toggle('active', !!cc.camOff);
    }
  }

  /** Returns a cleanup function that removes all added listeners. */
  _makePIPDraggable(el) {
    let ox=0,oy=0,mx=0,my=0,dragging=false;
    const start=e=>{ dragging=true; const s=e.touches?e.touches[0]:e; mx=s.clientX; my=s.clientY; ox=el.offsetLeft; oy=el.offsetTop; };
    const move =e=>{ if(!dragging) return; const s=e.touches?e.touches[0]:e; el.style.left=(ox+s.clientX-mx)+'px'; el.style.top=(oy+s.clientY-my)+'px'; el.style.right='auto'; el.style.bottom='auto'; };
    const end  =()=>{ dragging=false; };
    el.addEventListener('mousedown',start); el.addEventListener('touchstart',start,{passive:true});
    document.addEventListener('mousemove',move); document.addEventListener('touchmove',move,{passive:true});
    document.addEventListener('mouseup',end);   document.addEventListener('touchend',end);
    return () => {
      el.removeEventListener('mousedown',start); el.removeEventListener('touchstart',start);
      document.removeEventListener('mousemove',move); document.removeEventListener('touchmove',move);
      document.removeEventListener('mouseup',end);   document.removeEventListener('touchend',end);
    };
  }

  _showCallIncoming(fp, callType, nick, circle) {
    const el=$('call-incoming'); if(!el) return;
    const caller=$('ci-caller-name'); if(caller) caller.textContent=(nick||fp.slice(0,8))+' · '+callType+(circle?' (circle)':'');
    el.dataset.callFp=fp; el.dataset.circle=circle?'1':'';
    el.classList.add('visible');
  }
  _hideCallIncoming() { $('call-incoming')?.classList.remove('visible'); }

  _toggleMute() {
    const c=this.call||this.circleCall; if(!c) return;
    c.muted=!c.muted; (c.localStream||null)?.getAudioTracks().forEach(t=>{t.enabled=!c.muted;});
    const btn=$('ctrl-mute'); if(btn) { btn.textContent=c.muted?'unmute':'mute'; btn.classList.toggle('active',c.muted); }
    this._broadcastCallState(c.muted?'muted':'unmuted');
    if (this.call) this._renderCallPanel();
    if (this.circleCall) this._renderCircleCallPanel();
  }

  _toggleCam() {
    const c=this.call||this.circleCall; if(!c) return;
    c.camOff=!c.camOff; (c.localStream||null)?.getVideoTracks().forEach(t=>{t.enabled=!c.camOff;});
    const btn=$('ctrl-cam'); if(btn) { btn.textContent=c.camOff?'cam on':'cam off'; btn.classList.toggle('active',c.camOff); }
    this._broadcastCallState(c.camOff?'camera-off':'camera-on');
    if (this.call) this._renderCallPanel();
    if (this.circleCall) this._renderCircleCallPanel();
  }

  _startStatsPolling(fp) {
    this._stopStatsPolling();
    this._statsTimer=setInterval(async()=>{
      const s=await this.net.getStats?.(fp); if(!s) return;
      const el=$('call-stats'); if(el) el.textContent=s.rtt?`rtt ${(s.rtt*1000).toFixed(0)}ms`:'';
    },3000);
  }
  _stopStatsPolling() { clearInterval(this._statsTimer); this._statsTimer=null; }

  _handleMediaError(e) {
    const msg=e.name==='NotAllowedError'?'mic/cam permission denied':'no mic/cam found';
    this._status(msg,'err',8000);
  }

  // ── State import/export ────────────────────────────────────────────────────

  async _exportState() {
    try {
      const msgs=await loadAllMessages();
      const ps=await loadPeers();
      const keys=await this.id.exportKeyData?.();
      const blob=new Blob([JSON.stringify({v:7,msgs,peers:ps,identity:{...keys,nickname:this.id.nickname}})],{type:'application/json'});
      const url=URL.createObjectURL(blob);
      const a=Object.assign(document.createElement('a'),{href:url,download:`turquoise-${Date.now()}.json`,style:'display:none'});
      document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); },5000);
    } catch(e){ this._status('export failed: '+e.message,'err',5000); }
  }

  async _importState(file) {
    try {
      const data=JSON.parse(await file.text());
      if (data.msgs) await restoreMessages(data.msgs);
      if (data.peers) await restorePeers(data.peers);
      if (data.identity?.privJwk) {
        await importIdentityData(data.identity);
        this._status('identity imported — reloading…','ok');
        setTimeout(()=>location.reload(),1500);
      } else {
        this._status(`imported ${data.msgs?.length||0} messages`,'ok',5000);
      }
    } catch(e){ this._status('import failed: '+e.message,'err',5000); }
  }

  async _confirmReset() {
    if (!confirm('Reset identity and clear all data? This cannot be undone.')) return;
    await clearAllData().catch(()=>{});
    await resetIdentity();
    location.reload();
  }
}
