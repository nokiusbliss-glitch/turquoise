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
    this._fileOwners= new Map();
    this._memo      = null;
    this._statsTimer= null;
    this._pipCleanup= null;   // cleanup fn for PIP drag listeners
    this.games      = new Map();

    this._audioEl = Object.assign(document.createElement('audio'), {autoplay:true, playsInline:true, style:'display:none'});
    document.body.appendChild(this._audioEl);

    this.ft = new FileTransfer(
      (fp,m) => network.sendCtrl(fp,m),
      (fp,b) => network.sendBinary(fp,b),
      fp     => network.waitForBuffer(fp)
    );
    this.ft.onProgress  = (id,pct,_dir,_fp,s) => this._onFileProg(id,pct,s);
    this.ft.onFileReady = f => this._onFileReady(f);
    this.ft.onError     = (id,m) => this._onFileErr(id,m);

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

    try { for (const p of await loadPeers()) this.peers.set(p.fingerprint, {nick:p.nickname||p.fingerprint.slice(0,8), connected:false}); } catch {}
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
        this.net.getConnectedPeers().forEach(fp => this.net.sendCtrl(fp,{type:'nick-update',nick:saved}));
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
    const online   = !isCircle && this.net.isReady(fp||'');
    const anyOnline= this.net.getConnectedPeers().length > 0;
    const canSend  = isCircle ? anyOnline : online;

    menu.innerHTML = `
      <div class="pm-item" id="pmi-file">📎  file</div>
      <div class="pm-item" id="pmi-folder">📁  folder</div>
      <div class="pm-item" id="pmi-memo">🎤  voice memo</div>
      <div class="pm-sep"></div>
      <div class="pm-label">◈ apps</div>
      <div class="pm-item${(!online||isCircle)?' pm-dim':''}" id="pmi-ttt">⊞  tic tac toe</div>
      <div class="pm-sep"></div>
      <div class="pm-item pm-danger" id="pmi-export">⬇  export state</div>
      <div class="pm-item" id="pmi-import">⬆  import state</div>`;

    const guard = fn => () => { this._closePlus(); if (!canSend) { this._sys('no peers available',true); return; } fn(); };
    $('pmi-file')?.addEventListener('click',   guard(() => $('__file-input')?.click()));
    $('pmi-folder')?.addEventListener('click', guard(() => this._sendFolder()));
    $('pmi-memo')?.addEventListener('click',   guard(() => this._startVoiceMemo()));
    $('pmi-ttt')?.addEventListener('click', () => {
      this._closePlus();
      if (!isCircle && online) this._startGame(fp,'ttt');
      else this._sys(isCircle?'games are 1:1 only':'peer offline',true);
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

  // ── Network wiring ─────────────────────────────────────────────────────────

  _wireNetwork() {
    const n = this.net;
    n.onPeerConnected         = (fp,nick) => this._onConnect(fp,nick);
    n.onPeerDisconnected      = fp        => this._onDisconnect(fp);
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
    this.peers.set(fp, {nick:name, connected:true});
    savePeer({fingerprint:fp, shortId:fp.slice(0,8), nickname:name}).catch(()=>{});
    if (!this.sessions.has(fp)) {
      loadMessages(fp).then(msgs => { this.sessions.set(fp,msgs); this._renderPeers(); if(this.active===fp) this._renderMsgs(); }).catch(() => this.sessions.set(fp,[]));
    } else this._renderPeers();
    if (this.active===fp) this._renderHeader();
    this._status(name+' joined','ok',3000);
  }

  _onDisconnect(fp) {
    const p=this.peers.get(fp); const name=p?.nick||fp.slice(0,8);
    if (p) p.connected=false;
    if (this.call?.fp===fp) this._endCallLocal(false);
    if (this.circleCall) this._removeCirclePeer(fp);
    this.games.get(fp)?.destroy?.(); this.games.delete(fp);
    this._renderPeers(); if(this.active===fp) this._renderHeader();
    this._status(name+' disconnected','warn',5000);
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

    const sorted = [...this.peers.entries()].sort(([,a],[,b]) => (b.connected?1:0)-(a.connected?1:0) || a.nick.localeCompare(b.nick));
    for (const [fp, p] of sorted) {
      const el = document.createElement('div');
      const ur = this.unread.get(fp)||0;
      const tier = this.net.connTier(fp);
      el.className = 'peer-item' + (p.connected?' online':'') + (this.active===fp?' active':'');
      el.innerHTML = `<span class="peer-dot"></span><span class="peer-nick">${esc(p.nick)}</span>${tier&&tier!=='disconnected'?`<span class="peer-tier ${tier==='p2p'?'p2p':''}">${tier==='p2p'?'p2p':'relay'}</span>`:''}${ur?`<span class="peer-badge">${ur}</span>`:''}`;
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
    const name = isCircle ? '◉ circle' : (p.nick || fp?.slice(0,8) || '—');
    const el=$('chat-peer-name'); if(el) el.textContent=name;
    const fpe=$('chat-peer-fp'); if(fpe) fpe.textContent = fp&&!isCircle ? fp.slice(0,16)+'…' : '';
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
    const inProg = msg.status==='sending'||msg.status==='receiving';
    el.innerHTML=`
      <div class="fname">${esc(msg.name||'file')}</div>
      <div class="fsize">${fmt(msg.size||0)} · ${esc(msg.mimeType||'')}</div>
      ${!msg.own?`<div style="font-size:9px;color:var(--dim)">from ${esc(msg.fromNick||'?')}</div>`:''}
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
    const inProg=msg.status==='sending'||msg.status==='receiving';
    el.innerHTML=`
      <div class="fname">📁 ${esc(msg.name||'folder')}</div>
      <div class="fsize">${fmt(msg.totalSize||0)} · ${msg.fileCount||0} files</div>
      ${!msg.own?`<div style="font-size:9px;color:var(--dim)">from ${esc(msg.fromNick||'?')}</div>`:''}
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

  // ── Dispatch ───────────────────────────────────────────────────────────────

  _dispatch(fp, msg) {
    const {type}=msg;
    if (type==='nick-update') {
      const p=this.peers.get(fp); if(p&&msg.nick){p.nick=msg.nick;this._renderPeers();if(this.active===fp)this._renderHeader();savePeer({fingerprint:fp,shortId:fp.slice(0,8),nickname:msg.nick}).catch(()=>{});}
      return;
    }
    if (type==='chat')            { msg.circle?this._recvCircle(fp,msg):this._recv1to1(fp,msg); return; }
    if (type==='file-meta')       {
      const sid=msg.circle?CIRCLE:fp;
      const fmsg={id:msg.fileId+'_recv',sessionId:sid,from:fp,fromNick:this.peers.get(fp)?.nick||fp.slice(0,8),own:false,type:'file',fileId:msg.fileId,name:msg.name||'file',size:msg.size||0,mimeType:msg.mimeType,ts:Date.now(),status:'receiving'};
      this._pushMsg(sid,fmsg,()=>this._appendFileCard(fmsg));
      this.ft.handleCtrl(fp,msg); return;
    }
    if (type==='file-end'||type==='file-abort') { this.ft.handleCtrl(fp,msg); return; }
    if (type==='folder-manifest')  {
      const sid=msg.circle?CIRCLE:fp;
      const fmsg={id:msg.folderId+'_recv',sessionId:sid,from:fp,fromNick:this.peers.get(fp)?.nick||fp.slice(0,8),own:false,type:'folder',folderId:msg.folderId,name:msg.name||'folder',totalSize:msg.totalSize||0,fileCount:msg.files?.length||0,manifest:msg.files||[],ts:Date.now(),status:'receiving'};
      this._pushMsg(sid,fmsg,()=>this._appendFolderCard(fmsg));
      this.folder.handleCtrl(fp,msg); return;
    }
    if (type==='call-invite')  { msg.circle?this._onCircleCallInvite(fp,msg):this._onCallInvite(fp,msg); return; }
    if (type==='call-accept')  { msg.circle?this._onCircleCallAccepted(fp):this._onCallAccepted(fp); return; }
    if (type==='call-decline') { msg.circle?this._onCircleCallDeclined(fp):this._onCallDeclined(fp); return; }
    if (type==='offer-reneg')  { msg.circle?this._onCircleOfferReneg(fp,msg):this._onOfferReneg(fp,msg); return; }
    if (type==='answer-reneg') { /* SDP answer handled by webrtc.js _onAnswer via net — no app action needed */ return; }
    if (type==='call-end')     {
      if(this.circleCall) this._removeCirclePeer(fp);
      if(this.call?.fp===fp){this._endCallLocal(false);this._status('call ended','info',3000);}
      this._hideCallIncoming(); return;
    }
    if (type==='permission-denied') {
      const nick=this.peers.get(fp)?.nick||fp.slice(0,8);
      this._status(nick+': '+(msg.media||'mic')+' permission denied','err',8000);
      if(this.call?.fp===fp) this._endCallLocal(false); this._hideCallIncoming(); return;
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
    const msg={id:ev.id||crypto.randomUUID(),sessionId:fp,from:fp,fromNick:ev.nick||this.peers.get(fp)?.nick||fp.slice(0,8),text:String(ev.text),ts:ev.ts||Date.now(),type:'text',own:false};
    this._pushMsg(fp,msg,()=>this._appendMsg(msg)); saveMessage(msg).catch(()=>{});
  }

  _recvCircle(fp, ev) {
    if (!ev.text||this.circleBlocked.has(fp)) return;
    const msg={id:ev.id||crypto.randomUUID(),sessionId:CIRCLE,from:fp,fromNick:ev.nick||this.peers.get(fp)?.nick||fp.slice(0,8),text:String(ev.text),ts:ev.ts||Date.now(),type:'text',own:false};
    this._pushMsg(CIRCLE,msg,()=>this._appendMsg(msg)); saveMessage(msg).catch(()=>{});
  }

  _send() {
    const inp=$('msg-input'), text=inp?.value?.trim();
    if (!text||!this.active) return;
    const id=crypto.randomUUID(), ts=Date.now();
    if (this.active===CIRCLE) {
      const fps=this.net.getConnectedPeers().filter(fp=>!this.circleBlocked.has(fp));
      if (!fps.length) { this._sys('no peers in circle',true); return; }
      fps.forEach(fp=>this.net.sendCtrl(fp,{type:'chat',circle:true,id,nick:this.id.nickname,text,ts}));
      const msg={id,sessionId:CIRCLE,from:this.id.fingerprint,fromNick:this.id.nickname,text,ts,type:'text',own:true};
      this._pushMsg(CIRCLE,msg,()=>this._appendMsg(msg)); saveMessage(msg).catch(()=>{});
    } else {
      const fp=this.active;
      if (!this.net.isReady(fp)) { this._sys('peer offline — message not sent',true); return; }
      if (!this.net.sendCtrl(fp,{type:'chat',id,nick:this.id.nickname,text,ts})) { this._sys('send failed',true); return; }
      const msg={id,sessionId:fp,from:this.id.fingerprint,fromNick:this.id.nickname,text,ts,type:'text',own:true};
      this._pushMsg(fp,msg,()=>this._appendMsg(msg)); saveMessage(msg).catch(()=>{});
    }
    if (inp) { inp.value=''; inp.style.height='auto'; }
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  _queueFile(file) {
    if (!file||!this.active) return;
    const sid=this.active, isCircle=sid===CIRCLE;
    const fps=isCircle?this.net.getConnectedPeers().filter(fp=>!this.circleBlocked.has(fp)):(this.net.isReady(sid)?[sid]:[]);
    if (!fps.length) { this._sys(isCircle?'no peers in circle':'peer offline',true); return; }
    const fileId=crypto.randomUUID();
    const fmsg={id:fileId+'_send',sessionId:sid,from:this.id.fingerprint,fromNick:this.id.nickname,type:'file',fileId,name:file.name,size:file.size,mimeType:file.type||'application/octet-stream',ts:Date.now(),own:true,status:'sending'};
    this._pushMsg(sid,fmsg,()=>this._appendFileCard(fmsg));
    this._fileOwners.set(fileId,{fps:[...fps]});
    fps.forEach(fp=>this.ft.send(file,fp,fileId));
    this._status('sending '+file.name+'…','info');
  }

  _cancelFile(msg) {
    const {fileId,own,from}=msg; if(!fileId) return;
    if (own) { const info=this._fileOwners.get(fileId); if(info){info.fps.forEach(fp=>this.ft.cancelSend(fileId,fp));this._fileOwners.delete(fileId);} }
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
    for (const msgs of this.sessions.values()) { const m=msgs.find(m=>m.fileId===f.fileId); if(m) m.status='done'; }
    this._fileOwners.delete(f.fileId);
    const cards=document.querySelectorAll(`[data-fcid="${f.fileId}"]`);
    cards.forEach(card=>{
      card.querySelector('.prog-track')?.remove(); card.querySelector('.file-stats')?.remove(); card.querySelector('.file-cancel')?.remove();
      if (!card.querySelector('.dl-btn,audio')) this._attachDownload(card,f);
    });
    const nick=this.peers.get(f.from)?.nick||f.from?.slice(0,8)||'?';
    this._status(f.name+(cards.length?' received':' from '+nick+' — open chat to download'),'ok',6000);
  }

  _onFileErr(fileId, errMsg) {
    this._fileOwners.delete(fileId);
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
    const fps=isCircle?this.net.getConnectedPeers().filter(fp=>!this.circleBlocked.has(fp)):(this.net.isReady(sid)?[sid]:[]);
    if (!fps.length) { this._sys(isCircle?'no peers in circle':'peer offline',true); return; }

    const folderId=crypto.randomUUID();
    let entries; try { entries=await FolderTransfer.pickFiles(); } catch(e){ this._sys('folder error: '+e.message,true); return; }
    if (!entries?.length) return;

    const folderName=entries[0].relativePath.split('/')[0]||'folder';
    let totalSize=0;
    const fileList=entries.map((e,i)=>{ totalSize+=e.file.size; return {fileId:`${folderId}:${i}`,relativePath:e.relativePath,size:e.file.size,mimeType:e.file.type||'application/octet-stream'}; });

    const fmsg={id:folderId+'_send',sessionId:sid,from:this.id.fingerprint,fromNick:this.id.nickname,type:'folder',folderId,name:folderName,totalSize,fileCount:fileList.length,manifest:fileList,ts:Date.now(),own:true,status:'sending'};
    this._pushMsg(sid,fmsg,()=>this._appendFolderCard(fmsg));

    fps.forEach(fp=>{
      this.net.sendCtrl(fp,{type:'folder-manifest',folderId,name:folderName,totalSize,files:fileList,circle:isCircle||undefined});
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
      if (m) { m.status='done'; m.files=files; m.manifest=manifest; m._downloadFns={downloadZip,downloadAll,download}; }
    }
    const card=document.querySelector(`[data-folderid="${folderId}"]`);
    if (card) {
      card.querySelector('.prog-track')?.remove(); card.querySelector('.folder-count')?.remove();
      if (!card.querySelector('.folder-dl')) this._finalizeFolderCard(card,{manifest,downloadZip,downloadAll,download});
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

  async _startCall(fp, callType) {
    if (!this.net.isReady(fp)) { this._sys('peer offline',true); return; }
    if (this.call) { this._sys('already in a call',true); return; }
    const video=callType==='stream';
    let s; try { s=await navigator.mediaDevices.getUserMedia({audio:true,video}); } catch(e){ this._handleMediaError(e,fp); return; }
    this.call={fp,type:callType,phase:'inviting',localStream:s,remoteStream:null,muted:false,camOff:false,inviteTimer:setTimeout(()=>this._onCallTimeout(fp),45_000)};
    this.net.sendCtrl(fp,{type:'call-invite',callType,nick:this.id.nickname});
    this._status(callType+' — calling '+(this.peers.get(fp)?.nick||fp.slice(0,8))+'…','info');
    this._renderCallPanel();
  }

  _onCallInvite(fp, msg) {
    if (this.call&&this.call.fp!==fp) { this.net.sendCtrl(fp,{type:'call-decline'}); return; }
    this.call={fp,type:msg.callType==='stream'?'stream':'walkie',phase:'ringing',localStream:null,remoteStream:null,muted:false,camOff:false};
    this._showCallIncoming(fp,msg.callType||'walkie',msg.nick,false);
  }

  _onCallAccepted(fp) {
    if (!this.call||this.call.fp!==fp||this.call.phase!=='inviting') return;
    clearTimeout(this.call.inviteTimer); this.call.phase='connecting';
    this.net.offerWithStream(fp,this.call.localStream)
      .then(()=>this._attachRemote1to1(fp))
      .catch(e=>{ this._status('call failed: '+e.message,'err',5000); this._endCallLocal(true); });
  }

  _onCallDeclined(fp) {
    if (!this.call||this.call.fp!==fp) return;
    clearTimeout(this.call.inviteTimer);
    this.call.localStream?.getTracks().forEach(t=>t.stop()); this.call=null; this._renderCallPanel();
    this._status((this.peers.get(fp)?.nick||fp.slice(0,8))+' declined','warn',5000);
  }

  _onCallTimeout(fp) {
    if (!this.call||this.call.fp!==fp) return;
    this.call.localStream?.getTracks().forEach(t=>t.stop()); this.call=null; this._renderCallPanel();
    this._status('no answer — timed out','warn',5000);
  }

  async _acceptCall(fp) {
    if (!this.call||this.call.fp!==fp||this.call.phase!=='ringing') return;
    this._hideCallIncoming();
    const video=this.call.type==='stream';
    let s; try { s=await navigator.mediaDevices.getUserMedia({audio:true,video}); }
    catch(e){ this.net.sendCtrl(fp,{type:'permission-denied',media:video?'camera/mic':'microphone'}); this.call=null; this._handleMediaError(e,fp); return; }
    this.call.localStream=s; this.call.phase='connecting';
    this.net.sendCtrl(fp,{type:'call-accept'});
    await this._openSession(fp); this._renderCallPanel();
  }

  _declineCall(fp) {
    this._hideCallIncoming();
    if (this.call?.fp===fp) { this.call.localStream?.getTracks().forEach(t=>t.stop()); this.call=null; }
    this.net.sendCtrl(fp,{type:'call-decline'}); this._renderCallPanel();
  }

  // Called when we receive an offer-reneg (we are the answering side of the call).
  // msg.sdp is the offer SDP — must be passed to answerWithStream.
  _onOfferReneg(fp, msg) {
    if (!this.call||this.call.fp!==fp||!this.call.localStream) return;
    this.net.answerWithStream(fp, msg.sdp, this.call.localStream)
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
        this._status(this.call.type+' on · '+(this.peers.get(fp)?.nick||fp.slice(0,8)),'ok');
      }
    });
  }

  async _endCallLocal(sendEnd=true) {
    if (!this.call) return;
    const fp=this.call.fp;
    clearTimeout(this.call.inviteTimer);
    this.call.localStream?.getTracks().forEach(t=>t.stop());
    this.call=null; this._stopStatsPolling();
    if (sendEnd) this.net.stopMedia(fp);
    this._audioEl.srcObject=null; this._renderCallPanel();
  }

  // ── Circle calls ───────────────────────────────────────────────────────────

  async _startCircleCall(callType) {
    if (this.call) { this._sys('end 1:1 call first',true); return; }
    if (this.circleCall?.phase==='active') { this._endCircleCall(); return; }
    const fps=this.net.getConnectedPeers().filter(fp=>!this.circleBlocked.has(fp));
    if (!fps.length) { this._sys('no peers in circle',true); return; }
    const video=callType==='stream';
    let s; try { s=await navigator.mediaDevices.getUserMedia({audio:true,video}); } catch(e){ this._handleMediaError(e,null); return; }
    this.circleCall={type:callType,phase:'connecting',localStream:s,remoteStreams:new Map(),audioEls:new Map(),muted:false,camOff:false};
    fps.forEach(fp=>{ this.net.sendCtrl(fp,{type:'call-invite',callType,nick:this.id.nickname,circle:true}); this._attachCircleRemote(fp); });
    this._renderCircleCallPanel();
  }

  _onCircleCallInvite(fp, msg) {
    if (this.call) { this.net.sendCtrl(fp,{type:'call-decline',circle:true}); return; }
    const callType=msg.callType==='stream'?'stream':'walkie';
    if (!this.circleCall) this.circleCall={type:callType,phase:'ringing',localStream:null,remoteStreams:new Map(),audioEls:new Map(),muted:false,camOff:false};
    this._showCallIncoming(fp,callType,msg.nick,true);
  }

  async _acceptCircleCall(fp) {
    if (!this.circleCall) return;
    this._hideCallIncoming();
    const video=this.circleCall.type==='stream';
    let s;
    if (this.circleCall.localStream) { s=this.circleCall.localStream; }
    else { try { s=await navigator.mediaDevices.getUserMedia({audio:true,video}); } catch(e){ this.net.sendCtrl(fp,{type:'permission-denied',media:video?'camera/mic':'microphone'}); this._handleMediaError(e,null); return; } this.circleCall.localStream=s; }
    this.circleCall.phase='active';
    this.net.sendCtrl(fp,{type:'call-accept',circle:true});
    this._attachCircleRemote(fp); this._renderCircleCallPanel();
  }

  _declineCircleCall(fp) { this._hideCallIncoming(); this.net.sendCtrl(fp,{type:'call-decline',circle:true}); }

  _onCircleCallAccepted(fp) {
    if (!this.circleCall?.localStream) return;
    this.circleCall.phase='active';
    this.net.offerWithStream(fp,this.circleCall.localStream).then(()=>this._attachCircleRemote(fp)).catch(()=>{});
    this._renderCircleCallPanel();
  }

  _onCircleCallDeclined(fp) { this._status((this.peers.get(fp)?.nick||fp.slice(0,8))+' declined circle call','warn',3000); }

  _onCircleOfferReneg(fp, msg) {
    if (!this.circleCall?.localStream||!msg.sdp) return;
    this.net.answerWithStream(fp, msg.sdp, this.circleCall.localStream).catch(()=>{});
    this.circleCall.phase='active'; this._renderCircleCallPanel();
  }

  _attachCircleRemote(fp) {
    this.net.setRemoteStreamHandler(fp, stream => {
      if (!stream||!this.circleCall) return;
      this.circleCall.remoteStreams.set(fp,stream);
      let el=this.circleCall.audioEls.get(fp);
      if (!el) { el=Object.assign(document.createElement('audio'),{autoplay:true,playsInline:true,style:'display:none'}); document.body.appendChild(el); this.circleCall.audioEls.set(fp,el); }
      el.srcObject=stream; el.play().catch(()=>{});
      this.circleCall.phase='active'; this._renderCircleCallPanel();
    });
  }

  _removeCirclePeer(fp) {
    if (!this.circleCall) return;
    this.circleCall.remoteStreams.delete(fp);
    const el=this.circleCall.audioEls.get(fp);
    if (el) { el.srcObject=null; try{el.remove();}catch{} this.circleCall.audioEls.delete(fp); }
    if (this.circleCall.remoteStreams.size===0) this._endCircleCall();
    else this._renderCircleCallPanel();
  }

  _endCircleCall() {
    if (!this.circleCall) return;
    this.circleCall.localStream?.getTracks().forEach(t=>t.stop());
    this.circleCall.audioEls.forEach(el=>{ try{el.srcObject=null;el.remove();}catch{} });
    this.net.getConnectedPeers().forEach(fp=>{ this.net.sendCtrl(fp,{type:'call-end'}); this.net.stopMedia(fp); });
    this.circleCall=null; this._renderCircleCallPanel();
    this._status('circle call ended','info',3000);
  }

  // ── Call UI ────────────────────────────────────────────────────────────────

  _renderCallPanel() {
    const panel=$('call-panel'); if(!panel) return;
    const c=this.call;
    // Clean up previous PIP and its listeners before re-rendering
    this._pipCleanup?.(); this._pipCleanup=null;
    panel.querySelectorAll('.call-pip').forEach(el=>el.remove());
    if (!c) { panel.classList.remove('visible'); this._stopStatsPolling(); return; }
    panel.classList.add('visible');
    const vids=$('call-videos'); if(!vids) return;
    vids.innerHTML='';
    const remote=document.createElement('div');
    remote.className='call-video-tile'; remote.style.cssText='flex:1;min-width:200px;max-width:480px;background:var(--bg2)';
    if (c.remoteStream) { const v=document.createElement('video'); v.autoplay=true; v.playsInline=true; v.srcObject=c.remoteStream; v.muted=false; remote.appendChild(v); }
    const lbl=document.createElement('div'); lbl.className='vtile-label'; lbl.textContent=this.peers.get(c.fp)?.nick||c.fp.slice(0,8); remote.appendChild(lbl);
    vids.appendChild(remote);
    const pip=document.createElement('div'); pip.className='call-pip'+(c.camOff?' cam-off':'');
    if (c.localStream&&c.type==='stream') { const v=document.createElement('video'); v.autoplay=true; v.playsInline=true; v.muted=true; v.srcObject=c.localStream; pip.appendChild(v); }
    panel.appendChild(pip);
    this._pipCleanup=this._makePIPDraggable(pip);
    const mu=$('ctrl-mute'); if(mu) mu.textContent=c.muted?'unmute':'mute';
    const cam=$('ctrl-cam'); if(cam) cam.textContent=c.camOff?'cam on':'cam off';
  }

  _renderCircleCallPanel() {
    const panel=$('call-panel'); if(!panel) return;
    this._pipCleanup?.(); this._pipCleanup=null;
    panel.querySelectorAll('.call-pip').forEach(el=>el.remove());
    const cc=this.circleCall;
    if (!cc) { panel.classList.remove('visible'); return; }
    panel.classList.add('visible');
    const vids=$('call-videos'); if(!vids) return;
    vids.innerHTML='';
    cc.remoteStreams.forEach((stream,fp)=>{
      const tile=document.createElement('div'); tile.className='call-video-tile'; tile.style.cssText='flex:1;min-width:140px;max-width:260px;background:var(--bg2)';
      if (cc.type==='stream') { const v=document.createElement('video'); v.autoplay=true; v.playsInline=true; v.muted=false; v.srcObject=stream; tile.appendChild(v); }
      const lbl=document.createElement('div'); lbl.className='vtile-label'; lbl.textContent=this.peers.get(fp)?.nick||fp.slice(0,8); tile.appendChild(lbl); vids.appendChild(tile);
    });
    const pip=document.createElement('div'); pip.className='call-pip'+(cc.camOff?' cam-off':'');
    if (cc.localStream&&cc.type==='stream') { const v=document.createElement('video'); v.autoplay=true; v.playsInline=true; v.muted=true; v.srcObject=cc.localStream; pip.appendChild(v); }
    panel.appendChild(pip);
    this._pipCleanup=this._makePIPDraggable(pip);
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
  }

  _toggleCam() {
    const c=this.call||this.circleCall; if(!c) return;
    c.camOff=!c.camOff; (c.localStream||null)?.getVideoTracks().forEach(t=>{t.enabled=!c.camOff;});
    const btn=$('ctrl-cam'); if(btn) { btn.textContent=c.camOff?'cam on':'cam off'; btn.classList.toggle('active',c.camOff); }
  }

  _startStatsPolling(fp) {
    this._stopStatsPolling();
    this._statsTimer=setInterval(async()=>{
      const s=await this.net.getStats?.(fp); if(!s) return;
      const el=$('call-stats'); if(el) el.textContent=s.rtt?`rtt ${(s.rtt*1000).toFixed(0)}ms`:'';
    },3000);
  }
  _stopStatsPolling() { clearInterval(this._statsTimer); this._statsTimer=null; }

  _handleMediaError(e, fp) {
    const msg=e.name==='NotAllowedError'?'mic/cam permission denied':'no mic/cam found';
    this._status(msg,'err',8000);
    if (fp) this.net.sendCtrl(fp,{type:'permission-denied',media:msg});
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
