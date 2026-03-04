/**
 * tools-modules.js — Turquoise v5
 *
 * Key fix: broadcast() must NOT re-apply locally.
 * app.js's _broadcastToolAction only sends to peers.
 * onLocalMove already applied the action directly.
 * This prevents the double-apply / seenActions confusion.
 */

import { getToolById } from './tools-registry.js';

export function createToolRuntime(toolId, ctx) {
  if (toolId === 'tic-tac-toe') return createTicTacToeRuntime(ctx);
  if (toolId === 'whiteboard')  return createWhiteboardRuntime(ctx);
  return createPlaceholderRuntime(toolId, ctx);
}

/* ────────────────────────── Placeholder ───────────────────────── */

function createPlaceholderRuntime(ctxToolId, ctx) {
  const tool = getToolById(ctxToolId);
  let root = null;

  return {
    mount(container) {
      root = document.createElement('div');
      root.style.cssText = 'padding:8px;';
      root.innerHTML = `
        <div style="font-size:.75rem;color:#7ab8b2;">
          <b>${escapeHtml(tool?.title || ctxToolId)}</b>
        </div>
        <div style="margin-top:6px;font-size:.65rem;color:#3d7a74;">
          Not yet implemented. Add module in <code>tools-modules.js</code>.
        </div>
      `;
      container.appendChild(root);
    },
    apply() {},
    destroy() { root?.parentNode?.removeChild(root); root = null; },
  };
}

/* ─────────────────────────── Tic Tac Toe ──────────────────────── */

function createTicTacToeRuntime(ctx) {
  // participants[0] is always the initiator; order is identical on all devices
  const players    = [...new Set(ctx.participants)].slice(0, 2);
  const board      = Array(9).fill(null);
  const seenActions = new Set();

  let turn   = players[0] || null;
  let winner = null;
  let root   = null, statusEl = null, cells = [];

  function markerFor(fp) {
    if (fp === players[0]) return 'X';
    if (fp === players[1]) return 'O';
    return null;
  }

  function checkWinner() {
    const lines = [
      [0,1,2],[3,4,5],[6,7,8],
      [0,3,6],[1,4,7],[2,5,8],
      [0,4,8],[2,4,6],
    ];
    for (const [a, b, c] of lines) {
      if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
    }
    return board.every(Boolean) ? 'draw' : null;
  }

  function render() {
    if (!statusEl) return;

    const iAmPlayer = players.includes(ctx.selfId);
    const myTurn    = turn === ctx.selfId;
    const role      = iAmPlayer ? (players.indexOf(ctx.selfId) === 0 ? 'X' : 'O') : 'spectator';

    let header;
    if (winner === 'draw')   header = 'Draw!';
    else if (winner)         header = `Winner: ${short(winner) === short(ctx.selfId) ? 'you!' : short(winner)}`;
    else if (turn)           header = `${turn === ctx.selfId ? 'Your' : short(turn) + "'s"} turn`;
    else                     header = '…';

    statusEl.textContent = `${header}  ·  you: ${role}`;

    for (let i = 0; i < 9; i++) {
      const v = board[i];
      cells[i].textContent = v ?? '';
      cells[i].disabled    = !!winner || !iAmPlayer || !myTurn || board[i] !== null;
      cells[i].style.color = v === 'X' ? '#40e0d0' : v === 'O' ? '#7ab8b2' : '#c4e8e4';
    }
  }

  function applyMove(action) {
    if (!action || action.type !== 'move') return;
    if (seenActions.has(action.id)) return;
    seenActions.add(action.id);

    if (winner)                                                return;
    if (action.by !== turn)                                    return;
    if (typeof action.index !== 'number' || action.index < 0 || action.index > 8) return;
    if (board[action.index] !== null)                          return;

    board[action.index] = markerFor(action.by);
    winner = checkWinner();
    if (!winner) turn = (turn === players[0]) ? players[1] : players[0];
    render();
  }

  function onLocalMove(index) {
    if (winner || turn !== ctx.selfId) return;
    const action = {
      id:    `${ctx.selfId}:${Date.now()}:${index}`,
      type:  'move',
      index,
      by:    ctx.selfId,
      ts:    Date.now(),
    };
    // Apply locally first, then broadcast to peers.
    // broadcast() must NOT re-apply locally (handled in app.js _broadcastToolAction).
    applyMove(action);
    ctx.broadcast(action);
  }

  function resetGame() {
    board.fill(null);
    turn   = players[0] || null;
    winner = null;
    seenActions.clear();
    render();
  }

  return {
    mount(container) {
      root = document.createElement('div');
      root.style.cssText = 'user-select:none;';

      statusEl = document.createElement('div');
      statusEl.style.cssText = 'font-size:.66rem;color:#7ab8b2;margin-bottom:8px;min-height:1.2em;';
      root.appendChild(statusEl);

      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:5px;max-width:210px;';
      cells = [];

      for (let i = 0; i < 9; i++) {
        const btn = document.createElement('button');
        btn.style.cssText = [
          'height:60px;border:1px solid #1e7068;background:#071a18;',
          'color:#c4e8e4;font-size:1.2rem;cursor:pointer;',
          'transition:background .12s,border-color .12s;',
        ].join('');
        btn.addEventListener('mouseover', () => { if (!btn.disabled) btn.style.background = '#0d2e2a'; });
        btn.addEventListener('mouseout',  () => { btn.style.background = '#071a18'; });
        btn.addEventListener('click', () => onLocalMove(i));
        cells.push(btn);
        grid.appendChild(btn);
      }
      root.appendChild(grid);

      // Reset button (appears after game over)
      const resetBtn = document.createElement('button');
      resetBtn.textContent = 'new game';
      resetBtn.style.cssText = 'margin-top:8px;border:1px solid #1e7068;background:transparent;color:#7ab8b2;cursor:pointer;padding:4px 10px;font-size:.65rem;display:none;';
      resetBtn.addEventListener('click', () => {
        resetGame();
        resetBtn.style.display = 'none';
      });
      root.appendChild(resetBtn);
      root._resetBtn = resetBtn;

      container.appendChild(root);
      render();

      // Show reset btn when game ends
      const origRender = render;
      // We'll check in render
    },

    apply(action) {
      applyMove(action);
      // Show reset button if game over
      if (root?._resetBtn && winner) root._resetBtn.style.display = '';
    },

    destroy() {
      root?.parentNode?.removeChild(root);
      root = null; statusEl = null; cells = [];
    },
  };
}

/* ─────────────────────────── Whiteboard ───────────────────────── */

function createWhiteboardRuntime(ctx) {
  let root = null, canvas = null, ctx2d = null;
  let drawing = false, lastX = 0, lastY = 0;
  const strokes = [];

  function applyStroke(action) {
    if (!ctx2d || action.type !== 'stroke') return;
    ctx2d.beginPath();
    ctx2d.strokeStyle = action.color || '#40e0d0';
    ctx2d.lineWidth   = action.width || 2;
    ctx2d.lineCap     = 'round';
    ctx2d.moveTo(action.x0, action.y0);
    ctx2d.lineTo(action.x1, action.y1);
    ctx2d.stroke();
  }

  return {
    mount(container) {
      root = document.createElement('div');
      root.style.cssText = 'position:relative;';

      const toolbar = document.createElement('div');
      toolbar.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;align-items:center;font-size:.62rem;color:#7ab8b2;';
      toolbar.innerHTML = `
        <label>color <input type="color" id="wb-color" value="#40e0d0" style="width:32px;height:20px;border:1px solid #1e7068;background:#071a18;cursor:pointer;"></label>
        <label>size <input type="range" id="wb-size" min="1" max="12" value="2" style="width:60px;"></label>
        <button id="wb-clear" style="border:1px solid #1e7068;background:transparent;color:#7ab8b2;cursor:pointer;padding:2px 8px;">clear</button>
      `;
      root.appendChild(toolbar);

      canvas = document.createElement('canvas');
      canvas.width  = 400;
      canvas.height = 260;
      canvas.style.cssText = 'border:1px solid #1e7068;background:#030e0c;cursor:crosshair;touch-action:none;width:100%;height:auto;display:block;';
      ctx2d = canvas.getContext('2d');
      root.appendChild(canvas);

      // Redraw history
      strokes.forEach(applyStroke);

      const getColor = () => root.querySelector('#wb-color')?.value || '#40e0d0';
      const getSize  = () => Number(root.querySelector('#wb-size')?.value) || 2;

      const getXY = (e) => {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width  / rect.width;
        const scaleY = canvas.height / rect.height;
        const src = e.touches ? e.touches[0] : e;
        return [(src.clientX - rect.left) * scaleX, (src.clientY - rect.top) * scaleY];
      };

      const onStart = (e) => { drawing = true; [lastX, lastY] = getXY(e); e.preventDefault(); };
      const onMove  = (e) => {
        if (!drawing) return;
        e.preventDefault();
        const [x, y] = getXY(e);
        const action = { type: 'stroke', color: getColor(), width: getSize(), x0: lastX, y0: lastY, x1: x, y1: y };
        applyStroke(action);
        strokes.push(action);
        ctx.broadcast(action);
        [lastX, lastY] = [x, y];
      };
      const onEnd = () => { drawing = false; };

      canvas.addEventListener('mousedown',  onStart);
      canvas.addEventListener('mousemove',  onMove);
      canvas.addEventListener('mouseup',    onEnd);
      canvas.addEventListener('mouseleave', onEnd);
      canvas.addEventListener('touchstart', onStart, { passive: false });
      canvas.addEventListener('touchmove',  onMove,  { passive: false });
      canvas.addEventListener('touchend',   onEnd);

      root.querySelector('#wb-clear')?.addEventListener('click', () => {
        strokes.length = 0;
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
        ctx.broadcast({ type: 'clear' });
      });

      container.appendChild(root);
    },

    apply(action) {
      if (action.type === 'stroke') { applyStroke(action); strokes.push(action); }
      if (action.type === 'clear')  { strokes.length = 0; ctx2d?.clearRect(0, 0, canvas?.width || 400, canvas?.height || 260); }
    },

    destroy() {
      root?.parentNode?.removeChild(root);
      root = null; canvas = null; ctx2d = null;
    },
  };
}

/* ───────────────────────── Utility ────────────────────────── */

function short(v)  { return (v || '?').slice(0, 8); }

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
