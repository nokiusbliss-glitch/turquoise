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
  { id: 'airh',  label: 'air hockey',             icon: '◉', p2pOnly: true,  cls: null },
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
// Physics run locally on both devices; authoritative state synced every frame.
// Player 1 (inviter) controls bottom paddle, Player 2 (acceptor) controls top.

const AH_W = 320, AH_H = 480;  // canvas logical size
const AH_PR = 24;               // paddle radius
const AH_BR = 12;               // ball radius
const AH_GW = 80;               // goal width half
const AH_SYNC_MS = 33;          // ~30fps sync

function ahClamp(v,mn,mx){return v<mn?mn:v>mx?mx:v;}
function ahCirclesCollide(ax,ay,ar,bx,by,br){const dx=ax-bx,dy=ay-by;return dx*dx+dy*dy<(ar+br)*(ar+br);}
function ahReflect(bvx,bvy,ax,ay,bx,by){const nx=bx-ax,ny=by-ay,d=Math.hypot(nx,ny)||1;const dot=bvx*(nx/d)+bvy*(ny/d);return[bvx-2*dot*(nx/d),bvy-2*dot*(ny/d)];}

export class AirHockey {
  constructor(peerFp, myFp, sendFn, onCloseFn) {
    this.peerFp  = peerFp;
    this.myFp    = myFp;
    this.send    = sendFn;
    this.onClose = onCloseFn;

    this.mySlot  = null;  // 1=bottom, 2=top
    this.state   = 'waiting';
    this._invited= false;
    this._dom    = null;
    this._canvas = null;
    this._ctx    = null;
    this._raf    = null;
    this._syncT  = 0;
    this._inputX = AH_W/2;
    this._inputY = AH_H*3/4;
    this._dragging=false;

    // Game state (both devices run same simulation)
    this.ball  = {x:AH_W/2, y:AH_H/2, vx:2, vy:3};
    this.p1    = {x:AH_W/2, y:AH_H-50};   // bottom
    this.p2    = {x:AH_W/2, y:50};          // top
    this.score = {p1:0, p2:0};
    this.maxScore = 7;
    this._gameOver=false;
  }

  handleMsg(msg) {
    const {action}=msg;
    if (action==='invite') { this._invited=true; this.mySlot=2; this.state='waiting'; this._draw(); }
    else if (action==='accept') { this.mySlot=1; this.state='active'; this._startLoop(); this._draw(); }
    else if (action==='state') {
      // Remote sends their paddle + ball position
      if (this.mySlot===1) {
        this.p2.x=msg.px; this.p2.y=msg.py;
        if (msg.ball) { this.ball.x=msg.ball.x; this.ball.y=msg.ball.y; this.ball.vx=msg.ball.vx; this.ball.vy=msg.ball.vy; }
        if (msg.score) { this.score=msg.score; }
      } else {
        this.p1.x=msg.px; this.p1.y=msg.py;
      }
    }
    else if (action==='goal') { this.score=msg.score; this._checkOver(); }
    else if (action==='reset') { this._resetBall(); }
    else if (action==='resign') { this.state='done'; this._draw(); this._stopLoop(); }
  }

  _accept() {
    this.mySlot=2; this.state='active';
    this.send({gameType:'airh',action:'accept'});
    this._startLoop(); this._draw();
  }

  _startLoop() {
    if (this._raf) return;
    const loop = (ts) => {
      this._raf = requestAnimationFrame(loop);
      if (this.state!=='active') return;
      this._updateBall();
      this._drawFrame();
      if (ts - this._syncT > AH_SYNC_MS) {
        this._syncT=ts;
        const myP = this.mySlot===1 ? this.p1 : this.p2;
        const msg = {gameType:'airh',action:'state',px:myP.x,py:myP.y};
        // Player 1 (bottom) is authoritative for ball physics
        if (this.mySlot===1) {
          msg.ball={x:this.ball.x,y:this.ball.y,vx:this.ball.vx,vy:this.ball.vy};
          msg.score=this.score;
        }
        this.send(msg);
      }
    };
    this._raf = requestAnimationFrame(loop);
  }

  _stopLoop() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf=null; }
  }

  _updateBall() {
    if (this.mySlot!==1) return; // only p1 runs physics
    const b=this.ball;
    b.x+=b.vx; b.y+=b.vy;
    // Wall bounce
    if (b.x-AH_BR<0) { b.x=AH_BR; b.vx=Math.abs(b.vx); }
    if (b.x+AH_BR>AH_W) { b.x=AH_W-AH_BR; b.vx=-Math.abs(b.vx); }
    // Paddle collisions
    if (ahCirclesCollide(b.x,b.y,AH_BR,this.p1.x,this.p1.y,AH_PR)) {
      [b.vx,b.vy]=ahReflect(b.vx,b.vy,this.p1.x,this.p1.y,b.x,b.y);
      const spd=Math.hypot(b.vx,b.vy); b.vx=b.vx/spd*Math.min(spd*1.05,12); b.vy=b.vy/spd*Math.min(spd*1.05,12);
      b.x+=b.vx*2; b.y+=b.vy*2;
    }
    if (ahCirclesCollide(b.x,b.y,AH_BR,this.p2.x,this.p2.y,AH_PR)) {
      [b.vx,b.vy]=ahReflect(b.vx,b.vy,this.p2.x,this.p2.y,b.x,b.y);
      const spd=Math.hypot(b.vx,b.vy); b.vx=b.vx/spd*Math.min(spd*1.05,12); b.vy=b.vy/spd*Math.min(spd*1.05,12);
      b.x+=b.vx*2; b.y+=b.vy*2;
    }
    // Goals
    if (b.y-AH_BR<0) {
      if (Math.abs(b.x-AH_W/2)<AH_GW) { this.score.p1++; this._onGoal(); return; }
      b.y=AH_BR; b.vy=Math.abs(b.vy);
    }
    if (b.y+AH_BR>AH_H) {
      if (Math.abs(b.x-AH_W/2)<AH_GW) { this.score.p2++; this._onGoal(); return; }
      b.y=AH_H-AH_BR; b.vy=-Math.abs(b.vy);
    }
  }

  _onGoal() {
    this.send({gameType:'airh',action:'goal',score:this.score});
    this._checkOver();
    if (!this._gameOver) { setTimeout(()=>{ this._resetBall(); this.send({gameType:'airh',action:'reset'}); },1200); }
  }

  _checkOver() {
    if (this.score.p1>=this.maxScore||this.score.p2>=this.maxScore) {
      this._gameOver=true; this.state='done'; this._stopLoop(); this._draw();
    }
  }

  _resetBall() {
    const angle=(Math.random()*Math.PI/2+Math.PI/4)*(Math.random()<.5?1:-1);
    const spd=4;
    this.ball={x:AH_W/2,y:AH_H/2,vx:Math.cos(angle)*spd,vy:Math.sin(angle)*spd};
  }

  _drawFrame() {
    const cv=this._canvas, ctx=this._ctx; if(!cv||!ctx) return;
    const dpr=window.devicePixelRatio||1;
    // Background
    ctx.fillStyle='#040a09'; ctx.fillRect(0,0,cv.width,cv.height);
    const sx=cv.width/(AH_W*dpr)*AH_W, sy=cv.height/(AH_H*dpr)*AH_H;
    ctx.save(); ctx.scale(cv.width/(AH_W),cv.height/(AH_H));

    // Field
    ctx.strokeStyle='rgba(64,224,208,.15)'; ctx.lineWidth=1;
    ctx.strokeRect(1,1,AH_W-2,AH_H-2);
    ctx.beginPath(); ctx.moveTo(0,AH_H/2); ctx.lineTo(AH_W,AH_H/2); ctx.stroke();
    ctx.beginPath(); ctx.arc(AH_W/2,AH_H/2,40,0,Math.PI*2); ctx.stroke();

    // Goals
    const gx1=AH_W/2-AH_GW, gx2=AH_W/2+AH_GW;
    ctx.fillStyle='rgba(64,224,208,.08)';
    ctx.fillRect(gx1,0,AH_GW*2,8);
    ctx.fillRect(gx1,AH_H-8,AH_GW*2,8);
    ctx.strokeStyle='rgba(64,224,208,.4)'; ctx.lineWidth=2;
    ctx.strokeRect(gx1,0,AH_GW*2,8);
    ctx.strokeRect(gx1,AH_H-8,AH_GW*2,8);

    // Paddles
    const drawPaddle=(x,y,mine)=>{
      ctx.beginPath(); ctx.arc(x,y,AH_PR,0,Math.PI*2);
      ctx.fillStyle=mine?'rgba(64,224,208,.25)':'rgba(107,255,123,.2)';
      ctx.fill();
      ctx.strokeStyle=mine?'#40e0d0':'#6bff7b'; ctx.lineWidth=2; ctx.stroke();
    };
    const iBottom=this.mySlot===1;
    drawPaddle(this.p1.x,this.p1.y,iBottom);
    drawPaddle(this.p2.x,this.p2.y,!iBottom);

    // Ball
    ctx.beginPath(); ctx.arc(this.ball.x,this.ball.y,AH_BR,0,Math.PI*2);
    ctx.fillStyle='rgba(255,255,255,.9)'; ctx.fill();
    ctx.strokeStyle='rgba(64,224,208,.6)'; ctx.lineWidth=2; ctx.stroke();

    ctx.restore();
  }

  render(container) { this._dom=container; this._draw(); }

  _draw() {
    const c=this._dom; if(!c) return;
    if (this.state==='waiting'&&this._invited) {
      c.innerHTML=`<div class="tqapp-airh">
        <div class="tqapp-hdr"><span>◉ air hockey</span></div>
        <div class="ta-invite"><div class="ta-inv-text">air hockey challenge</div>
        <div class="ta-btns">
          <div class="ta-btn accept" id="ah-acc">accept</div>
          <div class="ta-btn danger" id="ah-dec">decline</div>
        </div></div></div>`;
      c.querySelector('#ah-acc')?.addEventListener('click',()=>this._accept());
      c.querySelector('#ah-dec')?.addEventListener('click',()=>{this.send({gameType:'airh',action:'resign'});this.onClose?.();});
      return;
    }
    if (this.state==='waiting') {
      c.innerHTML=`<div class="tqapp-airh"><div class="tqapp-hdr"><span>◉ air hockey</span></div><div class="ta-status">waiting for opponent…</div></div>`;
      return;
    }
    if (this.state==='done') {
      const won=this.score.p1>=this.maxScore?(this.mySlot===1):(this.mySlot===2);
      const draw=this.score.p1===this.score.p2;
      c.innerHTML=`<div class="tqapp-airh">
        <div class="tqapp-hdr"><span>◉ air hockey</span><span class="tqapp-sym">${this.score.p1}–${this.score.p2}</span></div>
        <div class="ta-status ${draw?'ta-draw':won?'ta-win':'ta-loss'}">${draw?'draw':won?'you win!':'you lose'}
          <div class="ta-btns" style="margin-top:5px">
            <div class="ta-btn danger" id="ah-close">close</div>
          </div></div></div>`;
      c.querySelector('#ah-close')?.addEventListener('click',()=>this.onClose?.());
      return;
    }
    // Active — build canvas if needed
    if (!this._canvas) {
      c.innerHTML=`<div class="tqapp-airh">
        <div class="tqapp-hdr"><span>◉ air hockey</span><span class="tqapp-sym" id="ah-score">${this.score.p1}–${this.score.p2}</span></div>
        <div class="ah-field"><canvas id="ah-canvas"></canvas></div>
        <div class="ta-status" id="ah-side" style="font-size:9px;color:var(--dim);margin-top:3px">you: ${this.mySlot===1?'bottom (teal)':'top (green)'}</div>
        <div class="ta-btns"><div class="ta-btn danger" id="ah-resign">resign</div></div>
      </div>`;
      this._canvas=c.querySelector('#ah-canvas');
      this._ctx=this._canvas.getContext('2d');
      this._resizeCanvas();
      this._bindInput();
      c.querySelector('#ah-resign')?.addEventListener('click',()=>{ this.send({gameType:'airh',action:'resign'}); this.state='done'; this._stopLoop(); this._draw(); });
    }
    // Update score display
    const sc=c.querySelector('#ah-score'); if(sc) sc.textContent=`${this.score.p1}–${this.score.p2}`;
  }

  _resizeCanvas() {
    const cv=this._canvas; if(!cv) return;
    const w=Math.min(cv.parentElement?.clientWidth||320,320);
    const dpr=window.devicePixelRatio||1;
    cv.width=w*dpr; cv.height=w*(AH_H/AH_W)*dpr;
    cv.style.width=w+'px'; cv.style.height=(w*(AH_H/AH_W))+'px';
  }

  _bindInput() {
    const cv=this._canvas; if(!cv) return;
    const pos=(e)=>{
      const r=cv.getBoundingClientRect();
      const src=e.touches?e.touches[0]:e;
      const rx=(src.clientX-r.left)/r.width*AH_W;
      const ry=(src.clientY-r.top)/r.height*AH_H;
      const p=this.mySlot===1?this.p1:this.p2;
      // Constrain to own half
      p.x=ahClamp(rx,AH_PR,AH_W-AH_PR);
      p.y=ahClamp(ry, this.mySlot===1?AH_H/2+AH_PR:AH_PR, this.mySlot===1?AH_H-AH_PR:AH_H/2-AH_PR);
    };
    cv.addEventListener('mousemove',e=>{ if(this.state==='active') pos(e); });
    cv.addEventListener('touchmove',e=>{ if(this.state==='active'){e.preventDefault();pos(e);} },{passive:false});
  }

  destroy() { this._stopLoop(); this._canvas=null; this._ctx=null; this._dom=null; }
}

// Update registry
REGISTRY.find(r => r.id === 'ttt').cls   = TicTacToe;
REGISTRY.find(r => r.id === 'sps').cls   = StonePaperScissors;
REGISTRY.find(r => r.id === 'chess').cls = Chess;
REGISTRY.find(r => r.id === 'airh').cls  = AirHockey;
REGISTRY.find(r => r.id === 'memo').cls  = VoiceMemo;
