/**
 * tqapps.js — Turquoise Apps
 *
 * Entirely separate from core chat/call/file code.
 * Each app implements: constructor, handleMsg(msg), render(container), destroy()
 *
 * AppRegistry: central registry, app.js imports only this.
 *
 * Apps:
 *   TicTacToe  — P2P game, 1:1 only
 *   VoiceMemo  — record audio → send as file (uses file transfer, not WebRTC)
 *
 * Adding new apps: implement the interface, add to REGISTRY.
 */

// ── App Registry ─────────────────────────────────────────────────────────────
export const REGISTRY = [
  { id: 'ttt',  label: 'tic tac toe', icon: '⊞', p2pOnly: true,  cls: null /* set below */ },
  { id: 'memo', label: 'voice memo',  icon: '🎤', p2pOnly: false, cls: null /* set below — special case */ },
];

// ── TicTacToe ─────────────────────────────────────────────────────────────────
export class TicTacToe {
  constructor(peerFp, myFp, sendFn, onCloseFn) {
    this.peerFp  = peerFp;
    this.myFp    = myFp;
    this.send    = sendFn;
    this.onClose = onCloseFn;

    this.board    = Array(9).fill(null);
    this.mySymbol = null;
    this.turn     = 'X';
    this.state    = 'waiting';  // waiting | active | won | draw | resigned
    this.winner   = null;
    this.winLine  = null;
    this._dom     = null;
    this._invited = false;
  }

  handleMsg(msg) {
    const { action } = msg;
    if (action === 'invite') {
      this.mySymbol = 'O'; this._invited = true; this.state = 'waiting'; this._draw();
    } else if (action === 'accept') {
      this.mySymbol = 'X'; this.state = 'active'; this._draw();
    } else if (action === 'move') {
      const { cell } = msg;
      if (typeof cell !== 'number' || cell < 0 || cell > 8) return;
      if (this.board[cell] || this.state !== 'active') return;
      const peerSym = this.mySymbol === 'X' ? 'O' : 'X';
      if (this.turn !== peerSym) return;
      this.board[cell] = peerSym;
      this.turn = this.mySymbol;
      this._check(); this._draw();
    } else if (action === 'reset') {
      this._reset(); this._draw();
    } else if (action === 'resign') {
      this.state = 'resigned'; this._draw();
    }
  }

  _accept() { this.mySymbol='O'; this.state='active'; this.send({gameType:'ttt',action:'accept'}); this._draw(); }
  _move(cell) {
    if (this.state!=='active'||this.board[cell]||this.turn!==this.mySymbol) return;
    this.board[cell]=this.mySymbol; this.turn=this.mySymbol==='X'?'O':'X';
    this.send({gameType:'ttt',action:'move',cell}); this._check(); this._draw();
  }
  _reset() { this.board=Array(9).fill(null); this.turn='X'; this.state=this.mySymbol?'active':'waiting'; this.winner=null; this.winLine=null; }
  _requestReset() { this._reset(); this.send({gameType:'ttt',action:'reset'}); this._draw(); }
  _resign() { this.state='resigned'; this.send({gameType:'ttt',action:'resign'}); this._draw(); }

  _check() {
    const lines=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    for (const [a,b,c] of lines) {
      if (this.board[a]&&this.board[a]===this.board[b]&&this.board[b]===this.board[c]) {
        this.winner=this.board[a]; this.winLine=[a,b,c]; this.state='won'; return;
      }
    }
    if (this.board.every(c=>c!==null)) this.state='draw';
  }

  render(container) { this._dom = container; this._draw(); }

  _draw() {
    const c=this._dom; if(!c)return;
    const sym=this.mySymbol, peer=sym==='X'?'O':'X', myTurn=this.state==='active'&&this.turn===sym;
    let status='';
    if (this.state==='waiting'&&this._invited&&!sym) {
      status=`<div class="ta-invite"><div class="ta-inv-text">challenge received</div><div class="ta-btns"><div class="ta-btn accept" id="ttt-acc">accept</div><div class="ta-btn danger" id="ttt-dec">decline</div></div></div>`;
    } else if (this.state==='waiting') {
      status='<div class="ta-status">waiting for opponent…</div>';
    } else if (this.state==='active') {
      status=`<div class="ta-status${myTurn?' ta-myturn':''}">${myTurn?`your move — you are ${sym}`:`opponent's move (${peer})…`}</div>`;
    } else if (this.state==='won') {
      const won=this.winner===sym;
      status=`<div class="ta-status ${won?'ta-win':'ta-loss'}">${won?'🎉 you win':'😔 you lose'}<div class="ta-btns"><div class="ta-btn" id="ttt-reset">rematch</div><div class="ta-btn danger" id="ttt-close">close</div></div></div>`;
    } else if (this.state==='draw') {
      status=`<div class="ta-status ta-draw">draw<div class="ta-btns"><div class="ta-btn" id="ttt-reset">rematch</div><div class="ta-btn danger" id="ttt-close">close</div></div></div>`;
    } else if (this.state==='resigned') {
      status=`<div class="ta-status ta-loss">opponent resigned<div class="ta-btns"><div class="ta-btn" id="ttt-reset">rematch</div><div class="ta-btn danger" id="ttt-close">close</div></div></div>`;
    }
    const cells=this.board.map((v,i)=>{
      const win=this.winLine?.includes(i), click=myTurn&&!v&&this.state==='active';
      return `<div class="ta-cell${v?' filled':''}${win?' win':''}${click?' click':''}" data-i="${i}">${v||''}</div>`;
    }).join('');
    c.innerHTML=`<div class="tqapp-ttt">
      <div class="tqapp-hdr"><span>⊞ tic tac toe</span><span class="tqapp-sym">${sym?`you = ${sym}`:'…'}</span></div>
      <div class="ta-board">${cells}</div>
      ${status}
      ${this.state==='active'?`<div class="ta-btns"><div class="ta-btn danger" id="ttt-resign">resign</div></div>`:''}
    </div>`;
    c.querySelectorAll('.ta-cell.click').forEach(el=>el.addEventListener('click',()=>this._move(+el.dataset.i)));
    c.querySelector('#ttt-acc')?.addEventListener('click',()=>this._accept());
    c.querySelector('#ttt-dec')?.addEventListener('click',()=>{this.send({gameType:'ttt',action:'resign'});this.onClose?.();});
    c.querySelector('#ttt-reset')?.addEventListener('click',()=>this._requestReset());
    c.querySelector('#ttt-close')?.addEventListener('click',()=>this.onClose?.());
    c.querySelector('#ttt-resign')?.addEventListener('click',()=>this._resign());
  }

  destroy() { this._dom=null; }
}

// ── Voice Memo ─────────────────────────────────────────────────────────────────
// Not a two-player app — handles recording UI and produces a File.
// app.js creates this, calls start(), receives File via onFile callback.
export class VoiceMemo {
  constructor(onFile, onCancel) {
    this.onFile   = onFile;   // (File) => void
    this.onCancel = onCancel; // () => void
    this._recorder  = null;
    this._stream    = null;
    this._chunks    = [];
    this._timer     = null;
    this._elapsed   = 0;
    this._dom       = null;
  }

  async start(container) {
    this._dom = container;
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      container.innerHTML = `<div class="vm-err">🎤 ${e.name==='NotAllowedError'?'microphone denied':'no microphone found'}</div>`;
      setTimeout(() => this.onCancel?.(), 2500);
      return;
    }
    this._recorder = new MediaRecorder(this._stream, { mimeType: this._bestMime() });
    this._recorder.ondataavailable = e => { if (e.data?.size > 0) this._chunks.push(e.data); };
    this._recorder.onstop = () => this._finish();
    this._recorder.start(100); // collect every 100ms
    this._elapsed = 0;
    this._timer   = setInterval(() => { this._elapsed++; this._draw(); }, 1000);
    this._draw();
  }

  _bestMime() {
    const types = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'];
    return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
  }

  _draw() {
    if (!this._dom) return;
    const s = this._elapsed;
    const time = (s < 60 ? '0:' : Math.floor(s/60)+':') + String(s%60).padStart(2,'0');
    this._dom.innerHTML = `<div class="tqapp-memo">
      <div class="tqapp-hdr"><span>🎤 voice memo</span><span class="vm-time">${time}</span></div>
      <div class="vm-bars"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
      <div class="vm-hint">recording — tap stop to send</div>
      <div class="vm-controls">
        <div class="ta-btn danger" id="vm-cancel">cancel</div>
        <div class="ta-btn accept" id="vm-stop">◼ stop &amp; send</div>
      </div>
    </div>`;
    this._dom.querySelector('#vm-stop')?.addEventListener('click',()=>this.stop());
    this._dom.querySelector('#vm-cancel')?.addEventListener('click',()=>this.cancel());
  }

  stop() {
    clearInterval(this._timer);
    if (this._recorder?.state === 'recording') this._recorder.stop();
    this._stream?.getTracks().forEach(t => t.stop());
  }

  cancel() {
    clearInterval(this._timer);
    if (this._recorder?.state === 'recording') try { this._recorder.stop(); } catch {}
    this._stream?.getTracks().forEach(t => t.stop());
    this._chunks = [];
    if (this._dom) this._dom.innerHTML = '';
    this.onCancel?.();
  }

  _finish() {
    if (!this._chunks.length) { this.onCancel?.(); return; }
    const mime = this._recorder.mimeType || 'audio/webm';
    const blob = new Blob(this._chunks, { type: mime });
    const ext  = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
    const file = new File([blob], `memo-${Date.now()}.${ext}`, { type: mime });
    if (this._dom) this._dom.innerHTML = '';
    this.onFile?.(file);
  }

  destroy() { this.cancel(); this._dom = null; }
}

// Populate registry classes
REGISTRY.find(r => r.id === 'ttt').cls  = TicTacToe;
REGISTRY.find(r => r.id === 'memo').cls = VoiceMemo;
