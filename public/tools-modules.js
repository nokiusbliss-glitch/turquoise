import { getToolById } from './tools-registry.js';

export function createToolRuntime(toolId, ctx) {
  if (toolId === 'tic-tac-toe') return createTicTacToeRuntime(ctx);
  return createPlaceholderRuntime(toolId, ctx);
}

function createPlaceholderRuntime(ctxToolId, ctx) {
  const tool = getToolById(ctxToolId);
  let root = null;

  return {
    mount(container) {
      root = document.createElement('div');
      root.innerHTML = `
        <div style="font-size:.75rem;color:#7ab8b2;">
          <b>${escapeHtml(tool?.title || ctxToolId)}</b> is registered but not implemented yet.
        </div>
        <div style="margin-top:6px;font-size:.65rem;color:#3d7a74;">
          Add implementation in <code>tools-modules.js</code> only.
        </div>
      `;
      container.appendChild(root);
    },
    apply() {},
    destroy() {
      if (root?.parentNode) root.parentNode.removeChild(root);
      root = null;
    },
  };
}

function createTicTacToeRuntime(ctx) {
  const players = [...new Set(ctx.participants)].slice(0, 2);
  const board = Array(9).fill(null);
  const seenActions = new Set();
  let turn = players[0] || null;
  let winner = null;
  let root = null;
  let statusEl = null;
  let cells = [];

  function render() {
    if (!statusEl) return;
    const iAmPlayer = players.includes(ctx.selfId);
    const myTurn = turn === ctx.selfId;
    const role = iAmPlayer ? (players.indexOf(ctx.selfId) === 0 ? 'X' : 'O') : 'spectator';
    const header = winner
      ? (winner === 'draw' ? 'Draw' : `Winner: ${short(winner)}`)
      : `Turn: ${turn ? short(turn) : '-'}`;

    statusEl.textContent = `${header} | you: ${role}${iAmPlayer ? (myTurn ? ' | your move' : ' | wait') : ''}`;

    for (let i = 0; i < 9; i += 1) {
      const v = board[i];
      cells[i].textContent = v === null ? '' : v;
      cells[i].disabled = !!winner || !iAmPlayer || !myTurn || board[i] !== null;
    }
  }

  function markerFor(fp) {
    if (fp === players[0]) return 'X';
    if (fp === players[1]) return 'O';
    return null;
  }

  function evaluate() {
    const lines = [
      [0,1,2],[3,4,5],[6,7,8],
      [0,3,6],[1,4,7],[2,5,8],
      [0,4,8],[2,4,6],
    ];
    for (const [a,b,c] of lines) {
      if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
    }
    if (board.every(Boolean)) return 'draw';
    return null;
  }

  function applyMove(action) {
    if (!action || action.type !== 'move') return;
    if (seenActions.has(action.id)) return;
    seenActions.add(action.id);

    if (winner) return;
    if (action.by !== turn) return;
    if (typeof action.index !== 'number' || action.index < 0 || action.index > 8) return;
    if (board[action.index] !== null) return;

    board[action.index] = markerFor(action.by);
    winner = evaluate();
    if (!winner) {
      turn = turn === players[0] ? players[1] : players[0];
    }
    render();
  }

  function onLocalMove(index) {
    if (winner || turn !== ctx.selfId) return;
    const action = {
      id: `${ctx.selfId}:${Date.now()}:${index}`,
      type: 'move',
      index,
      by: ctx.selfId,
      ts: Date.now(),
    };
    applyMove(action);
    ctx.broadcast(action);
  }

  return {
    mount(container) {
      root = document.createElement('div');
      statusEl = document.createElement('div');
      statusEl.style.cssText = 'font-size:.65rem;color:#7ab8b2;margin-bottom:8px;';
      root.appendChild(statusEl);

      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:6px;max-width:220px;';
      cells = [];

      for (let i = 0; i < 9; i += 1) {
        const b = document.createElement('button');
        b.style.cssText = 'height:56px;border:1px solid #1e7068;background:#0a2320;color:#c4e8e4;font-size:1rem;cursor:pointer;';
        b.addEventListener('click', () => onLocalMove(i));
        cells.push(b);
        grid.appendChild(b);
      }

      root.appendChild(grid);
      container.appendChild(root);
      render();
    },
    apply(action) {
      applyMove(action);
    },
    destroy() {
      if (root?.parentNode) root.parentNode.removeChild(root);
      root = null;
      statusEl = null;
      cells = [];
    },
  };
}

function short(v) {
  return (v || '?').slice(0, 8);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
