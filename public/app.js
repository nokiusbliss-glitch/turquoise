/**
 * app.js — Turquoise v7.2
 *
 * Changes over v7.1:
 *   - All call/UI labels use Turquoise-specific naming:
 *     walkie → signal, video → eyes·on, accept → tune·in, decline → pass
 *   - Circle call "waiting for peer" fixed: track _connecting set (peers who
 *     accepted but whose stream hasn't arrived yet); render named placeholder
 *     tiles for them so the panel is never deceptively empty.
 *   - Camera front/back flip: _switchCamera() with facingMode toggle.
 *     ctrl-cam-switch button shown only during stream (video) calls.
 *   - _appendCallMeta() now appends to the call panel (not #call-videos) so
 *     position:absolute badge layout works correctly.
 *   - _renderCallPanel/_renderCircleCallPanel: phase status text uses new names.
 *   - _buildSuggestions(): emoji row now mixes turquoise geometric symbols with
 *     regular colour emoji for richer input options.
 *   - _buildPlus(): renamed menu items with turquoise vocabulary.
 *   - _startCall / _startCircleCall: status text uses new names.
 *   - _bindUI: wires ctrl-cam-switch button.
 *   - _removeCirclePeer: only calls _endCircleCall when ALL remote streams are
 *     gone AND no peers are still connecting — prevents premature call teardown
 *     when one peer drops before their stream arrives.
 */

import { saveMessage, loadMessages, loadAllMessages, clearAllData,
         savePeer, loadPeers, restoreMessages, restorePeers } from './messages.js';
import { resetIdentity, importIdentityData } from './identity.js';
import { TQLog } from './tqlog.js';
import { FileTransfer }   from './files.js';
import { FolderTransfer } from './folder.js';
import { TicTacToe, StonePaperScissors, Chess, AirHockey, BattleGalactica, VoiceMemo } from './tqapps.js';

const $ = id => document.getElementById(id);
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const shortCode = fp => String(fp||'').slice(0,8);
const fmt  = b => !b ? '0 B' : b < 1024 ? b+' B' : b < 1_048_576 ? (b/1024).toFixed(1)+' KB' : b < 1_073_741_824 ? (b/1_048_576).toFixed(1)+' MB' : (b/1_073_741_824).toFixed(2)+' GB';
const fmtSpd = s => !s ? '—' : s < 1024 ? s.toFixed(0)+' B/s' : s < 1_048_576 ? (s/1024).toFixed(1)+' KB/s' : (s/1_048_576).toFixed(2)+' MB/s';
const fmtEta = s => !s||s<=0||!isFinite(s) ? '—' : s<60 ? Math.ceil(s)+'s' : Math.floor(s/60)+'m'+Math.ceil(s%60)+'s';
const gameLabel = type => type==='ttt' ? 'tic tac toe'
  : type==='sps' ? 'stone paper scissors'
  : type==='airh' ? 'air hockey'
  : (type==='skyd' || type==='snake') ? 'battle galactica'
  : 'chess';

const CIRCLE = 'circle';
const TTL    = 86_400_000;

function msgStyle(id='') {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const shape = h % 8;
  const rot   = ((h >> 8) % 17 - 8) / 52;
  return { shape, rot };
}

function labelWithCodeHtml(name='', fp='', codeClass='ui-code', nameClass='ui-name') {
  const code = shortCode(fp);
  const label = String(name || code || '—');
  const showName = !code || label !== code;
  return `${code ? `<span class="${codeClass}">(${esc(code)})</span>` : ''}${showName ? `<span class="${nameClass}">${esc(label)}</span>` : ''}`;
}

function buttonIconHtml(icon, iconClass, label='') {
  return `<span class="btn-icon ${iconClass}">${esc(icon)}</span>${label ? `<span class="btn-label">${esc(label)}</span>` : ''}`;
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
    this._folderSendState = new Map();
    this._folderSendByFile = new Map();
    this._memo      = null;
    this._statsTimer= null;
    this._pipCleanup= null;
    this.games      = new Map();
    this.circleCallingEnabled = false;
    this._wakeLock = null;
    this._wakeLockBound = false;
    this._wakeLockWarned = false;
    this._audioCtx = null;
    this._failureReloadTimer = null;
    this._failureReloadDueAt = 0;
    this._failureReloadForced = false;
    this._callAlertTimer = null;
    this._lastAlertAt = 0;

    // Camera facing mode for video calls (front/back flip)
    this._facingMode = 'user';   // 'user' = front, 'environment' = back

    this._audioEl = Object.assign(document.createElement('audio'), {autoplay:true, playsInline:true, style:'display:none'});
    document.body.appendChild(this._audioEl);

    // circleFileIds: Map<fileId, peerCount> so resumed control messages keep circle routing.
    this._circleFileIds = new Map();
    this.ft = new FileTransfer(
      (fp,m) => {
        const isCircleFile = m.fileId ? this._circleFileIds.has(m.fileId) : false;
        const extra = isCircleFile ? {circle:true} : {};
        return network.sendCtrl(fp, {...m, ...extra});
      },
      (fp,b) => network.sendBinary(fp,b),
      fp     => network.waitForBuffer(fp),
      fp     => network.isBinaryReady(fp)
    );
    this.ft.onProgress  = (id,pct,dir,_fp,s) => this._onFileProg(id,pct,dir,s);
    this.ft.onSent      = (id,fp,s) => this._onFileSent(id,fp,s);
    this.ft.onFileReady = f => this._onFileReady(f);
    this.ft.onError     = (id,m,fp) => this._onFileErr(id,m,fp);

    this.folder = new FolderTransfer(this.ft, (fp,m) => network.sendCtrl(fp,m));
    this.folder.onProgress    = (fid,d,t,dir,_fp) => this._onFolderProg(fid,d,t,dir);
    this.folder.onFolderReady = info => this._onFolderReady(info);
    this.folder.onError       = (folderId,m,fp) => this._onFolderErr(folderId,m,fp);

    // Expose active-state flags for main.js auto-reload guard
    window.__tqApp = this;
  }

  // ── Transfer / game warning ────────────────────────────────────────────────
  // Returns true when it's unsafe to reload (active transfer or active game).
  hasActiveTransfer() {
    return this._fileOwners.size > 0 || this.ft._recv?.size > 0
        || this._folderSendState.size > 0 || this.folder._recv?.size > 0;
  }
  _hasActiveReceiveTransfer() {
    return (this.ft._recv?.size || 0) > 0 || (this.folder._recv?.size || 0) > 0;
  }
  hasActiveGame() {
    return this.games.size > 0;
  }
  _updateTransferWarn() {
    const el = $('transfer-warn'); if (!el) return;
    const hasT = this.hasActiveTransfer();
    const hasG = this.hasActiveGame();
    if (hasT && hasG) {
      el.textContent = '◈ live transfer + game running — keep both screens on; if a screen sleeps, Turquoise tries to resume from the last confirmed point when both devices return'; el.classList.add('visible');
    } else if (hasT) {
      el.textContent = '◈ live transfer running — keep both screens on; if a screen sleeps, Turquoise tries to resume from the last confirmed chunk when both devices return'; el.classList.add('visible');
    } else if (hasG) {
      el.textContent = '◈ live game running — keep both screens on; if a screen sleeps, the live connection can drop'; el.classList.add('visible');
    } else {
      el.classList.remove('visible');
    }
    // Also set window flag for main.js to read synchronously
    window.__tqUnsafeToReload = hasT || hasG;
    if (!this._hasActiveReceiveTransfer()) this._clearFailureReload();
  }

  _renderSelfIdentity() {
    const nd=$('nick-display'), ni=$('nick-input'), fp=$('full-fp');
    if (nd) nd.innerHTML = labelWithCodeHtml(this.id.nickname, this.id.fingerprint, 'ui-code self-code', 'ui-name self-name');
    if (ni) ni.value = this.id.nickname;
    if (fp) fp.textContent = this.id.fingerprint;
  }

  _loadTheme() {
    try { return localStorage.getItem('tq-color-twist') === 'emerald' ? 'emerald' : 'turquoise'; }
    catch { return 'turquoise'; }
  }

  _applyTheme(theme='turquoise', persist=true) {
    const root = document.documentElement;
    if (!root) return;
    const emerald = theme === 'emerald';
    if (emerald) root.dataset.twist = 'emerald';
    else delete root.dataset.twist;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', emerald ? '#07120a' : '#040a09');
    if (persist) {
      try { localStorage.setItem('tq-color-twist', emerald ? 'emerald' : 'turquoise'); } catch {}
    }
    this._renderThemeButton();
  }

  _toggleTheme() {
    const emerald = document.documentElement?.dataset?.twist === 'emerald';
    this._applyTheme(emerald ? 'turquoise' : 'emerald');
    this._status(emerald ? 'turquoise restored' : 'emerald twist engaged', 'ok', 2600);
  }

  _renderThemeButton() {
    const btn = $('sidebar-theme-btn'); if (!btn) return;
    const emerald = document.documentElement?.dataset?.twist === 'emerald';
    btn.classList.toggle('theme-on', emerald);
    btn.innerHTML = buttonIconHtml('✦', 'ico-options', emerald ? 'emerald twist · on' : 'emerald twist');
  }

  _renderChromeButtons() {
    const bw=$('btn-walkie'), bv=$('btn-stream'), plus=$('plus-btn'), send=$('send-btn');
    if (bw) bw.innerHTML = buttonIconHtml('∿', 'ico-signal', 'signal');
    if (bv) bv.innerHTML = buttonIconHtml('◌', 'ico-eyes', 'eyes·on');
    if (plus) plus.innerHTML = buttonIconHtml('✦', 'ico-options');
    if (send) send.innerHTML = buttonIconHtml('⟿', 'ico-send');
  }

  // ── Mount ──────────────────────────────────────────────────────────────────

  async mount() {
    this._applyTheme(this._loadTheme(), false);
    this._renderSelfIdentity();

    try {
      for (const p of await loadPeers()) {
        this.peers.set(p.fingerprint, {nick:p.nickname||p.fingerprint.slice(0,8), connected:false});
        this.net.addKnownPeer(p.fingerprint, p.nickname||p.fingerprint.slice(0,8));
      }
    } catch {}
    try { this.sessions.set(CIRCLE, this._normalizeLoadedMessages(await loadMessages(CIRCLE))); } catch { this.sessions.set(CIRCLE,[]); }

    this._bindUI();
    this._wireNetwork();
    this._mountLog();
    await this._openSession(CIRCLE);

    this._buildSuggestions();
    this._renderChromeButtons();
    this._renderThemeButton();
    if (this.id.isNewUser) {
      this._status('tap your call sign to set it','info');
      setTimeout(() => this._startNickEdit(), 500);
    } else {
      this._status('connecting…','info');
    }

    this._updateTransferWarn();
    this._bindWakeLock();
    this._refreshWakeLock('mount');

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
        this.id.nickname = saved;
        this._renderSelfIdentity();
        nd.classList.remove('hidden'); ni.classList.remove('visible');
        this.net.getConnectedPeers().forEach(fp => this.net.sendCtrl(fp,{type:'nick-update',nick:saved}));
        this._status('call sign: '+saved,'ok',3000);
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
    $('sidebar-log-btn')?.addEventListener('click', () => TQLog.get().exportToFile(this.id.fingerprint));
    $('sidebar-export-btn')?.addEventListener('click', () => this._exportState());
    $('sidebar-import-btn')?.addEventListener('click', () => { this._suppressVisibleReconnect(); $('__import-input')?.click(); });
    $('sidebar-ping-btn')?.addEventListener('click', () => this._pingActivePeer());
    $('sidebar-theme-btn')?.addEventListener('click', () => this._toggleTheme());
    $('sidebar-backdrop')?.addEventListener('click', () => this._hideSidebar());
    $('reset-btn')?.addEventListener('click', () => this._confirmReset());

    $('btn-walkie')?.addEventListener('click', () => {
      if (this.active && this.active!==CIRCLE) this._startCall(this.active,'walkie');
    });
    $('btn-stream')?.addEventListener('click', () => {
      if (this.active && this.active!==CIRCLE) this._startCall(this.active,'stream');
    });
    $('ctrl-mute')?.addEventListener('click', () => this._toggleMute());
    $('ctrl-cam')?.addEventListener('click',  () => this._toggleCam());
    $('ctrl-cam-switch')?.addEventListener('click', () => this._switchCamera());
    $('ctrl-end')?.addEventListener('click',  () => this._endCallLocal(true));
    $('ci-accept')?.addEventListener('click',  () => {
      const d=$('call-incoming'), fp=d?.dataset.callFp;
      if (!fp) return;
      if (d?.dataset.circle === '1') this._acceptCircleCall(fp);
      else this._acceptCall(fp);
    });
    $('ci-decline')?.addEventListener('click', () => {
      const d=$('call-incoming'), fp=d?.dataset.callFp;
      if (!fp) return;
      if (d?.dataset.circle === '1') this._declineCircleCall(fp);
      else this._declineCall(fp);
    });
  }

  _startNickEdit() {
    const d=$('nick-display'), i=$('nick-input');
    if (!d||!i||i.classList.contains('visible')) return;
    d.classList.add('hidden'); i.classList.add('visible'); i.focus(); i.select();
  }

  _suppressVisibleReconnect(ms=60_000) {
    try { window.__tqSuppressVisibleReconnectUntil = Date.now() + ms; } catch {}
  }

  _togglePlus() {
    const m=$('plus-menu'), btn=$('plus-btn');
    if (!m||!btn) return;
    const was = m.classList.contains('visible');
    this._closePlus();
    if (!was) {
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
    const canGame  = online && !isCircle;

    menu.innerHTML = `
      <div class="pm-item" id="pmi-file">◈  transmit file</div>
      <div class="pm-item" id="pmi-folder">◫  transmit folder</div>
      <div class="pm-item" id="pmi-memo">◎  voice fragment</div>
      <div class="pm-sep"></div>
      ${!isCircle ? `
      <div class="pm-label">◈ play together</div>
      <div class="pm-item${canGame?'':' pm-dim'}" id="pmi-ttt">⊞  tic tac toe</div>
      <div class="pm-item${canGame?'':' pm-dim'}" id="pmi-sps">✦  stone paper scissors</div>
      <div class="pm-item${canGame?'':' pm-dim'}" id="pmi-chess">♟  chess</div>
      <div class="pm-item${canGame?'':' pm-dim'}" id="pmi-airh">◉  air hockey</div>
      <div class="pm-item${canGame?'':' pm-dim'}" id="pmi-skyd">✦  battle galactica</div>
      ` : ''}
      <div class="pm-sep"></div>
      <div class="pm-item pm-danger" id="pmi-export">⬇  export state</div>
      <div class="pm-item" id="pmi-import">⬆  import state</div>`;

    const guard = fn => () => { this._closePlus(); if (!canSend) { this._sys('no nodes available',true); return; } fn(); };
    $('pmi-file')?.addEventListener('click',   guard(() => { this._suppressVisibleReconnect(); $('__file-input')?.click(); }));
    $('pmi-folder')?.addEventListener('click', guard(() => this._sendFolder()));
    $('pmi-memo')?.addEventListener('click',   guard(() => this._startVoiceMemo()));
    $('pmi-ttt')?.addEventListener('click', () => { this._closePlus(); if(canGame) this._startGame(fp,'ttt'); else this._sys('node offline',true); });
    $('pmi-sps')?.addEventListener('click', () => { this._closePlus(); if(canGame) this._startGame(fp,'sps'); else this._sys('node offline',true); });
    $('pmi-chess')?.addEventListener('click', () => { this._closePlus(); if(canGame) this._startGame(fp,'chess'); else this._sys('node offline',true); });
    $('pmi-airh')?.addEventListener('click', () => { this._closePlus(); if(canGame) this._startGame(fp,'airh'); else this._sys('node offline',true); });
    $('pmi-skyd')?.addEventListener('click', () => { this._closePlus(); if(canGame) this._startGame(fp,'skyd'); else this._sys('node offline',true); });
    $('pmi-export')?.addEventListener('click', () => { this._closePlus(); this._exportState(); });
    $('pmi-import')?.addEventListener('click', () => { this._closePlus(); this._suppressVisibleReconnect(); $('__import-input')?.click(); });
  }

  // ── Suggestion bar ────────────────────────────────────────────────────────

  _buildSuggestions() {
    const bar = $('suggest-bar'); if (!bar) return;
    const PHRASES = [
      'hey','on my way','be right back','ok','got it',
      'can you hear me?','send the file','try again','sounds good','play a game?',
    ];

    // Mixed: turquoise geometric + regular colour emoji
    // Geometric symbols use .sg-emoji (turquoise tinted)
    // Regular emoji use .sg-emoji.regular (full color)
    const GEO   = ['◈','◉','▸','△','▷','⬡','✦','✧','⟐','⊞','◌','◎','⋄','◆','❖'];
    const REAL  = ['😂','❤️','🔥','👍','🙏','✅','💯','🤝','👀','🫡','⚡','🌊','🎯','💎','🌀'];

    const pRow = bar.querySelector('.sg-phrases');
    const eRow = bar.querySelector('.sg-emojis');

    if (pRow && !pRow.children.length) {
      PHRASES.forEach(t => {
        const el=document.createElement('span'); el.className='sg-chip'; el.textContent=t;
        el.addEventListener('click',()=>{ const i=$('msg-input'); if(i){i.value=(i.value?i.value+' ':'')+t;i.focus();i.dispatchEvent(new Event('input'));} });
        pRow.appendChild(el);
      });
    }
    if (eRow && !eRow.children.length) {
      // Interleave geometric and real emoji for visual richness
      const merged = [];
      const len = Math.max(GEO.length, REAL.length);
      for (let i=0; i<len; i++) {
        if (i < GEO.length)  merged.push({e:GEO[i],  real:false});
        if (i < REAL.length) merged.push({e:REAL[i], real:true});
      }
      merged.forEach(({e, real}) => {
        const el=document.createElement('span');
        el.className = real ? 'sg-emoji regular' : 'sg-emoji';
        el.textContent=e;
        el.addEventListener('click',()=>{ const i=$('msg-input'); if(i){i.value=(i.value||'')+e;i.focus();i.dispatchEvent(new Event('input'));} });
        eRow.appendChild(el);
      });
    }
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
      loadMessages(fp).then(msgs => { this.sessions.set(fp,this._normalizeLoadedMessages(msgs)); this._renderPeers(); if(this.active===fp) this._renderMsgs(); }).catch(() => this.sessions.set(fp,[]));
    } else this._renderPeers();
    if (this.active===fp || this.active===CIRCLE) this._renderHeader();
    const resuming = this.ft.onPeerConnected(fp);
    this._clearFailureReload();
    this._resendActiveFolderManifests(fp);
    this._updateTransferWarn();
    this._status(resuming ? `${name} rejoined — resuming live transfer` : `${name} joined`, resuming ? 'info' : 'ok', 5000);
  }

  _onDisconnect(fp) {
    const p=this.peers.get(fp); const name=p?.nick||fp.slice(0,8);
    if (p) p.connected=false;
    if (this.call?.fp===fp) this._endCallLocal(false);
    if (this.circleCall) this._removeCirclePeer(fp);
    for (const [key] of [...this.games]) {
      if (key.startsWith(fp + ':')) this._closeGameShell(key);
    }

    // Check per-peer receive state BEFORE onPeerDisconnected mutates it.
    // ft._recv IS keyed by fp — direct lookup is correct.
    // folder._recv is keyed by folderId (UUID), NOT by fp — must scan values.
    const ftRecvState = this.ft._recv?.get(fp);
    const wasReceivingFromPeer = (ftRecvState && !ftRecvState.done)
      || [...(this.folder._recv?.values() || [])].some(s => s.from === fp && !s.done);

    const pausedTransfers = this.ft.onPeerDisconnected(fp);
    if (pausedTransfers && wasReceivingFromPeer) {
      this._scheduleFailureReload('live receive paused too long', 10_000);
    }
    this._updateTransferWarn();
    this._renderPeers();
    if (this.active===fp || this.active===CIRCLE) this._renderHeader();
    this._status(pausedTransfers ? `${name} disconnected — live transfer paused, waiting to resume` : `${name} disconnected`, 'warn', 7000);
  }

  // ── Circle members display ─────────────────────────────────────────────────
  // Shows a compact list of connected nodes in the circle chat header.
  _renderCircleMembers(isCircle) {
    const el = $('circle-members'); if (!el) return;
    if (!isCircle) { el.classList.remove('visible'); return; }
    const connected = this.net.getConnectedPeers();
    if (!connected.length) { el.classList.remove('visible'); return; }
    el.classList.add('visible');
    const count = connected.length;
    el.innerHTML = `
      <div class="cm-count">${count} node${count===1?'':'s'} online</div>
      <div class="cm-nodes">${connected.map(fp => {
        const nick = this.peers.get(fp)?.nick || fp.slice(0,6);
        return `<span class="cm-node online">${esc(nick)}</span>`;
      }).join('')}</div>`;
  }

  // ── Circle peer list in chat area ────────────────────────────────────────
  // Renders a strip of selectable node cards above the circle chat.
  // Clicking a card opens a 1:1 chat with that peer (same as clicking in sidebar).
  _renderCirclePeerList(isCircle) {
    const el = $('circle-peer-list'); if (!el) return;
    if (!isCircle) { el.style.display='none'; return; }
    el.style.display = 'block';
    const connected = this.net.getConnectedPeers();
    if (!connected.length) {
      // Show waiting state so user understands what circle is
      el.innerHTML = `<div class="cp-header">nodes in circle</div>
        <div class="cp-empty">no nodes online yet — share your device fingerprint to connect</div>`;
      return;
    }
    const nodes = connected.map(fp => {
      const p    = this.peers.get(fp)||{};
      const nick = p.nick || fp.slice(0,8);
      const sid  = fp.slice(0,8);
      return `<div class="cp-node" data-fp="${fp}" title="tap to open 1:1 chat with ${esc(nick)}">
        <span class="cp-node-dot"></span>
        <span class="cp-node-nick">${esc(nick)}</span>
        <span class="cp-node-id">(${sid})</span>
      </div>`;
    }).join('');
    el.innerHTML = `
      <div class="cp-header">nodes in circle · tap to chat 1:1</div>
      <div class="cp-nodes">${nodes}</div>`;
    el.querySelectorAll('.cp-node').forEach(card => {
      card.addEventListener('click', () => {
        const fp = card.dataset.fp;
        if (fp) this._openSession(fp);
      });
    });
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
      el.innerHTML = `<span class="peer-dot"></span><span class="peer-nick">${labelWithCodeHtml(p.nick, fp, 'ui-code peer-code', 'ui-name peer-name')}</span>${tier&&tier!=='disconnected'?`<span class="peer-tier ${tier==='p2p'?'p2p':''}">${tier==='p2p'?'p2p':'relay'}</span>`:''}${ur?`<span class="peer-badge">${ur}</span>`:''}`;
      el.addEventListener('click', () => { this._hideSidebar(); this._openSession(fp); });
      frag.appendChild(el);
    }
    list.innerHTML=''; list.appendChild(frag);
    const cnt=$('peer-count'); if(cnt) cnt.textContent=`(${this.peers.size})`;
    this._renderSidebarPing();
    // Refresh circle members + peer list if circle is active
    if (this.active===CIRCLE) {
      this._renderCircleMembers(true);
      this._renderCirclePeerList(true);
    }
  }

  _normalizeLoadedMessages(msgs=[]) {
    return msgs.map(msg => {
      if ((msg.type==='file' || msg.type==='folder') && (msg.status==='sending' || msg.status==='receiving')) {
        const fixed = { ...msg, status:'error', _sentError:'interrupted after reload' };
        this._persistMsg(fixed);
        return fixed;
      }
      return msg;
    });
  }

  _renderHeader() {
    const fp = this.active;
    const isCircle = fp===CIRCLE;
    const p = this.peers.get(fp)||{};
    const el=$('chat-peer-name'); if(el) el.innerHTML = isCircle ? '<span class="hdr-name">◉ circle</span>' : labelWithCodeHtml(p.nick, fp, 'ui-code hdr-code', 'ui-name hdr-name');
    const fpe=$('chat-peer-fp');
    if (fpe) {
      if (isCircle) {
        const n = this.net.getConnectedPeers().length;
        fpe.textContent = n === 0 ? 'no nodes online' : n === 1 ? '1 node online' : `${n} nodes online`;
      } else {
        const tier = this.net.connTier(fp);
        fpe.textContent = tier === 'p2p' ? 'p2p · direct' : tier === 'ws-relay' ? 'relay' : fp ? fp.slice(0,16)+'…' : '';
      }
    }
    // Show call buttons for 1:1 chats, hide for circle
    const cb = $('call-btns');
    if (cb) cb.style.display = isCircle ? 'none' : 'flex';
    this._renderChromeButtons();
    // Circle members badge + peer list
    this._renderCircleMembers(isCircle);
    this._renderCirclePeerList(isCircle);
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
    if (!msg.own && !isSys) {
      // Show name + short fingerprint code so nick changes don't cause confusion
      const senderFp   = msg.from || '';
      const shortCode  = senderFp.slice(0,8);
      const codePart   = shortCode ? `<span class="sender-code">(${shortCode})</span> ` : '';
      el.innerHTML = `<div class="sender">${codePart}${esc(msg.fromNick||'?')}</div>`;
    }
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
      else if (msg.own) this._setFileCardNote(el, 'transmitted');
      else this._setFileCardNote(el, 'file not available after reload');
    } else if (msg.status==='error' && msg._sentError) {
      this._setFileCardNote(el, `⚠ ${msg._sentError}`, 'err');
    }
    ca.appendChild(el); ca.scrollTop=ca.scrollHeight;
  }

  _setFileCardNote(card, text, tone='mute') {
    if (!card) return;
    let note = card.querySelector('.file-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'file-note';
      card.appendChild(note);
    }
    note.style.cssText = `font-size:9px;margin-top:4px;color:${tone==='err'?'var(--err)':'var(--mute)'}`;
    note.textContent = text;
  }

  _appendFolderCard(msg) {
    const ca=$('chat-area'); if(!ca) return;
    const el=document.createElement('div');
    el.className='folder-card'+(msg.own?' sent':'');
    el.dataset.folderid=msg.folderId;
    const inProg=msg.status==='sending'||msg.status==='receiving';
    el.innerHTML=`
      <div class="fname">◫ ${esc(msg.name||'folder')}</div>
      <div class="fsize">${fmt(msg.totalSize||0)} · ${msg.fileCount||0} files</div>
      ${!msg.own?`<div style="font-size:9px;color:var(--dim)">from ${esc(msg.fromNick||'?')}</div>`:''}
      ${inProg?`<div class="folder-count">0 / ${msg.fileCount||0} files</div><div class="prog-track"><div class="prog-fill"></div></div>`:''}`;
    if (msg.status==='done' && msg._downloadFns) {
      this._finalizeFolderCard(el, msg._downloadFns);
    } else if (msg.status==='done' && msg.own && msg._sentInfo) {
      const peers = msg._sentInfo.peerCount || 1;
      this._setFolderCardNote(el, `transmitted to ${peers} node${peers===1?'':'s'}`);
    } else if (msg.status==='error' && msg._sentError) {
      this._setFolderCardNote(el, `⚠ ${msg._sentError}`, 'err');
    } else if (msg.status==='done') {
      this._setFolderCardNote(el, 'files not available after reload');
    }
    ca.appendChild(el); ca.scrollTop=ca.scrollHeight;
  }

  _setFolderCardNote(card, text, tone='mute') {
    if (!card) return;
    let note = card.querySelector('.folder-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'folder-note';
      card.appendChild(note);
    }
    note.style.cssText = `font-size:9px;margin-top:4px;color:${tone==='err'?'var(--err)':'var(--mute)'}`;
    note.textContent = text;
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

  _persistMsg(msg) {
    if (!msg?.id || !msg?.sessionId) return;
    try {
      const persistable = JSON.parse(JSON.stringify(msg, (key, val) => {
        if (typeof val === 'function') return undefined;
        if (key === '_downloadFns' || key === 'files' || key === 'blob' || key === 'url') return undefined;
        return val;
      }));
      saveMessage(persistable).catch(()=>{});
    } catch (e) {
      this._log.warn('app','_persistMsg','failed: '+e.message, { id:msg.id });
    }
  }

  _findTransferMsg(sessionId, type, key, value) {
    return (this.sessions.get(sessionId) || []).find(m => m?.type===type && m?.[key]===value);
  }

  _resendActiveFolderManifests(fp) {
    if (!fp || !this.net.isReady(fp)) return;
    for (const state of this._folderSendState.values()) {
      if (!state?.targets?.includes(fp)) continue;
      this.net.sendCtrl(fp, {
        type:'folder-manifest',
        folderId:state.folderId,
        name:state.name,
        totalSize:state.totalSize,
        files:state.manifest,
        circle:state.circle||undefined,
      });
    }
  }

  _onFolderErr(folderId, errMsg, fp) {
    const receiverSide = !this._folderSendState.has(folderId);
    for (const msgs of this.sessions.values()) {
      const m=msgs.find(msg=>msg.folderId===folderId && (!fp || msg.own || msg.from===fp));
      if (m) { m.status='error'; m._sentError=errMsg; this._persistMsg(m); }
    }
    const card=document.querySelector(`[data-folderid="${folderId}"]`);
    if (card) {
      card.querySelector('.prog-track')?.remove();
      card.querySelector('.folder-count')?.remove();
      this._setFolderCardNote(card, `⚠ ${errMsg}`, 'err');
    }
    this._updateTransferWarn();
    if (receiverSide && errMsg!=='Cancelled') this._scheduleFailureReload(`folder receive failed: ${errMsg}`, 2200, true);
    if (errMsg!=='Cancelled') this._status('folder error: '+errMsg,'err',5000);
  }

  _scheduleFailureReload(reason='connection failed', ms=8000, force=false) {
    if (!force && !this._hasActiveReceiveTransfer()) return;
    const dueAt = Date.now() + ms;
    if (this._failureReloadTimer) {
      const existingDueAt = this._failureReloadDueAt || Infinity;
      const existingForce = !!this._failureReloadForced;
      const shouldReplace = force
        ? (!existingForce || dueAt < existingDueAt)
        : (!existingForce && dueAt < existingDueAt);
      if (!shouldReplace) return;
      clearTimeout(this._failureReloadTimer);
      this._failureReloadTimer = null;
    }
    this._failureReloadDueAt = dueAt;
    this._failureReloadForced = !!force;
    if (force) {
      window.__tqForceReloadOnVisible = true;
      window.__tqForceReloadReason = reason;
    }
    this._log.warn('app','_scheduleFailureReload', reason, { ms });
    this._status(`${reason} — reloading this device to recover receive state`,'warn',Math.max(2500, Math.min(ms - 400, 6500)));
    this._failureReloadTimer = setTimeout(() => {
      const forced = this._failureReloadForced;
      this._failureReloadTimer = null;
      this._failureReloadDueAt = 0;
      this._failureReloadForced = false;
      window.__tqForceReloadOnVisible = false;
      window.__tqForceReloadReason = '';
      if (!forced && !this._hasActiveReceiveTransfer()) return;
      this._status('reloading this device to recover transfer…','warn');
      location.reload();
    }, ms);
  }

  _clearFailureReload() {
    if (this._failureReloadTimer) clearTimeout(this._failureReloadTimer);
    this._failureReloadTimer = null;
    this._failureReloadDueAt = 0;
    this._failureReloadForced = false;
    window.__tqForceReloadOnVisible = false;
    window.__tqForceReloadReason = '';
  }

  async _primeAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!this._audioCtx) this._audioCtx = new AC();
      await this._audioCtx.resume?.();
      return this._audioCtx;
    } catch {
      return null;
    }
  }

  async _playAlertTone(kind='message') {
    try {
      const ctx = await this._primeAudio();
      if (!ctx) return;
      const presets = kind === 'call'
        ? [{f:780,o:0,d:0.18,t:'sine',g:0.055},{f:1040,o:0.18,d:0.2,t:'triangle',g:0.045}]
        : kind === 'message'
          ? [{f:930,o:0,d:0.08,t:'triangle',g:0.035},{f:1180,o:0.09,d:0.07,t:'sine',g:0.025}]
          : [{f:860,o:0,d:0.16,t:'sine',g:0.055},{f:1020,o:0.22,d:0.16,t:'triangle',g:0.055},{f:860,o:0.44,d:0.16,t:'sine',g:0.055}];
      presets.forEach(p => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = p.t;
        osc.frequency.value = p.f;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + p.o);
        gain.gain.exponentialRampToValueAtTime(p.g, ctx.currentTime + p.o + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + p.o + p.d);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + p.o);
        osc.stop(ctx.currentTime + p.o + p.d + 0.01);
      });
    } catch {}
  }

  _pulseIncomingMessage(name, text, sessionId) {
    const now = Date.now();
    if (now - this._lastAlertAt < 700) return;
    this._lastAlertAt = now;
    this._playAlertTone('message');
    navigator.vibrate?.([50, 30, 60]);
    if ((document.hidden || this.active!==sessionId) && window.Notification?.permission === 'granted') {
      try { new window.Notification('Turquoise message', { body:`${name}: ${String(text||'').slice(0,80)}` }); } catch {}
    }
  }

  _startIncomingCallAlert(name, callType) {
    this._stopIncomingCallAlert();
    const ring = () => {
      this._playAlertTone('call');
      navigator.vibrate?.([220, 120, 220, 260]);
    };
    ring();
    this._callAlertTimer = setInterval(ring, 1800);
    if (document.hidden && window.Notification?.permission === 'granted') {
      try { new window.Notification('Turquoise call', { body:`${name} is calling · ${callType}` }); } catch {}
    }
  }

  _stopIncomingCallAlert() {
    if (!this._callAlertTimer) return;
    clearInterval(this._callAlertTimer);
    this._callAlertTimer = null;
    navigator.vibrate?.(0);
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
    if (type==='nudge')           { this._onNudge(fp,msg); return; }
    if (type==='chat')            { msg.circle?this._recvCircle(fp,msg):this._recv1to1(fp,msg); return; }
    if (type==='file-meta')       {
      const sid=msg.circle?CIRCLE:fp;
      const existing=this._findTransferMsg(sid,'file','fileId',msg.fileId);
      if (!existing) {
        const fmsg={id:msg.fileId+'_recv',sessionId:sid,from:fp,fromNick:this.peers.get(fp)?.nick||fp.slice(0,8),own:false,type:'file',fileId:msg.fileId,name:msg.name||'file',size:msg.size||0,mimeType:msg.mimeType,ts:Date.now(),status:'receiving'};
        this._pushMsg(sid,fmsg,()=>this._appendFileCard(fmsg));
      } else if (existing.status!=='done') {
        existing.status='receiving';
        delete existing._sentError;
        this._persistMsg(existing);
      }
      this.ft.handleCtrl(fp,msg);
      this._status(`receiving ${(existing?.name||msg.name||'file')}…`,'info');
      this._updateTransferWarn();
      return;
    }
    if (type==='file-ack'||type==='file-end'||type==='file-complete'||type==='file-abort') { this.ft.handleCtrl(fp,msg); return; }
    if (type==='folder-manifest')  {
      const sid=msg.circle?CIRCLE:fp;
      const existing=this._findTransferMsg(sid,'folder','folderId',msg.folderId);
      if (!existing) {
        const fmsg={id:msg.folderId+'_recv',sessionId:sid,from:fp,fromNick:this.peers.get(fp)?.nick||fp.slice(0,8),own:false,type:'folder',folderId:msg.folderId,name:msg.name||'folder',totalSize:msg.totalSize||0,fileCount:msg.files?.length||0,manifest:msg.files||[],ts:Date.now(),status:'receiving'};
        this._pushMsg(sid,fmsg,()=>this._appendFolderCard(fmsg));
      } else if (existing.status!=='done') {
        existing.status='receiving';
        existing.manifest=msg.files||existing.manifest||[];
        existing.totalSize=msg.totalSize||existing.totalSize||0;
        existing.fileCount=msg.files?.length||existing.fileCount||0;
        delete existing._sentError;
        this._persistMsg(existing);
      }
      this.folder.handleCtrl(fp,msg);
      this._status(`receiving "${existing?.name||msg.name||'folder'}"…`,'info');
      this._updateTransferWarn();
      return;
    }
    if (type==='call-invite')  { msg.circle?this._onCircleCallInvite(fp,msg):this._onCallInvite(fp,msg); return; }
    if (type==='call-accept')  { msg.circle?this._onCircleCallAccepted(fp):this._onCallAccepted(fp); return; }
    if (type==='call-decline') { msg.circle?this._onCircleCallDeclined(fp):this._onCallDeclined(fp); return; }
    if (type==='offer-reneg')  { msg.circle?this._onCircleOfferReneg(fp,msg):this._onOfferReneg(fp,msg); return; }
    if (type==='answer-reneg') { return; }
    if (type==='call-end')     {
      if(this.circleCall) this._removeCirclePeer(fp);
      if(this.call?.fp===fp) {
        this._endCallLocal(false); this._status('signal ended','info',3000);
      } else {
        this._audioEl.srcObject=null;
        this._renderCallPanel();
      }
      this._hideCallIncoming(); return;
    }
    if (type==='circle-peer-joined'&&msg.circle) {
      const newFp=msg.newPeer;
      if (newFp && this.circleCall?.localStream && !this.circleCall.remoteStreams.has(newFp)) {
        this._attachCircleRemote(newFp);
        this.net.offerWithStream(newFp, this.circleCall.localStream).catch(()=>{});
      }
      return;
    }
    if (type==='circle-peer-left'&&msg.circle) {
      if (msg.leftPeer && this.circleCall) this._removeCirclePeer(msg.leftPeer);
      return;
    }
    if (type==='permission-denied') {
      const nick=this.peers.get(fp)?.nick||fp.slice(0,8);
      this._status(nick+': '+(msg.media||'mic')+' permission denied','err',8000);
      if(this.call?.fp===fp) { this._endCallLocal(false); this._hideCallIncoming(); }
      return;
    }
    if (type==='game') { this._dispatchGame(fp,msg); return; }
  }

  _pushMsg(sessionId, msg, renderFn) {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId,[]);
    this.sessions.get(sessionId).push(msg);
    this._persistMsg(msg);
    if (this.active===sessionId) renderFn();
    else { this.unread.set(sessionId,(this.unread.get(sessionId)||0)+1); this._renderPeers(); }
  }

  // ── Chat ───────────────────────────────────────────────────────────────────

  _recv1to1(fp, ev) {
    if (!ev.text) return;
    const msg={id:ev.id||crypto.randomUUID(),sessionId:fp,from:fp,fromNick:ev.nick||this.peers.get(fp)?.nick||fp.slice(0,8),text:String(ev.text),ts:ev.ts||Date.now(),type:'text',own:false};
    this._pulseIncomingMessage(msg.fromNick, msg.text, fp);
    this._pushMsg(fp,msg,()=>this._appendMsg(msg));
  }

  _recvCircle(fp, ev) {
    if (!ev.text||this.circleBlocked.has(fp)) return;
    const msg={id:ev.id||crypto.randomUUID(),sessionId:CIRCLE,from:fp,fromNick:ev.nick||this.peers.get(fp)?.nick||fp.slice(0,8),text:String(ev.text),ts:ev.ts||Date.now(),type:'text',own:false};
    this._pulseIncomingMessage(msg.fromNick, msg.text, CIRCLE);
    this._pushMsg(CIRCLE,msg,()=>this._appendMsg(msg));
  }

  _send() {
    const inp=$('msg-input'), text=inp?.value?.trim();
    if (!text||!this.active) return;
    const id=crypto.randomUUID(), ts=Date.now();
    if (this.active===CIRCLE) {
      const fps=this.net.getConnectedPeers().filter(fp=>!this.circleBlocked.has(fp));
      if (!fps.length) { this._sys('no nodes in circle',true); return; }
      fps.forEach(fp=>this.net.sendCtrl(fp,{type:'chat',circle:true,id,nick:this.id.nickname,text,ts}));
      const msg={id,sessionId:CIRCLE,from:this.id.fingerprint,fromNick:this.id.nickname,text,ts,type:'text',own:true};
      this._pushMsg(CIRCLE,msg,()=>this._appendMsg(msg));
    } else {
      const fp=this.active;
      if (!this.net.isReady(fp)) { this._sys('node offline — message not sent',true); return; }
      if (!this.net.sendCtrl(fp,{type:'chat',id,nick:this.id.nickname,text,ts})) { this._sys('send failed',true); return; }
      const msg={id,sessionId:fp,from:this.id.fingerprint,fromNick:this.id.nickname,text,ts,type:'text',own:true};
      this._pushMsg(fp,msg,()=>this._appendMsg(msg));
    }
    if (inp) {
      inp.value = '';
      inp.style.height = '';   // remove inline height so CSS min-height takes over cleanly
      inp.dispatchEvent(new Event('input')); // let auto-resize listener normalize
    }
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  _queueFile(file) {
    if (!file||!this.active) return;
    const sid=this.active, isCircle=sid===CIRCLE;
    const _peerOk = fp => this.net.isBinaryReady(fp);
    const connected = isCircle
      ? this.net.getConnectedPeers().filter(fp=>!this.circleBlocked.has(fp))
      : (sid && this.net.isReady(sid) ? [sid] : []);
    const fps = connected.filter(_peerOk);
    if (!fps.length) {
      const waiting = connected.length > 0;
      this._log.warn('app','_queueFile', waiting ? 'blocked: file channel opening' : `blocked: ${isCircle?'no nodes in circle':'node offline'}`, { active:sid, circle:isCircle, connected:connected.length });
      this._sys(waiting ? 'file channel opening — try again in a moment' : (isCircle?'no nodes in circle':'node offline'), true);
      return;
    }
    this._log.info('app','_queueFile', `sending ${file.name}`, { size:file.size, peers:fps.length, circle:isCircle });
    const fileId=crypto.randomUUID();
    const fmsg={id:fileId+'_send',sessionId:sid,from:this.id.fingerprint,fromNick:this.id.nickname,type:'file',fileId,name:file.name,size:file.size,mimeType:file.type||'application/octet-stream',ts:Date.now(),own:true,status:'sending'};
    this._pushMsg(sid,fmsg,()=>this._appendFileCard(fmsg));
    this._fileOwners.set(fileId,{fps:[...fps], pending:new Set(fps), totalPeers:fps.length});
    if (isCircle) this._circleFileIds.set(fileId, fps.length);
    fps.forEach(fp=>this.ft.send(file,fp,fileId));
    this._status('transmitting '+file.name+'…','info');
    this._updateTransferWarn();
  }

  _cancelFile(msg) {
    const {fileId,own,from}=msg; if(!fileId) return;
    if (own) { const info=this._fileOwners.get(fileId); if(info){info.fps.forEach(fp=>this.ft.cancelSend(fileId,fp));this._fileOwners.delete(fileId);} }
    else this.ft.cancelRecv(from,fileId);
    this._updateTransferWarn();
  }

  _onFileProg(fileId, pct, dir, stats) {
    if (dir === 'recv') this._clearFailureReload();
    document.querySelectorAll(`[data-fcid="${fileId}"] .prog-fill`).forEach(el=>el.style.width=(pct*100).toFixed(1)+'%');
    document.querySelectorAll(`[data-fcid="${fileId}"] .file-stats`).forEach(el=>{
      if(!stats) return;
      el.innerHTML=`<span>${(pct*100).toFixed(1)}%</span><span style="color:var(--mute)">·</span><span>${fmt(stats.bytesTransferred)}/${fmt(stats.totalBytes)}</span><span style="color:var(--mute)">·</span><span>${fmtSpd(stats.speedBps)}</span><span style="color:var(--mute)">·</span><span>${fmtEta(stats.etaSec)}</span>`;
    });
  }

  _onFileSent(fileId, fp, _stats) {
    const folderId = this._folderSendByFile.get(fileId);
    if (!folderId) {
      const ownMsgs = [...this.sessions.values()].flatMap(msgs => msgs.filter(m=>m.fileId===fileId && m.own));
      if (ownMsgs.some(m => m.status === 'error' || m._sentError)) return;
      const info = this._fileOwners.get(fileId);
      if (info?.pending) {
        info.pending.delete(fp);
        if (info.pending.size > 0) return;
      }
      if (this._circleFileIds.has(fileId)) this._circleFileIds.delete(fileId);
      this._fileOwners.delete(fileId);
      ownMsgs.forEach(m => { m.status='done'; this._persistMsg(m); });
      this._updateTransferWarn();
      document.querySelectorAll(`[data-fcid="${fileId}"]`).forEach(card=>{
        card.querySelector('.prog-track')?.remove();
        card.querySelector('.file-stats')?.remove();
        card.querySelector('.file-cancel')?.remove();
        this._setFileCardNote(card, `transmitted${info?.totalPeers>1?` to ${info.totalPeers} nodes`:''}`);
      });
      const fileName = ownMsgs[0]?.name || 'file';
      this._status(`${fileName} transmitted${info?.totalPeers>1?` to ${info.totalPeers} nodes`:''}`,'ok',6000);
      return;
    }
    const state = this._folderSendState.get(folderId);
    if (!state) return;
    const key = `${fp}:${fileId}`;
    if (state.completed.has(key)) return;
    state.completed.add(key);
    if (this._circleFileIds.has(fileId)) {
      const rem = (this._circleFileIds.get(fileId) || 1) - 1;
      if (rem <= 0) this._circleFileIds.delete(fileId);
      else this._circleFileIds.set(fileId, rem);
    }
    state.doneTransfers++;
    state.doneFiles.add(fileId);
    const done = state.peerCount > 1 ? state.doneTransfers : state.doneFiles.size;
    const total = state.peerCount > 1 ? state.totalTransfers : state.fileCount;
    this._updateFolderCardProgress(folderId, done, total, state.peerCount > 1 ? 'transfers' : 'files');
    if (state.doneTransfers >= state.totalTransfers) this._finalizeOutgoingFolder(folderId);
  }

  _onFileReady(f) {
    this._clearFailureReload();
    if (this.folder.claimFile(f)) return;
    this._fileUrls.set(f.fileId, f);
    setTimeout(()=>{ if(this._fileUrls.get(f.fileId)===f) URL.revokeObjectURL(f.url); }, TTL);
    for (const msgs of this.sessions.values()) {
      const m=msgs.find(m=>m.fileId===f.fileId);
      if(m) { m.status='done'; this._persistMsg(m); }
    }
    this._fileOwners.delete(f.fileId);
    const cards=document.querySelectorAll(`[data-fcid="${f.fileId}"]`);
    cards.forEach(card=>{
      card.querySelector('.prog-track')?.remove(); card.querySelector('.file-stats')?.remove(); card.querySelector('.file-cancel')?.remove();
      if (!card.querySelector('.dl-btn,audio')) this._attachDownload(card,f);
    });
    const nick=this.peers.get(f.from)?.nick||f.from?.slice(0,8)||'?';
    this._status(f.name+(cards.length?' received':' from '+nick+' — open chat to download'),'ok',6000);
    this._updateTransferWarn();
  }

  _onFileErr(fileId, errMsg, fp) {
    this._log.warn('app','_onFileErr', errMsg, { fileId });
    const folderId = this._folderSendByFile.get(fileId);
    if (this._circleFileIds.has(fileId)) this._circleFileIds.delete(fileId);
    const receiverSide = !this._fileOwners.has(fileId) && !folderId;
    if (folderId) this._failOutgoingFolder(folderId, errMsg, fp);
    else {
      this.folder.handleFileError(fileId, fp, errMsg);
      for (const msgs of this.sessions.values()) {
        const m=msgs.find(m=>m.fileId===fileId && (m.own || m.from===fp));
        if (m) { m.status='error'; m._sentError=errMsg; this._persistMsg(m); }
      }
    }
    this._fileOwners.delete(fileId);
    this._updateTransferWarn();
    document.querySelectorAll(`[data-fcid="${fileId}"]`).forEach(card=>{
      card.querySelector('.prog-track')?.remove(); card.querySelector('.file-stats')?.remove(); card.querySelector('.file-cancel')?.remove();
      this._setFileCardNote(card, `⚠ ${errMsg}`, 'err');
    });
    if (receiverSide && errMsg!=='Cancelled') this._scheduleFailureReload(`file receive failed: ${errMsg}`, 2200, true);
    if (errMsg!=='Cancelled') this._status('transfer error: '+errMsg,'err',5000);
  }

  // ── Folder ─────────────────────────────────────────────────────────────────

  async _sendFolder() {
    if (!this.active) return;
    const sid=this.active, isCircle=sid===CIRCLE;
    this._suppressVisibleReconnect();
    const _peerOk = fp => this.net.isBinaryReady(fp);
    const connected = isCircle
      ? this.net.getConnectedPeers().filter(fp=>!this.circleBlocked.has(fp))
      : (sid && this.net.isReady(sid) ? [sid] : []);
    const fps = connected.filter(_peerOk);
    if (!fps.length) {
      const waiting = connected.length > 0;
      this._log.warn('app','_sendFolder', waiting ? 'blocked: file channel opening' : `blocked: ${isCircle?'no nodes in circle':'node offline'}`, { active:sid, circle:isCircle, connected:connected.length });
      this._sys(waiting ? 'file channel opening — try again in a moment' : (isCircle?'no nodes in circle':'node offline'), true);
      return;
    }

    const folderId=crypto.randomUUID();
    let entries; try { entries=await FolderTransfer.pickFiles(); } catch(e){ this._sys('folder error: '+e.message,true); return; }
    if (!entries?.length) return;

    const folderName=entries[0].relativePath.split('/')[0]||'folder';
    let totalSize=0;
    const fileList=entries.map((e,i)=>{ totalSize+=e.file.size; return {fileId:`${folderId}:${i}`,relativePath:e.relativePath,size:e.file.size,mimeType:e.file.type||'application/octet-stream'}; });

    const fmsg={id:folderId+'_send',sessionId:sid,from:this.id.fingerprint,fromNick:this.id.nickname,type:'folder',folderId,name:folderName,totalSize,fileCount:fileList.length,manifest:fileList,ts:Date.now(),own:true,status:'sending'};
    this._pushMsg(sid,fmsg,()=>this._appendFolderCard(fmsg));
    this._log.info('app','_sendFolder', `sending folder ${folderName}`, { files:fileList.length, totalSize, peers:fps.length, circle:isCircle });
    this._folderSendState.set(folderId, {
      folderId, name:folderName, peerCount:fps.length, fileCount:fileList.length,
      totalTransfers:fileList.length * fps.length,
      doneTransfers:0, doneFiles:new Set(), completed:new Set(),
      fileIds:fileList.map(f => f.fileId),
      manifest:fileList,
      targets:[...fps],
      totalSize,
      circle:isCircle,
    });
    fileList.forEach(f => this._folderSendByFile.set(f.fileId, folderId));
    if (isCircle) fileList.forEach(f => this._circleFileIds.set(f.fileId, fps.length));

    fps.forEach(fp=>{
      this.net.sendCtrl(fp,{type:'folder-manifest',folderId,name:folderName,totalSize,files:fileList,circle:isCircle||undefined});
      entries.forEach((e,i)=>this.ft.send(e.file,fp,fileList[i].fileId));
    });
    this._status(`transmitting "${folderName}" (${fileList.length} files)…`,'info');
    this._updateTransferWarn();
  }

  _onFolderProg(folderId, done, total, dir) {
    if (dir === 'recv') this._clearFailureReload();
    this._updateFolderCardProgress(folderId, done, total, 'files');
  }

  _updateFolderCardProgress(folderId, done, total, noun='files') {
    const card=document.querySelector(`[data-folderid="${folderId}"]`); if(!card) return;
    const fill=card.querySelector('.prog-fill'); if(fill) fill.style.width=((total>0?done/total:0)*100).toFixed(1)+'%';
    const lbl=card.querySelector('.folder-count'); if(lbl) lbl.textContent=`${done} / ${total} ${noun}`;
  }

  _onFolderReady(info) {
    this._clearFailureReload();
    const {folderId,name,from,files,manifest,totalSize,downloadZip,downloadAll,download}=info;
    for (const msgs of this.sessions.values()) {
      const m=msgs.find(m=>m.folderId===folderId);
      if (m) { m.status='done'; m.files=files; m.manifest=manifest; m._downloadFns={downloadZip,downloadAll,download}; this._persistMsg(m); }
    }
    const card=document.querySelector(`[data-folderid="${folderId}"]`);
    if (card) {
      card.querySelector('.prog-track')?.remove(); card.querySelector('.folder-count')?.remove();
      if (!card.querySelector('.folder-dl')) this._finalizeFolderCard(card,{manifest,downloadZip,downloadAll,download});
    }
    const nick=this.peers.get(from)?.nick||from?.slice(0,8)||'?';
    this._status(`folder "${name}" from ${nick} — ${files.length} files, ${fmt(totalSize)}`,'ok',8000);
    this._updateTransferWarn();
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

  _finalizeOutgoingFolder(folderId) {
    const state = this._folderSendState.get(folderId);
    if (!state) return;
    this._folderSendState.delete(folderId);
    state.fileIds.forEach(fileId => {
      this._folderSendByFile.delete(fileId);
      this._circleFileIds.delete(fileId);
    });
    for (const msgs of this.sessions.values()) {
      const m=msgs.find(m=>m.folderId===folderId && m.own);
      if (m) { m.status='done'; m._sentInfo={peerCount:state.peerCount}; this._persistMsg(m); }
    }
    const card=document.querySelector(`[data-folderid="${folderId}"]`);
    if (card) {
      card.querySelector('.prog-track')?.remove();
      card.querySelector('.folder-count')?.remove();
      this._setFolderCardNote(card, `transmitted to ${state.peerCount} node${state.peerCount===1?'':'s'}`);
    }
    this._status(`folder "${state.name}" transmitted to ${state.peerCount} node${state.peerCount===1?'':'s'}`,'ok',6000);
    this._updateTransferWarn();
  }

  _failOutgoingFolder(folderId, errMsg, _fp) {
    const state = this._folderSendState.get(folderId);
    if (!state) return;
    this._folderSendState.delete(folderId);
    state.fileIds.forEach(fileId => {
      this._folderSendByFile.delete(fileId);
      this._circleFileIds.delete(fileId);
    });
    for (const msgs of this.sessions.values()) {
      const m=msgs.find(m=>m.folderId===folderId && m.own);
      if (m) { m.status='error'; m._sentError=errMsg; this._persistMsg(m); }
    }
    const card=document.querySelector(`[data-folderid="${folderId}"]`);
    if (card) {
      card.querySelector('.prog-track')?.remove();
      card.querySelector('.folder-count')?.remove();
      this._setFolderCardNote(card, `⚠ ${errMsg}`, 'err');
    }
    this._updateTransferWarn();
  }

  // ── Voice Memo ─────────────────────────────────────────────────────────────

  _startVoiceMemo() {
    const panel=$('memo-panel'); if(!panel) return;
    if (this._memo) { this._memo.cancel(); this._memo=null; }
    panel.classList.add('visible');
    const memo=new VoiceMemo(
      file => { panel.classList.remove('visible'); panel.innerHTML=''; this._memo=null; this._queueFile(file); this._status('voice fragment transmitted','ok',3000); },
      ()   => { panel.classList.remove('visible'); panel.innerHTML=''; this._memo=null; }
    );
    this._memo=memo; memo.start(panel);
  }

  // ── Games ──────────────────────────────────────────────────────────────────

  _closeGameShell(key) {
    const game = this.games.get(key);
    if (!game) return;
    game._host?._cleanupFs?.();
    game.destroy?.();
    game._host?.remove?.();
    game._host = null;
    this.games.delete(key);
    this._updateTransferWarn();
  }

  _gameShellMissing(game) {
    return !game || !game._host || game._host.isConnected === false || !game._dom;
  }

  _createGameShell(key, gameType, own=false) {
    const shell = document.createElement('div');
    shell.className = 'tool-embed game-shell' + (own ? ' sent' : '');
    shell.dataset.gameType = gameType;

    const bar = document.createElement('div');
    bar.className = 'tool-embed-bar';

    const tag = document.createElement('div');
    tag.className = 'tool-embed-tag';
    tag.textContent = gameLabel(gameType);

    const actions = document.createElement('div');
    actions.className = 'tool-embed-actions';

    const full = document.createElement('button');
    full.className = 'tool-mini-btn';
    full.type = 'button';
    actions.appendChild(full);

    const body = document.createElement('div');
    body.className = 'tool-embed-body';
    body.dataset.gameType = gameType;

    bar.append(tag, actions);
    shell.append(bar, body);

    const syncFullscreen = () => {
      const active = document.fullscreenElement === shell;
      shell.classList.toggle('fs-active', active);
      full.textContent = active ? 'back' : 'full';
      setTimeout(() => {
        const game = this.games.get(key);
        game?._resizeCanvas?.();
        game?._setupCanvas?.();
        try { window.dispatchEvent(new Event('resize')); } catch {}
      }, 40);
    };

    const onFullscreenChange = () => syncFullscreen();
    document.addEventListener('fullscreenchange', onFullscreenChange);
    shell._cleanupFs = () => document.removeEventListener('fullscreenchange', onFullscreenChange);

    full.addEventListener('click', async e => {
      e.preventDefault();
      try {
        if (document.fullscreenElement === shell) await document.exitFullscreen?.();
        else await shell.requestFullscreen?.();
      } catch {}
      syncFullscreen();
    });

    if (typeof shell.requestFullscreen !== 'function') full.style.display = 'none';
    syncFullscreen();
    return { shell, body };
  }

  _makeGame(fp, gameType) {
    const key  = fp + ':' + gameType;
    const send = m => this.net.sendCtrl(fp, {type:'game',...m});
    const close = () => this._closeGameShell(key);
    if (gameType === 'sps')   return new StonePaperScissors(fp, this.id.fingerprint, send, close);
    if (gameType === 'chess') return new Chess(fp, this.id.fingerprint, send, close);
    if (gameType === 'airh')  return new AirHockey(fp, this.id.fingerprint, send, close);
    if (gameType === 'skyd' || gameType === 'snake') return new BattleGalactica(fp, this.id.fingerprint, send, close, gameType);
    return new TicTacToe(fp, this.id.fingerprint, send, close);
  }

  _startGame(fp, gameType) {
    if (!['ttt','sps','chess','airh','skyd','snake'].includes(gameType)) return;
    this._openSession(fp).then(() => {
      const key = fp + ':' + gameType;
      if (this.games.has(key)) this._closeGameShell(key);
      const game = this._makeGame(fp, gameType);
      if (gameType === 'chess') game.myColor = 'w';
      this.games.set(key, game);
      this._updateTransferWarn();
      this.net.sendCtrl(fp, {type:'game', gameType, action:'invite'});
      const label = gameLabel(gameType);
      const rec={id:crypto.randomUUID(),sessionId:fp,from:this.id.fingerprint,fromNick:this.id.nickname,
        type:'text',own:true,ts:Date.now(),text:`▶ started ${label}`};
      this._pushMsg(fp,rec,()=>this._appendMsg(rec));
      const ca = $('chat-area'); if (!ca) return;
      const { shell, body } = this._createGameShell(key, gameType, true);
      game._host = shell;
      ca.appendChild(shell); ca.scrollTop = ca.scrollHeight; game.render(body);
    });
  }

  _dispatchGame(fp, msg) {
    const { gameType } = msg;
    if (!gameType) return;
    const key = fp + ':' + gameType;
    let game = this.games.get(key);
    if (game && this._gameShellMissing(game)) {
      this._closeGameShell(key);
      game = null;
    }
    if (!game && msg.action === 'invite') {
      this._openSession(fp).then(() => {
        game = this._makeGame(fp, gameType);
        this.games.set(key, game);
        this._updateTransferWarn();
        const nick=this.peers.get(fp)?.nick||fp.slice(0,8);
        const label = gameLabel(gameType);
        const rec={id:crypto.randomUUID(),sessionId:fp,from:fp,fromNick:nick,
          type:'text',own:false,ts:Date.now(),text:`▶ ${nick} invited you to ${label}`};
        this._pushMsg(fp,rec,()=>this._appendMsg(rec));
        const ca = $('chat-area'); if (!ca) return;
        const { shell, body } = this._createGameShell(key, gameType, false);
        game._host = shell;
        ca.appendChild(shell); ca.scrollTop = ca.scrollHeight;
        game.render(body); game.handleMsg(msg);
      });
    } else {
      game?.handleMsg(msg);
      this._updateTransferWarn();
    }
  }

  // ── 1:1 Calls ──────────────────────────────────────────────────────────────

  async _startCall(fp, callType) {
    if (!this.net.isReady(fp)) { this._sys('node offline',true); return; }
    if (this.call) { this._sys('already in a signal',true); return; }
    const video=callType==='stream';
    let s;
    try {
      s = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: video ? {facingMode: this._facingMode} : false
      });
    } catch(e) { this._handleMediaError(e,fp); return; }
    this.call={fp,type:callType,phase:'inviting',localStream:s,remoteStream:null,muted:false,camOff:false,inviteTimer:setTimeout(()=>this._onCallTimeout(fp),45_000)};
    this.net.sendCtrl(fp,{type:'call-invite',callType,nick:this.id.nickname});
    const label = callType==='stream' ? 'eyes·on' : 'signal';
    this._status(`${label} — calling ${this.peers.get(fp)?.nick||fp.slice(0,8)}…`,'info');
    this._renderCallPanel();
  }

  _onCallInvite(fp, msg) {
    if (this.call&&this.call.fp!==fp) { this.net.sendCtrl(fp,{type:'call-decline'}); return; }
    this.call={fp,type:msg.callType==='stream'?'stream':'walkie',phase:'ringing',localStream:null,remoteStream:null,muted:false,camOff:false};
    const label = msg.callType==='stream' ? 'eyes·on' : 'signal';
    this._showCallIncoming(fp,label,msg.nick,false);
  }

  _onCallAccepted(fp) {
    if (!this.call||this.call.fp!==fp||this.call.phase!=='inviting') return;
    clearTimeout(this.call.inviteTimer); this.call.phase='connecting';
    this._attachRemote1to1(fp);
    this.net.offerWithStream(fp, this.call.localStream)
      .catch(e=>{ this._status('signal failed: '+e.message,'err',5000); this._endCallLocal(true); });
  }

  _onCallDeclined(fp) {
    if (!this.call||this.call.fp!==fp) return;
    clearTimeout(this.call.inviteTimer);
    this.call.localStream?.getTracks().forEach(t=>t.stop()); this.call=null; this._renderCallPanel();
    this._status((this.peers.get(fp)?.nick||fp.slice(0,8))+' passed','warn',5000);
  }

  _onCallTimeout(fp) {
    if (!this.call||this.call.fp!==fp) return;
    this.call.localStream?.getTracks().forEach(t=>t.stop()); this.call=null; this._renderCallPanel();
    this._status('no answer — signal timed out','warn',5000);
  }

  async _acceptCall(fp) {
    if (!this.call||this.call.fp!==fp||this.call.phase!=='ringing') return;
    this._hideCallIncoming();
    const video=this.call.type==='stream';
    let s;
    try {
      s = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: video ? {facingMode: this._facingMode} : false
      });
    }
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

  _onOfferReneg(fp, msg) {
    if (!this.call || this.call.fp !== fp) return;
    if (!this.call.localStream) {
      if (!this.call._offerRenegPending) this.call._offerRenegPending = msg;
      const retry = () => {
        if (!this.call || this.call.fp !== fp) return;
        if (this.call.localStream) { this._onOfferReneg(fp, this.call._offerRenegPending||msg); return; }
        if ((this.call._offerRenegRetries = (this.call._offerRenegRetries||0)+1) < 25)
          setTimeout(retry, 200);
        else this._status('media not ready — signal failed','err',5000);
      };
      setTimeout(retry, 200);
      return;
    }
    this._attachRemote1to1(fp);
    this.net.answerWithStream(fp, msg.sdp, this.call.localStream)
      .catch(e=>{ this._status('signal answer failed: '+e.message,'err',5000); this._endCallLocal(true); });
  }

  _attachRemote1to1(fp) {
    this.net.setRemoteStreamHandler(fp, stream => {
      if (!stream) {
        if (this.call?.fp===fp) {
          this.call.remoteStream=null;
          if (this.call.phase === 'active') this.call.phase = 'connecting';
          this._renderCallPanel();
        }
        this._audioEl.srcObject=null;
        return;
      }
      this._audioEl.srcObject=stream; this._audioEl.play().catch(()=>{});
      if (this.call?.fp===fp) {
        this.call.remoteStream=stream; this.call.phase='active';
        this._renderCallPanel();
        this._startStatsPolling(fp);
        const label = this.call.type==='stream' ? 'eyes·on' : 'signal';
        this._status(`${label} live · ${this.peers.get(fp)?.nick||fp.slice(0,8)}`,'ok');
      }
    });
  }

  async _endCallLocal(sendEnd=true) {
    if (!this.call) return;
    const fp=this.call.fp;
    clearTimeout(this.call.inviteTimer);
    this.call.localStream?.getTracks().forEach(t=>t.stop());
    this.call=null; this._stopStatsPolling();
    if (sendEnd) {
      this.net.sendCtrl(fp, {type:'call-end'});
      this.net.stopMedia(fp);
    }
    this._audioEl.srcObject=null; this._renderCallPanel();
  }

  // ── Circle calls ───────────────────────────────────────────────────────────

  async _startCircleCall(callType) {
    if (!this.circleCallingEnabled) {
      this._status('circle calling is unavailable right now — open a node for 1:1 signal','warn',5000);
      return;
    }
    if (this.call) { this._sys('end 1:1 signal first',true); return; }
    if (this.circleCall?.phase==='active') { this._endCircleCall(); return; }
    const fps=this.net.getConnectedPeers().filter(fp=>!this.circleBlocked.has(fp));
    if (!fps.length) { this._sys('no nodes in circle',true); return; }
    const video=callType==='stream';
    let s;
    try {
      s = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: video ? {facingMode: this._facingMode} : false
      });
    } catch(e) { this._handleMediaError(e,null); return; }

    // _connecting: peers we've invited but haven't got streams from yet
    this.circleCall={
      type:callType, phase:'connecting', localStream:s,
      remoteStreams:new Map(), audioEls:new Map(),
      muted:false, camOff:false,
      _inviters:new Set(),
      _connecting:new Set(fps),  // ← NEW: track who we're waiting on
    };
    fps.forEach(fp=>{ this.net.sendCtrl(fp,{type:'call-invite',callType,nick:this.id.nickname,circle:true}); this._attachCircleRemote(fp); });
    const label = callType==='stream' ? 'eyes·circle' : 'signal·circle';
    this._status(`${label} — calling ${fps.length} node${fps.length===1?'':'s'}…`,'info');
    this._renderCircleCallPanel();
  }

  _onCircleCallInvite(fp, msg) {
    if (!this.circleCallingEnabled) {
      this._log.warn('app','_onCircleCallInvite','circle calling disabled; declining', { from:fp.slice(0,8), type:msg.callType||'walkie' });
      this.net.sendCtrl(fp,{type:'call-decline',circle:true,reason:'circle-calls-disabled'});
      this._status('circle calling is unavailable right now — open a node for 1:1 signal','warn',5000);
      return;
    }
    if (this.call) { this.net.sendCtrl(fp,{type:'call-decline',circle:true}); return; }
    const callType=msg.callType==='stream'?'stream':'walkie';
    if (this.circleCall?.phase==='active'&&this.circleCall.localStream) {
      this.net.sendCtrl(fp,{type:'call-accept',circle:true});
      this.circleCall._connecting?.add(fp);
      this._attachCircleRemote(fp); this._renderCircleCallPanel(); return;
    }
    if (!this.circleCall) {
      this.circleCall={
        type:callType, phase:'ringing', localStream:null,
        remoteStreams:new Map(), audioEls:new Map(),
        muted:false, camOff:false,
        _inviters:new Set(),
        _connecting:new Set(),
      };
    }
    this.circleCall._inviters.add(fp);
    const label = callType==='stream' ? 'eyes·on' : 'signal';
    this._showCallIncoming(fp,label,msg.nick,true);
  }

  async _acceptCircleCall(fp) {
    if (!this.circleCallingEnabled) { this._declineCircleCall(fp); return; }
    if (!this.circleCall) return;
    this._hideCallIncoming();
    const video=this.circleCall.type==='stream';
    let s;
    if (this.circleCall.localStream) { s=this.circleCall.localStream; }
    else {
      try {
        s = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: video ? {facingMode: this._facingMode} : false
        });
      }
      catch(e) { this.net.sendCtrl(fp,{type:'permission-denied',media:video?'camera/mic':'microphone'}); this._handleMediaError(e,null); return; }
      this.circleCall.localStream=s;
    }
    this.circleCall.phase='active';
    const inviters = this.circleCall._inviters?.size ? this.circleCall._inviters : new Set([fp]);
    inviters.forEach(p => {
      this.circleCall._connecting?.add(p);
      this.net.sendCtrl(p,{type:'call-accept',circle:true});
      this._attachCircleRemote(p);
    });
    this._renderCircleCallPanel();
  }

  _declineCircleCall(fp) { this._hideCallIncoming(); this.net.sendCtrl(fp,{type:'call-decline',circle:true}); }

  _onCircleCallAccepted(fp) {
    if (!this.circleCall?.localStream) return;
    this.circleCall.phase='active';
    this.circleCall._connecting?.add(fp);
    this._attachCircleRemote(fp);
    this.net.offerWithStream(fp, this.circleCall.localStream).catch(()=>{});
    this.circleCall.remoteStreams.forEach((_stream, existingFp) => {
      if (existingFp === fp) return;
      this.net.sendCtrl(existingFp, {type:'circle-peer-joined', newPeer:fp, circle:true});
    });
    this._renderCircleCallPanel();
  }

  _onCircleCallDeclined(fp) { this._status((this.peers.get(fp)?.nick||fp.slice(0,8))+' passed circle signal','warn',3000); }

  _onCircleOfferReneg(fp, msg) {
    if (!this.circleCall || !msg.sdp) return;
    if (!this.circleCall.localStream) {
      const retry = () => {
        if (!this.circleCall) return;
        if (this.circleCall.localStream) { this._onCircleOfferReneg(fp, msg); return; }
        if ((this.circleCall._renegRetries = (this.circleCall._renegRetries||0)+1) < 25)
          setTimeout(retry, 200);
      };
      setTimeout(retry, 200);
      return;
    }
    this.circleCall._connecting?.add(fp);
    this._attachCircleRemote(fp);
    this.net.answerWithStream(fp, msg.sdp, this.circleCall.localStream).catch(()=>{});
    this.circleCall.phase='active'; this._renderCircleCallPanel();
  }

  _attachCircleRemote(fp) {
    this.net.setRemoteStreamHandler(fp, stream => {
      if (!this.circleCall) return;
      if (!stream) {
        this.circleCall.remoteStreams.delete(fp);
        const el=this.circleCall.audioEls.get(fp);
        if (el) el.srcObject=null;
        this._renderCircleCallPanel();
        return;
      }
      // Stream arrived — peer is no longer just connecting
      this.circleCall._connecting?.delete(fp);
      this.circleCall.remoteStreams.set(fp,stream);
      let el=this.circleCall.audioEls.get(fp);
      if (!el) {
        el=Object.assign(document.createElement('audio'),{autoplay:true,playsInline:true,style:'display:none'});
        document.body.appendChild(el); this.circleCall.audioEls.set(fp,el);
      }
      el.srcObject=stream; el.play().catch(()=>{});
      this.circleCall.phase='active'; this._renderCircleCallPanel();
    });
  }

  _removeCirclePeer(fp) {
    if (!this.circleCall) return;
    this.circleCall.remoteStreams.delete(fp);
    this.circleCall._connecting?.delete(fp);
    const el=this.circleCall.audioEls.get(fp);
    if (el) { el.srcObject=null; try{el.remove();}catch{} this.circleCall.audioEls.delete(fp); }
    this.circleCall.remoteStreams.forEach((_s, otherFp) => {
      this.net.sendCtrl(otherFp, {type:'circle-peer-left', leftPeer:fp, circle:true});
    });
    // Only teardown when truly no one is connected or still connecting
    const noStreams = this.circleCall.remoteStreams.size === 0;
    const noConnecting = (this.circleCall._connecting?.size || 0) === 0;
    if (noStreams && noConnecting) this._endCircleCall();
    else this._renderCircleCallPanel();
  }

  _endCircleCall() {
    if (!this.circleCall) return;
    this.circleCall.localStream?.getTracks().forEach(t=>t.stop());
    this.circleCall.audioEls.forEach(el=>{ try{el.srcObject=null;el.remove();}catch{} });
    this.net.getConnectedPeers().forEach(fp=>{ this.net.sendCtrl(fp,{type:'call-end'}); this.net.stopMedia(fp); });
    this.circleCall=null; this._renderCircleCallPanel();
    this._status('circle signal ended','info',3000);
  }

  // ── Call UI ────────────────────────────────────────────────────────────────

  _appendCallMeta(panel, title, subtitle) {
    const meta = document.createElement('div');
    meta.className = 'call-stage-meta';
    meta.innerHTML = `<div class="call-stage-title">${esc(title)}</div><div class="call-stage-sub">${esc(subtitle)}</div>`;
    panel.appendChild(meta);
  }

  _makeCallVideo(stream, muted=true) {
    const v = document.createElement('video');
    v.autoplay = true; v.playsInline = true;
    if (muted) { v.muted = true; v.setAttribute('muted',''); }
    v.srcObject = stream;
    v.onloadedmetadata = () => v.play().catch(()=>{});
    v.play().catch(()=>{});
    return v;
  }

  _streamHasLiveVideo(stream) {
    return !!stream?.getVideoTracks?.().some(track => track.readyState !== 'ended');
  }

  _makeCallPlaceholder(text) {
    const ph = document.createElement('div');
    ph.className = 'call-stage-placeholder';
    ph.textContent = text;
    return ph;
  }

  _mountLocalPIP(panel, stream, camOff, hidden=false) {
    const pip=document.createElement('div');
    pip.className='call-pip'+(camOff?' cam-off':'')+(hidden?' pip-hidden':'');
    if (stream && !hidden) pip.appendChild(this._makeCallVideo(stream, true));
    const lbl=document.createElement('div'); lbl.className='call-pip-label'; lbl.textContent='you'; pip.appendChild(lbl);
    panel.appendChild(pip);
    this._pipCleanup=this._makePIPDraggable(pip);
  }

  _renderCallPanel() {
    const panel=$('call-panel'); if(!panel) return;
    const c=this.call;
    this._pipCleanup?.(); this._pipCleanup=null;
    panel.querySelectorAll('.call-pip').forEach(el=>el.remove());
    panel.querySelectorAll('.call-stage-meta').forEach(el=>el.remove());
    if (!c) { panel.classList.remove('visible'); this._stopStatsPolling(); this._syncCamSwitchBtn(); return; }
    panel.classList.add('visible');
    const vids=$('call-videos'); if(!vids) return;
    vids.innerHTML='';

    const peerName = this.peers.get(c.fp)?.nick||c.fp.slice(0,8);
    const typeLabel = c.type==='stream' ? 'eyes·on' : 'signal';
    const phaseText = c.phase==='ringing' ? 'incoming' : c.phase==='inviting' ? 'calling' : c.phase==='active' ? 'live' : 'connecting';
    // Badge appended to panel so position:absolute works (not inside flex vids)
    this._appendCallMeta(panel, `${typeLabel} · ${peerName}`, phaseText);

    if (c.phase !== 'active') {
      const txt = c.phase==='ringing' ? `incoming ${typeLabel}…` : c.phase==='inviting' ? `calling ${peerName}…` : `connecting…`;
      vids.appendChild(this._makeCallPlaceholder(txt));
    }

    const remote=document.createElement('div');
    remote.className='call-video-tile'+(c.type==='walkie'?' walkie-tile':'');
    remote.style.background='var(--bg2)';
    const hasRemoteVideo = c.type==='stream' && this._streamHasLiveVideo(c.remoteStream);
    if (hasRemoteVideo) remote.appendChild(this._makeCallVideo(c.remoteStream, true));
    else if (c.type==='stream') {
      remote.classList.add('call-video-empty');
      remote.dataset.emptyLabel = c.remoteStream ? 'camera not live yet' : 'no signal yet';
    }
    const lbl=document.createElement('div'); lbl.className='vtile-label'; lbl.textContent=peerName; remote.appendChild(lbl);
    if (c.phase==='active'||c.remoteStream||c.type==='stream') vids.appendChild(remote);
    this._mountLocalPIP(panel, c.localStream, c.camOff, c.type==='walkie');

    const mu=$('ctrl-mute'); if(mu) { mu.textContent=c.muted?'unmute':'mute'; mu.classList.toggle('active',!!c.muted); }
    const cam=$('ctrl-cam');
    if (cam) { cam.style.display = c.type==='walkie' ? 'none' : ''; cam.textContent = c.camOff?'cam on':'cam off'; }
    this._syncCamSwitchBtn();
  }

  _renderCircleCallPanel() {
    const panel=$('call-panel'); if(!panel) return;
    this._pipCleanup?.(); this._pipCleanup=null;
    panel.querySelectorAll('.call-pip').forEach(el=>el.remove());
    panel.querySelectorAll('.call-stage-meta').forEach(el=>el.remove());
    const cc=this.circleCall;
    if (!cc) { panel.classList.remove('visible'); this._syncCamSwitchBtn(); return; }
    panel.classList.add('visible');
    const vids=$('call-videos'); if(!vids) return;
    vids.innerHTML='';

    const typeLabel = cc.type==='stream' ? 'eyes·circle' : 'signal·circle';
    const liveCount = cc.remoteStreams.size;
    const connectingCount = cc._connecting?.size || 0;
    let phaseText;
    if (cc.phase==='ringing') phaseText='incoming';
    else if (cc.phase==='connecting') phaseText='calling';
    else if (liveCount>0) phaseText=`${liveCount} live${connectingCount>0?' +'+connectingCount:''}`;
    else if (connectingCount>0) phaseText=`${connectingCount} joining…`;
    else phaseText='open';

    this._appendCallMeta(panel, typeLabel, phaseText);

    if (cc.phase !== 'active' || (liveCount === 0 && connectingCount === 0)) {
      const text = cc.phase==='ringing' ? `incoming ${typeLabel}…` :
                   cc.phase==='connecting' ? `calling circle…` : '';
      if (text) vids.appendChild(this._makeCallPlaceholder(text));
    }

    // Connecting-but-no-stream tiles — show named placeholders so UI isn't empty
    if (cc._connecting) {
      cc._connecting.forEach(fp => {
        if (cc.remoteStreams.has(fp)) return;
        const tile = document.createElement('div');
        tile.className = 'call-video-tile circle-tile' + (cc.type==='walkie' ? ' walkie-tile' : '');
        tile.style.cssText = 'background:var(--bg2);opacity:.7';
        const lbl = document.createElement('div'); lbl.className = 'vtile-label';
        lbl.textContent = (this.peers.get(fp)?.nick || fp.slice(0,8)) + ' ·joining';
        tile.appendChild(lbl); vids.appendChild(tile);
      });
    }

    cc.remoteStreams.forEach((stream, fp) => {
      const tile = document.createElement('div');
      tile.className = 'call-video-tile circle-tile' + (cc.type==='walkie' ? ' walkie-tile' : '');
      tile.style.background = 'var(--bg2)';
      if (cc.type==='stream' && this._streamHasLiveVideo(stream)) tile.appendChild(this._makeCallVideo(stream, true));
      else if (cc.type==='stream') {
        tile.classList.add('call-video-empty');
        tile.dataset.emptyLabel = 'camera not live yet';
      }
      const lbl = document.createElement('div'); lbl.className='vtile-label';
      lbl.textContent = this.peers.get(fp)?.nick || fp.slice(0,8);
      tile.appendChild(lbl); vids.appendChild(tile);
    });

    this._mountLocalPIP(panel, cc.localStream, cc.camOff, cc.type==='walkie');
    const mu=$('ctrl-mute'); if(mu) { mu.textContent=cc.muted?'unmute':'mute'; mu.classList.toggle('active',!!cc.muted); }
    const cam=$('ctrl-cam');
    if (cam) { cam.style.display=cc.type==='walkie'?'none':''; cam.textContent=cc.camOff?'cam on':'cam off'; }
    this._syncCamSwitchBtn();
  }

  _syncCamSwitchBtn() {
    const btn=$('ctrl-cam-switch'); if(!btn) return;
    const c=this.call||this.circleCall;
    btn.style.display = c?.type==='stream' ? '' : 'none';
  }

  async _switchCamera() {
    const c=this.call||this.circleCall;
    if (!c?.localStream||c.type!=='stream') return;
    const newFacing = this._facingMode==='user' ? 'environment' : 'user';
    const btn=$('ctrl-cam-switch');
    const origText=btn?.textContent;
    if (btn) { btn.textContent='…'; btn.disabled=true; }
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:newFacing}});
      const [newTrack] = newStream.getVideoTracks();
      if (!newTrack) return;
      this._facingMode=newFacing;
      const fps = this.call ? [this.call.fp] : [...(this.circleCall?.remoteStreams.keys()||[])];
      for (const fp of fps) { try { await this.net.replaceVideoTrack?.(fp,newTrack); } catch {} }
      c.localStream.getVideoTracks().forEach(t=>{t.stop();c.localStream.removeTrack(t);});
      c.localStream.addTrack(newTrack);
      if (this.call) this._renderCallPanel(); else this._renderCircleCallPanel();
      this._log.info('app','_switchCamera',`switched to ${newFacing}`);
    } catch(e) {
      this._log.warn('app','_switchCamera','failed: '+e.message);
      this._status('camera flip failed','err',3000);
    } finally {
      if (btn) { btn.textContent=origText; btn.disabled=false; }
    }
  }

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
    const caller=$('ci-caller-name');
    if(caller) caller.textContent=(nick||fp.slice(0,8))+' · '+callType+(circle?' (circle)':'');
    el.dataset.callFp=fp; el.dataset.circle=circle?'1':'';
    el.classList.add('visible');
    this._startIncomingCallAlert(nick||fp.slice(0,8), callType+(circle?' (circle)':''));
  }
  _hideCallIncoming() {
    this._stopIncomingCallAlert();
    $('call-incoming')?.classList.remove('visible');
  }

  _toggleMute() {
    const c=this.call||this.circleCall; if(!c) return;
    c.muted=!c.muted; (c.localStream||null)?.getAudioTracks().forEach(t=>{t.enabled=!c.muted;});
    const btn=$('ctrl-mute'); if(btn){btn.textContent=c.muted?'unmute':'mute';btn.classList.toggle('active',c.muted);}
  }

  _toggleCam() {
    const c=this.call||this.circleCall; if(!c) return;
    c.camOff=!c.camOff; (c.localStream||null)?.getVideoTracks().forEach(t=>{t.enabled=!c.camOff;});
    const btn=$('ctrl-cam'); if(btn){btn.textContent=c.camOff?'cam on':'cam off';btn.classList.toggle('active',c.camOff);}
  }

  _startStatsPolling(fp) {
    this._stopStatsPolling();
    this._statsTimer=setInterval(async()=>{
      const s=await this.net.getStats?.(fp); if(!s) return;
      const el=$('call-stats'); if(el) el.textContent=s.rtt?`rtt ${(s.rtt*1000).toFixed(0)}ms`:'';
    },3000);
  }
  _stopStatsPolling() { clearInterval(this._statsTimer); this._statsTimer=null; }

  _renderSidebarPing() {
    const btn=$('sidebar-ping-btn'); if(!btn) return;
    const activePeer = this.active && this.active!==CIRCLE ? this.active : null;
    const online = activePeer ? this.net.isReady(activePeer) : false;
    btn.disabled = !online;
    btn.innerHTML = buttonIconHtml('∿', 'ico-signal', activePeer ? `ping ${this.peers.get(activePeer)?.nick||activePeer.slice(0,8)}` : 'ping active node');
    btn.title = online ? 'send a nudge tone to the active node' : 'open an online node chat to send a nudge';
  }

  _pingActivePeer() {
    const fp = this.active;
    if (!fp || fp===CIRCLE) { this._status('open an individual node chat to send a ping','warn',5000); return; }
    if (!this.net.isReady(fp)) { this._status('node offline — ping not sent','warn',5000); return; }
    const ok = this.net.sendCtrl(fp,{type:'nudge',nick:this.id.nickname,ts:Date.now()});
    if (!ok) { this._status('ping failed','err',4000); return; }
    this._status(`ping sent to ${this.peers.get(fp)?.nick||fp.slice(0,8)}`,'ok',4000);
  }

  async _playNudgeTone() {
    try {
      const ctx = await this._primeAudio();
      if (!ctx) return;
      const pulses = [0, 0.22, 0.44];
      pulses.forEach((offset, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = i === 1 ? 'triangle' : 'sine';
        osc.frequency.value = i === 1 ? 1020 : 860;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
        gain.gain.exponentialRampToValueAtTime(0.055, ctx.currentTime + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.16);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.18);
      });
    } catch {}
  }

  _onNudge(fp, msg={}) {
    const name = msg.nick || this.peers.get(fp)?.nick || fp.slice(0,8);
    this._playNudgeTone();
    navigator.vibrate?.([160, 80, 160]);
    if (document.hidden && window.Notification?.permission === 'granted') {
      try { new window.Notification('Turquoise ping', { body:`${name} wants your attention` }); } catch {}
    }
    this._status(`${name} pinged this device`,'warn',7000);
  }

  _bindWakeLock() {
    if (this._wakeLockBound) return;
    this._wakeLockBound = true;
    const retry = () => { this._refreshWakeLock('interaction'); this._primeAudio(); };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._releaseWakeLock();
      else this._refreshWakeLock('visible');
    });
    ['pointerdown','touchstart','keydown'].forEach(ev =>
      document.addEventListener(ev, retry, { passive:true })
    );
  }

  async _refreshWakeLock(reason='app') {
    if (!navigator.wakeLock?.request || document.hidden || this._wakeLock) return;
    try {
      const wl = await navigator.wakeLock.request('screen');
      this._wakeLock = wl;
      this._log.info('app','_refreshWakeLock',`granted (${reason})`);
      wl.addEventListener?.('release', () => {
        if (this._wakeLock === wl) this._wakeLock = null;
        if (!document.hidden) setTimeout(() => this._refreshWakeLock('release'), 250);
      });
    } catch (e) {
      if (!this._wakeLockWarned) {
        this._wakeLockWarned = true;
        this._log.warn('app','_refreshWakeLock','failed: '+e.message);
      }
    }
  }

  _releaseWakeLock() {
    const wl = this._wakeLock;
    this._wakeLock = null;
    wl?.release?.().catch?.(()=>{});
  }

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
