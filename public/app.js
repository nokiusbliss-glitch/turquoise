/**
 * app.js — Turquoise
 * UI: mesh group + 1:1 chat, files, walkie (audio), stream (video)
 *
 * File transfer persistence fix:
 *   Files stored as {type:'file'} messages in sessions[], not only as DOM cards.
 *   _onFileReady caches blob URL → _renderMsgs builds cards from stored data.
 *   Cards always appear when a session is opened, regardless of whether the
 *   user was watching at the time of transfer.
 *
 * Mesh features: group walkie, group stream, file broadcast.
 *   Mesh walkie/stream: get mic/cam once → offerWithStream to each peer.
 *   Mesh file: send independently to each connected peer.
 *   Mesh calls auto-join on the receiver side (show accept/decline overlay,
 *   auto-accept after 8s to avoid silent mic activation).
 */

import { saveMessage, loadMessages, savePeer, loadPeers, clearMessages, clearAllData } from './messages.js';
import { resetIdentity } from './identity.js';
import { FileTransfer } from './files.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmt = (b) => {
  if (!b || b < 1) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1)+' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1)+' MB';
  return (b/1073741824).toFixed(2)+' GB';
};
const clock = () => new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });

const MESH_ID = 'mesh';

export class TurquoiseApp {
  constructor(identity, network) {
    if (!identity?.fingerprint) throw new Error('App: identity required');
    if (!network?.sendCtrl)     throw new Error('App: network required');
    this.id   = identity;
    this.net  = network;

    this.peers      = new Map();   // fp → {nick, connected}
    this.sessions   = new Map();   // sessionId → msg[]
    this.active     = null;
    this.unread     = new Map();
    this.meshBlocked= new Set();

    // 1:1 call
    this.call = null;
    // call = {fp, type('walkie'|'stream'), phase('inviting'|'ringing'|'connecting'|'active'),
    //          localStream, remoteStream, muted, camOff, inviteTimer, inviteSdp}

    // Mesh call — separate from 1:1
    this.meshCall = null;
    // meshCall = {type, phase, localStream, remoteStreams: Map<fp,MediaStream>,
    //             audioEls: Map<fp,HTMLAudioElement>, muted, camOff}

    // File blob URL cache: fileId → {url, name, from, sessionId}
    this._fileUrls  = new Map();

    // 1:1 audio element
    this._audioEl = document.createElement('audio');
    this._audioEl.autoplay = true; this._audioEl.playsInline = true;
    this._audioEl.controls = false; this._audioEl.style.display = 'none';
    document.body.appendChild(this._audioEl);

    this.ft = new FileTransfer(
      (fp, msg) => network.sendCtrl(fp, msg),
      (fp, buf) => network.sendBinary(fp, buf),
      (fp)      => network.waitForBuffer(fp),
    );
    this.ft.onProgress  = (id, pct, dir, fp) => this._onFileProg(id, pct, dir, fp);
    this.ft.onFileReady = (f)                 => this._onFileReady(f);
    this.ft.onError     = (id, msg, fp)       => this._onFileErr(id, msg, fp);
  }

  // ── Mount ──────────────────────────────────────────────────────────────────
  async mount() {
    const nd = $('nick-display'), ni = $('nick-input'), fp = $('full-fp');
    if (nd) nd.textContent = this.id.nickname;
    if (ni) ni.value       = this.id.nickname;
    if (fp) fp.textContent = this.id.fingerprint;

    try {
      const saved = await loadPeers();
      for (const p of saved) this.peers.set(p.fingerprint, { nick: p.nickname||p.shortId||p.fingerprint.slice(0,8), connected:false });
    } catch (e) { this._log('⚠ peer history: '+e.message, true); }

    // Load mesh history
    try { this.sessions.set(MESH_ID, await loadMessages(MESH_ID)); }
    catch { this.sessions.set(MESH_ID, []); }

    this._bind();
    this._wire();
    await this._openSession(MESH_ID);

    if (this.id.isNewUser) {
      this._status('welcome — tap your name to set it', 'info');
      setTimeout(() => this._triggerNickEdit(), 500);
    } else {
      this._status('connecting…', 'info');
    }
  }

  // ── Bind UI ────────────────────────────────────────────────────────────────
  _bind() {
    // Nick edit
    const row = $('identity-row'), disp = $('nick-display'), inp = $('nick-input');
    if (row && disp && inp) {
      row.addEventListener('click', () => this._triggerNickEdit());
      const save = async () => {
        if (!inp.classList.contains('visible')) return;
        const saved = await this.id.saveNickname(inp.value).catch(() => this.id.nickname);
        this.id.nickname = saved;
        disp.textContent = saved; inp.value = saved;
        disp.classList.remove('hidden'); inp.classList.remove('visible');
        this.net.getConnectedPeers().forEach(fp => this.net.sendCtrl(fp, { type:'nick-update', nick:saved }));
        this._status('name saved: '+saved, 'ok', 3000);
      };
      inp.addEventListener('keydown', e => { if (e.key==='Enter'||e.key==='Escape') { e.preventDefault(); save(); } });
      inp.addEventListener('blur', save);
    }

    // Message send
    const mi = $('msg-input'), sb = $('send-btn');
    if (mi) {
      mi.addEventListener('keydown', e => { if (e.key==='Enter'&&!e.shiftKey) { e.preventDefault(); this._send(); } });
      mi.addEventListener('input', () => { mi.style.height='auto'; mi.style.height=Math.min(mi.scrollHeight,128)+'px'; });
    }
    sb?.addEventListener('click', () => this._send());

    // File attach
    const fb = $('file-btn'), fi = $('__file-input');
    if (fb && fi) {
      fb.addEventListener('click', () => {
        if (!this.active) { this._sys('select a session first', true); return; }
        if (this.active !== MESH_ID && !this.net.isReady(this.active)) { this._sys('peer offline', true); return; }
        fi.click();
      });
      fi.addEventListener('change', e => { Array.from(e.target.files||[]).forEach(f => this._queueFile(f)); fi.value=''; });
    }

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
    const disp = $('nick-display'), inp = $('nick-input');
    if (!disp||!inp||inp.classList.contains('visible')) return;
    disp.classList.add('hidden'); inp.classList.add('visible'); inp.focus(); inp.select();
  }

  // ── Wire network ──────────────────────────────────────────────────────────
  _wire() {
    const n = this.net;
    n.onPeerConnected         = (fp,nick) => this._onConnect(fp, nick);
    n.onPeerDisconnected      = (fp)      => this._onDisconnect(fp);
    n.onMessage               = (fp,msg)  => { try { this._dispatch(fp,msg); } catch(e) { this._log('⚠ msg: '+e.message,true); } };
    n.onBinaryChunk           = (fp,buf)  => { try { this.ft.handleBinary(fp,buf); } catch(e) { this._log('⚠ binary: '+e.message,true); } };
    n.onLog                   = (t,e)     => this._log(t,e);
    n.onSignalingConnected    = ()        => this._status('signaling connected — searching for peers','ok',4000);
    n.onSignalingDisconnected = ()        => this._status('signaling lost — reconnecting…','warn');
  }

  // ── Peer lifecycle ─────────────────────────────────────────────────────────
  _onConnect(fp, nick) {
    const ex = this.peers.get(fp);
    const name = nick||ex?.nick||fp.slice(0,8);
    this.peers.set(fp, { nick:name, connected:true });
    savePeer({ fingerprint:fp, shortId:fp.slice(0,8), nickname:name }).catch(()=>{});
    if (!this.sessions.has(fp)) {
      loadMessages(fp).then(msgs => { this.sessions.set(fp, msgs); this._renderPeers(); if(this.active===fp) this._renderMsgs(); }).catch(() => { this.sessions.set(fp,[]); });
    } else { this._renderPeers(); }
    if (this.active===fp) this._renderHeader();
    this._status(`${name} joined`,'ok',3000);
  }

  _onDisconnect(fp) {
    const p = this.peers.get(fp); const name = p?.nick||fp.slice(0,8);
    if (p) p.connected = false;
    // End any calls with this peer
    if (this.call?.fp===fp) this._endCallLocal(false);
    if (this.meshCall) this._removeMeshPeer(fp);
    this._renderPeers();
    if (this.active===fp) this._renderHeader();
    this._status(`${name} disconnected`,'warn',5000);
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────
  _dispatch(fp, msg) {
    const { type } = msg;
    if (type==='hello') {
      const p = this.peers.get(fp); if(p&&msg.nick){ p.nick=msg.nick; this._renderPeers(); } return;
    }
    if (type==='nick-update') {
      const p = this.peers.get(fp);
      if(p&&msg.nick) { p.nick=msg.nick; this._renderPeers(); if(this.active===fp) this._renderHeader(); savePeer({fingerprint:fp,shortId:fp.slice(0,8),nickname:msg.nick}).catch(()=>{}); } return;
    }
    if (type==='chat') { msg.mesh ? this._recvMesh(fp,msg) : this._recv1to1(fp,msg); return; }

    // ── File transfer ──────────────────────────────────────────────────────
    if (type==='file-meta') {
      const sessionId = msg.mesh ? MESH_ID : fp;
      const nick = this.peers.get(fp)?.nick||fp.slice(0,8);
      // Always store as a file message in the session — regardless of which session is open
      const fileMsgId = msg.fileId+'_recv';
      const fileMsg = {
        id: fileMsgId, sessionId, from:fp, fromNick:nick, own:false,
        type:'file', fileId:msg.fileId, name:msg.name||'file', size:msg.size||0,
        mimeType:msg.mimeType, ts:Date.now(), status:'receiving',
      };
      if (!this.sessions.has(sessionId)) this.sessions.set(sessionId,[]);
      this.sessions.get(sessionId).push(fileMsg);
      // Render card if session is open; else just badge
      if (this.active===sessionId) this._appendFileCard(fileMsg);
      else { this.unread.set(sessionId,(this.unread.get(sessionId)||0)+1); this._renderPeers(); }
      this.ft.handleCtrl(fp, msg);
      this._status(`receiving ${msg.name} from ${nick}…`,'info');
      return;
    }
    if (type==='file-end'||type==='file-abort') { this.ft.handleCtrl(fp,msg); return; }

    // ── 1:1 call signals ──────────────────────────────────────────────────
    if (type==='call-invite')   { this._onCallInvite(fp,msg); return; }
    if (type==='call-accept')   { this._onCallAccepted(fp); return; }
    if (type==='call-decline')  { this._onCallDeclined(fp); return; }
    if (type==='offer-reneg')   { this._onOfferReneg(fp,msg); return; }
    if (type==='call-end')      { this._onCallEnd(fp); return; }

    // ── Permission error from remote ───────────────────────────────────────
    if (type==='permission-denied') {
      const nick = this.peers.get(fp)?.nick||fp.slice(0,8);
      this._status(`${nick}: ${msg.media||'microphone'} permission denied on their device`,'err',8000);
      if (this.call?.fp===fp) this._endCallLocal(false);
      this._hideCallIncoming(); return;
    }
  }

  // ── 1:1 Chat ──────────────────────────────────────────────────────────────
  _recv1to1(fp, ev) {
    if (!ev.text) return;
    const msg = { id:ev.id||crypto.randomUUID(), sessionId:fp, from:fp, fromNick:ev.nick||this.peers.get(fp)?.nick||fp.slice(0,8), text:String(ev.text), ts:ev.ts||Date.now(), type:'text', own:false };
    if (!this.sessions.has(fp)) this.sessions.set(fp,[]);
    this.sessions.get(fp).push(msg);
    saveMessage(msg).catch(()=>{});
    if (this.active!==fp) { this.unread.set(fp,(this.unread.get(fp)||0)+1); this._renderPeers(); }
    else this._appendMsg(msg);
  }

  // ── Mesh Chat ──────────────────────────────────────────────────────────────
  _recvMesh(fp, ev) {
    if (!ev.text||this.meshBlocked.has(fp)) return;
    const msg = { id:ev.id||crypto.randomUUID(), sessionId:MESH_ID, from:fp, fromNick:ev.nick||this.peers.get(fp)?.nick||fp.slice(0,8), text:String(ev.text), ts:ev.ts||Date.now(), type:'text', own:false };
    if (!this.sessions.has(MESH_ID)) this.sessions.set(MESH_ID,[]);
    this.sessions.get(MESH_ID).push(msg);
    saveMessage(msg).catch(()=>{});
    if (this.active!==MESH_ID) { this.unread.set(MESH_ID,(this.unread.get(MESH_ID)||0)+1); this._renderPeers(); }
    else this._appendMsg(msg);
  }

  _send() {
    const inp = $('msg-input'); const text = inp?.value?.trim();
    if (!text||!this.active) return;
    const id=crypto.randomUUID(), ts=Date.now();
    if (this.active===MESH_ID) {
      const fps = this.net.getConnectedPeers().filter(fp=>!this.meshBlocked.has(fp));
      if (!fps.length) { this._sys('no peers in mesh',true); return; }
      fps.forEach(fp => this.net.sendCtrl(fp, { type:'chat', mesh:true, id, nick:this.id.nickname, text, ts }));
      const msg = { id, sessionId:MESH_ID, from:this.id.fingerprint, fromNick:this.id.nickname, text, ts, type:'text', own:true };
      if (!this.sessions.has(MESH_ID)) this.sessions.set(MESH_ID,[]);
      this.sessions.get(MESH_ID).push(msg);
      saveMessage(msg).catch(()=>{}); this._appendMsg(msg); this._renderPeers();
    } else {
      const fp=this.active;
      if (!this.net.isReady(fp)) { this._sys('peer offline — not sent',true); return; }
      if (!this.net.sendCtrl(fp,{ type:'chat', id, nick:this.id.nickname, text, ts })) { this._sys('send failed',true); return; }
      const msg = { id, sessionId:fp, from:this.id.fingerprint, fromNick:this.id.nickname, text, ts, type:'text', own:true };
      if (!this.sessions.has(fp)) this.sessions.set(fp,[]);
      this.sessions.get(fp).push(msg);
      saveMessage(msg).catch(()=>{}); this._appendMsg(msg); this._renderPeers();
    }
    if (inp) { inp.value=''; inp.style.height='auto'; }
  }

  // ── Files ──────────────────────────────────────────────────────────────────
  _queueFile(file) {
    if (!file||!this.active) return;
    const sessionId = this.active;
    const peers = sessionId===MESH_ID
      ? this.net.getConnectedPeers().filter(fp=>!this.meshBlocked.has(fp))
      : (this.net.isReady(sessionId) ? [sessionId] : []);
    if (!peers.length) { this._sys(sessionId===MESH_ID?'no peers in mesh':'peer offline',true); return; }

    const fileId = crypto.randomUUID();
    // Store as a file message so it persists when session re-opens
    const fileMsg = {
      id: fileId+'_send', sessionId, from:this.id.fingerprint, fromNick:this.id.nickname,
      type:'file', fileId, name:file.name, size:file.size, mimeType:file.type||'application/octet-stream',
      ts:Date.now(), own:true, status:'sending',
    };
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId,[]);
    this.sessions.get(sessionId).push(fileMsg);
    this._appendFileCard(fileMsg);
    this._status(`sending ${file.name}…`,'info');
    // Send to all relevant peers
    peers.forEach(fp => this.ft.send(file, fp, fileId));
  }

  _onFileProg(fileId, pct) {
    // Update any visible progress bar for this fileId
    document.querySelectorAll(`[data-fcid="${fileId}"] .prog-fill`).forEach(el => {
      el.style.width = (pct*100).toFixed(1)+'%';
    });
  }

  _onFileReady(f) {
    // Cache the URL
    this._fileUrls.set(f.fileId, f);

    // Update the stored session message status
    const sessId = f.sessionId || f.from; // receivers: use from as sessionId (or MESH_ID if mesh)
    // Find and update in sessions
    for (const [sid, msgs] of this.sessions) {
      for (const m of msgs) {
        if (m.fileId===f.fileId) { m.status='done'; break; }
      }
    }

    // Update any visible card in DOM
    const cards = document.querySelectorAll(`[data-fcid="${f.fileId}"]`);
    cards.forEach(card => {
      card.querySelector('.prog-track')?.remove();
      if (!card.querySelector('.dl-btn')) {
        const a = document.createElement('a');
        a.className='dl-btn'; a.href=f.url; a.download=f.name||'file';
        a.textContent='↓ '+esc(f.name||'file'); card.appendChild(a);
      }
    });
    if (!cards.length) {
      // Card not in DOM (different session open) — show status nudge
      const nick = this.peers.get(f.from)?.nick||f.from?.slice(0,8)||'?';
      this._status(`${f.name} received from ${nick} — open their chat to download`,'ok',8000);
    } else {
      this._status(`${f.name} received`,'ok',4000);
    }
  }

  _onFileErr(fileId, errMsg, fp) {
    // Update stored message
    for (const msgs of this.sessions.values()) {
      const m = msgs.find(m=>m.fileId===fileId); if(m) { m.status='error'; m.error=errMsg; }
    }
    document.querySelectorAll(`[data-fcid="${fileId}"]`).forEach(card => {
      card.querySelector('.prog-track')?.remove();
      const d = document.createElement('div');
      d.style.cssText='color:var(--err);font-size:.65rem;margin-top:4px';
      d.textContent='⚠ '+errMsg; card.appendChild(d);
    });
    this._status('file error: '+errMsg,'err',5000);
  }

  // ── 1:1 Call: Initiator ────────────────────────────────────────────────────
  async _startCall(fp, callType) {
    if (!this.net.isReady(fp)) { this._sys('peer offline',true); return; }
    if (this.call)              { this._sys('already in a call',true); return; }
    if (this.meshCall)          { this._sys('end the mesh call first',true); return; }
    const peerName = this.peers.get(fp)?.nick||fp.slice(0,8);
    const video    = callType==='stream';
    this._status(`getting ${video?'camera/mic':'mic'}…`,'info');
    let localStream;
    try { localStream = await this.net.getLocalStream(video); }
    catch (e) { return this._handleMediaError(e, fp); }
    this.call = { fp, type:callType, phase:'inviting', localStream, remoteStream:null, muted:false, camOff:false,
      inviteTimer: setTimeout(()=>this._onCallTimeout(fp), 45000) };
    this.net.sendCtrl(fp, { type:'call-invite', callType, nick:this.id.nickname });
    this._status(`${callType} — calling ${peerName}…`,'info');
    this._renderHeader(); this._renderCallPanel();
  }

  _onCallAccepted(fp) {
    if (!this.call||this.call.fp!==fp||this.call.phase!=='inviting') return;
    clearTimeout(this.call.inviteTimer);
    this.call.phase='connecting';
    const peerName=this.peers.get(fp)?.nick||fp.slice(0,8);
    this._status(`${this.call.type} — connecting with ${peerName}…`,'info');
    this.net.offerWithStream(fp, this.call.localStream).then(()=>this._attachRemote1to1(fp)).catch(e=>{
      this._status('call setup failed: '+e.message,'err',5000); this._endCallLocal(true);
    });
  }

  _onCallDeclined(fp) {
    if (!this.call||this.call.fp!==fp) return;
    clearTimeout(this.call.inviteTimer);
    this.call.localStream?.getTracks().forEach(t=>t.stop()); this.call=null;
    this._renderCallPanel(); this._renderHeader();
    this._status(`${this.peers.get(fp)?.nick||fp.slice(0,8)} declined the call`,'warn',5000);
  }

  _onCallTimeout(fp) {
    if (!this.call||this.call.fp!==fp) return;
    this.call.localStream?.getTracks().forEach(t=>t.stop()); this.call=null;
    this._renderCallPanel(); this._renderHeader();
    this._status('no answer — call timed out','warn',5000);
  }

  // ── 1:1 Call: Receiver ─────────────────────────────────────────────────────
  _onCallInvite(fp, msg) {
    // If already in any call, decline automatically
    if (this.call&&this.call.fp!==fp) { this.net.sendCtrl(fp,{type:'call-decline'}); return; }
    if (this.meshCall) { this.net.sendCtrl(fp,{type:'call-decline'}); return; }
    if (!this.call) {
      this.call = { fp, type:msg.callType==='stream'?'stream':'walkie', phase:'ringing',
        localStream:null, remoteStream:null, muted:false, camOff:false, inviteTimer:null, inviteSdp:null };
    }
    this._showCallIncoming(fp, msg.callType||'walkie', msg.nick, false);
  }

  async _acceptCall(fp) {
    if (!this.call||this.call.fp!==fp||this.call.phase!=='ringing') return;
    this._hideCallIncoming();
    const video=this.call.type==='stream';
    this._status(`getting ${video?'camera/mic':'mic'}…`,'info');
    let localStream;
    try { localStream = await this.net.getLocalStream(video); }
    catch (e) {
      this.net.sendCtrl(fp,{type:'permission-denied',media:video?'camera/mic':'microphone'});
      this.call=null; return this._handleMediaError(e, fp);
    }
    this.call.localStream=localStream; this.call.phase='connecting';
    this.net.sendCtrl(fp,{type:'call-accept'});
    this._status(`${this.call.type} — waiting for ${this.peers.get(fp)?.nick||fp.slice(0,8)}…`,'info');
    this._openSession(fp); this._renderCallPanel();
  }

  _declineCall(fp) {
    this._hideCallIncoming();
    if (this.call?.fp===fp) { this.call.localStream?.getTracks().forEach(t=>t.stop()); this.call=null; }
    this.net.sendCtrl(fp,{type:'call-decline'});
    this._renderCallPanel();
  }

  _onOfferReneg(fp, msg) {
    // Is this for an accepted 1:1 call?
    if (this.call?.fp===fp&&(this.call.phase==='connecting'||this.call.phase==='ringing')) {
      if (!this.call.localStream) { this.call.inviteSdp=msg.sdp; return; }
      this.net.answerWithStream(fp, msg.sdp, this.call.localStream)
        .then(()=>this._attachRemote1to1(fp))
        .catch(e=>{ this._status('call answer failed: '+e.message,'err',5000); this._endCallLocal(true); });
      return;
    }
    // Is this a mesh call coming in? (peer started mesh walkie/stream)
    if (msg.meshCall) { this._onMeshCallInvite(fp, msg); return; }
    // Unknown — ignore (stale renegotiation)
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
        this._status(`${this.call.type} on · ${this.peers.get(fp)?.nick||fp.slice(0,8)}`,'ok');
      }
    });
  }

  _onCallEnd(fp) {
    if (this.call?.fp===fp) { this._endCallLocal(false); this._status('call ended','info',3000); }
    this._hideCallIncoming();
  }

  async _endCallLocal(sendEnd=true) {
    if (!this.call) return;
    const fp=this.call.fp;
    clearTimeout(this.call.inviteTimer);
    this.call.localStream?.getTracks().forEach(t=>t.stop());
    this.call=null;
    if (sendEnd) await this.net.stopMedia(fp).catch(()=>{});
    this._audioEl.srcObject=null;
    this._renderCallPanel(); this._renderHeader();
  }

  _handleMediaError(e, fp) {
    if (e.message.startsWith('permission-denied:')) {
      const media=e.message.split(':')[1];
      this._status(`${media} permission denied — allow in browser settings`,'err',8000);
      if(fp) this.net.sendCtrl(fp,{type:'permission-denied',media});
    } else if (e.message.startsWith('no-device:')) {
      this._status(`no ${e.message.split(':')[1]} found on this device`,'err',6000);
    } else { this._status('media error: '+e.message,'err',5000); }
    if (this.call) { this.call.localStream?.getTracks().forEach(t=>t.stop()); this.call=null; }
    this._renderCallPanel(); this._renderHeader();
  }

  // ── Mesh Call ──────────────────────────────────────────────────────────────
  async _startMeshCall(callType) {
    if (this.call) { this._sys('end the 1:1 call first',true); return; }
    if (this.meshCall?.phase==='active') { this._endMeshCall(); return; }
    const fps = this.net.getConnectedPeers().filter(fp=>!this.meshBlocked.has(fp));
    if (!fps.length) { this._sys('no peers in mesh',true); return; }
    const video = callType==='stream';
    this._status(`getting ${video?'camera/mic':'mic'} for mesh ${callType}…`,'info');
    let localStream;
    try { localStream = await this.net.getLocalStream(video); }
    catch (e) { return this._handleMediaError(e, null); }
    this.meshCall = { type:callType, phase:'connecting', localStream, remoteStreams:new Map(), audioEls:new Map(), muted:false, camOff:false };
    // Offer to each mesh peer
    fps.forEach(fp => {
      this.net.sendCtrl(fp, { type:'call-invite', callType, nick:this.id.nickname, meshCall:true });
      this._attachMeshRemote(fp);
    });
    this._status(`mesh ${callType} starting — inviting ${fps.length} peer${fps.length>1?'s':''}…`,'info');
    this._renderMeshCallPanel();
    this._renderHeader();
  }

  _onMeshCallInvite(fp, msg) {
    if (this.call) { this.net.sendCtrl(fp,{type:'call-decline'}); return; }
    // Show accept/decline overlay with mesh context
    const callType = msg.callType==='stream'?'stream':'walkie';
    const nick = msg.nick||this.peers.get(fp)?.nick||fp.slice(0,8);
    // Also store SDP for when user accepts (offer-reneg arrives simultaneously)
    if (!this.meshCall) {
      this.meshCall = { type:callType, phase:'ringing', localStream:null, remoteStreams:new Map(), audioEls:new Map(), muted:false, camOff:false, pendingSdps:new Map() };
    }
    if (msg.sdp) this.meshCall.pendingSdps?.set(fp, msg.sdp);
    this._showCallIncoming(fp, callType, nick, true /* isMesh */);
  }

  async _acceptMeshCall(fp) {
    if (!this.meshCall) return;
    this._hideCallIncoming();
    const video = this.meshCall.type==='stream';
    this._status(`getting ${video?'camera/mic':'mic'} for mesh…`,'info');
    let localStream;
    if (this.meshCall.localStream) { localStream = this.meshCall.localStream; }
    else {
      try { localStream = await this.net.getLocalStream(video); }
      catch (e) {
        this.net.sendCtrl(fp,{type:'permission-denied',media:video?'camera/mic':'microphone'});
        return this._handleMediaError(e, null);
      }
      this.meshCall.localStream=localStream;
    }
    this.meshCall.phase='active';
    this.net.sendCtrl(fp,{type:'call-accept'});
    this._attachMeshRemote(fp);
    this._renderMeshCallPanel();
    this._renderHeader();
    this._status(`mesh ${this.meshCall.type} active`,'ok');
  }

  _declineMeshCall(fp) {
    this._hideCallIncoming();
    this.net.sendCtrl(fp,{type:'call-decline'});
    // If meshCall has no active streams, clean it up
    if (this.meshCall?.remoteStreams.size===0&&this.meshCall?.phase!=='active') {
      this.meshCall=null; this._renderMeshCallPanel();
    }
  }

  _attachMeshRemote(fp) {
    this.net.setRemoteStreamHandler(fp, stream => {
      if (!stream||!this.meshCall) return;
      this.meshCall.remoteStreams.set(fp, stream);
      // Create or update per-peer audio element
      let el = this.meshCall.audioEls.get(fp);
      if (!el) {
        el = document.createElement('audio');
        el.autoplay=true; el.playsInline=true; el.controls=false;
        el.style.display='none'; document.body.appendChild(el);
        this.meshCall.audioEls.set(fp, el);
      }
      el.srcObject=stream;
      if (typeof el.setSinkId==='function') el.setSinkId('').catch(()=>{});
      el.play().catch(()=>{});
      this.meshCall.phase='active';
      this._renderMeshCallPanel();
      this._renderHeader();
    });
  }

  _removeMeshPeer(fp) {
    if (!this.meshCall) return;
    this.meshCall.remoteStreams.delete(fp);
    const el = this.meshCall.audioEls.get(fp);
    if (el) { el.srcObject=null; try{el.remove();}catch{} this.meshCall.audioEls.delete(fp); }
    if (this.meshCall.remoteStreams.size===0) { this._endMeshCall(); }
    else { this._renderMeshCallPanel(); }
  }

  _endMeshCall() {
    if (!this.meshCall) return;
    this.meshCall.localStream?.getTracks().forEach(t=>t.stop());
    this.meshCall.audioEls.forEach(el=>{try{el.srcObject=null;el.remove();}catch{}});
    const fps = this.net.getConnectedPeers();
    fps.forEach(fp => this.net.sendCtrl(fp,{type:'call-end'}));
    // Clean up tracks on each PC
    fps.forEach(fp => this.net.stopMedia(fp).catch(()=>{}));
    this.meshCall=null;
    this._renderMeshCallPanel(); this._renderHeader();
    this._status('mesh call ended','info',3000);
  }

  // ── Call incoming overlay ──────────────────────────────────────────────────
  _showCallIncoming(fp, callType, nick, isMesh=false) {
    const panel=$('call-incoming'); if(!panel) return;
    const name=nick||this.peers.get(fp)?.nick||fp.slice(0,8);
    const icon=callType==='stream'?'📷':'🎙';
    const label=callType==='stream'?'stream':'walkie';
    const meshTag=isMesh?'<div class="ci-mesh">mesh</div>':'';
    panel.innerHTML=`
      <div class="ci-icon">${icon}</div>
      ${meshTag}
      <div class="ci-label">${label}</div>
      <div class="ci-name">${esc(name)}</div>
      <div class="ci-sub">${isMesh?'invited you to mesh '+label:'wants to '+label+' with you'}</div>
      <div class="ci-btns">
        <div class="ci-btn accept" id="ci-accept">accept</div>
        <div class="ci-btn decline" id="ci-decline">decline</div>
      </div>`;
    panel.classList.add('visible');
    $('ci-accept')?.addEventListener('click', ()=> isMesh?this._acceptMeshCall(fp):this._acceptCall(fp));
    $('ci-decline')?.addEventListener('click',()=> isMesh?this._declineMeshCall(fp):this._declineCall(fp));
  }

  _hideCallIncoming() { $('call-incoming')?.classList.remove('visible'); }

  // ── Render: 1:1 call panel ─────────────────────────────────────────────────
  _renderCallPanel() {
    const panel=$('call-panel'); if (!panel) return;
    if (!this.call) { panel.innerHTML=''; panel.classList.remove('visible'); return; }
    const {fp,type,phase,muted,camOff,localStream,remoteStream}=this.call;
    const peerName=this.peers.get(fp)?.nick||fp.slice(0,8);
    panel.classList.add('visible');

    if (phase==='inviting'||phase==='connecting') {
      const lbl=phase==='inviting'?`calling ${esc(peerName)}…`:'connecting…';
      panel.innerHTML=`<div class="call-waiting"><div class="call-type-badge">${type==='stream'?'📷 stream':'🎙 walkie'}</div><div class="call-state">${lbl}</div><div class="call-controls"><div class="call-btn end" id="cb-end">✕ cancel</div></div></div>`;
      $('cb-end')?.addEventListener('click',()=>{ this.net.sendCtrl(fp,{type:'call-end'}); this._endCallLocal(false); this._status('cancelled','info',3000); });
      return;
    }
    const isStream=type==='stream';
    panel.innerHTML=(isStream?`<div class="video-grid"><div class="video-wrap" id="vw-r"><video id="vid-r" autoplay playsinline></video><div class="video-label">${esc(peerName)}</div></div><div class="video-wrap local"><video id="vid-l" autoplay playsinline muted></video><div class="video-label">you</div></div></div>`:`<div class="walkie-active">🎙 walkie · <span class="walkie-peer">${esc(peerName)}</span></div>`)+
      `<div class="call-controls">
        <div class="call-btn${muted?' muted':''}" id="cb-mute">🎙 ${muted?'muted':'mic on'}</div>
        ${isStream?`<div class="call-btn${camOff?' muted':''}" id="cb-cam">📷 ${camOff?'cam off':'cam on'}</div>
        <div class="call-btn" id="cb-fs">⛶ full</div>`:''}
        <div class="call-btn end" id="cb-end">✕ end</div>
      </div>`;
    const vr=$('vid-r'),vl=$('vid-l');
    if(vr&&remoteStream){vr.srcObject=remoteStream;vr.addEventListener('dblclick',()=>{if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});else vr.requestFullscreen?.().catch(()=>{});});}
    if(vl&&localStream)vl.srcObject=localStream;
    $('cb-mute')?.addEventListener('click',()=>{ if(!this.call)return; this.call.muted=!this.call.muted; this.call.localStream?.getAudioTracks().forEach(t=>{t.enabled=!this.call.muted;}); this._renderCallPanel(); });
    $('cb-cam')?.addEventListener('click',()=>{ if(!this.call)return; this.call.camOff=!this.call.camOff; this.call.localStream?.getVideoTracks().forEach(t=>{t.enabled=!this.call.camOff;}); this._renderCallPanel(); });
    $('cb-fs')?.addEventListener('click',()=>{ const v=$('vid-r');if(!v)return; if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});else v.requestFullscreen?.().catch(()=>{}); });
    $('cb-end')?.addEventListener('click',()=>{ this.net.sendCtrl(fp,{type:'call-end'}); this._endCallLocal(false); this._status('call ended','info',3000); });
  }

  // ── Render: mesh call panel ────────────────────────────────────────────────
  _renderMeshCallPanel() {
    const panel=$('mesh-call-panel'); if (!panel) return;
    if (!this.meshCall) { panel.innerHTML=''; panel.classList.remove('visible'); return; }
    const {type,phase,muted,camOff,localStream,remoteStreams}=this.meshCall;
    panel.classList.add('visible');
    const count=remoteStreams.size;
    const isStream=type==='stream';
    if (phase==='connecting'||phase==='ringing') {
      panel.innerHTML=`<div class="call-waiting"><div class="call-type-badge">⬡ mesh ${type==='stream'?'📷 stream':'🎙 walkie'}</div><div class="call-state">inviting peers…</div><div class="call-controls"><div class="call-btn end" id="mcb-end">✕ end mesh call</div></div></div>`;
      $('mcb-end')?.addEventListener('click',()=>this._endMeshCall());
      return;
    }
    let videoHTML='';
    if (isStream) {
      videoHTML='<div class="video-grid">';
      videoHTML+=`<div class="video-wrap local"><video id="mvid-l" autoplay playsinline muted></video><div class="video-label">you</div></div>`;
      remoteStreams.forEach((stream,fp)=>{ const nick=this.peers.get(fp)?.nick||fp.slice(0,8); videoHTML+=`<div class="video-wrap" id="mvid-wrap-${fp.slice(0,8)}"><video id="mvid-${fp.slice(0,8)}" autoplay playsinline></video><div class="video-label">${esc(nick)}</div></div>`; });
      videoHTML+='</div>';
    } else {
      const peerNames=[...remoteStreams.keys()].map(fp=>this.peers.get(fp)?.nick||fp.slice(0,8)).join(', ');
      videoHTML=`<div class="walkie-active">⬡ mesh walkie · <span class="walkie-peer">${count} peer${count!==1?'s':''}: ${esc(peerNames)}</span></div>`;
    }
    panel.innerHTML=videoHTML+`<div class="call-controls">
      <div class="call-btn${muted?' muted':''}" id="mcb-mute">🎙 ${muted?'muted':'mic on'}</div>
      ${isStream?`<div class="call-btn${camOff?' muted':''}" id="mcb-cam">📷 ${camOff?'cam off':'cam on'}</div>`:''}
      <div class="call-btn end" id="mcb-end">✕ end</div>
    </div>`;
    // Attach video elements
    const vl=$('mvid-l'); if(vl&&localStream)vl.srcObject=localStream;
    remoteStreams.forEach((stream,fp)=>{ const v=$(`mvid-${fp.slice(0,8)}`); if(v)v.srcObject=stream; });
    $('mcb-mute')?.addEventListener('click',()=>{ if(!this.meshCall)return; this.meshCall.muted=!this.meshCall.muted; this.meshCall.localStream?.getAudioTracks().forEach(t=>{t.enabled=!this.meshCall.muted;}); this._renderMeshCallPanel(); });
    $('mcb-cam')?.addEventListener('click',()=>{ if(!this.meshCall)return; this.meshCall.camOff=!this.meshCall.camOff; this.meshCall.localStream?.getVideoTracks().forEach(t=>{t.enabled=!this.meshCall.camOff;}); this._renderMeshCallPanel(); });
    $('mcb-end')?.addEventListener('click',()=>this._endMeshCall());
  }

  // ── Session ────────────────────────────────────────────────────────────────
  async _openSession(fp) {
    if (!fp) return;
    this.active=fp;
    this.unread.delete(fp);
    if (!this.sessions.has(fp)) {
      try { this.sessions.set(fp, await loadMessages(fp)); } catch { this.sessions.set(fp,[]); }
    }
    this._renderHeader(); this._renderMsgs(); this._renderPeers();
    this._renderCallPanel(); this._renderMeshCallPanel();
    const ib=$('input-bar'); if(ib) ib.classList.add('visible');
    $('msg-input')?.focus();
    this._showChat();
  }

  async _clearChat(fp) {
    const label=fp===MESH_ID?'mesh chat':('chat with '+(this.peers.get(fp)?.nick||fp.slice(0,8)));
    if (!confirm(`Clear ${label}?\nFiles received will still be accessible in their session.`)) return;
    try { await clearMessages(fp); this.sessions.set(fp,[]); this._renderMsgs(); this._status('cleared','ok',2000); }
    catch (e) { this._status('clear failed: '+e.message,'err',4000); }
  }

  async _confirmReset() {
    if (!confirm('Reset Turquoise?\n\n• New cryptographic identity\n• All messages and peers cleared\n\nThis cannot be undone.')) return;
    this._status('resetting…','warn');
    try { await clearAllData(); await resetIdentity(); if('caches' in window){ const ks=await caches.keys(); await Promise.all(ks.map(k=>caches.delete(k))); } } catch(e){ console.warn('reset:',e); }
    location.reload();
  }

  _toggleMesh(fp, e) {
    e.stopPropagation();
    if (this.meshBlocked.has(fp)) this.meshBlocked.delete(fp); else this.meshBlocked.add(fp);
    this._renderPeers();
    const name=this.peers.get(fp)?.nick||fp.slice(0,8);
    this._status(`${name} ${this.meshBlocked.has(fp)?'removed from':'added to'} mesh`,'info',2000);
  }

  // ── Render: peer list ──────────────────────────────────────────────────────
  _renderPeers() {
    const list=$('peer-list'); if(!list) return;
    const meshOnline=this.net.getConnectedPeers().length>0;
    const meshUnread=this.unread.get(MESH_ID)||0;
    const meshMsgs=this.sessions.get(MESH_ID)||[];
    const meshLast=meshMsgs[meshMsgs.length-1];
    const meshPrev=meshLast?(meshLast.type==='file'?`📎 ${esc(meshLast.name||'file')}`:esc(meshLast.text?.slice(0,40)||'')):'group · everyone';
    const meshActive=this.active===MESH_ID?' active':'';
    const meshBadge=this.meshCall?`<div class="peer-badge call-badge">${this.meshCall.type==='stream'?'📷':'🎙'}</div>`:meshUnread?`<div class="peer-badge">${meshUnread>9?'9+':meshUnread}</div>`:'';

    const meshTile=`<div class="peer-tile mesh-tile${meshActive}" data-fp="${MESH_ID}">
      <div class="mesh-icon${meshOnline?' online':''}">⬡</div>
      <div class="peer-info"><div class="peer-nick">mesh</div><div class="peer-preview">${meshPrev}</div></div>
      ${meshBadge}
    </div>`;

    if (!this.peers.size) {
      list.innerHTML=meshTile+'<div id="no-peers">waiting for peers…</div>';
      list.querySelector('.mesh-tile')?.addEventListener('click',()=>this._openSession(MESH_ID));
      return;
    }

    const sorted=[...this.peers.entries()].sort(([,a],[,b])=>{if(a.connected!==b.connected)return a.connected?-1:1;return(a.nick||'').localeCompare(b.nick||'');});
    const peerTiles=sorted.map(([fp,p])=>{
      const active=fp===this.active?' active':'';
      const dot=p.connected?'online':'offline';
      const unread=this.unread.get(fp)||0;
      const msgs=this.sessions.get(fp)||[];
      const last=msgs[msgs.length-1];
      const prev=last?(last.type==='file'?`📎 ${esc(last.name||'file')}`:esc(last.text?.slice(0,42)||'')):'';
      const blocked=this.meshBlocked.has(fp);
      const inCall=this.call?.fp===fp;
      const badge=inCall?`<div class="peer-badge call-badge">${this.call.type==='stream'?'📷':'🎙'}</div>`:unread?`<div class="peer-badge">${unread>9?'9+':unread}</div>`:'';
      return `<div class="peer-tile${active}" data-fp="${fp}">
        <div class="peer-dot ${dot}"></div>
        <div class="peer-info"><div class="peer-nick">${esc(p.nick||fp.slice(0,8))}</div>${prev?`<div class="peer-preview">${prev}</div>`:''}</div>
        <div class="mesh-toggle${blocked?' blocked':''}" data-fp="${fp}" title="${blocked?'add to mesh':'remove from mesh'}">⬡</div>
        ${badge}
      </div>`;
    }).join('');
    list.innerHTML=meshTile+peerTiles;
    list.querySelectorAll('.peer-tile').forEach(t=>t.addEventListener('click',()=>{const fp=t.dataset.fp;if(fp)this._openSession(fp);}));
    list.querySelectorAll('.mesh-toggle').forEach(b=>b.addEventListener('click',e=>{const fp=b.dataset.fp;if(fp)this._toggleMesh(fp,e);}));
  }

  // ── Render: chat header ────────────────────────────────────────────────────
  _renderHeader() {
    const h=$('chat-header'); if(!h) return;
    const fp=this.active;

    if (fp===MESH_ID) {
      const connected=this.net.getConnectedPeers().length;
      const mcActive=!!this.meshCall&&this.meshCall.phase==='active';
      h.innerHTML=`
        <span id="back-btn" style="display:none">←</span>
        <div class="mesh-icon-hdr">⬡</div>
        <div class="chat-peer-info">
          <div class="chat-peer-name">mesh</div>
          <div class="chat-peer-fp">${connected} peer${connected!==1?'s':''} · broadcast to all</div>
        </div>
        <div class="chat-actions">
          <div class="action-btn${mcActive&&this.meshCall?.type==='walkie'?' active-call':''}" id="hbtn-mwalkie" title="mesh walkie">🎙</div>
          <div class="action-btn${mcActive&&this.meshCall?.type==='stream'?' active-call':''}" id="hbtn-mstream" title="mesh stream">📷</div>
          <div class="action-btn danger" id="hbtn-clear" title="clear mesh history">🗑</div>
        </div>`;
      $('back-btn')?.addEventListener('click',()=>this._showSidebar());
      $('hbtn-mwalkie')?.addEventListener('click',()=>{ if(this.meshCall&&this.meshCall.phase==='active')this._endMeshCall();else this._startMeshCall('walkie'); });
      $('hbtn-mstream')?.addEventListener('click',()=>{ if(this.meshCall&&this.meshCall.phase==='active')this._endMeshCall();else this._startMeshCall('stream'); });
      $('hbtn-clear')?.addEventListener('click',()=>this._clearChat(MESH_ID));
      return;
    }

    const p=fp?this.peers.get(fp):null;
    if (!fp||!p) { h.innerHTML='<span id="back-btn" style="display:none">←</span><span id="chat-placeholder">select a peer</span>'; $('back-btn')?.addEventListener('click',()=>this._showSidebar()); return; }
    const dot=p.connected?'online':'offline';
    const inCall=this.call?.fp===fp&&this.call.phase==='active';
    h.innerHTML=`
      <span id="back-btn" style="display:none">←</span>
      <div class="peer-dot ${dot}"></div>
      <div class="chat-peer-info">
        <div class="chat-peer-name">${esc(p.nick||fp.slice(0,8))}</div>
        <div class="chat-peer-fp">${fp}</div>
      </div>
      <div class="chat-actions">
        <div class="action-btn${inCall&&this.call?.type==='walkie'?' active-call':''}" id="hbtn-walkie" title="walkie">🎙</div>
        <div class="action-btn${inCall&&this.call?.type==='stream'?' active-call':''}" id="hbtn-stream" title="stream">📷</div>
        <div class="action-btn danger" id="hbtn-clear" title="clear chat">🗑</div>
      </div>`;
    $('back-btn')?.addEventListener('click',()=>this._showSidebar());
    $('hbtn-walkie')?.addEventListener('click',()=>{ if(inCall){this.net.sendCtrl(fp,{type:'call-end'});this._endCallLocal(false);}else this._startCall(fp,'walkie'); });
    $('hbtn-stream')?.addEventListener('click',()=>{ if(inCall){this.net.sendCtrl(fp,{type:'call-end'});this._endCallLocal(false);}else this._startCall(fp,'stream'); });
    $('hbtn-clear')?.addEventListener('click',()=>this._clearChat(fp));
  }

  // ── Render: messages ───────────────────────────────────────────────────────
  _renderMsgs() {
    const msgs=$('messages'); if(!msgs) return;
    msgs.innerHTML='';
    const session=this.sessions.get(this.active)||[];
    if (!session.length) {
      msgs.innerHTML=`<div class="sys-msg">${this.active===MESH_ID?'mesh — messages go to everyone connected':'no messages yet'}</div>`;
      return;
    }
    const frag=document.createDocumentFragment();
    session.forEach(m => {
      if (m.type==='text') frag.appendChild(this._msgEl(m));
      else if (m.type==='file') frag.appendChild(this._fileCardEl(m));
    });
    msgs.appendChild(frag);
    this._scroll();
  }

  _appendMsg(msg) {
    const msgs=$('messages'); if(!msgs) return;
    const e=msgs.querySelector('.sys-msg'); if(e&&msgs.children.length===1)e.remove();
    msgs.appendChild(this._msgEl(msg)); this._scroll();
  }

  // Create or append a file card from a file message object
  _appendFileCard(fileMsg) {
    const msgs=$('messages'); if(!msgs||!fileMsg?.fileId) return;
    if (document.querySelector(`[data-fcid="${fileMsg.fileId}"]`)) return;
    const e=msgs.querySelector('.sys-msg'); if(e&&msgs.children.length===1)e.remove();
    msgs.appendChild(this._fileCardEl(fileMsg)); this._scroll();
  }

  _msgEl(msg) {
    const d=document.createElement('div');
    d.className=`msg ${msg.own?'own':'peer'}`;
    const time=new Date(msg.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    d.innerHTML=`<div class="meta">${msg.own?'you':esc(msg.fromNick||'?')} · ${time}</div><div class="bubble">${esc(msg.text)}</div>`;
    return d;
  }

  _fileCardEl(msg) {
    const w=document.createElement('div');
    w.className=`msg ${msg.own?'own':'peer'}`;
    const time=new Date(msg.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    const cached=this._fileUrls.get(msg.fileId);
    let inner=`<div class="file-name">📎 ${esc(msg.name||'file')}</div><div class="file-size">${fmt(msg.size)}</div>`;
    if (cached) {
      inner+=`<a class="dl-btn" href="${cached.url}" download="${esc(msg.name||'file')}">↓ ${esc(msg.name||'file')}</a>`;
    } else if (msg.status==='error') {
      inner+=`<div class="file-err">⚠ ${esc(msg.error||'transfer failed')}</div>`;
    } else {
      inner+=`<div class="prog-track"><div class="prog-fill" style="width:0%"></div></div>`;
    }
    w.innerHTML=`<div class="meta">${msg.own?'you':esc(msg.fromNick||'?')} · ${time}</div><div class="file-card" data-fcid="${msg.fileId}">${inner}</div>`;
    return w;
  }

  // ── Narrow screen ──────────────────────────────────────────────────────────
  _showChat()    { $('sidebar')?.classList.add('slide-left');    $('chat-area')?.classList.add('slide-in'); }
  _showSidebar() { $('sidebar')?.classList.remove('slide-left'); $('chat-area')?.classList.remove('slide-in'); }

  // ── Status bar — always visible ────────────────────────────────────────────
  _status(text, type='info', duration=0) {
    const bar=$('status-bar'); if(!bar) return;
    clearTimeout(this._statusTimer);
    bar.textContent=text;
    bar.className=`s-${type}`;
    if (duration) this._statusTimer=setTimeout(()=>{bar.className='';},duration);
  }

  _scroll() { const m=$('messages'); if(m) m.scrollTop=m.scrollHeight; }

  _sys(text, isErr=false) {
    const msgs=$('messages'); if(!msgs) return;
    const d=document.createElement('div');
    d.className=`sys-msg${isErr?' err':''}`;
    d.textContent=text; msgs.appendChild(d); this._scroll();
    setTimeout(()=>{ try{d.remove();}catch{} },5000);
  }

  _log(text, isErr=false) {
    const log=$('net-log'); if(!log) return;
    const d=document.createElement('div');
    d.className=`entry${isErr?' err':''}`;
    d.textContent=text; log.appendChild(d); log.scrollTop=log.scrollHeight;
    while(log.children.length>120) log.removeChild(log.firstChild);
  }
}
