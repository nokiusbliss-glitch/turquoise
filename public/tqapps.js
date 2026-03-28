/**
 * tqapps.js — Turquoise Apps v6
 *
 * Fixes over v5:
 *   - TicTacToe: handleMsg('invite') was setting mySymbol='O' immediately,
 *     which caused _draw()'s invite-UI branch (`!sym`) to be false — so the
 *     receiver NEVER saw the "challenge received / accept / decline" UI.
 *     Fix: mySymbol is left null on invite receipt; _accept() sets it to 'O'
 *     as it always should have been. The invite condition is now just
 *     `this._invited && this.state === 'waiting'`, independent of sym.
 */

// ── App Registry ──────────────────────────────────────────────────────────────

export const REGISTRY = [
  { id: 'ttt',   label: 'tic tac toe',          icon: '⊞', p2pOnly: true,  cls: null },
  { id: 'sps',   label: 'stone paper scissors',  icon: '✂️', p2pOnly: true,  cls: null },
  { id: 'chess', label: 'chess',                 icon: '♟', p2pOnly: true,  cls: null },
  { id: 'airh',  label: 'air hockey',            icon: '◉', p2pOnly: true,  cls: null },
  { id: 'snake', label: 'strand',                icon: '⟐', p2pOnly: true,  cls: null },
  { id: 'memo',  label: 'voice memo',            icon: '🎤', p2pOnly: false, cls: null },
];

// ── TicTacToe ─────────────────────────────────────────────────────────────────

export class TicTacToe {
  constructor(peerFp, myFp, sendFn, onCloseFn) {
    this.peerFp   = peerFp;
    this.myFp     = myFp;
    this.send     = sendFn;
    this.onClose  = onCloseFn;

    this.board     = Array(9).fill(null);
    this.mySymbol  = null;
    this.turn      = 'X';
    this.state     = 'waiting';  // waiting | active | won | draw | resigned
    this.winner    = null;
    this.winLine   = null;
    this._dom      = null;
    this._invited  = false;
  }

  handleMsg(msg) {
    const { action } = msg;

    if (action === 'invite') {
      // Do NOT set mySymbol here — leave it null so _draw() can show the
      // invite UI (which checks `this.state === 'waiting' && this._invited`).
      // mySymbol is set to 'O' only when the user actually clicks Accept.
      this._invited = true;
      this.state    = 'waiting';
      this._draw();

    } else if (action === 'accept') {
      // Initiator ('X') learns peer accepted → game is on
      this.mySymbol = 'X';
      this.state    = 'active';
      this._draw();

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

  _accept() {
    // Accepting side is always 'O'; inviter is 'X'
    this.mySymbol = 'O';
    this.state    = 'active';
    this.send({ gameType: 'ttt', action: 'accept' });
    this._draw();
  }

  _move(cell) {
    if (this.state !== 'active' || this.board[cell] || this.turn !== this.mySymbol) return;
    this.board[cell] = this.mySymbol;
    this.turn = this.mySymbol === 'X' ? 'O' : 'X';
    this.send({ gameType: 'ttt', action: 'move', cell });
    this._check(); this._draw();
  }

  _reset() {
    this.board   = Array(9).fill(null);
    this.turn    = 'X';
    this.state   = this.mySymbol ? 'active' : 'waiting';
    this.winner  = null;
    this.winLine = null;
  }

  _requestReset() {
    this._reset();
    this.send({ gameType: 'ttt', action: 'reset' });
    this._draw();
  }

  _resign() {
    this.state = 'resigned';
    this.send({ gameType: 'ttt', action: 'resign' });
    this._draw();
  }

  _check() {
    const lines = [
      [0,1,2],[3,4,5],[6,7,8],
      [0,3,6],[1,4,7],[2,5,8],
      [0,4,8],[2,4,6],
    ];
    for (const [a, b, c] of lines) {
      if (this.board[a] && this.board[a] === this.board[b] && this.board[b] === this.board[c]) {
        this.winner  = this.board[a];
        this.winLine = [a, b, c];
        this.state   = 'won';
        return;
      }
    }
    if (this.board.every(c => c !== null)) this.state = 'draw';
  }

  render(container) { this._dom = container; this._draw(); }

  _draw() {
    const c = this._dom; if (!c) return;
    const sym  = this.mySymbol;
    const peer = sym === 'X' ? 'O' : 'X';
    const myTurn = this.state === 'active' && this.turn === sym;

    let status = '';
    // Invite UI: shown whenever we've been invited and haven't accepted yet
    if (this.state === 'waiting' && this._invited) {
      status = `<div class="ta-invite">
        <div class="ta-inv-text">challenge received</div>
        <div class="ta-btns">
          <div class="ta-btn accept" id="ttt-acc">accept</div>
          <div class="ta-btn danger" id="ttt-dec">decline</div>
        </div>
      </div>`;
    } else if (this.state === 'waiting') {
      status = '<div class="ta-status">waiting for opponent…</div>';
    } else if (this.state === 'active') {
      status = `<div class="ta-status${myTurn ? ' ta-myturn' : ''}">
        ${myTurn ? `your move — you are ${sym}` : `opponent's move (${peer})…`}
      </div>`;
    } else if (this.state === 'won') {
      const won = this.winner === sym;
      status = `<div class="ta-status ${won ? 'ta-win' : 'ta-loss'}">
        ${won ? '🎉 you win' : '😔 you lose'}
        <div class="ta-btns">
          <div class="ta-btn" id="ttt-reset">rematch</div>
          <div class="ta-btn danger" id="ttt-close">close</div>
        </div>
      </div>`;
    } else if (this.state === 'draw') {
      status = `<div class="ta-status ta-draw">draw
        <div class="ta-btns">
          <div class="ta-btn" id="ttt-reset">rematch</div>
          <div class="ta-btn danger" id="ttt-close">close</div>
        </div>
      </div>`;
    } else if (this.state === 'resigned') {
      status = `<div class="ta-status ta-loss">opponent resigned
        <div class="ta-btns">
          <div class="ta-btn" id="ttt-reset">rematch</div>
          <div class="ta-btn danger" id="ttt-close">close</div>
        </div>
      </div>`;
    }

    const cells = this.board.map((v, i) => {
      const win   = this.winLine?.includes(i);
      const click = myTurn && !v && this.state === 'active';
      return `<div class="ta-cell${v ? ' filled' : ''}${win ? ' win' : ''}${click ? ' click' : ''}" data-i="${i}">${v || ''}</div>`;
    }).join('');

    c.innerHTML = `<div class="tqapp-ttt">
      <div class="tqapp-hdr">
        <span>⊞ tic tac toe</span>
        <span class="tqapp-sym">${sym ? `you = ${sym}` : '…'}</span>
      </div>
      <div class="ta-board">${cells}</div>
      ${status}
      ${this.state === 'active' ? `<div class="ta-btns"><div class="ta-btn danger" id="ttt-resign">resign</div></div>` : ''}
    </div>`;

    c.querySelectorAll('.ta-cell.click').forEach(el =>
      el.addEventListener('click', () => this._move(+el.dataset.i))
    );
    c.querySelector('#ttt-acc')?.addEventListener('click', () => this._accept());
    c.querySelector('#ttt-dec')?.addEventListener('click', () => {
      this.send({ gameType: 'ttt', action: 'resign' });
      this.onClose?.();
    });
    c.querySelector('#ttt-reset')?.addEventListener('click', () => this._requestReset());
    c.querySelector('#ttt-close')?.addEventListener('click', () => this.onClose?.());
    c.querySelector('#ttt-resign')?.addEventListener('click', () => this._resign());
  }

  destroy() { this._dom = null; }
}

// ── VoiceMemo ─────────────────────────────────────────────────────────────────

export class VoiceMemo {
  constructor(onFile, onCancel) {
    this.onFile   = onFile;    // (File) => void
    this.onCancel = onCancel;  // () => void

    this._recorder  = null;
    this._stream    = null;
    this._chunks    = [];
    this._timer     = null;
    this._elapsed   = 0;
    this._dom       = null;
    this._started   = false;   // guard against concurrent start() calls
    this._cancelled = false;   // prevents _finish() from firing after cancel()
  }

  async start(container) {
    if (this._started) return;
    this._started   = true;
    this._cancelled = false;
    this._dom       = container;

    if (typeof MediaRecorder === 'undefined') {
      container.innerHTML = `<div class="vm-err">🎤 voice recording not supported in this browser</div>`;
      setTimeout(() => this.onCancel?.(), 2500);
      return;
    }

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const msg = e.name === 'NotAllowedError'
        ? 'microphone access denied'
        : 'no microphone found';
      container.innerHTML = `<div class="vm-err">🎤 ${msg}</div>`;
      setTimeout(() => this.onCancel?.(), 2500);
      return;
    }

    const mime = this._bestMime();
    try {
      this._recorder = new MediaRecorder(this._stream, mime ? { mimeType: mime } : {});
    } catch (e) {
      try { this._recorder = new MediaRecorder(this._stream); }
      catch (e2) {
        container.innerHTML = `<div class="vm-err">🎤 recording setup failed: ${e2.message}</div>`;
        this._stream.getTracks().forEach(t => t.stop());
        setTimeout(() => this.onCancel?.(), 2500);
        return;
      }
    }

    this._chunks = [];
    this._recorder.ondataavailable = (e) => {
      if (e.data?.size > 0) this._chunks.push(e.data);
    };
    this._recorder.onstop = () => this._finish();
    this._recorder.start(100);

    this._elapsed = 0;
    this._timer   = setInterval(() => { this._elapsed++; this._draw(); }, 1000);
    this._draw();
  }

  _bestMime() {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
  }

  _draw() {
    if (!this._dom) return;
    const s    = this._elapsed;
    const mins = Math.floor(s / 60);
    const secs = String(s % 60).padStart(2, '0');

    this._dom.innerHTML = `<div class="tqapp-memo">
      <div class="tqapp-hdr">
        <span>🎤 voice memo</span>
        <span class="vm-time">${mins}:${secs}</span>
      </div>
      <div class="vm-bars">
        <span></span><span></span><span></span><span></span>
        <span></span><span></span><span></span>
      </div>
      <div class="vm-hint">recording — tap stop to send</div>
      <div class="vm-controls">
        <div class="ta-btn danger" id="vm-cancel">cancel</div>
        <div class="ta-btn accept" id="vm-stop">◼ stop &amp; send</div>
      </div>
    </div>`;

    this._dom.querySelector('#vm-stop')?.addEventListener('click',   () => this.stop());
    this._dom.querySelector('#vm-cancel')?.addEventListener('click', () => this.cancel());
  }

  stop() {
    clearInterval(this._timer);
    if (this._recorder?.state === 'recording') {
      try { this._recorder.stop(); } catch {}
    }
    this._stream?.getTracks().forEach(t => t.stop());
  }

  cancel() {
    this._cancelled = true;
    clearInterval(this._timer);
    if (this._recorder?.state === 'recording') {
      try { this._recorder.stop(); } catch {}
    }
    this._stream?.getTracks().forEach(t => t.stop());
    this._chunks = [];
    if (this._dom) this._dom.innerHTML = '';
    this.onCancel?.();
  }

  _finish() {
    if (this._cancelled) return;
    if (!this._chunks.length) { this.onCancel?.(); return; }
    const mime = this._recorder?.mimeType || 'audio/webm';
    const blob = new Blob(this._chunks, { type: mime });
    const ext  = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
    const file = new File([blob], `memo-${Date.now()}.${ext}`, { type: mime });
    if (this._dom) this._dom.innerHTML = '';
    this.onFile?.(file);
  }

  destroy() {
    this._cancelled = true;
    clearInterval(this._timer);
    if (this._recorder?.state === 'recording') {
      try { this._recorder.stop(); } catch {}
    }
    this._stream?.getTracks().forEach(t => t.stop());
    this._dom = null;
  }
}

// ── Stone Paper Scissors ──────────────────────────────────────────────────────

const SPS_CHOICES = ['🪨', '📄', '✂️'];
const SPS_NAMES   = ['stone', 'paper', 'scissors'];

// beats[i] beats beats[j] if BEATS[i] === j
// stone(0) beats scissors(2), paper(1) beats stone(0), scissors(2) beats paper(1)
const SPS_BEATS = [2, 0, 1];

export class StonePaperScissors {
  constructor(peerFp, myFp, sendFn, onCloseFn) {
    this.peerFp  = peerFp;
    this.myFp    = myFp;
    this.send    = sendFn;
    this.onClose = onCloseFn;

    this.state      = 'waiting';   // waiting | picking | reveal | done
    this.myChoice   = null;        // 0|1|2
    this.peerChoice = null;        // 0|1|2 — received after both have picked
    this.myScore    = 0;
    this.peerScore  = 0;
    this.round      = 0;
    this.lastResult = null;        // 'win'|'lose'|'draw'
    this._invited   = false;
    this._peerPicked= false;       // did peer commit this round?
    this._dom       = null;
  }

  handleMsg(msg) {
    const { action } = msg;

    if (action === 'invite') {
      this._invited = true;
      this.state    = 'waiting';
      this._draw();

    } else if (action === 'accept') {
      this.state = 'picking';
      this._draw();

    } else if (action === 'pick') {
      // Peer has committed their choice — store it, check if we can reveal
      this._peerPicked = true;
      this.peerChoice  = typeof msg.choice === 'number' ? msg.choice : null;
      this._tryReveal();

    } else if (action === 'reset') {
      this._resetRound();
      this._draw();

    } else if (action === 'resign') {
      this.state = 'done';
      this._draw();
    }
  }

  _accept() {
    this.state = 'picking';
    this.send({ gameType:'sps', action:'accept' });
    this._draw();
  }

  _pick(choice) {
    if (this.state !== 'picking' || this.myChoice !== null) return;
    this.myChoice = choice;
    this.send({ gameType:'sps', action:'pick', choice });
    this._tryReveal();
    this._draw();   // show "waiting for opponent" after picking
  }

  _tryReveal() {
    if (this.myChoice === null || !this._peerPicked) return;
    this.state = 'reveal';
    this.round++;
    // Determine result
    if (this.myChoice === this.peerChoice) {
      this.lastResult = 'draw';
    } else if (SPS_BEATS[this.myChoice] === this.peerChoice) {
      this.lastResult = 'win'; this.myScore++;
    } else {
      this.lastResult = 'lose'; this.peerScore++;
    }
    this._draw();
  }

  _resetRound() {
    this.myChoice   = null;
    this.peerChoice = null;
    this._peerPicked = false;
    this.lastResult  = null;
    this.state       = 'picking';
  }

  _requestReset() {
    this._resetRound();
    this.send({ gameType:'sps', action:'reset' });
    this._draw();
  }

  _resign() {
    this.state = 'done';
    this.send({ gameType:'sps', action:'resign' });
    this._draw();
  }

  render(container) { this._dom = container; this._draw(); }

  _draw() {
    const c = this._dom; if (!c) return;

    let status = '';

    if (this.state === 'waiting' && this._invited) {
      status = `<div class="ta-invite">
        <div class="ta-inv-text">challenge received</div>
        <div class="ta-btns">
          <div class="ta-btn accept" id="sps-acc">accept</div>
          <div class="ta-btn danger" id="sps-dec">decline</div>
        </div>
      </div>`;
    } else if (this.state === 'waiting') {
      status = '<div class="ta-status">waiting for opponent…</div>';
    } else if (this.state === 'picking') {
      if (this.myChoice !== null) {
        status = `<div class="ta-status" style="color:var(--uy)">✓ ${SPS_NAMES[this.myChoice]} chosen — waiting for opponent…</div>`;
      } else {
        // Show choice buttons
        const btns = SPS_CHOICES.map((e,i) =>
          `<div class="sps-choice" data-i="${i}" title="${SPS_NAMES[i]}">${e}</div>`
        ).join('');
        status = `<div class="ta-status ta-myturn">your turn — pick one</div>
          <div class="sps-choices">${btns}</div>`;
      }
    } else if (this.state === 'reveal') {
      const myE   = this.myChoice !== null   ? SPS_CHOICES[this.myChoice]   : '?';
      const peerE = this.peerChoice !== null ? SPS_CHOICES[this.peerChoice] : '?';
      const resClass = this.lastResult==='win'?'ta-win':this.lastResult==='lose'?'ta-loss':'ta-draw';
      const resText  = this.lastResult==='win'?'you win!':this.lastResult==='lose'?'you lose':'draw';
      status = `
        <div class="sps-reveal">
          <div class="sps-side"><div class="sps-big">${myE}</div><div class="sps-label">you</div></div>
          <div class="sps-vs">vs</div>
          <div class="sps-side"><div class="sps-big">${peerE}</div><div class="sps-label">them</div></div>
        </div>
        <div class="ta-status ${resClass}" style="text-align:center">${resText}</div>
        <div class="ta-btns" style="justify-content:center">
          <div class="ta-btn" id="sps-next">next round</div>
          <div class="ta-btn danger" id="sps-close">close</div>
        </div>`;
    } else if (this.state === 'done') {
      status = `<div class="ta-status ta-loss" style="text-align:center">game over
        <div class="ta-btns" style="justify-content:center;margin-top:6px">
          <div class="ta-btn danger" id="sps-close">close</div>
        </div>
      </div>`;
    }

    c.innerHTML = `<div class="tqapp-sps">
      <div class="tqapp-hdr">
        <span>✂️ stone paper scissors</span>
        <span class="tqapp-sym">🪨${this.myScore} · ${this.peerScore}📄</span>
      </div>
      ${status}
      ${this.state==='picking'||this.state==='reveal'?`<div class="sps-rounds">round ${this.round+1} · scores ${this.myScore}–${this.peerScore}</div>`:''}
    </div>`;

    c.querySelectorAll('.sps-choice').forEach(el =>
      el.addEventListener('click', () => this._pick(+el.dataset.i))
    );
    c.querySelector('#sps-acc')?.addEventListener('click',  () => this._accept());
    c.querySelector('#sps-dec')?.addEventListener('click',  () => { this.send({gameType:'sps',action:'resign'}); this.onClose?.(); });
    c.querySelector('#sps-next')?.addEventListener('click', () => this._requestReset());
    c.querySelector('#sps-close')?.addEventListener('click',() => this.onClose?.());
  }

  destroy() { this._dom = null; }
}

// ── Chess ─────────────────────────────────────────────────────────────────────
// Full legal-move enforcement: castling, en-passant, promotion (auto-queen),
// check, checkmate, stalemate. No external libraries.

const CH_INIT = [
  'r','n','b','q','k','b','n','r',
  'p','p','p','p','p','p','p','p',
  '','','','','','','','',
  '','','','','','','','',
  '','','','','','','','',
  '','','','','','','','',
  'P','P','P','P','P','P','P','P',
  'R','N','B','Q','K','B','N','R',
];

const CH_GLYPHS = {
  K:'♔',Q:'♕',R:'♖',B:'♗',N:'♘',P:'♙',
  k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟',
};

function chColor(p) { return p === p.toUpperCase() ? 'w' : 'b'; }

function chMoves(board, sq, ep, castle) {
  // Returns array of target squares for piece on sq (does NOT filter for check)
  const p = board[sq]; if (!p) return [];
  const col = chColor(p), opp = col==='w'?'b':'w';
  const r = Math.floor(sq/8), c = sq%8;
  const out = [], t = p.toLowerCase();

  const add = (nr, nc) => {
    if (nr<0||nr>7||nc<0||nc>7) return false;
    const ti = nr*8+nc;
    if (!board[ti]) { out.push(ti); return true; }
    if (chColor(board[ti])===opp) { out.push(ti); return false; }
    return false;
  };
  const slide = (dr, dc) => { let nr=r+dr, nc=c+dc; while(nr>=0&&nr<8&&nc>=0&&nc<8) { if (!add(nr,nc)) break; nr+=dr; nc+=dc; } };

  if (t==='p') {
    const dir = col==='w'?-1:1, start = col==='w'?6:1;
    const f1 = (r+dir)*8+c;
    if (f1>=0&&f1<64&&!board[f1]) {
      out.push(f1);
      const f2=(r+2*dir)*8+c;
      if (r===start&&!board[f2]) out.push(f2);
    }
    for (const dc of [-1,1]) {
      const nc=c+dc, nr=r+dir, ti=nr*8+nc;
      if (nc>=0&&nc<8&&nr>=0&&nr<8) {
        if (board[ti]&&chColor(board[ti])===opp) out.push(ti);
        if (ti===ep) out.push(ti);
      }
    }
  } else if (t==='n') {
    for (const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) add(r+dr,c+dc);
  } else if (t==='b') {
    for (const [dr,dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) slide(dr,dc);
  } else if (t==='r') {
    for (const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]]) slide(dr,dc);
  } else if (t==='q') {
    for (const [dr,dc] of [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]) slide(dr,dc);
  } else if (t==='k') {
    for (const [dr,dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) add(r+dr,c+dc);
    // Castling
    if (castle) {
      const row = col==='w'?7:0, kSq = row*8+4;
      if (sq===kSq) {
        if (castle[col+'K'] && !board[kSq+1] && !board[kSq+2]) out.push(kSq+2);
        if (castle[col+'Q'] && !board[kSq-1] && !board[kSq-2] && !board[kSq-3]) out.push(kSq-2);
      }
    }
  }
  return out;
}

function chAttacked(board, sq, byColor) {
  // Is sq attacked by byColor?
  for (let i=0;i<64;i++) {
    const p=board[i]; if(!p||chColor(p)!==byColor) continue;
    if (chMoves(board,i,-1,null).includes(sq)) return true;
  }
  return false;
}

function chKingSq(board, col) {
  const k = col==='w'?'K':'k';
  return board.indexOf(k);
}

function chLegalMoves(board, sq, ep, castle) {
  const p=board[sq]; if(!p) return [];
  const col=chColor(p);
  return chMoves(board,sq,ep,castle).filter(to => {
    const b2=[...board]; b2[to]=b2[sq]; b2[sq]='';
    // En-passant capture removes the pawn
    if (p.toLowerCase()==='p' && to===ep && ep>=0) {
      const dir=col==='w'?1:-1; b2[to+dir*8]='';
    }
    // Castling: king must not pass through check
    if (p.toLowerCase()==='k' && Math.abs(to-sq)===2) {
      const mid=(sq+to)/2;
      if (chAttacked(b2,sq,col==='w'?'b':'w')) return false;
      if (chAttacked(b2,mid,col==='w'?'b':'w')) return false;
    }
    return !chAttacked(b2, chKingSq(b2,col), col==='w'?'b':'w');
  });
}

function chAllLegal(board, col, ep, castle) {
  const moves=[];
  for (let i=0;i<64;i++) {
    if (board[i]&&chColor(board[i])===col) {
      for (const to of chLegalMoves(board,i,ep,castle)) moves.push([i,to]);
    }
  }
  return moves;
}

export class Chess {
  constructor(peerFp, myFp, sendFn, onCloseFn) {
    this.peerFp  = peerFp;
    this.myFp    = myFp;
    this.send    = sendFn;
    this.onClose = onCloseFn;

    this.board   = [...CH_INIT];
    this.turn    = 'w';
    this.myColor = null;   // set on accept/invite
    this.ep      = -1;     // en-passant target square
    this.castle  = {wK:true,wQ:true,bK:true,bQ:true};
    this.state   = 'waiting';
    this.result  = null;   // null | 'checkmate' | 'stalemate' | 'resign'
    this.winner  = null;   // 'w'|'b'|null
    this.selected= null;   // selected square index
    this.legalTos= [];     // legal destinations for selected piece
    this._invited= false;
    this._dom    = null;
  }

  handleMsg(msg) {
    const {action}=msg;
    if (action==='invite') { this._invited=true; this.myColor='b'; this.state='waiting'; this._draw(); }
    else if (action==='accept') { this.myColor='w'; this.state='active'; this._draw(); }
    else if (action==='move') { this._applyMove(msg.from,msg.to,false); }
    else if (action==='resign') { this.result='resign'; this.winner=this.myColor==='w'?'w':'b'; this.state='done'; this._draw(); }
    else if (action==='reset') { this._resetGame(); this._draw(); }
  }

  _accept() {
    this.myColor='b'; this.state='active';
    this.send({gameType:'chess',action:'accept'});
    this._draw();
  }

  _resetGame() {
    this.board=[...CH_INIT]; this.turn='w'; this.ep=-1;
    this.castle={wK:true,wQ:true,bK:true,bQ:true};
    this.state='active'; this.result=null; this.winner=null;
    this.selected=null; this.legalTos=[];
  }

  _requestReset() { this._resetGame(); this.send({gameType:'chess',action:'reset'}); this._draw(); }
  _resign() { this.result='resign'; this.winner=this.myColor==='w'?'b':'w'; this.state='done'; this.send({gameType:'chess',action:'resign'}); this._draw(); }

  _selectSquare(sq) {
    if (this.state!=='active'||this.turn!==this.myColor) return;
    const p=this.board[sq];
    // If clicking a legal destination — make the move
    if (this.selected!==null && this.legalTos.includes(sq)) {
      this._applyMove(this.selected, sq, true); return;
    }
    // Select own piece
    if (p && chColor(p)===this.myColor) {
      this.selected=sq;
      this.legalTos=chLegalMoves(this.board,sq,this.ep,this.castle);
    } else {
      this.selected=null; this.legalTos=[];
    }
    this._draw();
  }

  _applyMove(from, to, local) {
    const b=this.board, p=b[from];
    if (!p) return;
    const col=chColor(p), opp=col==='w'?'b':'w';

    // En-passant capture
    let newEp=-1;
    if (p.toLowerCase()==='p' && to===this.ep && this.ep>=0) {
      const dir=col==='w'?1:-1; b[to+dir*8]='';
    }
    // Double pawn push — set ep square
    if (p.toLowerCase()==='p' && Math.abs(to-from)===16) {
      newEp=(from+to)/2;
    }
    // Castling rook move
    if (p.toLowerCase()==='k' && Math.abs(to-from)===2) {
      const row=Math.floor(from/8);
      if (to>from) { b[row*8+5]=b[row*8+7]; b[row*8+7]=''; }
      else         { b[row*8+3]=b[row*8+0]; b[row*8+0]=''; }
    }
    // Update castling rights
    if (p==='K') { this.castle.wK=false; this.castle.wQ=false; }
    if (p==='k') { this.castle.bK=false; this.castle.bQ=false; }
    if (from===0||to===0) this.castle.bQ=false;
    if (from===7||to===7) this.castle.bK=false;
    if (from===56||to===56) this.castle.wQ=false;
    if (from===63||to===63) this.castle.wK=false;

    b[to]=b[from]; b[from]='';
    // Promotion — auto-queen
    if (b[to]==='P' && Math.floor(to/8)===0) b[to]='Q';
    if (b[to]==='p' && Math.floor(to/8)===7) b[to]='q';

    this.ep=newEp; this.turn=opp; this.selected=null; this.legalTos=[];

    // Check game-end conditions
    const oppMoves=chAllLegal(b,opp,newEp,this.castle);
    if (!oppMoves.length) {
      const inCheck=chAttacked(b,chKingSq(b,opp),col);
      this.result=inCheck?'checkmate':'stalemate';
      this.winner=inCheck?col:null;
      this.state='done';
    }

    if (local) this.send({gameType:'chess',action:'move',from,to});
    this._draw();
  }

  render(container) { this._dom=container; this._draw(); }

  _draw() {
    const c=this._dom; if(!c) return;
    const myC=this.myColor, turn=this.turn;
    const flipped=myC==='b';   // black plays from bottom

    // Status line
    let status='';
    if (this.state==='waiting'&&this._invited) {
      status=`<div class="ta-invite"><div class="ta-inv-text">chess challenge received</div>
        <div class="ta-btns">
          <div class="ta-btn accept" id="ch-acc">accept</div>
          <div class="ta-btn danger" id="ch-dec">decline</div>
        </div></div>`;
    } else if (this.state==='waiting') {
      status='<div class="ta-status">waiting for opponent…</div>';
    } else if (this.state==='active') {
      const myTurn=turn===myC;
      const inCheck=myC&&chAttacked(this.board,chKingSq(this.board,turn),turn==='w'?'b':'w');
      status=`<div class="ta-status ${myTurn?'ta-myturn':''}">
        ${inCheck?'⚠ check — ':''}${myTurn?'your move':'opponent\'s move'}
        <span style="color:var(--dim);margin-left:8px">you: ${myC==='w'?'white':'black'}</span>
      </div>`;
    } else if (this.state==='done') {
      const won=this.winner===myC, draw=!this.winner;
      const msg=this.result==='resign'?'opponent resigned':this.result==='stalemate'?'stalemate':won?'checkmate — you win!':'checkmate — you lose';
      status=`<div class="ta-status ${draw?'ta-draw':won?'ta-win':'ta-loss'}">${msg}
        <div class="ta-btns" style="margin-top:5px">
          <div class="ta-btn" id="ch-reset">rematch</div>
          <div class="ta-btn danger" id="ch-close">close</div>
        </div></div>`;
    }

    // Board
    let boardHtml='<div class="ch-board">';
    for (let vi=0;vi<64;vi++) {
      const sq=flipped?(63-vi):vi;
      const r=Math.floor(sq/8), cf=sq%8;
      const light=(r+cf)%2===0;
      const p=this.board[sq];
      const sel=this.selected===sq;
      const hint=this.legalTos.includes(sq);
      const kingSq=chKingSq(this.board,turn);
      const inCheck=this.state==='active'&&sq===kingSq&&chAttacked(this.board,kingSq,turn==='w'?'b':'w');
      let cls=`ch-sq ${light?'ch-light':'ch-dark'}${sel?' ch-sel':''}${hint?' ch-hint':''}${inCheck?' ch-check':''}`;
      boardHtml+=`<div class="${cls}" data-sq="${sq}">${p?`<span class="ch-piece ${chColor(p)==='w'?'ch-w':'ch-b'}">${CH_GLYPHS[p]||''}</span>`:hint?'<span class="ch-dot"></span>':''}</div>`;
    }
    boardHtml+='</div>';

    // Rank/file labels (tiny)
    const files='abcdefgh', ranks='87654321';
    const fileLabels=(flipped?[...files].reverse():files.split('').map(x=>x)).join('');
    const rankLabels=(flipped?[...ranks].reverse():ranks.split('').map(x=>x)).join('');

    c.innerHTML=`<div class="tqapp-chess">
      <div class="tqapp-hdr"><span>♟ chess</span></div>
      ${status}
      <div class="ch-wrap">
        <div class="ch-ranks">${rankLabels.split('').map(l=>`<span>${l}</span>`).join('')}</div>
        ${boardHtml}
      </div>
      <div class="ch-files">${fileLabels.split('').map(l=>`<span>${l}</span>`).join('')}</div>
      ${this.state==='active'?`<div class="ta-btns" style="margin-top:4px"><div class="ta-btn danger" id="ch-resign">resign</div></div>`:''}
    </div>`;

    c.querySelectorAll('.ch-sq').forEach(el=>
      el.addEventListener('click',()=>this._selectSquare(+el.dataset.sq))
    );
    c.querySelector('#ch-acc')?.addEventListener('click',()=>this._accept());
    c.querySelector('#ch-dec')?.addEventListener('click',()=>{ this.send({gameType:'chess',action:'resign'}); this.onClose?.(); });
    c.querySelector('#ch-reset')?.addEventListener('click',()=>this._requestReset());
    c.querySelector('#ch-close')?.addEventListener('click',()=>this.onClose?.());
    c.querySelector('#ch-resign')?.addEventListener('click',()=>this._resign());
  }

  destroy() { this._dom=null; }
}

// (registry populated at end of file)

// ── Air Hockey ────────────────────────────────────────────────────────────────
// 2-player real-time air hockey over the game message bus.
// Physics: impulse-based with paddle-velocity transfer, penetration resolution,
// speed management, and goal-flash visual feedback.
// P1 (inviter) = physics authority; P2 receives authoritative ball+score.
// Both run local rendering; P2 receives P1's state ~60fps.

const AH_W = 320, AH_H = 480;   // logical canvas size
const AH_PR = 26;                // paddle radius
const AH_BR = 12;                // ball radius
const AH_GW = 84;                // half goal width
const AH_SYNC_MS = 16;           // ~60fps sync
const AH_MAX_SPD = 16;           // ball speed ceiling
const AH_MIN_SPD = 2.8;          // ball speed floor
const AH_TRAIL   = 8;            // number of trail positions

function ahClamp(v,mn,mx){return v<mn?mn:v>mx?mx:v;}
function ahDist(ax,ay,bx,by){return Math.hypot(ax-bx,ay-by);}
function ahColliding(ax,ay,ar,bx,by,br){return ahDist(ax,ay,bx,by)<(ar+br);}

export class AirHockey {
  constructor(peerFp, myFp, sendFn, onCloseFn) {
    this.peerFp  = peerFp;
    this.myFp    = myFp;
    this.send    = sendFn;
    this.onClose = onCloseFn;

    this.mySlot   = null;
    this.state    = 'waiting';
    this._invited = false;
    this._dom     = null;
    this._canvas  = null;
    this._ctx     = null;
    this._raf     = null;
    this._syncT   = 0;

    // Physics state — P1 authoritative
    this.ball  = {x:AH_W/2, y:AH_H/2, vx:2.5, vy:3.5, trail:[]};
    // Paddles: position + previous position (for velocity derivation)
    this.p1    = {x:AH_W/2, y:AH_H-52, px:AH_W/2, py:AH_H-52, vx:0, vy:0};
    this.p2    = {x:AH_W/2, y:52,       px:AH_W/2, py:52,       vx:0, vy:0};
    this.score = {p1:0, p2:0};
    this.maxScore    = 7;
    this._gameOver   = false;
    this._goalPending= false;
    this._goalTimer  = null;
    this._flashT     = 0;    // frames of goal flash remaining
    this._hitCount   = 0;    // cumulative hits for gentle speed escalation
  }

  handleMsg(msg) {
    const {action} = msg;
    if (action === 'invite') {
      this._invited = true; this.mySlot = 2; this.state = 'waiting'; this._draw();
    } else if (action === 'accept') {
      this.mySlot = 1; this.state = 'active'; this._startLoop(); this._draw();
    } else if (action === 'state') {
      if (this.mySlot === 1) {
        // P1 receives only P2's paddle position
        if (msg.px !== undefined) { this.p2.vx = msg.px - this.p2.x; this.p2.vy = msg.py - this.p2.y; this.p2.x = msg.px; this.p2.y = msg.py; }
      } else {
        // P2 receives P1's paddle + authoritative ball + score
        if (msg.px !== undefined) { this.p1.vx = msg.px - this.p1.x; this.p1.vy = msg.py - this.p1.y; this.p1.x = msg.px; this.p1.y = msg.py; }
        if (msg.ball) { Object.assign(this.ball, msg.ball); }
        if (msg.score) { this.score = {...msg.score}; }
        if (msg.flash) { this._flashT = 12; }
      }
    } else if (action === 'goal') {
      this._goalPending = true; this._flashT = 16;
      this.score = {...msg.score}; this._checkOver();
    } else if (action === 'reset') {
      this._goalPending = false; this.ball.trail = [];
      this._resetBall();
    } else if (action === 'resign') {
      this.state = 'done'; this._stopLoop(); this._draw();
    }
  }

  _accept() {
    this.mySlot = 2; this.state = 'active';
    this.send({gameType:'airh', action:'accept'});
    this._startLoop(); this._draw();
  }

  _startLoop() {
    if (this._raf) return;
    const loop = (ts) => {
      this._raf = requestAnimationFrame(loop);
      if (this.state !== 'active') return;
      if (this.mySlot === 1) this._updatePhysics();
      if (this._flashT > 0) this._flashT--;
      this._drawFrame();
      if (ts - this._syncT > AH_SYNC_MS) {
        this._syncT = ts;
        const myP = this.mySlot === 1 ? this.p1 : this.p2;
        const msg = {gameType:'airh', action:'state', px:myP.x, py:myP.y};
        if (this.mySlot === 1) {
          msg.ball  = {x:this.ball.x, y:this.ball.y, vx:this.ball.vx, vy:this.ball.vy};
          msg.score = this.score;
          if (this._flashT > 0) msg.flash = true;
        }
        this.send(msg);
      }
    };
    this._raf = requestAnimationFrame(loop);
  }

  _stopLoop() { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } }

  _updatePhysics() {
    if (this._goalPending || this._gameOver) return;
    const b = this.ball;

    // Store trail position before moving
    b.trail = b.trail || [];
    b.trail.unshift({x:b.x, y:b.y});
    if (b.trail.length > AH_TRAIL) b.trail.length = AH_TRAIL;

    // Integrate position
    b.x += b.vx; b.y += b.vy;

    // Side wall collisions (no energy loss — walls are perfectly elastic)
    if (b.x - AH_BR < 0)     { b.x = AH_BR;        b.vx =  Math.abs(b.vx); }
    if (b.x + AH_BR > AH_W)  { b.x = AH_W - AH_BR; b.vx = -Math.abs(b.vx); }

    // Paddle collision — impulse-based with velocity transfer
    this._paddleCollide(this.p1);
    this._paddleCollide(this.p2);

    // Speed floor: if ball nearly stops, nudge it
    const spd = Math.hypot(b.vx, b.vy);
    if (spd < AH_MIN_SPD && !this._goalPending) {
      const a = Math.atan2(b.vy, b.vx);
      b.vx = Math.cos(a) * AH_MIN_SPD;
      b.vy = Math.sin(a) * AH_MIN_SPD;
    }

    // Goal detection — ball exits top or bottom through goal mouth
    if (b.y - AH_BR < 0) {
      if (Math.abs(b.x - AH_W/2) < AH_GW) {
        this.score.p1++; this._onGoal(); return;
      }
      b.y = AH_BR; b.vy = Math.abs(b.vy);
    }
    if (b.y + AH_BR > AH_H) {
      if (Math.abs(b.x - AH_W/2) < AH_GW) {
        this.score.p2++; this._onGoal(); return;
      }
      b.y = AH_H - AH_BR; b.vy = -Math.abs(b.vy);
    }
  }

  _paddleCollide(p) {
    const b = this.ball;
    const dist = ahDist(b.x, b.y, p.x, p.y);
    const minD  = AH_PR + AH_BR;
    if (dist >= minD) return;

    // Normal vector from paddle centre to ball
    const nx = dist > 0 ? (b.x - p.x) / dist : 0;
    const ny = dist > 0 ? (b.y - p.y) / dist : -1;

    // Penetration correction — push ball fully outside paddle
    const overlap = minD - dist;
    b.x += nx * (overlap + 0.5);
    b.y += ny * (overlap + 0.5);

    // Relative velocity along normal
    const relVn = (b.vx - p.vx) * nx + (b.vy - p.vy) * ny;
    if (relVn > 0) return; // already separating

    // Restitution coefficient — slightly super-elastic to maintain energy
    const e = 1.08;
    const impulse = -(1 + e) * relVn;

    // Apply impulse to ball (paddle treated as immovable, infinite mass)
    b.vx += impulse * nx;
    b.vy += impulse * ny;

    // Transfer a fraction of paddle velocity for "flick" feel
    b.vx += p.vx * 0.55;
    b.vy += p.vy * 0.55;

    // Clamp to speed ceiling; escalate ceiling slightly with hit count
    this._hitCount++;
    const capSpd = Math.min(AH_MAX_SPD, 6 + this._hitCount * 0.18);
    const newSpd = Math.hypot(b.vx, b.vy);
    if (newSpd > capSpd) {
      b.vx = b.vx / newSpd * capSpd;
      b.vy = b.vy / newSpd * capSpd;
    }
  }

  _onGoal() {
    if (this._goalPending) return;
    this._goalPending = true; this._flashT = 18;
    this.ball.vx = 0; this.ball.vy = 0; this.ball.trail = [];
    this.send({gameType:'airh', action:'goal', score:{...this.score}});
    this._checkOver();
    if (!this._gameOver) {
      clearTimeout(this._goalTimer);
      this._goalTimer = setTimeout(() => {
        this._goalPending = false;
        this._hitCount = 0;
        this._resetBall();
        this.send({gameType:'airh', action:'reset'});
      }, 1400);
    }
  }

  _checkOver() {
    if (this.score.p1 >= this.maxScore || this.score.p2 >= this.maxScore) {
      clearTimeout(this._goalTimer); this._goalTimer = null;
      this._gameOver = true; this.state = 'done'; this._stopLoop(); this._draw();
    }
  }

  _resetBall() {
    // Serve toward the scorer's opponent with slight random angle
    const angle = (Math.random() * 0.6 + 0.2) * Math.PI * (Math.random() < .5 ? 1 : -1);
    const spd   = 4.5;
    this.ball = {x:AH_W/2, y:AH_H/2, vx:Math.cos(angle)*spd, vy:Math.sin(angle)*spd, trail:[]};
  }

  _drawFrame() {
    const cv = this._canvas, ctx = this._ctx;
    if (!cv || !ctx) return;
    const W = cv.width, H = cv.height;
    const sx = W / AH_W, sy = H / AH_H;

    // Background
    ctx.fillStyle = '#040a09';
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.scale(sx, sy);

    // Board flip for P2 — their paddle always at bottom visually
    const flip = this.mySlot === 2;
    if (flip) { ctx.translate(AH_W, AH_H); ctx.scale(-1,-1); }

    // Goal flash overlay
    if (this._flashT > 0) {
      const alpha = (this._flashT / 18) * 0.22;
      ctx.fillStyle = `rgba(64,224,208,${alpha})`;
      ctx.fillRect(0, 0, AH_W, AH_H);
    }

    // ── Field markings ──
    // Outer border with glow
    ctx.shadowColor = 'rgba(64,224,208,.35)'; ctx.shadowBlur = 6;
    ctx.strokeStyle = 'rgba(64,224,208,.35)'; ctx.lineWidth = 1.5;
    ctx.strokeRect(2, 2, AH_W-4, AH_H-4);
    ctx.shadowBlur = 0;

    // Half-court line
    ctx.strokeStyle = 'rgba(64,224,208,.2)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, AH_H/2); ctx.lineTo(AH_W, AH_H/2); ctx.stroke();

    // Centre circle
    ctx.beginPath(); ctx.arc(AH_W/2, AH_H/2, 42, 0, Math.PI*2);
    ctx.strokeStyle = 'rgba(64,224,208,.15)'; ctx.lineWidth = 1.5; ctx.stroke();
    // Centre dot
    ctx.beginPath(); ctx.arc(AH_W/2, AH_H/2, 4, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(64,224,208,.25)'; ctx.fill();

    // Half-zone tints (subtle)
    const zoneGrad = ctx.createLinearGradient(0,0,0,AH_H);
    zoneGrad.addColorStop(0,   'rgba(26,158,148,.04)');
    zoneGrad.addColorStop(0.48,'rgba(26,158,148,.01)');
    zoneGrad.addColorStop(0.52,'rgba(107,255,123,.01)');
    zoneGrad.addColorStop(1,   'rgba(107,255,123,.04)');
    ctx.fillStyle = zoneGrad; ctx.fillRect(0,0,AH_W,AH_H);

    // ── Goals ──
    const gx1 = AH_W/2 - AH_GW;
    const drawGoal = (y, h, topGoal) => {
      // Fill
      const gg = ctx.createLinearGradient(0, y, 0, y+h);
      gg.addColorStop(0, 'rgba(64,224,208,.18)');
      gg.addColorStop(1, 'rgba(64,224,208,.04)');
      ctx.fillStyle = gg; ctx.fillRect(gx1, y, AH_GW*2, h);
      // Border
      ctx.strokeStyle = 'rgba(64,224,208,.55)'; ctx.lineWidth = 2;
      ctx.strokeRect(gx1, y, AH_GW*2, h);
      // Goal label
      ctx.font = '7px "Space Mono",monospace';
      ctx.fillStyle = 'rgba(64,224,208,.4)';
      ctx.textAlign = 'center';
      ctx.fillText(topGoal ? 'GOAL' : 'GOAL', AH_W/2, topGoal ? y+h-2 : y+8);
    };
    drawGoal(0,       10, true);   // top goal (P2 defends)
    drawGoal(AH_H-10, 10, false);  // bottom goal (P1 defends)

    // ── Ball trail ──
    const trail = this.ball.trail || [];
    trail.forEach((pos, i) => {
      const alpha = (1 - i/trail.length) * 0.22;
      const r     = AH_BR * (1 - i/trail.length * 0.5);
      ctx.beginPath(); ctx.arc(pos.x, pos.y, r, 0, Math.PI*2);
      ctx.fillStyle = `rgba(64,224,208,${alpha})`; ctx.fill();
    });

    // ── Ball ──
    // Outer glow
    ctx.shadowColor = 'rgba(64,224,208,.6)'; ctx.shadowBlur = 14;
    // Radial gradient on ball
    const bg = ctx.createRadialGradient(this.ball.x-3, this.ball.y-3, 1, this.ball.x, this.ball.y, AH_BR);
    bg.addColorStop(0, '#ffffff');
    bg.addColorStop(0.5, 'rgba(220,255,250,.95)');
    bg.addColorStop(1, 'rgba(64,224,208,.8)');
    ctx.beginPath(); ctx.arc(this.ball.x, this.ball.y, AH_BR, 0, Math.PI*2);
    ctx.fillStyle = bg; ctx.fill();
    ctx.strokeStyle = 'rgba(64,224,208,.9)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.shadowBlur = 0;

    // ── Paddles ──
    const drawPaddle = (p, mine) => {
      const baseColor  = mine ? '#40e0d0' : '#6bff7b';
      const fillColor  = mine ? 'rgba(64,224,208,.22)' : 'rgba(107,255,123,.18)';
      const glowColor  = mine ? 'rgba(64,224,208,.6)'  : 'rgba(107,255,123,.5)';

      // Glow
      ctx.shadowColor = glowColor; ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.arc(p.x, p.y, AH_PR, 0, Math.PI*2);

      // Radial gradient fill
      const pg = ctx.createRadialGradient(p.x-5, p.y-5, 2, p.x, p.y, AH_PR);
      pg.addColorStop(0, mine ? 'rgba(100,255,245,.55)' : 'rgba(150,255,160,.45)');
      pg.addColorStop(1, fillColor);
      ctx.fillStyle = pg; ctx.fill();

      // Ring
      ctx.strokeStyle = baseColor; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.shadowBlur = 0;

      // Inner ring detail
      ctx.beginPath(); ctx.arc(p.x, p.y, AH_PR * 0.52, 0, Math.PI*2);
      ctx.strokeStyle = `${baseColor}55`; ctx.lineWidth = 1; ctx.stroke();

      // Centre dot
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI*2);
      ctx.fillStyle = baseColor; ctx.fill();
    };

    const myIsP1 = this.mySlot === 1;
    drawPaddle(this.p1,  myIsP1);
    drawPaddle(this.p2, !myIsP1);

    ctx.restore();

    // Score DOM update
    const sc = this._dom?.querySelector('#ah-score');
    if (sc) {
      const myScore  = this.mySlot===1 ? this.score.p1 : this.score.p2;
      const oppScore = this.mySlot===1 ? this.score.p2 : this.score.p1;
      sc.textContent = `${myScore} — ${oppScore}`;
    }
  }

  render(container) { this._dom = container; this._draw(); }

  _draw() {
    const c = this._dom; if (!c) return;

    if (this.state === 'waiting' && this._invited) {
      c.innerHTML = `<div class="tqapp-airh">
        <div class="tqapp-hdr"><span>◉ air hockey</span></div>
        <div class="ta-invite">
          <div class="ta-inv-text">air hockey challenge</div>
          <div class="ta-btns">
            <div class="ta-btn accept" id="ah-acc">tune·in</div>
            <div class="ta-btn danger" id="ah-dec">pass</div>
          </div>
        </div>
      </div>`;
      c.querySelector('#ah-acc')?.addEventListener('click', () => this._accept());
      c.querySelector('#ah-dec')?.addEventListener('click', () => { this.send({gameType:'airh',action:'resign'}); this.onClose?.(); });
      return;
    }
    if (this.state === 'waiting') {
      c.innerHTML = `<div class="tqapp-airh"><div class="tqapp-hdr"><span>◉ air hockey</span></div><div class="ta-status">waiting for opponent…</div></div>`;
      return;
    }
    if (this.state === 'done') {
      const myScore  = this.mySlot===1 ? this.score.p1 : this.score.p2;
      const oppScore = this.mySlot===1 ? this.score.p2 : this.score.p1;
      const won = myScore >= this.maxScore;
      c.innerHTML = `<div class="tqapp-airh">
        <div class="tqapp-hdr"><span>◉ air hockey</span><span class="tqapp-sym">${myScore} — ${oppScore}</span></div>
        <div class="ta-status ${won?'ta-win':'ta-loss'}">${won?'you win!':'you lose'}
          <div class="ta-btns" style="margin-top:5px">
            <div class="ta-btn danger" id="ah-close">close</div>
          </div>
        </div>
      </div>`;
      c.querySelector('#ah-close')?.addEventListener('click', () => this.onClose?.());
      return;
    }
    // Active — create canvas once
    if (!this._canvas) {
      const myHalf = this.mySlot===1 ? 'bottom half' : 'top half (flipped)';
      const myColor= this.mySlot===1 ? 'teal' : 'green';
      c.innerHTML = `<div class="tqapp-airh">
        <div class="tqapp-hdr">
          <span>◉ air hockey</span>
          <span class="tqapp-sym" id="ah-score">0 — 0</span>
        </div>
        <div class="ah-field"><canvas id="ah-canvas"></canvas></div>
        <div class="ta-status" style="font-size:9px;color:var(--dim);margin-top:3px">
          you: ${myColor} · ${myHalf} · move to aim · first to ${this.maxScore}
        </div>
        <div class="ta-btns"><div class="ta-btn danger" id="ah-resign">resign</div></div>
      </div>`;
      this._canvas = c.querySelector('#ah-canvas');
      this._ctx    = this._canvas.getContext('2d');
      this._resizeCanvas();
      this._bindInput();
      c.querySelector('#ah-resign')?.addEventListener('click', () => {
        this.send({gameType:'airh', action:'resign'});
        this.state = 'done'; this._stopLoop(); this._draw();
      });
    }
  }

  _resizeCanvas() {
    const cv = this._canvas; if (!cv) return;
    const w   = Math.min(cv.parentElement?.clientWidth || 300, 300);
    const dpr = window.devicePixelRatio || 1;
    cv.width  = w * dpr;
    cv.height = w * (AH_H / AH_W) * dpr;
    cv.style.width  = w + 'px';
    cv.style.height = (w * (AH_H / AH_W)) + 'px';
  }

  _bindInput() {
    const cv = this._canvas; if (!cv) return;
    const pos = (e) => {
      const r   = cv.getBoundingClientRect();
      const src = e.touches ? e.touches[0] : e;
      let rx = (src.clientX - r.left) / r.width  * AH_W;
      let ry = (src.clientY - r.top)  / r.height * AH_H;
      if (this.mySlot === 2) { rx = AH_W - rx; ry = AH_H - ry; }
      const p = this.mySlot === 1 ? this.p1 : this.p2;
      // Compute paddle velocity for impulse transfer
      p.vx = ahClamp(rx, AH_PR, AH_W-AH_PR) - p.x;
      p.vy = (this.mySlot===1 ? ahClamp(ry, AH_H/2+AH_PR, AH_H-AH_PR) : ahClamp(ry, AH_PR, AH_H/2-AH_PR)) - p.y;
      p.x  = ahClamp(rx, AH_PR, AH_W-AH_PR);
      p.y  = this.mySlot===1 ? ahClamp(ry, AH_H/2+AH_PR, AH_H-AH_PR) : ahClamp(ry, AH_PR, AH_H/2-AH_PR);
    };
    cv.addEventListener('mousemove',  e => { if (this.state==='active') pos(e); });
    cv.addEventListener('touchmove',  e => { if (this.state==='active') { e.preventDefault(); pos(e); } }, {passive:false});
    cv.addEventListener('touchstart', e => { if (this.state==='active') { e.preventDefault(); pos(e); } }, {passive:false});
  }

  destroy() {
    this._stopLoop();
    clearTimeout(this._goalTimer); this._goalTimer = null;
    this._canvas = null; this._ctx = null; this._dom = null;
  }
}


// ── Strand (Snake Duel) ───────────────────────────────────────────────────────
// 2-player snake duel. P1 (inviter) is game authority — runs simulation and
// broadcasts full state every tick. P2 sends only direction inputs.
// Both snakes share one field. Eat apples to grow. Die on walls, self, or
// opponent. 3 lives each; lose a life on death and respawn. Last alive wins.

const SN_COLS = 22, SN_ROWS = 26;           // grid dimensions
const SN_CELL = 13;                          // pixels per cell
const SN_W    = SN_COLS * SN_CELL;          // canvas logical width  (286)
const SN_H    = SN_ROWS * SN_CELL;          // canvas logical height (338)
const SN_TICK = 155;                         // ms per game tick
const SN_LIVES= 3;                           // lives each player starts with
const SN_GROW = 4;                           // segments added per apple

// Direction vectors
const SN_DIR = {n:[0,-1], s:[0,1], e:[1,0], w:[-1,0]};
// Opposite directions (can't reverse into yourself)
const SN_OPP = {n:'s', s:'n', e:'w', w:'e'};

function snEqual(a, b)  { return a.x===b.x && a.y===b.y; }
function snInList(pos, arr) { return arr.some(s=>snEqual(s,pos)); }
function snRandPos(exclude) {
  let p;
  let tries = 0;
  do {
    p = {x:1+Math.floor(Math.random()*(SN_COLS-2)), y:1+Math.floor(Math.random()*(SN_ROWS-2))};
    tries++;
  } while (snInList(p, exclude) && tries < 200);
  return p;
}

export class SnakeDuel {
  constructor(peerFp, myFp, sendFn, onCloseFn) {
    this.peerFp  = peerFp;
    this.myFp    = myFp;
    this.send    = sendFn;
    this.onClose = onCloseFn;

    this.mySlot   = null;   // 1=inviter (authority), 2=acceptor
    this.state    = 'waiting';
    this._invited = false;
    this._dom     = null;
    this._canvas  = null;
    this._ctx     = null;
    this._tick    = null;   // setInterval handle

    // Game state (authoritative on P1, mirrored on P2)
    this._s1     = [];      // snake 1 segments [{x,y},...] head first
    this._s2     = [];      // snake 2 segments
    this._d1     = 'e';    // snake 1 current direction
    this._d2     = 'w';    // snake 2 current direction
    this._nd1    = 'e';    // next direction queued (to prevent double-reverse)
    this._nd2    = 'w';
    this._apple  = null;   // {x, y}
    this._lives  = {p1:SN_LIVES, p2:SN_LIVES};
    this._score  = {p1:0, p2:0};   // apples eaten each
    this._grow1  = 0;       // segments to still add for s1
    this._grow2  = 0;
    this._phase  = 'active';  // 'active' | 'dead1' | 'dead2' | 'over'
    this._respT  = 0;         // respawn timer
    this._deathFlash = 0;     // frames of death flash
  }

  // ── Message handling ────────────────────────────────────────────────────────

  handleMsg(msg) {
    const {action} = msg;
    if (action === 'invite') {
      this._invited = true; this.mySlot = 2; this.state = 'waiting'; this._draw();
    } else if (action === 'accept') {
      this.mySlot = 1; this.state = 'active'; this._initGame(); this._startLoop(); this._draw();
    } else if (action === 'dir') {
      // P1 receives P2's direction request
      if (this.mySlot === 1 && msg.d && SN_DIR[msg.d] && msg.d !== SN_OPP[this._d2]) {
        this._nd2 = msg.d;
      }
    } else if (action === 'state') {
      // P2 receives authoritative full state from P1
      if (this.mySlot !== 2) return;
      // Array.isArray so empty arrays (dead/respawned snake) are applied correctly
      if (Array.isArray(msg.s1)) this._s1 = msg.s1;
      if (Array.isArray(msg.s2)) this._s2 = msg.s2;
      if (msg.apple !== undefined) this._apple = msg.apple;
      if (msg.lives)  this._lives = msg.lives;
      if (msg.score)  this._score = msg.score;
      if (msg.phase)  this._phase = msg.phase;
      if (msg.flash)  this._deathFlash = 14;
      // FIX: P2 must transition to done when P1 declares game over.
      // Without this P2's renderLoop runs forever and done screen never shows.
      if (msg.phase === 'over') {
        this.state = 'done';
        this._stopLoop();
        this._unbindKeys();
        this._canvas = null; this._ctx = null;
        this._draw();
      }
    } else if (action === 'resign') {
      // FIX: unbind keys so listeners don't leak after game ends
      this.state = 'done';
      this._stopLoop();
      this._unbindKeys();
      this._canvas = null; this._ctx = null;
      this._draw();
    }
  }

  _accept() {
    this.mySlot = 2; this.state = 'active';
    this.send({gameType:'snake', action:'accept'});
    this._startLoop(); this._draw();
  }

  // ── Game logic (P1 only) ────────────────────────────────────────────────────

  _initGame() {
    // Place snakes in opposite halves facing each other
    const cx = Math.floor(SN_COLS/2);
    const row1 = Math.floor(SN_ROWS * 0.75);
    const row2 = Math.floor(SN_ROWS * 0.25);
    this._s1 = [{x:cx-1,y:row1},{x:cx-2,y:row1},{x:cx-3,y:row1}]; // P1 bottom, heading east
    this._s2 = [{x:cx+1,y:row2},{x:cx+2,y:row2},{x:cx+3,y:row2}]; // P2 top, heading west
    this._d1='e'; this._nd1='e';
    this._d2='w'; this._nd2='w';
    this._lives={p1:SN_LIVES, p2:SN_LIVES};
    this._score={p1:0,p2:0};
    this._grow1=0; this._grow2=0;
    this._phase='active';
    this._spawnApple();
  }

  _spawnApple() {
    const occupied = [...this._s1, ...this._s2];
    this._apple = snRandPos(occupied);
  }

  _startLoop() {
    if (this._tick) return;
    // P1 runs game ticks; P2 just renders on received state
    if (this.mySlot === 1) {
      this._tick = setInterval(() => this._gameTick(), SN_TICK);
    }
    // Both render at ~30fps for smooth display
    const renderLoop = () => {
      this._drawFrame();
      if (this.state === 'active') this._animFrame = requestAnimationFrame(renderLoop);
    };
    this._animFrame = requestAnimationFrame(renderLoop);
  }

  _stopLoop() {
    clearInterval(this._tick); this._tick = null;
    cancelAnimationFrame(this._animFrame); this._animFrame = null;
  }

  _gameTick() {
    if (this.state !== 'active') return;

    if (this._phase === 'dead1' || this._phase === 'dead2') {
      this._respT--;
      if (this._respT <= 0) {
        // _respawnBoth flag handles simultaneous death case
        this._respawn(this._phase === 'dead1' ? 1 : 2);
      }
      this._broadcast();
      return;
    }
    if (this._phase !== 'active') return;

    // Commit queued direction changes
    this._d1 = this._nd1;
    this._d2 = this._nd2;

    // Move snakes
    const [dx1,dy1] = SN_DIR[this._d1];
    const [dx2,dy2] = SN_DIR[this._d2];
    const head1 = {x:this._s1[0].x+dx1, y:this._s1[0].y+dy1};
    const head2 = {x:this._s2[0].x+dx2, y:this._s2[0].y+dy2};

    // Determine apple eaten BEFORE collision checks (apple at new head)
    const ate1 = this._apple && snEqual(head1, this._apple);
    const ate2 = this._apple && snEqual(head2, this._apple);

    // Check collisions
    const s1TailExcluded = this._grow1===0 ? this._s1.slice(0,-1) : this._s1;
    const s2TailExcluded = this._grow2===0 ? this._s2.slice(0,-1) : this._s2;
    const dead1 = this._hitWall(head1) || snInList(head1, s1TailExcluded) || snInList(head1, s2TailExcluded);
    const dead2 = this._hitWall(head2) || snInList(head2, s2TailExcluded) || snInList(head2, s1TailExcluded);

    // Handle deaths — including simultaneous collision
    if (dead1 || dead2) {
      this._deathFlash = 14;
      if (dead1) this._lives.p1--;
      if (dead2) this._lives.p2--;

      // Check game over (either player ran out of lives)
      const p1Out = this._lives.p1 <= 0;
      const p2Out = this._lives.p2 <= 0;
      if (p1Out || p2Out) {
        this._phase = 'over'; this.state = 'done';
        this._stopLoop(); this._broadcast(); this._canvas = null; this._ctx = null; this._draw();
        return;
      }

      // Not game over — enter dead phase for each dead snake independently.
      // Both can be dead simultaneously; we respawn both when timer expires.
      if (dead1 && dead2) {
        // Both dead: use a shared dead phase; _respawn checks the flag
        this._phase = 'dead1'; this._respawnBoth = true; this._respT = 8;
      } else if (dead1) {
        this._phase = 'dead1'; this._respawnBoth = false; this._respT = 8;
      } else {
        this._phase = 'dead2'; this._respawnBoth = false; this._respT = 8;
      }
      this._broadcast();
      return;
    }

    // Advance S1
    this._s1.unshift(head1);
    if (this._grow1 > 0) this._grow1--;
    else this._s1.pop();

    // Advance S2
    this._s2.unshift(head2);
    if (this._grow2 > 0) this._grow2--;
    else this._s2.pop();

    // Apple eaten
    if (ate1) {
      this._grow1 += SN_GROW; this._score.p1++;
      this._spawnApple();
    } else if (ate2) {
      this._grow2 += SN_GROW; this._score.p2++;
      this._spawnApple();
    }

    this._broadcast();
  }

  _hitWall(pos) {
    return pos.x < 0 || pos.x >= SN_COLS || pos.y < 0 || pos.y >= SN_ROWS;
  }

  _respawn(who) {
    const cx = Math.floor(SN_COLS/2);
    const doP1 = () => {
      const row = Math.floor(SN_ROWS * 0.75);
      this._s1=[{x:cx-1,y:row},{x:cx-2,y:row},{x:cx-3,y:row}];
      this._d1='e'; this._nd1='e'; this._grow1=0;
    };
    const doP2 = () => {
      const row = Math.floor(SN_ROWS * 0.25);
      this._s2=[{x:cx+1,y:row},{x:cx+2,y:row},{x:cx+3,y:row}];
      this._d2='w'; this._nd2='w'; this._grow2=0;
    };
    if (this._respawnBoth) { doP1(); doP2(); this._respawnBoth = false; }
    else if (who === 1)    { doP1(); }
    else                   { doP2(); }
    this._phase = 'active';
  }

  _broadcast() {
    this.send({
      gameType:'snake', action:'state',
      s1:this._s1, s2:this._s2,
      apple:this._apple,
      lives:{...this._lives}, score:{...this._score},
      phase:this._phase,
      flash: this._deathFlash > 0,
    });
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  _bindKeys() {
    this._onKey = (e) => {
      if (this.state !== 'active') return;
      const map = {ArrowUp:'n', ArrowDown:'s', ArrowLeft:'w', ArrowRight:'e',
                   KeyW:'n', KeyS:'s', KeyA:'w', KeyD:'e'};
      const d = map[e.code];
      if (!d) return;
      e.preventDefault();
      this._queueDir(d);
    };
    window.addEventListener('keydown', this._onKey);
  }

  _unbindKeys() {
    if (this._onKey) { window.removeEventListener('keydown', this._onKey); this._onKey=null; }
  }

  _queueDir(d) {
    const myDir = this.mySlot===1 ? this._d1 : this._d2;
    if (d === SN_OPP[myDir]) return; // can't reverse
    if (this.mySlot === 1) {
      this._nd1 = d;
    } else {
      this._nd2 = d;
      // P2 sends direction to P1
      this.send({gameType:'snake', action:'dir', d});
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  _drawFrame() {
    const cv = this._canvas, ctx = this._ctx;
    if (!cv || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.width, H = cv.height;
    const cs = (SN_CELL * W) / (SN_W * dpr); // cell size in device px / scale

    ctx.clearRect(0, 0, W, H);

    ctx.save();
    ctx.scale(W / (SN_W * dpr), H / (SN_H * dpr));
    ctx.scale(dpr, dpr);

    // Background grid
    ctx.fillStyle = '#040a09';
    ctx.fillRect(0, 0, SN_W, SN_H);

    // Subtle grid lines
    ctx.strokeStyle = 'rgba(64,224,208,.04)'; ctx.lineWidth = 0.5;
    for (let x=0; x<=SN_COLS; x++) {
      ctx.beginPath(); ctx.moveTo(x*SN_CELL,0); ctx.lineTo(x*SN_CELL,SN_H); ctx.stroke();
    }
    for (let y=0; y<=SN_ROWS; y++) {
      ctx.beginPath(); ctx.moveTo(0,y*SN_CELL); ctx.lineTo(SN_W,y*SN_CELL); ctx.stroke();
    }

    // Half-zone tint (very subtle)
    ctx.fillStyle = 'rgba(64,224,208,.018)';
    ctx.fillRect(0, SN_H/2, SN_W, SN_H/2);

    // Death flash
    if (this._deathFlash > 0) {
      this._deathFlash--;
      ctx.fillStyle = `rgba(255,96,64,${this._deathFlash/14 * 0.14})`;
      ctx.fillRect(0, 0, SN_W, SN_H);
    }

    // Apple
    if (this._apple) {
      const ax = this._apple.x*SN_CELL + SN_CELL/2;
      const ay = this._apple.y*SN_CELL + SN_CELL/2;
      const ar = SN_CELL*0.38;
      ctx.shadowColor='rgba(255,96,64,.7)'; ctx.shadowBlur=10;
      ctx.beginPath(); ctx.arc(ax, ay, ar, 0, Math.PI*2);
      const ag = ctx.createRadialGradient(ax-1,ay-1,0,ax,ay,ar);
      ag.addColorStop(0,'#ff9060'); ag.addColorStop(1,'#ff4020');
      ctx.fillStyle=ag; ctx.fill();
      ctx.shadowBlur=0;
    }

    // Helper: draw a snake
    const drawSnake = (segs, isMe, isDead) => {
      if (!segs || !segs.length) return;
      const base  = isMe ? '#40e0d0' : '#6bff7b';
      const glow  = isMe ? 'rgba(64,224,208,.55)' : 'rgba(107,255,123,.45)';
      const alpha = isDead ? 0.25 : 1;

      segs.forEach((seg, i) => {
        const px = seg.x*SN_CELL, py = seg.y*SN_CELL;
        const fade = 1 - (i / segs.length) * 0.55;
        const inset = i===0 ? 1 : 2;
        ctx.shadowColor = i===0 ? glow : 'transparent';
        ctx.shadowBlur  = i===0 ? 10 : 0;
        // Segment rect with inset for gap
        const r = SN_CELL - inset*2;
        ctx.fillStyle = i===0
          ? `${base}${Math.round(fade*255*alpha).toString(16).padStart(2,'0')}`
          : `${base}${Math.round(fade*200*alpha).toString(16).padStart(2,'0')}`;
        ctx.fillRect(px+inset, py+inset, r, r);
        ctx.shadowBlur=0;
      });

      // Head: rounded square with brighter center
      const hx = segs[0].x*SN_CELL, hy = segs[0].y*SN_CELL;
      ctx.shadowColor=glow; ctx.shadowBlur=8;
      const hg = ctx.createRadialGradient(hx+SN_CELL/2-1, hy+SN_CELL/2-1, 0, hx+SN_CELL/2, hy+SN_CELL/2, SN_CELL/2);
      hg.addColorStop(0, isDead ? '#444' : (isMe ? '#90fff8' : '#b0ffb8'));
      hg.addColorStop(1, base);
      ctx.fillStyle = hg;
      ctx.fillRect(hx+1, hy+1, SN_CELL-2, SN_CELL-2);
      ctx.shadowBlur=0;
    };

    const myIsP1 = this.mySlot === 1;
    const dead1  = this._phase === 'dead1';
    const dead2  = this._phase === 'dead2';
    drawSnake(this._s2, !myIsP1, dead2);   // draw opponent first
    drawSnake(this._s1,  myIsP1, dead1);   // draw self on top

    // Border
    ctx.strokeStyle='rgba(64,224,208,.3)'; ctx.lineWidth=1.5;
    ctx.strokeRect(0.75,0.75,SN_W-1.5,SN_H-1.5);

    ctx.restore();
  }

  render(container) { this._dom = container; this._draw(); }

  _draw() {
    const c = this._dom; if (!c) return;

    if (this.state === 'waiting' && this._invited) {
      c.innerHTML = `<div class="tqapp-snake">
        <div class="tqapp-hdr"><span>⟐ strand</span></div>
        <div class="ta-invite">
          <div class="ta-inv-text">snake duel challenge</div>
          <div class="ta-btns">
            <div class="ta-btn accept" id="sn-acc">tune·in</div>
            <div class="ta-btn danger" id="sn-dec">pass</div>
          </div>
        </div>
      </div>`;
      c.querySelector('#sn-acc')?.addEventListener('click', () => this._accept());
      c.querySelector('#sn-dec')?.addEventListener('click', () => { this.send({gameType:'snake',action:'resign'}); this.onClose?.(); });
      return;
    }
    if (this.state === 'waiting') {
      c.innerHTML = `<div class="tqapp-snake"><div class="tqapp-hdr"><span>⟐ strand</span></div><div class="ta-status">waiting for opponent…</div></div>`;
      return;
    }
    if (this.state === 'done') {
      const myLives = this.mySlot===1 ? this._lives.p1 : this._lives.p2;
      const won = myLives > 0 && (this.mySlot===1 ? this._lives.p2 : this._lives.p1) <= 0;
      const myApples = this.mySlot===1 ? this._score.p1 : this._score.p2;
      const opApples = this.mySlot===1 ? this._score.p2 : this._score.p1;
      c.innerHTML = `<div class="tqapp-snake">
        <div class="tqapp-hdr"><span>⟐ strand</span><span class="tqapp-sym">${myApples}–${opApples} apples</span></div>
        <div class="ta-status ${won?'ta-win':'ta-loss'}">${won?'you win!':'you lose'}
          <div class="ta-btns" style="margin-top:5px">
            <div class="ta-btn danger" id="sn-close">close</div>
          </div>
        </div>
      </div>`;
      c.querySelector('#sn-close')?.addEventListener('click', () => this.onClose?.());
      return;
    }

    // Active — create canvas + HUD once
    if (!this._canvas) {
      const myColor = this.mySlot===1 ? 'teal' : 'green';
      const ctrlHint = 'arrow keys or WASD';
      c.innerHTML = `<div class="tqapp-snake">
        <div class="tqapp-hdr" style="margin-bottom:4px">
          <span>⟐ strand</span>
          <span class="tqapp-sym" id="sn-score">●●● vs ●●●</span>
        </div>
        <div class="sn-field"><canvas id="sn-canvas"></canvas></div>
        <div id="sn-hud" style="display:flex;justify-content:space-between;font-size:8px;color:var(--dim);margin-top:3px;letter-spacing:.06em">
          <span>you: ${myColor}</span><span>${ctrlHint}</span>
        </div>
        <div class="ta-btns"><div class="ta-btn danger" id="sn-resign">resign</div></div>
      </div>`;

      // On-canvas touch swipe controls
      this._canvas = c.querySelector('#sn-canvas');
      this._ctx    = this._canvas.getContext('2d');
      this._setupCanvas();
      this._bindKeys();
      this._bindTouch();

      c.querySelector('#sn-resign')?.addEventListener('click', () => {
        this.send({gameType:'snake',action:'resign'});
        this.state='done'; this._stopLoop(); this._unbindKeys(); this._draw();
      });
    }

    // Update lives/score display every draw
    const sc = c.querySelector('#sn-score');
    if (sc) {
      const myL  = this.mySlot===1 ? this._lives.p1 : this._lives.p2;
      const opL  = this.mySlot===1 ? this._lives.p2 : this._lives.p1;
      const myA  = this.mySlot===1 ? this._score.p1 : this._score.p2;
      const opA  = this.mySlot===1 ? this._score.p2 : this._score.p1;
      const dot  = n => '●'.repeat(n)+'○'.repeat(SN_LIVES-n);
      sc.textContent = `${dot(myL)} ${myA}·${opA} ${dot(opL)}`;
    }
  }

  _setupCanvas() {
    const cv = this._canvas; if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w   = Math.min(cv.parentElement?.clientWidth || SN_W, SN_W+10);
    const scale = w / SN_W;
    cv.width  = Math.round(SN_W * scale * dpr);
    cv.height = Math.round(SN_H * scale * dpr);
    cv.style.width  = Math.round(SN_W * scale) + 'px';
    cv.style.height = Math.round(SN_H * scale) + 'px';
  }

  _bindTouch() {
    const cv = this._canvas; if (!cv) return;
    let tx=0, ty=0;
    cv.addEventListener('touchstart', e => { e.preventDefault(); tx=e.touches[0].clientX; ty=e.touches[0].clientY; },{passive:false});
    cv.addEventListener('touchend', e => {
      e.preventDefault();
      const dx=e.changedTouches[0].clientX-tx, dy=e.changedTouches[0].clientY-ty;
      if (Math.abs(dx)<8&&Math.abs(dy)<8) return;
      const d = Math.abs(dx)>Math.abs(dy) ? (dx>0?'e':'w') : (dy>0?'s':'n');
      this._queueDir(d);
    },{passive:false});
  }

  destroy() {
    this._stopLoop(); this._unbindKeys();
    this._canvas=null; this._ctx=null; this._dom=null;
  }
}

// Update registry
REGISTRY.find(r => r.id === 'ttt').cls   = TicTacToe;
REGISTRY.find(r => r.id === 'sps').cls   = StonePaperScissors;
REGISTRY.find(r => r.id === 'chess').cls = Chess;
REGISTRY.find(r => r.id === 'airh').cls  = AirHockey;
REGISTRY.find(r => r.id === 'snake').cls = SnakeDuel;
REGISTRY.find(r => r.id === 'memo').cls  = VoiceMemo;
