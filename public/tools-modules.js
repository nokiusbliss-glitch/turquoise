import { getToolById } from './tools-registry.js';

export function createToolRuntime(toolId, ctx) {
  if (toolId === 'tic-tac-toe') return createTicTacToeRuntime(ctx);
  return createPlaceholderRuntime(toolId);
}

function createPlaceholderRuntime(toolId) {
  let root = null;
  const tool = getToolById(toolId);

  return {
    mount(container) {
      root = document.createElement('div');
      root.innerHTML = `
        <div style="font-size:.75rem;color:#7ab8b2;">
          <b>${escapeHtml(tool?.title || toolId)}</b> is registered but not implemented yet.
        </div>
      `;
      container.appendChild(root);
    },
    apply() {},
    destroy() {
      if (root?.parentNode) root.parentNode.removeChild(root);
    },
  };
}

function createTicTacToeRuntime(ctx) {
  const players = [...new Set(ctx.participants)].slice(0, 2);
  const board = Array(9).fill(null);
  const seen = new Set();
  let turn = players[0] || null;
  let winner = null;
  let statusEl = null;
  let cells = [];
  let root = null;

  function markerFor(fp) {
    if (fp === players[0]) return 'X';
    if (fp === players[1]) return 'O';
    return null;
  }

  function evalWinner() {
    const l = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    for (const [a,b,c] of l) if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
    if (board.every(Boolean)) return 'draw';
    return null;
  }

  function render() {
    const iAmPlayer = players.includes(ctx.selfId);
    const myTurn = turn === ctx.selfId;
    const role = iAmPlayer ? (players.indexOf(ctx.selfId) === 0 ? 'X' : 'O') : 'spectator';
    statusEl.textContent = winner
      ? (winner === 'draw' ? 'Draw' : `Winner: ${winner}`)
      : `Turn: ${turn ? turn.slice(0,8) : '-'} | you: ${role}${iAmPlayer && myTurn ? ' | your move' : ''}`;

    for (let i = 0; i < 9; i += 1) {
      cells[i].textContent = board[i] || '';
      cells[i].disabled = !!winner || !iAmPlayer || !myTurn || board[i] !== null;
    }
  }

  function apply(action) {
    if (!action || action.type !== 'move' || seen.has(action.id)) return;
    seen.add(action.id);
    if (winner || action.by !== turn || board[action.index] !== null) return;

    board[action.index] = markerFor(action.by);
    winner = evalWinner();
    if (!winner) turn = turn === players[0] ? players[1] : players[0];
    render();
  }

  function onMove(i) {
    if (turn !== ctx.selfId || winner) return;
    const action = { id: `${ctx.selfId}:${Date.now()}:${i}`, type: 'move', index: i, by: ctx.selfId };
    apply(action);
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
        b.addEventListener('click', () => onMove(i));
        cells.push(b);
        grid.appendChild(b);
      }

      root.appendChild(grid);
      container.appendChild(root);
      render();
    },
    apply,
    destroy() {
      if (root?.parentNode) root.parentNode.removeChild(root);
    },
  };
}

function escapeHtml(s) {
  return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;");
}
