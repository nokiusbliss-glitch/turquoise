/**
 * app.js — Turquoise v10
 *
 * Changes from v9:
 *  - "mesh" renamed to "circle" everywhere (CIRCLE_ID = 'circle')
 *  - "you:" removed — own messages show actual nickname
 *  - 3 call modes: walkie (live audio) | stream (live video) | memo (record→send)
 *  - Voice memo via VoiceMemo from tqapps.js → sends as file
 *  - File transfer: cards always stored in session → always visible on open
 *  - State export (JSON bundle: identity + messages + peers)
 *  - Reset dialog offers download before wipe
 *  - State import from JSON file
 *  - Games → tqapps.js (TicTacToe, VoiceMemo, AppRegistry)
 *  - identity.js v3: extractable keys, localStorage fallback
 */

import { saveMessage, loadMessages, loadAllMessages, clearMessages, clearAllData, savePeer, loadPeers, restoreMessages, restorePeers } from './messages.js';
import { resetIdentity, importIdentityData } from './identity.js';
import { FileTransfer } from './files.js';
import { TicTacToe, VoiceMemo, REGISTRY } from './tqapps.js';

const $ = id => document.getElementById(id);
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmt = b => { if(!b||b<1)return'0 B'; if(b<1024)return b+' B'; if(b<1048576)return(b/1024).toFixed(1)+' KB'; if(b<1073741824)return(b/1048576).toFixed(1)+' MB'; return(b/1073741824).toFixed(2)+' GB'; };
const fmtSpd = s => { if(!s||s<1)return'—'; if(s<1024)return s.toFixed(0)+' B/s'; if(s<1048576)return(s/1024).toFixed(1)+' KB/s'; return(s/1048576).toFixed(2)+' MB/s'; };
const fmtEta = s => { if(!s||s<=0||!isFinite(s))return'—'; return s<60?Math.ceil(s)+'s':Math.floor(s/60)+'m'+Math.ceil(s%60)+'s'; };
const clock  = () => new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});

const CIRCLE_ID = 'circle';

export class TurquoiseApp {
  constructor(identity, network) {
    this.id  = identity;
    this.net = network;
    this.peers        = new Map();   // fp → {nick, connected}
    this.sessions     = new Map();   // sessionId → msg[]
    this.active       = null;
    this.unread       = new Map();
    this.circleBlocked= new Set();

    // 1:1 call: {fp, type:'walkie'|'stream', phase, localStream, remoteStream, muted, camOff, inviteTimer}
    this.call     = null;
    // Circle call: {type, phase, localStream, remoteStreams:Map, audioEls:Map, muted, camOff}
    this.circleCall = null;

    // File blob URL cache: fileId → {url, name, from}
    this._fileUrls = new Map();

    // Voice memo state
    this._memo = null;

    // 1:1 audio element
    this._audioEl = Object.assign(document.createElement('audio'), { autoplay:true, playsInline:true });
    this._audioEl.style.display = 'none';
    document.body.appendChild(this._audioEl);

    this._statsTimer = null;
    this.games = new Map(); // fp → TicTacToe

    this.ft = new FileTransfer(
      (fp,msg) => network.sendCtrl(fp,msg),
      (fp,buf) => network.sendBinary(fp,buf),
      (fp)     => network.waitForBuffer(fp),
    );
    this.ft.onProgress  = (id,pct,dir,fp,stats) => this._onFileProg(id,pct,stats);
    this.ft.onFileReady = f                      => this._onFileReady(f);
    this.ft.onError     = (id,msg)               => this._onFileErr(id,msg);
  }

  // ── Mount ──────────────────────────────────────────────────────────────────
  async mount() {
    const nd=$('nick-display'), ni=$('nick-input'), fp=$('full-fp');
    if(nd) nd.textContent = this.id.nickname;
    if(ni) ni.value       = this.id.nickname;
    if(fp) fp.textContent = this.id.fingerprint;

    try {
      const saved = await loadPeers();
      for (const p of saved) this.peers.set(p.fingerprint, { nick: p.nickname||p.shortId||p.fingerprint.slice(0,8), connected: false });
    } catch(e) { this._log('peer history: '+e.message, true); }

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
    // Nick edit
    const row=$('identity-row'), disp=$('nick-display'), inp=$('nick-input');
    if (row && disp && inp) {
      row.addEventListener('click', () => this._triggerNickEdit());
      const save = async () => {
        if (!inp.classList.contains('visible')) return;
        const saved = await this.id.saveNickname(inp.value).catch(() => this.id.nickname);
        this.id.nickname = saved;
        disp.textContent = saved; inp.value = saved;
        disp.classList.remove('hidden'); inp.classList.remove('visible');
        this.net.getConnectedPeers().forEach(fp => this.net.sendCtrl(fp, {type:'nick-update', nick:saved}));
        this._status('name: '+saved, 'ok', 3000);
      };
      inp.addEventListener('keydown', e => { if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();save();} });
      inp.addEventListener('blur', save);
    }

    // Send message
    const mi=$('msg-input'), sb=$('send-btn');
    if (mi) {
      mi.addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();this._send();} });
      mi.addEventListener('input', () => { mi.style.height='auto'; mi.style.height=Math.min(mi.scrollHeight,128)+'px'; });
    }
    sb?.addEventListener('click', () => this._send());

    // + menu
    $('plus-btn')?.addEventListener('click', e => { e.stopPropagation(); this._togglePlusMenu(); });
    document.addEventListener('click', () => this._closePlusMenu());

    // File input
    $('__file-input')?.addEventListener('change', e => {
      Array.from(e.target.files||[]).forEach(f => this._queueFile(f));
      e.target.value = '';
    });

    // Import state input
    $('__import-input')?.addEventListener('change', e => {
      const f = e.target.files?.[0]; if(f) this._importState(f);
      e.target.value = '';
    });

    // Drag/drop
    const ca = $('chat-area');
    if (ca) {
      ca.addEventListener('dragover', e => { e.preventDefault(); ca.classList.add('drag-over'); });
      ca.addEventListener('dragleave', () => ca.classList.remove('drag-over'));
      ca.addEventListener('drop', e => {
        e.preventDefault(); ca.classList.remove('drag-over');
        if (!this.active) { this._sys('select a session first', true); return; }
        Array.from(e.dataTransfer?.files||[]).forEach(f => this._queueFile(f));
      });
    }

    $('back-btn')?.addEventListener('click', () => this._showSidebar());
    $('reset-btn')?.addEventListener('click', () => this._confirmReset());
  }

  _triggerNickEdit() {
    const d=$('nick-display'), i=$('nick-input');
    if(!d||!i||i.classList.contains('visible'))return;
    d.classList.add('hidden'); i.classList.add('visible'); i.focus(); i.select();
  }

  _togglePlusMenu() {
    const m=$('plus-menu'); if(!m)return;
    const showing = m.classList.contains('visible');
    this._closePlusMenu();
    if (!showing) { this._buildPlusMenu(); m.classList.add('visible'); }
  }
  _closePlusMenu() { $('plus-menu')?.classList.remove('visible'); }

  _buildPlusMenu() {
    const menu = $('plus-menu'); if(!menu)return;
    const fp   = this.active;
    const isCircle   = fp === CIRCLE_ID;
    const peerOnline = !isCircle && this.net.isReady(fp||'');
    const anyOnline  = this.net.getConnectedPeers().length > 0;

    menu.innerHTML = `
      <div class="pm-item" id="pmi-file">📎  file</div>
      <div class="pm-item" id="pmi-memo">🎤  voice memo</div>
      <div class="pm-sep"></div>
      <div class="pm-label">◈ apps</div>
      <div class="pm-item${!peerOnline||isCircle?' pm-dim':''}" id="pmi-ttt">⊞  tic tac toe</div>
      <div class="pm-sep"></div>
      <div class="pm-label">session</div>
      <div class="pm-item pm-danger" id="pmi-export">⬇  export state</div>
      <div class="pm-item" id="pmi-import">⬆  import state</div>`;

    $('pmi-file')?.addEventListener('click', () => {
      this._closePlusMenu();
      if (isCircle ? !anyOnline : !peerOnline) { this._sys('no peers available', true); return; }
      $('__file-input')?.click();
    });
    $('pmi-memo')?.addEventListener('click', () => {
      this._closePlusMenu();
      if (isCircle ? !anyOnline : !peerOnline) { this._sys('no peers available', true); return; }
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
    n.onPeerConnected         = (fp,nick) => this._onConnect(fp,nick);
    n.onPeerDisconnected      = (fp)      => this._onDisconnect(fp);
    n.onMessage               = (fp,msg)  => { try{ this._dispatch(fp,msg); }catch(e){ this._log('msg:'+e.message,true); } };
    n.onBinaryChunk           = (fp,buf)  => { try{ this.ft.handleBinary(fp,buf); }catch(e){ this._log('bin:'+e.message,true); } };
    n.onLog                   = (t,e)     => this._log(t,e);
    n.onSignalingConnected    = ()        => this._status('signaling ✓ — searching…', 'ok', 4000);
    n.onSignalingDisconnected = ()        => this._status('signaling lost — reconnecting…', 'warn');
  }

  _onConnect(fp, nick) {
    const ex = this.peers.get(fp);
    const name = nick||ex?.nick||fp.slice(0,8);
    this.peers.set(fp, { nick:name, connected:true });
    savePeer({ fingerprint:fp, shortId:fp.slice(0,8), nickname:name }).catch(()=>{});
    if (!this.sessions.has(fp)) {
      loadMessages(fp).then(msgs => { this.sessions.set(fp,msgs); this._renderPeers(); if(this.active===fp)this._renderMsgs(); }).catch(() => this.sessions.set(fp,[]));
    } else this._renderPeers();
    if (this.active===fp) this._renderHeader();
    this._status(name+' joined', 'ok', 3000);
  }

  _onDisconnect(fp) {
    const p = this.peers.get(fp); const name = p?.nick||fp.slice(0,8);
    if (p) p.connected = false;
    if (this.call?.fp===fp)   this._endCallLocal(false);
    if (this.circleCall)      this._removeCirclePeer(fp);
    this.games.get(fp)?.destroy?.(); this.games.delete(fp);
    this._renderPeers(); if(this.active===fp)this._renderHeader();
    this._status(name+' disconnected', 'warn', 5000);
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────
  _dispatch(fp, msg) {
    const { type } = msg;
    if (type==='hello') {
      const p=this.peers.get(fp); if(p&&msg.nick){p.nick=msg.nick;this._renderPeers();} return;
    }
    if (type==='nick-update') {
      const p=this.peers.get(fp); if(p&&msg.nick){p.nick=msg.nick;this._renderPeers();if(this.active===fp)this._renderHeader();savePeer({fingerprint:fp,shortId:fp.slice(0,8),nickname:msg.nick}).catch(()=>{});} return;
    }
    if (type==='chat') { msg.circle?this._recvCircle(fp,msg):this._recv1to1(fp,msg); return; }

    // ── File ──────────────────────────────────────────────────────────────
    if (type==='file-meta') {
      const sessionId = msg.circle ? CIRCLE_ID : fp;
      const nick = this.peers.get(fp)?.nick||fp.slice(0,8);
      const fileMsg = {
        id: msg.fileId+'_recv', sessionId, from:fp, fromNick:nick, own:false,
        type:'file', fileId:msg.fileId, name:msg.name||'file', size:msg.size||0,
        mimeType:msg.mimeType, ts:Date.now(), status:'receiving',
      };
      if (!this.sessions.has(sessionId)) this.sessions.set(sessionId,[]);
      this.sessions.get(sessionId).push(fileMsg);
      if (this.active===sessionId) this._appendFileCard(fileMsg);
      else { this.unread.set(sessionId,(this.unread.get(sessionId)||0)+1); this._renderPeers(); }
      this.ft.handleCtrl(fp,msg);
      this._status('receiving '+msg.name+' from '+nick+'…','info');
      return;
    }
    if (type==='file-end'||type==='file-abort') { this.ft.handleCtrl(fp,msg); return; }

    // ── Calls ─────────────────────────────────────────────────────────────
    if (type==='call-invite')  { msg.circle?this._onCircleCallInvite(fp,msg):this._onCallInvite(fp,msg); return; }
    if (type==='call-accept')  { msg.circle?this._onCircleCallAccepted(fp):this._onCallAccepted(fp); return; }
    if (type==='call-decline') { msg.circle?this._onCircleCallDeclined(fp):this._onCallDeclined(fp); return; }
    if (type==='offer-reneg')  { msg.circle?this._onCircleOfferReneg(fp,msg):this._onOfferReneg(fp,msg); return; }
    if (type==='call-end') {
      if (this.circleCall) this._removeCirclePeer(fp);
      if (this.call?.fp===fp) { this._endCallLocal(false); this._status('call ended','info',3000); }
      this._hideCallIncoming(); return;
    }
    if (type==='permission-denied') {
      const nick=this.peers.get(fp)?.nick||fp.slice(0,8);
      this._status(nick+': '+( msg.media||'mic')+' permission denied', 'err', 8000);
      if (this.call?.fp===fp) this._endCallLocal(false);
      this._hideCallIncoming(); return;
    }

    // ── Games ─────────────────────────────────────────────────────────────
    if (type==='game') { this._dispatchGame(fp,msg); return; }
  }

  // ── Chat ──────────────────────────────────────────────────────────────────
  _recv1to1(fp, ev) {
    if (!ev.text) return;
    const msg = { id:ev.id||crypto.randomUUID(), sessionId:fp, from:fp, fromNick:ev.nick||this.peers.get(fp)?.nick||fp.slice(0,8), text:String(ev.text), ts:ev.ts||Date.now(), type:'text', own:false };
    if (!this.sessions.has(fp)) this.sessions.set(fp,[]);
    this.sessions.get(fp).push(msg); saveMessage(msg).catch(()=>{});
    if (this.active!==fp) { this.unread.set(fp,(this.unread.get(fp)||0)+1); this._renderPeers(); }
    else this._appendMsg(msg);
  }

  _recvCircle(fp, ev) {
    if (!ev.text||this.circleBlocked.has(fp)) return;
    const msg = { id:ev.id||crypto.randomUUID(), sessionId:CIRCLE_ID, from:fp, fromNick:ev.nick||this.peers.get(fp)?.nick||fp.slice(0,8), text:String(ev.text), ts:ev.ts||Date.now(), type:'text', own:false };
    if (!this.sessions.has(CIRCLE_ID)) this.sessions.set(CIRCLE_ID,[]);
    this.sessions.get(CIRCLE_ID).push(msg); saveMessage(msg).catch(()=>{});
    if (this.active!==CIRCLE_ID) { this.unread.set(CIRCLE_ID,(this.unread.get(CIRCLE_ID)||0)+1); this._renderPeers(); }
    else this._appendMsg(msg);
  }

  _send() {
    const inp=$('msg-input'); const text=inp?.value?.trim();
    if (!text||!this.active) return;
    const id=crypto.randomUUID(), ts=Date.now();
    if (this.active===CIRCLE_ID) {
      const fps = this.net.getConnectedPeers().filter(fp=>!this.circleBlocked.has(fp));
      if (!fps.length) { this._sys('no peers in circle', true); return; }
      fps.forEach(fp => this.net.sendCtrl(fp, {type:'chat',circle:true,id,nick:this.id.nickname,text,ts}));
      const msg = { id, sessionId:CIRCLE_ID, from:this.id.fingerprint, fromNick:this.id.nickname, text, ts, type:'text', own:true };
      if (!this.sessions.has(CIRCLE_ID)) this.sessions.set(CIRCLE_ID,[]);
      this.sessions.get(CIRCLE_ID).push(msg); saveMessage(msg).catch(()=>{}); this._appendMsg(msg); this._renderPeers();
    } else {
      const fp = this.active;
      if (!this.net.isReady(fp)) { this._sys('peer offline — not sent', true); return; }
      if (!this.net.sendCtrl(fp, {type:'chat',id,nick:this.id.nickname,text,ts})) { this._sys('send failed',true); return; }
      const msg = { id, sessionId:fp, from:this.id.fingerprint, fromNick:this.id.nickname, text, ts, type:'text', own:true };
      if (!this.sessions.has(fp)) this.sessions.set(fp,[]);
      this.sessions.get(fp).push(msg); saveMessage(msg).catch(()=>{}); this._appendMsg(msg); this._renderPeers();
    }
    if (inp) { inp.value=''; inp.style.height='auto'; }
  }

  // ── Files ──────────────────────────────────────────────────────────────────
  _queueFile(file) {
    if (!file||!this.active) return;
    const sessionId = this.active;
    const isCircle  = sessionId === CIRCLE_ID;
    const peers = isCircle
      ? this.net.getConnectedPeers().filter(fp=>!this.circleBlocked.has(fp))
      : (this.net.isReady(sessionId) ? [sessionId] : []);
    if (!peers.length) { this._sys(isCircle?'no peers in circle':'peer offline', true); return; }
    const fileId = crypto.randomUUID();
    const fileMsg = {
      id:fileId+'_send', sessionId, from:this.id.fingerprint, fromNick:this.id.nickname,
      type:'file', fileId, name:file.name, size:file.size, mimeType:file.type||'application/octet-stream',
      ts:Date.now(), own:true, status:'sending',
    };
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId,[]);
    this.sessions.get(sessionId).push(fileMsg);
    this._appendFileCard(fileMsg);
    this._status('sending '+file.name+'…','info');
    peers.forEach(fp => this.ft.send(file, fp, fileId));
  }

  _onFileProg(fileId, pct, stats) {
    document.querySelectorAll(`[data-fcid="${fileId}"] .prog-fill`).forEach(el => {
      el.style.width = (pct*100).toFixed(1)+'%';
    });
    document.querySelectorAll(`[data-fcid="${fileId}"] .file-stats`).forEach(el => {
      if (!stats) return;
      const p = (pct*100).toFixed(1);
      el.innerHTML = `<span class="fs-pct">${p}%</span><span class="fs-sep">·</span><span class="fs-bytes">${fmt(stats.bytesTransferred)} / ${fmt(stats.totalBytes)}</span><span class="fs-sep">·</span><span class="fs-spd">${fmtSpd(stats.speedBps)}</span><span class="fs-sep">·</span><span class="fs-eta">${fmtEta(stats.etaSec)}</span>`;
    });
  }

  _onFileReady(f) {
    this._fileUrls.set(f.fileId, f);
    for (const msgs of this.sessions.values()) {
      const m = msgs.find(m => m.fileId===f.fileId); if(m) m.status='done';
    }
    const cards = document.querySelectorAll(`[data-fcid="${f.fileId}"]`);
    cards.forEach(card => {
      card.querySelector('.prog-track')?.remove();
      card.querySelector('.file-stats')?.remove();
      if (!card.querySelector('.dl-btn')) {
        const mime = f.mimeType||'';
        // Audio files: show inline player
        if (mime.startsWith('audio/')) {
          const au = document.createElement('audio');
          au.controls=true; au.src=f.url; au.style.cssText='max-width:100%;margin-top:4px;height:32px';
          card.appendChild(au);
        } else {
          const a = document.createElement('a');
          a.className='dl-btn'; a.href=f.url; a.download=f.name||'file';
          a.textContent='↓ save'; card.appendChild(a);
        }
        // Always add a download link for audio too
        if (mime.startsWith('audio/')) {
          const a = document.createElement('a');
          a.className='dl-btn'; a.href=f.url; a.download=f.name||'memo.webm';
          a.style.marginTop='4px'; a.textContent='↓ save'; card.appendChild(a);
        }
      }
    });
    if (!cards.length) {
      const nick = this.peers.get(f.from)?.nick||f.from?.slice(0,8)||'?';
      this._status(f.name+' from '+nick+' — open chat to download','ok',8000);
    } else {
      this._status(f.name+' received','ok',4000);
    }
  }

  _onFileErr(fileId, errMsg) {
    for (const msgs of this.sessions.values()) {
      const m=msgs.find(m=>m.fileId===fileId); if(m){m.status='error';m.error=errMsg;}
    }
    document.querySelectorAll(`[data-fcid="${fileId}"]`).forEach(card => {
      card.querySelector('.prog-track')?.remove(); card.querySelector('.file-stats')?.remove();
      const d=document.createElement('div'); d.className='file-err'; d.textContent='⚠ '+errMsg; card.appendChild(d);
    });
    this._status('file error: '+errMsg,'err',5000);
  }

  // ── Voice Memo ─────────────────────────────────────────────────────────────
  _startVoiceMemo() {
    const panel = $('memo-panel'); if(!panel)return;
    if (this._memo) { this._memo.cancel(); this._memo=null; }
    panel.classList.add('visible');
    const memo = new VoiceMemo(
      (file) => { // onFile
        panel.classList.remove('visible'); panel.innerHTML='';
        this._memo=null;
        this._queueFile(file);
        this._status('voice memo sent','ok',3000);
      },
      () => { // onCancel
        panel.classList.remove('visible'); panel.innerHTML='';
        this._memo=null;
      }
    );
    this._memo=memo; memo.start(panel);
  }

  // ── 1:1 Call ──────────────────────────────────────────────────────────────
  async _startCall(fp, callType) {
    if (!this.net.isReady(fp)) { this._sys('peer offline',true); return; }
    if (this.call)             { this._sys('already in a call',true); return; }
    if (this.circleCall?.phase==='active') { this._sys('end circle call first',true); return; }
    const peerName=this.peers.get(fp)?.nick||fp.slice(0,8), video=callType==='stream';
    this._status('getting '+(video?'camera/mic':'mic')+'…','info');
    let s; try { s=await this.net.getLocalStream(video); } catch(e){ return this._handleMediaError(e,fp); }
    this.call = { fp, type:callType, phase:'inviting', localStream:s, remoteStream:null, muted:false, camOff:false,
      inviteTimer: setTimeout(()=>this._onCallTimeout(fp),45000) };
    this.net.sendCtrl(fp, {type:'call-invite',callType,nick:this.id.nickname});
    this._status(callType+' — calling '+peerName+'…','info');
    this._renderHeader(); this._renderCallPanel();
  }

  _onCallInvite(fp,msg) {
    if (this.call&&this.call.fp!==fp) { this.net.sendCtrl(fp,{type:'call-decline'}); return; }
    if (this.circleCall?.phase==='active') { this.net.sendCtrl(fp,{type:'call-decline'}); return; }
    this.call = { fp, type:msg.callType==='stream'?'stream':'walkie', phase:'ringing', localStream:null, remoteStream:null, muted:false, camOff:false };
    this._showCallIncoming(fp, msg.callType||'walkie', msg.nick, false);
  }

  _onCallAccepted(fp) {
    if (!this.call||this.call.fp!==fp||this.call.phase!=='inviting') return;
    clearTimeout(this.call.inviteTimer); this.call.phase='connecting';
    this._status(this.call.type+' — connecting…','info');
    this.net.offerWithStream(fp, this.call.localStream, false)
      .then(()=>this._attachRemote1to1(fp))
      .catch(e=>{this._status('call setup failed: '+e.message,'err',5000);this._endCallLocal(true);});
  }

  _onCallDeclined(fp) {
    if (!this.call||this.call.fp!==fp) return;
    clearTimeout(this.call.inviteTimer);
    this.call.localStream?.getTracks().forEach(t=>t.stop()); this.call=null;
    this._renderCallPanel(); this._renderHeader();
    this._status((this.peers.get(fp)?.nick||fp.slice(0,8))+' declined','warn',5000);
  }

  _onCallTimeout(fp) {
    if (!this.call||this.call.fp!==fp) return;
    this.call.localStream?.getTracks().forEach(t=>t.stop()); this.call=null;
    this._renderCallPanel(); this._renderHeader();
    this._status('no answer — timed out','warn',5000);
  }

  async _acceptCall(fp) {
    if (!this.call||this.call.fp!==fp||this.call.phase!=='ringing') return;
    this._hideCallIncoming();
    const video=this.call.type==='stream';
    let s; try { s=await this.net.getLocalStream(video); }
    catch(e) { this.net.sendCtrl(fp,{type:'permission-denied',media:video?'camera/mic':'microphone'}); this.call=null; return this._handleMediaError(e,fp); }
    this.call.localStream=s; this.call.phase='connecting';
    this.net.sendCtrl(fp,{type:'call-accept'}); // no circle flag — plain 1:1
    this._status(this.call.type+' — waiting for '+( this.peers.get(fp)?.nick||fp.slice(0,8))+'…','info');
    await this._openSession(fp); this._renderCallPanel();
  }

  _declineCall(fp) {
    this._hideCallIncoming();
    if (this.call?.fp===fp) { this.call.localStream?.getTracks().forEach(t=>t.stop()); this.call=null; }
    this.net.sendCtrl(fp,{type:'call-decline'}); this._renderCallPanel();
  }

  _onOfferReneg(fp, msg) {
    if (this.call?.fp===fp && (this.call.phase==='connecting'||this.call.phase==='ringing')) {
      if (!this.call.localStream) { this.call.inviteSdp=msg.sdp; return; }
      this.net.answerWithStream(fp,msg.sdp,this.call.localStream)
        .then(()=>this._attachRemote1to1(fp))
        .catch(e=>{this._status('call answer failed: '+e.message,'err',5000);this._endCallLocal(true);});
    }
  }

  _attachRemote1to1(fp) {
    this.net.setRemoteStreamHandler(fp, stream => {
      if (!stream) return;
      this._audioEl.srcObject=stream;
      if (typeof this._audioEl.setSinkId==='function') this._audioEl.setSinkId('').catch(()=>{});
      this._audioEl.play().catch(()=>{});
      if (this.call?.fp===fp) {
        this.call.remoteStream=stream; this.call.phase='active';
        this._renderCallPanel(); this._renderHeader();
        this._startStatsPolling(fp);
        this._status(this.call.type+' on · '+(this.peers.get(fp)?.nick||fp.slice(0,8)),'ok');
      }
    });
  }

  async _endCallLocal(sendEnd=true) {
    if (!this.call)return;
    const fp=this.call.fp;
    clearTimeout(this.call.inviteTimer);
    this.call.localStream?.getTracks().forEach(t=>t.stop()); this.call=null;
    this._stopStatsPolling();
    if (sendEnd) await this.net.stopMedia(fp).catch(()=>{});
    this._audioEl.srcObject=null; this._renderCallPanel(); this._renderHeader();
  }

  // ── Circle Call ────────────────────────────────────────────────────────────
  async _startCircleCall(callType) {
    if (this.call) { this._sys('end 1:1 call first',true); return; }
    if (this.circleCall?.phase==='active') { this._endCircleCall(); return; }
    const fps = this.net.getConnectedPeers().filter(fp=>!this.circleBlocked.has(fp));
    if (!fps.length) { this._sys('no peers in circle',true); return; }
    const video=callType==='stream';
    this._status('getting '+(video?'camera/mic':'mic')+' for circle…','info');
    let s; try{ s=await this.net.getLocalStream(video); }catch(e){ return this._handleMediaError(e,null); }
    this.circleCall = { type:callType, phase:'connecting', localStream:s, remoteStreams:new Map(), audioEls:new Map(), muted:false, camOff:false };
    fps.forEach(fp => {
      this.net.sendCtrl(fp, {type:'call-invite',callType,nick:this.id.nickname,circle:true});
      this._attachCircleRemote(fp);
    });
    this._status('circle '+callType+' — inviting '+fps.length+' peer'+(fps.length>1?'s':'')+'…','info');
    this._renderCircleCallPanel(); this._renderHeader();
  }

  _onCircleCallInvite(fp,msg) {
    if (this.call) { this.net.sendCtrl(fp,{type:'call-decline',circle:true}); return; }
    const callType=msg.callType==='stream'?'stream':'walkie';
    if (!this.circleCall) {
      this.circleCall={type:callType,phase:'ringing',localStream:null,remoteStreams:new Map(),audioEls:new Map(),muted:false,camOff:false};
    }
    const nick=msg.nick||this.peers.get(fp)?.nick||fp.slice(0,8);
    this._showCallIncoming(fp,callType,nick,true);
  }

  async _acceptCircleCall(fp) {
    if (!this.circleCall) return;
    this._hideCallIncoming();
    const video=this.circleCall.type==='stream';
    let s;
    if (this.circleCall.localStream) { s=this.circleCall.localStream; }
    else {
      try { s=await this.net.getLocalStream(video); }
      catch(e) { this.net.sendCtrl(fp,{type:'permission-denied',media:video?'camera/mic':'microphone'}); return this._handleMediaError(e,null); }
      this.circleCall.localStream=s;
    }
    this.circleCall.phase='active';
    this.net.sendCtrl(fp, {type:'call-accept',circle:true});
    this._attachCircleRemote(fp);
    this._renderCircleCallPanel(); this._renderHeader();
    this._status('circle '+this.circleCall.type+' active','ok');
  }

  _declineCircleCall(fp) {
    this._hideCallIncoming();
    this.net.sendCtrl(fp,{type:'call-decline',circle:true});
    if (this.circleCall?.remoteStreams.size===0&&this.circleCall?.phase!=='active') {
      this.circleCall=null; this._renderCircleCallPanel();
    }
  }

  // Initiator: peer accepted → send offer
  _onCircleCallAccepted(fp) {
    if (!this.circleCall?.localStream) { this._log('circle accept but no stream',true); return; }
    this.circleCall.phase='active';
    this.net.offerWithStream(fp, this.circleCall.localStream, true)
      .then(() => this._attachCircleRemote(fp))
      .catch(e => this._log('circle offer failed: '+e.message,true));
    this._renderCircleCallPanel(); this._renderHeader();
  }

  _onCircleCallDeclined(fp) {
    const nick=this.peers.get(fp)?.nick||fp.slice(0,8);
    this._status(nick+' declined circle call','warn',3000);
  }

  // Receiver: incoming offer-reneg for circle call (msg.circle===true)
  _onCircleOfferReneg(fp, msg) {
    if (!this.circleCall?.localStream) { this._log('circle offer-reneg but no stream',true); return; }
    this.net.answerWithStream(fp, msg.sdp, this.circleCall.localStream)
      .then(()=>this._attachCircleRemote(fp))
      .catch(e=>this._status('circle answer failed: '+e.message,'err',5000));
    this.circleCall.phase='active';
    this._renderCircleCallPanel(); this._renderHeader();
  }

  _attachCircleRemote(fp) {
    this.net.setRemoteStreamHandler(fp, stream => {
      if (!stream||!this.circleCall)return;
      this.circleCall.remoteStreams.set(fp,stream);
      let el=this.circleCall.audioEls.get(fp);
      if (!el) { el=Object.assign(document.createElement('audio'),{autoplay:true,playsInline:true}); el.style.display='none'; document.body.appendChild(el); this.circleCall.audioEls.set(fp,el); }
      el.srcObject=stream;
      if (typeof el.setSinkId==='function') el.setSinkId('').catch(()=>{});
      el.play().catch(()=>{});
      this.circleCall.phase='active';
      this._renderCircleCallPanel(); this._renderHeader();
    });
  }

  _removeCirclePeer(fp) {
    if (!this.circleCall)return;
    this.circleCall.remoteStreams.delete(fp);
    const el=this.circleCall.audioEls.get(fp);
    if (el) { el.srcObject=null; try{el.remove();}catch{} this.circleCall.audioEls.delete(fp); }
    if (this.circleCall.remoteStreams.size===0) this._endCircleCall();
    else this._renderCircleCallPanel();
  }

  _endCircleCall() {
    if (!this.circleCall)return;
    this.circleCall.localStream?.getTracks().forEach(t=>t.stop());
    this.circleCall.audioEls.forEach(el=>{try{el.srcObject=null;el.remove();}catch{}});
    this.net.getConnectedPeers().forEach(fp=>{this.net.sendCtrl(fp,{type:'call-end'});this.net.stopMedia(fp).catch(()=>{});});
    this.circleCall=null;
    this._renderCircleCallPanel(); this._renderHeader();
    this._status('circle call ended','info',3000);
  }

  // ── Games ──────────────────────────────────────────────────────────────────
  _startGame(fp, type) {
    if (!this.net.isReady(fp)) { this._sys('peer offline',true); return; }
    this._closePlusMenu();
    if (type==='ttt') {
      this.games.get(fp)?.destroy?.();
      const g = new TicTacToe(fp, this.id.fingerprint, msg=>this.net.sendCtrl(fp,{type:'game',...msg}), ()=>{this.games.delete(fp);this._renderGamePanel(fp);});
      this.games.set(fp,g);
      this.net.sendCtrl(fp,{type:'game',gameType:'ttt',action:'invite',nick:this.id.nickname});
      this._openSession(fp); this._renderGamePanel(fp);
      this._status('tic tac toe invite sent','info');
    }
  }

  _dispatchGame(fp, msg) {
    if (msg.gameType==='ttt') {
      if (msg.action==='invite') {
        const g=new TicTacToe(fp,this.id.fingerprint,m=>this.net.sendCtrl(fp,{type:'game',...m}),()=>{this.games.delete(fp);this._renderGamePanel(fp);});
        this.games.set(fp,g); g.handleMsg(msg);
        this._openSession(fp); this._renderGamePanel(fp);
        this._status((this.peers.get(fp)?.nick||fp.slice(0,8))+' challenges you to tic tac toe!','info',5000);
        return;
      }
      const g=this.games.get(fp); if(g){ g.handleMsg(msg); if(this.active===fp)this._renderGamePanel(fp); }
    }
  }

  _renderGamePanel(fp) {
    const panel=$('game-panel'); if(!panel)return;
    const game=this.games.get(fp);
    if (!game||this.active!==fp) { panel.innerHTML=''; panel.classList.remove('visible'); return; }
    panel.classList.add('visible'); game.render(panel);
  }

  // ── Call incoming overlay ──────────────────────────────────────────────────
  _showCallIncoming(fp,callType,nick,isCircle=false) {
    const panel=$('call-incoming'); if(!panel)return;
    const name=nick||this.peers.get(fp)?.nick||fp.slice(0,8);
    const icon=callType==='stream'?'📷':'🎙';
    panel.innerHTML=`
      <div class="ci-icon">${icon}</div>
      ${isCircle?'<div class="ci-circle">◯ circle</div>':''}
      <div class="ci-label">${callType}</div>
      <div class="ci-name">${esc(name)}</div>
      <div class="ci-sub">${isCircle?'invited you to circle '+callType:'wants to '+callType+' with you'}</div>
      <div class="ci-btns">
        <div class="ci-btn accept" id="ci-acc">accept</div>
        <div class="ci-btn decline" id="ci-dec">decline</div>
      </div>`;
    panel.classList.add('visible');
    $('ci-acc')?.addEventListener('click',()=>isCircle?this._acceptCircleCall(fp):this._acceptCall(fp));
    $('ci-dec')?.addEventListener('click',()=>isCircle?this._declineCircleCall(fp):this._declineCall(fp));
  }
  _hideCallIncoming() { $('call-incoming')?.classList.remove('visible'); }

  // ── Render: 1:1 call panel ─────────────────────────────────────────────────
  _renderCallPanel() {
    const panel=$('call-panel'); if(!panel)return;
    if (!this.call) { panel.innerHTML=''; panel.classList.remove('visible'); return; }
    const {fp,type,phase,muted,camOff,localStream,remoteStream}=this.call;
    const peer=this.peers.get(fp)?.nick||fp.slice(0,8);
    panel.classList.add('visible');
    if (phase==='inviting'||phase==='connecting') {
      const lbl=phase==='inviting'?'calling '+esc(peer)+'…':'connecting…';
      panel.innerHTML=`<div class="call-waiting"><div class="call-type-badge">${type==='stream'?'📷':'🎙'} ${type}</div><div class="call-state">${lbl}</div><div class="call-controls"><div class="call-btn end" id="cb-end">✕ cancel</div></div></div>`;
      $('cb-end')?.addEventListener('click',()=>{this.net.sendCtrl(fp,{type:'call-end'});this._endCallLocal(false);this._status('cancelled','info',2000);});
      return;
    }
    const isStream=type==='stream';
    panel.innerHTML=
      (isStream
        ?`<div class="video-grid"><div class="video-wrap" id="vw-r"><video id="vid-r" autoplay playsinline></video><div class="video-label">${esc(peer)}</div><div class="vid-stats-overlay" id="vid-stats"></div></div><div class="video-wrap local"><video id="vid-l" autoplay playsinline muted></video><div class="video-label">${esc(this.id.nickname)}</div></div></div>`
        :`<div class="walkie-active"><span class="wk-pulse">🎙</span> walkie · <span class="wk-peer">${esc(peer)}</span><div class="waveform"><span></span><span></span><span></span><span></span><span></span></div></div>`)
      +`<div class="call-controls">
          <div class="call-btn${muted?' muted':''}" id="cb-mute">🎙 ${muted?'muted':'mic'}</div>
          ${isStream?`<div class="call-btn${camOff?' muted':''}" id="cb-cam">📷 ${camOff?'off':'cam'}</div><div class="call-btn" id="cb-fs">⛶</div>`:''}
          <div class="call-btn end" id="cb-end">✕ end</div>
        </div>
        <div class="call-stats-bar" id="call-stats-bar">connecting…</div>`;
    const vr=$('vid-r'), vl=$('vid-l');
    if(vr&&remoteStream){vr.srcObject=remoteStream;vr.addEventListener('dblclick',()=>{document.fullscreenElement?document.exitFullscreen().catch(()=>{}):vr.requestFullscreen?.().catch(()=>{});});}
    if(vl&&localStream) vl.srcObject=localStream;
    $('cb-mute')?.addEventListener('click',()=>{if(!this.call)return;this.call.muted=!this.call.muted;this.call.localStream?.getAudioTracks().forEach(t=>{t.enabled=!this.call.muted;});this._renderCallPanel();});
    $('cb-cam')?.addEventListener('click',()=>{if(!this.call)return;this.call.camOff=!this.call.camOff;this.call.localStream?.getVideoTracks().forEach(t=>{t.enabled=!this.call.camOff;});this._renderCallPanel();});
    $('cb-fs')?.addEventListener('click',()=>{const v=$('vid-r');if(v)document.fullscreenElement?document.exitFullscreen().catch(()=>{}):v.requestFullscreen?.().catch(()=>{});});
    $('cb-end')?.addEventListener('click',()=>{this.net.sendCtrl(fp,{type:'call-end'});this._endCallLocal(false);this._status('call ended','info',3000);});
  }

  // ── Render: circle call panel ──────────────────────────────────────────────
  _renderCircleCallPanel() {
    const panel=$('circle-call-panel'); if(!panel)return;
    if (!this.circleCall) { panel.innerHTML=''; panel.classList.remove('visible'); return; }
    const {type,phase,muted,camOff,localStream,remoteStreams}=this.circleCall;
    panel.classList.add('visible');
    if (phase==='connecting'||phase==='ringing') {
      panel.innerHTML=`<div class="call-waiting"><div class="call-type-badge">◯ circle ${type==='stream'?'📷 stream':'🎙 walkie'}</div><div class="call-state">inviting peers…</div><div class="call-controls"><div class="call-btn end" id="ccb-end">✕ end</div></div></div>`;
      $('ccb-end')?.addEventListener('click',()=>this._endCircleCall()); return;
    }
    const isStream=type==='stream', count=remoteStreams.size;
    let html='';
    if (isStream) {
      html='<div class="video-grid">';
      html+=`<div class="video-wrap local"><video id="cvid-l" autoplay playsinline muted></video><div class="video-label">${esc(this.id.nickname)}</div></div>`;
      remoteStreams.forEach((_,fp)=>{const n=this.peers.get(fp)?.nick||fp.slice(0,8);html+=`<div class="video-wrap"><video id="cvid-${fp.slice(0,8)}" autoplay playsinline></video><div class="video-label">${esc(n)}</div></div>`;});
      html+='</div>';
    } else {
      const names=[...remoteStreams.keys()].map(fp=>this.peers.get(fp)?.nick||fp.slice(0,8)).join(', ')||'—';
      html=`<div class="walkie-active"><span class="wk-pulse">◯🎙</span> circle · <span class="wk-peer">${count} peer${count!==1?'s':''}: ${esc(names)}</span><div class="waveform"><span></span><span></span><span></span><span></span><span></span></div></div>`;
    }
    html+=`<div class="call-controls"><div class="call-btn${muted?' muted':''}" id="ccb-mute">🎙 ${muted?'muted':'mic'}</div>${isStream?`<div class="call-btn${camOff?' muted':''}" id="ccb-cam">📷 ${camOff?'off':'cam'}</div>`:''}<div class="call-btn end" id="ccb-end">✕ end</div></div>`;
    panel.innerHTML=html;
    const vl=$('cvid-l'); if(vl&&localStream)vl.srcObject=localStream;
    remoteStreams.forEach((stream,fp)=>{const v=$(`cvid-${fp.slice(0,8)}`);if(v)v.srcObject=stream;});
    $('ccb-mute')?.addEventListener('click',()=>{if(!this.circleCall)return;this.circleCall.muted=!this.circleCall.muted;this.circleCall.localStream?.getAudioTracks().forEach(t=>{t.enabled=!this.circleCall.muted;});this._renderCircleCallPanel();});
    $('ccb-cam')?.addEventListener('click',()=>{if(!this.circleCall)return;this.circleCall.camOff=!this.circleCall.camOff;this.circleCall.localStream?.getVideoTracks().forEach(t=>{t.enabled=!this.circleCall.camOff;});this._renderCircleCallPanel();});
    $('ccb-end')?.addEventListener('click',()=>this._endCircleCall());
  }

  // ── Stats polling ──────────────────────────────────────────────────────────
  _startStatsPolling(fp) {
    this._stopStatsPolling();
    this._statsTimer=setInterval(async()=>{
      const s=await this.net.getStats(fp); if(!s)return;
      const bar=$('call-stats-bar'); if(!bar)return;
      const parts=[];
      if(s.videoWidth)parts.push(`${s.videoWidth}×${s.videoHeight} ${s.fps}fps`);
      if(s.videoKbps)parts.push(`↓${s.videoKbps}kbps`);
      if(s.audioKbps)parts.push(`🎙${s.audioKbps}kbps`);
      if(s.rttMs!=null)parts.push(`rtt ${s.rttMs}ms`);
      if(s.bytesSent)parts.push(`↑${fmt(s.bytesSent)}`);
      if(s.bytesRecv)parts.push(`↓${fmt(s.bytesRecv)}`);
      bar.textContent=parts.join(' · ')||'active';
    },2000);
  }
  _stopStatsPolling(){ clearInterval(this._statsTimer); this._statsTimer=null; }

  // ── Session ────────────────────────────────────────────────────────────────
  async _openSession(fp) {
    if (!fp)return;
    this.active=fp; this.unread.delete(fp);
    if (!this.sessions.has(fp)) { try{this.sessions.set(fp,await loadMessages(fp));}catch{this.sessions.set(fp,[]);} }
    this._renderHeader(); this._renderMsgs(); this._renderPeers();
    this._renderCallPanel(); this._renderCircleCallPanel();
    this._renderGamePanel(fp);
    const ib=$('input-bar'); if(ib)ib.classList.add('visible');
    $('msg-input')?.focus(); this._showChat();
    this._buildPlusMenu();
  }

  async _clearChat(fp) {
    const lbl=fp===CIRCLE_ID?'circle':('chat with '+(this.peers.get(fp)?.nick||fp.slice(0,8)));
    if (!confirm('Clear '+lbl+'?'))return;
    try{await clearMessages(fp);this.sessions.set(fp,[]);this._renderMsgs();this._status('cleared','ok',2000);}
    catch(e){this._status('clear failed','err',4000);}
  }

  // ── State export / import ──────────────────────────────────────────────────
  async _exportState() {
    this._status('preparing export…','info');
    try {
      const keyData = await this.id.exportKeyData();
      const messages = await loadAllMessages();
      const peers    = await loadPeers();
      const state = {
        tqVersion: 10,
        exportedAt: new Date().toISOString(),
        identity: keyData ? { ...keyData, nickname: this.id.nickname, fingerprint: this.id.fingerprint } : null,
        peers,
        messages,
      };
      const json  = JSON.stringify(state, null, 2);
      const blob  = new Blob([json], { type:'application/json' });
      const url   = URL.createObjectURL(blob);
      const a     = Object.assign(document.createElement('a'), { href:url, download:`turquoise-${this.id.shortId}-${Date.now()}.json` });
      a.click(); URL.revokeObjectURL(url);
      this._status('state exported ✓','ok',4000);
    } catch(e) {
      this._status('export failed: '+e.message,'err',5000);
    }
  }

  async _importState(file) {
    this._status('reading import file…','info');
    try {
      const text  = await file.text();
      const state = JSON.parse(text);
      if (!state?.tqVersion) throw new Error('Not a valid Turquoise state file');
      const confirmed = confirm(
        'Import Turquoise state?\n\n'
        +(state.identity?'• Identity: '+state.identity.fingerprint?.slice(0,16)+'…\n':'• No identity (messages only)\n')
        +'• '+( state.messages?.length||0)+' messages\n'
        +'• '+(state.peers?.length||0)+' peers\n\n'
        +(state.identity?'This will REPLACE your current identity. Current data will be lost.\n':'Messages will be merged.')
        +'\nContinue?'
      );
      if (!confirmed) { this._status('import cancelled','info',2000); return; }
      if (state.identity?.privJwk) {
        await clearAllData();
        await resetIdentity();
        await importIdentityData(state.identity);
      }
      if (state.messages?.length) await restoreMessages(state.messages);
      if (state.peers?.length)    await restorePeers(state.peers);
      this._status('import complete — reloading…','ok');
      setTimeout(()=>location.reload(), 1200);
    } catch(e) {
      this._status('import failed: '+e.message,'err',6000);
    }
  }

  async _confirmReset() {
    const choice = await this._resetDialog();
    if (choice==='cancel') return;
    if (choice==='export-reset') await this._exportState();
    this._status('resetting…','warn');
    try {
      await clearAllData(); await resetIdentity();
      if ('caches' in window) { const ks=await caches.keys(); await Promise.all(ks.map(k=>caches.delete(k))); }
    } catch(e) { console.warn('reset:', e); }
    location.reload();
  }

  _resetDialog() {
    return new Promise(res => {
      const overlay=document.createElement('div');
      overlay.className='reset-overlay';
      overlay.innerHTML=`<div class="reset-box">
        <div class="reset-title">reset turquoise</div>
        <div class="reset-body">This will delete your identity and all messages.<br>Consider exporting your state first.</div>
        <div class="reset-btns">
          <div class="reset-btn cancel" id="rd-cancel">cancel</div>
          <div class="reset-btn export" id="rd-export">export then reset</div>
          <div class="reset-btn danger" id="rd-reset">reset without export</div>
        </div>
      </div>`;
      document.body.appendChild(overlay);
      const close=(val)=>{overlay.remove();res(val);};
      overlay.querySelector('#rd-cancel')?.addEventListener('click',()=>close('cancel'));
      overlay.querySelector('#rd-export')?.addEventListener('click',()=>close('export-reset'));
      overlay.querySelector('#rd-reset')?.addEventListener('click',()=>close('reset'));
    });
  }

  _toggleCircle(fp, e) {
    e.stopPropagation();
    this.circleBlocked.has(fp)?this.circleBlocked.delete(fp):this.circleBlocked.add(fp);
    this._renderPeers();
    this._status((this.peers.get(fp)?.nick||fp.slice(0,8))+' '+(this.circleBlocked.has(fp)?'removed from':'in')+' circle','info',2000);
  }

  // ── Render: peer list ─────────────────────────────────────────────────────
  _renderPeers() {
    const list=$('peer-list'); if(!list)return;
    const circleOnline=this.net.getConnectedPeers().length>0;
    const cUnread=this.unread.get(CIRCLE_ID)||0;
    const cMsgs=this.sessions.get(CIRCLE_ID)||[];
    const cLast=cMsgs[cMsgs.length-1];
    const cPrev=cLast?(cLast.type==='file'?'📎 '+esc(cLast.name||'file'):esc(cLast.text?.slice(0,42)||'')):'group · everyone';
    const cBadge=this.circleCall?`<div class="peer-badge call-badge">${this.circleCall.type==='stream'?'📷':'🎙'}</div>`:cUnread?`<div class="peer-badge">${cUnread>9?'9+':cUnread}</div>`:'';
    const cActive=this.active===CIRCLE_ID?' active':'';
    const circleTile=`<div class="peer-tile circle-tile${cActive}" data-fp="${CIRCLE_ID}"><div class="circle-icon${circleOnline?' online':''}">◯</div><div class="peer-info"><div class="peer-nick">circle</div><div class="peer-preview">${cPrev}</div></div>${cBadge}</div>`;

    if (!this.peers.size) {
      list.innerHTML=circleTile+'<div id="no-peers">waiting for peers…</div>';
      list.querySelector('.circle-tile')?.addEventListener('click',()=>this._openSession(CIRCLE_ID));
      return;
    }
    const sorted=[...this.peers.entries()].sort(([,a],[,b])=>{if(a.connected!==b.connected)return a.connected?-1:1;return(a.nick||'').localeCompare(b.nick||'');});
    const peerTiles=sorted.map(([fp,p])=>{
      const active=fp===this.active?' active':'';
      const dot=p.connected?'online':'offline';
      const unread=this.unread.get(fp)||0;
      const msgs=this.sessions.get(fp)||[];
      const last=msgs[msgs.length-1];
      const prev=last?(last.type==='file'?'📎 '+esc(last.name||'file'):esc(last.text?.slice(0,42)||'')):'';
      const blocked=this.circleBlocked.has(fp);
      const inCall=this.call?.fp===fp;
      const hasGame=this.games.has(fp);
      const badge=inCall?`<div class="peer-badge call-badge">${this.call.type==='stream'?'📷':'🎙'}</div>`:hasGame?`<div class="peer-badge game-badge">⊞</div>`:unread?`<div class="peer-badge">${unread>9?'9+':unread}</div>`:'';
      return `<div class="peer-tile${active}" data-fp="${fp}"><div class="peer-dot ${dot}"></div><div class="peer-info"><div class="peer-nick">${esc(p.nick||fp.slice(0,8))}</div>${prev?`<div class="peer-preview">${prev}</div>`:''}</div><div class="circle-toggle${blocked?' blocked':''}" data-fp="${fp}" title="${blocked?'add to circle':'remove from circle'}">◯</div>${badge}</div>`;
    }).join('');
    list.innerHTML=circleTile+peerTiles;
    list.querySelectorAll('.peer-tile').forEach(t=>t.addEventListener('click',()=>{const fp=t.dataset.fp;if(fp)this._openSession(fp);}));
    list.querySelectorAll('.circle-toggle').forEach(b=>b.addEventListener('click',e=>{const fp=b.dataset.fp;if(fp)this._toggleCircle(fp,e);}));
  }

  // ── Render: chat header ───────────────────────────────────────────────────
  _renderHeader() {
    const h=$('chat-header'); if(!h)return;
    const fp=this.active;
    const back='<span class="back-btn" id="back-btn">←</span>';
    if (fp===CIRCLE_ID) {
      const connected=this.net.getConnectedPeers().length;
      const ccActive=this.circleCall?.phase==='active';
      h.innerHTML=`${back}<div class="circle-icon-hdr">◯</div><div class="chat-peer-info"><div class="chat-peer-name">circle</div><div class="chat-peer-fp">${connected} peer${connected!==1?'s':''} · broadcast</div></div><div class="chat-actions"><div class="action-btn${ccActive&&this.circleCall?.type==='walkie'?' active-call':''}" id="hbtn-cw" title="circle walkie">🎙</div><div class="action-btn${ccActive&&this.circleCall?.type==='stream'?' active-call':''}" id="hbtn-cs" title="circle stream">📷</div><div class="action-btn danger" id="hbtn-cl" title="clear circle">🗑</div></div>`;
      $('back-btn')?.addEventListener('click',()=>this._showSidebar());
      $('hbtn-cw')?.addEventListener('click',()=>{if(ccActive)this._endCircleCall();else this._startCircleCall('walkie');});
      $('hbtn-cs')?.addEventListener('click',()=>{if(ccActive)this._endCircleCall();else this._startCircleCall('stream');});
      $('hbtn-cl')?.addEventListener('click',()=>this._clearChat(CIRCLE_ID));
      return;
    }
    const p=fp?this.peers.get(fp):null;
    if (!fp||!p) {
      h.innerHTML=`${back}<span id="chat-placeholder">select a peer</span>`;
      $('back-btn')?.addEventListener('click',()=>this._showSidebar()); return;
    }
    const inCall=this.call?.fp===fp&&this.call.phase==='active';
    h.innerHTML=`${back}<div class="peer-dot ${p.connected?'online':'offline'}"></div><div class="chat-peer-info"><div class="chat-peer-name">${esc(p.nick||fp.slice(0,8))}</div><div class="chat-peer-fp">${fp}</div></div><div class="chat-actions"><div class="action-btn${inCall&&this.call?.type==='walkie'?' active-call':''}" id="hbtn-w" title="walkie">🎙</div><div class="action-btn${inCall&&this.call?.type==='stream'?' active-call':''}" id="hbtn-s" title="stream">📷</div><div class="action-btn danger" id="hbtn-cl" title="clear">🗑</div></div>`;
    $('back-btn')?.addEventListener('click',()=>this._showSidebar());
    $('hbtn-w')?.addEventListener('click',()=>{if(inCall){this.net.sendCtrl(fp,{type:'call-end'});this._endCallLocal(false);}else this._startCall(fp,'walkie');});
    $('hbtn-s')?.addEventListener('click',()=>{if(inCall){this.net.sendCtrl(fp,{type:'call-end'});this._endCallLocal(false);}else this._startCall(fp,'stream');});
    $('hbtn-cl')?.addEventListener('click',()=>this._clearChat(fp));
  }

  // ── Render: messages ──────────────────────────────────────────────────────
  _renderMsgs() {
    const msgs=$('messages'); if(!msgs)return;
    msgs.innerHTML='';
    const session=this.sessions.get(this.active)||[];
    if (!session.length) {
      msgs.innerHTML=`<div class="sys-msg">${this.active===CIRCLE_ID?'circle — messages go to everyone':'no messages yet'}</div>`;
      return;
    }
    const frag=document.createDocumentFragment();
    session.forEach(m=>{
      if (m.type==='text') frag.appendChild(this._msgEl(m));
      else if (m.type==='file') frag.appendChild(this._fileCardEl(m));
    });
    msgs.appendChild(frag); this._scroll();
  }

  _appendMsg(msg) {
    const msgs=$('messages'); if(!msgs)return;
    const e=msgs.querySelector('.sys-msg'); if(e&&msgs.children.length===1)e.remove();
    msgs.appendChild(this._msgEl(msg)); this._scroll();
  }

  _appendFileCard(fileMsg) {
    const msgs=$('messages'); if(!msgs||!fileMsg?.fileId)return;
    if (document.querySelector(`[data-fcid="${fileMsg.fileId}"]`))return;
    const e=msgs.querySelector('.sys-msg'); if(e&&msgs.children.length===1)e.remove();
    msgs.appendChild(this._fileCardEl(fileMsg)); this._scroll();
  }

  _msgEl(msg) {
    const d=document.createElement('div'); d.className='msg '+(msg.own?'own':'peer');
    const time=new Date(msg.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    // "you:" removed — show actual nickname for own messages too
    const who=esc(msg.own?this.id.nickname:msg.fromNick||'?');
    d.innerHTML=`<div class="meta">${who} · ${time}</div><div class="bubble">${esc(msg.text)}</div>`;
    return d;
  }

  _fileCardEl(msg) {
    const w=document.createElement('div'); w.className='msg '+(msg.own?'own':'peer');
    const time=new Date(msg.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    const who=esc(msg.own?this.id.nickname:msg.fromNick||'?');
    const cached=this._fileUrls.get(msg.fileId);
    const mime=msg.mimeType||'';
    let inner=`<div class="file-name">📎 ${esc(msg.name||'file')}</div><div class="file-size">${fmt(msg.size)}</div>`;
    if (cached) {
      if (mime.startsWith('audio/')) {
        inner+=`<audio controls src="${cached.url}" style="max-width:100%;height:32px;margin-top:4px"></audio>`;
        inner+=`<a class="dl-btn" href="${cached.url}" download="${esc(msg.name||'memo.webm')}">↓ save</a>`;
      } else {
        inner+=`<a class="dl-btn" href="${cached.url}" download="${esc(msg.name||'file')}">↓ save</a>`;
      }
    } else if (msg.status==='error') {
      inner+=`<div class="file-err">⚠ ${esc(msg.error||'failed')}</div>`;
    } else {
      inner+=`<div class="prog-track"><div class="prog-fill" style="width:0%"></div></div>`;
      inner+=`<div class="file-stats"><span class="fs-pct">0%</span> <span class="fs-sep">·</span> <span class="fs-bytes">—</span></div>`;
    }
    w.innerHTML=`<div class="meta">${who} · ${time}</div><div class="file-card" data-fcid="${msg.fileId}">${inner}</div>`;
    return w;
  }

  _handleMediaError(e,fp) {
    if (e.message.startsWith('permission-denied:')) {
      const media=e.message.split(':')[1];
      this._status(media+' permission denied — allow in browser settings','err',8000);
      if (fp) this.net.sendCtrl(fp,{type:'permission-denied',media});
    } else if (e.message.startsWith('no-device:')) {
      this._status('no '+e.message.split(':')[1]+' found','err',6000);
    } else { this._status('media error: '+e.message,'err',5000); }
    if (this.call){this.call.localStream?.getTracks().forEach(t=>t.stop());this.call=null;}
    this._renderCallPanel(); this._renderHeader();
  }

  // ── Narrow screen ─────────────────────────────────────────────────────────
  _showChat()    { $('sidebar')?.classList.add('slide-left');    $('chat-area')?.classList.add('slide-in'); }
  _showSidebar() { $('sidebar')?.classList.remove('slide-left'); $('chat-area')?.classList.remove('slide-in'); }

  // ── Status bar ────────────────────────────────────────────────────────────
  _status(text, type='info', duration=0) {
    const bar=$('status-bar'); if(!bar)return;
    clearTimeout(this._statusTimer);
    bar.textContent=text; bar.className='s-'+type;
    if (duration) this._statusTimer=setTimeout(()=>{bar.className='';},duration);
  }

  _scroll() { const m=$('messages'); if(m)m.scrollTop=m.scrollHeight; }

  _sys(text, isErr=false) {
    const msgs=$('messages'); if(!msgs)return;
    const d=document.createElement('div'); d.className='sys-msg'+(isErr?' err':''); d.textContent=text;
    msgs.appendChild(d); this._scroll();
    setTimeout(()=>{try{d.remove();}catch{}},5000);
  }

  _log(text, isErr=false) {
    const log=$('net-log'); if(!log)return;
    const d=document.createElement('div'); d.className='entry'+(isErr?' err':''); d.textContent=text;
    log.appendChild(d); log.scrollTop=log.scrollHeight;
    while(log.children.length>120) log.removeChild(log.firstChild);
  }
}
