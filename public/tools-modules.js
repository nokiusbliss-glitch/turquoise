/**
 * tools-modules.js — Turquoise v7
 *
 * Fixes carried forward from v5/v6 + new:
 *   - TicTacToe: seenActions never cleared on reset (was a double-reset bug)
 *   - TicTacToe: dead code `const origRender = render` removed
 *   - Whiteboard: MAX_STROKES splice corrected (was off-by-one)
 *   - broadcast() never re-applies locally — contract documented
 *   - New: tool containers now use the design system's clip-path aesthetic
 *   - Smaller: ~35% reduction via consolidation
 */

import { getToolById } from './tools-registry.js?tqv=20260411c';

export function createToolRuntime(toolId, ctx) {
  if (toolId === 'tic-tac-toe') return _ttt(ctx);
  if (toolId === 'whiteboard')  return _wb(ctx);
  return _placeholder(toolId, ctx);
}

// ── Placeholder ───────────────────────────────────────────────────────────────

function _placeholder(toolId, ctx) {
  const tool = getToolById(toolId);
  let root = null;
  return {
    mount(c) {
      root = _div('padding:8px;font-size:.72rem;color:var(--dim)');
      root.innerHTML = `<b style="color:var(--tq)">${esc(tool?.title||toolId)}</b><br><span style="color:var(--mute)">not yet implemented</span>`;
      c.appendChild(root);
    },
    apply() {},
    destroy() { root?.remove(); root=null; },
  };
}

// ── Tic-Tac-Toe ───────────────────────────────────────────────────────────────

function _ttt(ctx) {
  const players = [...new Set(ctx.participants)].slice(0,2);
  const board   = Array(9).fill(null);
  const seen    = new Set();   // never cleared — prevents double-apply of reset

  let turn=players[0]||null, winner=null, winLine=null;
  let root=null, statusEl=null, cells=[], resetBtn=null;

  const marker = fp => fp===players[0]?'X':fp===players[1]?'O':null;
  const myMark = marker(ctx.selfId);

  function checkWin() {
    const lines=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    for (const [a,b,c] of lines) if (board[a]&&board[a]===board[b]&&board[a]===board[c]) return {mark:board[a],line:[a,b,c]};
    return board.every(Boolean) ? {mark:'draw',line:null} : null;
  }

  function render() {
    if (!statusEl) return;
    const iAm  = players.includes(ctx.selfId);
    const myTurn = turn===ctx.selfId;
    const role   = iAm ? (players.indexOf(ctx.selfId)===0?'X':'O') : 'spectator';

    let hdr = winner ? (winner==='draw'?'Draw!':`${winner===myMark?'You win!':short(turn)+" wins"}`) : (turn ? `${myTurn?'your':''+short(turn)+"'s"} turn` : '…');
    statusEl.textContent = `${hdr}  ·  you: ${role}`;

    cells.forEach((btn,i)=>{
      const v=board[i];
      btn.textContent = v||'';
      btn.disabled    = !!winner||!iAm||!myTurn||v!==null;
      btn.style.color = v==='X'?'var(--tq)':v==='O'?'var(--ug)':'var(--dim)';
      btn.style.borderColor = winLine?.includes(i)?'var(--tq)':'var(--mute)';
    });
    if (resetBtn) resetBtn.style.display = winner ? '' : 'none';
  }

  function applyAction(action) {
    if (!action) return;
    if (action.type==='reset') {
      if (seen.has(action.id)) return; seen.add(action.id);
      board.fill(null); turn=players[0]||null; winner=null; winLine=null; render(); return;
    }
    if (action.type!=='move') return;
    if (seen.has(action.id)) return; seen.add(action.id);
    if (winner||action.by!==turn||typeof action.index!=='number'||action.index<0||action.index>8||board[action.index]!==null) return;
    board[action.index] = marker(action.by);
    const w = checkWin();
    if (w) { winner=w.mark; winLine=w.line; } else turn=turn===players[0]?players[1]:players[0];
    render();
  }

  function localMove(i) {
    if (winner||turn!==ctx.selfId) return;
    const a={id:`${ctx.selfId}:${Date.now()}:${i}`,type:'move',index:i,by:ctx.selfId,ts:Date.now()};
    applyAction(a); ctx.broadcast(a);
  }
  function localReset() {
    const a={id:`reset:${ctx.selfId}:${Date.now()}`,type:'reset',by:ctx.selfId,ts:Date.now()};
    applyAction(a); ctx.broadcast(a);
  }

  return {
    mount(container) {
      root = _div('user-select:none');
      statusEl = _div('font-size:.66rem;color:var(--tq2);margin-bottom:8px;min-height:1.2em;');
      root.appendChild(statusEl);

      const grid = _div('display:grid;grid-template-columns:repeat(3,1fr);gap:4px;max-width:190px;');
      cells = Array.from({length:9}, (_,i) => {
        const btn = document.createElement('button');
        btn.style.cssText = 'height:56px;border:1px solid var(--mute);background:var(--bg1);font-size:1.1rem;cursor:pointer;clip-path:polygon(0 0,calc(100%-6px) 0,100% 6px,100% 100%,6px 100%,0 calc(100%-6px));transition:background .1s';
        btn.addEventListener('mouseover', ()=>{if(!btn.disabled)btn.style.background='var(--bg2)';});
        btn.addEventListener('mouseout',  ()=>btn.style.background='var(--bg1)');
        btn.addEventListener('click', ()=>localMove(i));
        grid.appendChild(btn); return btn;
      });
      root.appendChild(grid);

      resetBtn = document.createElement('button');
      resetBtn.textContent='new game';
      resetBtn.style.cssText='margin-top:6px;border:1px solid var(--mute);background:transparent;color:var(--dim);cursor:pointer;padding:3px 10px;font-size:.65rem;font-family:inherit;clip-path:polygon(0 0,calc(100%-5px) 0,100% 5px,100% 100%,5px 100%,0 calc(100%-5px));display:none';
      resetBtn.addEventListener('click', localReset);
      root.appendChild(resetBtn);
      container.appendChild(root); render();
    },
    apply(a)  { applyAction(a); },
    destroy() { root?.remove(); root=null; statusEl=null; cells=[]; resetBtn=null; },
  };
}

// ── Whiteboard ────────────────────────────────────────────────────────────────

const MAX_STROKES = 2000;

function _wb(ctx) {
  let root=null, canvas=null, ctx2d=null, drawing=false, lx=0, ly=0;
  const strokes = [];

  function drawStroke(a) {
    if (!ctx2d||a.type!=='stroke') return;
    ctx2d.beginPath(); ctx2d.strokeStyle=a.color||'var(--tq)'; ctx2d.lineWidth=a.width||2; ctx2d.lineCap='round';
    ctx2d.moveTo(a.x0,a.y0); ctx2d.lineTo(a.x1,a.y1); ctx2d.stroke();
  }
  function pushStroke(a) {
    strokes.push(a);
    if (strokes.length > MAX_STROKES) strokes.splice(0, strokes.length - MAX_STROKES);
  }

  return {
    mount(container) {
      root = _div('position:relative');

      // Toolbar
      const tb = _div('display:flex;gap:6px;margin-bottom:5px;align-items:center;font-size:.62rem;color:var(--dim);flex-wrap:wrap');
      tb.innerHTML = `
        <label>color <input type="color" id="wb-color" value="#40e0d0" style="width:28px;height:18px;border:1px solid var(--mute);background:var(--bg1);cursor:pointer;vertical-align:middle"></label>
        <label>size&nbsp;<input type="range" id="wb-size" min="1" max="12" value="2" style="width:52px;vertical-align:middle"></label>
        <button id="wb-clear" style="border:1px solid var(--mute);background:transparent;color:var(--dim);cursor:pointer;padding:2px 8px;font-size:.62rem;font-family:inherit;clip-path:polygon(0 0,calc(100%-4px) 0,100% 4px,100% 100%,4px 100%,0 calc(100%-4px))">clear</button>`;
      root.appendChild(tb);

      canvas=document.createElement('canvas'); canvas.width=400; canvas.height=260;
      canvas.style.cssText='border:1px solid var(--mute);background:var(--bg0);cursor:crosshair;touch-action:none;width:100%;height:auto;display:block;clip-path:polygon(0 0,calc(100%-10px) 0,100% 10px,100% 100%,10px 100%,0 calc(100%-10px))';
      ctx2d=canvas.getContext('2d');
      root.appendChild(canvas);
      strokes.forEach(drawStroke); // redraw for late joiners

      const color = ()=>root.querySelector('#wb-color')?.value||'#40e0d0';
      const size  = ()=>+(root.querySelector('#wb-size')?.value)||2;
      const xy    = e => { const r=canvas.getBoundingClientRect(); const src=e.touches?e.touches[0]:e; return [(src.clientX-r.left)*canvas.width/r.width,(src.clientY-r.top)*canvas.height/r.height]; };

      const onStart = e=>{drawing=true;[lx,ly]=xy(e);e.preventDefault();};
      const onMove  = e=>{
        if(!drawing) return; e.preventDefault();
        const [x,y]=xy(e);
        const a={type:'stroke',color:color(),width:size(),x0:lx,y0:ly,x1:x,y1:y};
        drawStroke(a); pushStroke(a); ctx.broadcast(a);
        [lx,ly]=[x,y];
      };
      const onEnd = ()=>{drawing=false;};

      canvas.addEventListener('mousedown',onStart); canvas.addEventListener('mousemove',onMove);
      canvas.addEventListener('mouseup',onEnd);     canvas.addEventListener('mouseleave',onEnd);
      canvas.addEventListener('touchstart',onStart,{passive:false}); canvas.addEventListener('touchmove',onMove,{passive:false}); canvas.addEventListener('touchend',onEnd);

      root.querySelector('#wb-clear')?.addEventListener('click',()=>{
        strokes.length=0; ctx2d.clearRect(0,0,canvas.width,canvas.height);
        ctx.broadcast({type:'clear'});
      });
      container.appendChild(root);
    },
    apply(a) {
      if (a.type==='stroke')  { drawStroke(a); pushStroke(a); }
      if (a.type==='clear')   { strokes.length=0; ctx2d?.clearRect(0,0,canvas?.width||400,canvas?.height||260); }
    },
    destroy() { root?.remove(); root=null; canvas=null; ctx2d=null; },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const _div  = css => { const d=document.createElement('div'); d.style.cssText=css; return d; };
const short = v   => (v||'?').slice(0,8);
const esc   = s   => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
