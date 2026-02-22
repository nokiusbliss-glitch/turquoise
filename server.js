/**
 * server.js — Turquoise v7
 *
 * Roles:
 *   1. Serve /public as HTTP static files
 *   2. WebSocket signaling: peer discovery + relay
 *   3. Heartbeat every 25s to survive Render's 60s idle timeout
 *
 * Murphy's Law: every code path handles its own failure.
 *               Process never crashes on bad client data.
 */

import http             from 'http';
import fs               from 'fs';
import path             from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC    = path.join(__dirname, 'public');
const PORT      = process.env.PORT || 3000;

if (!fs.existsSync(PUBLIC)) {
  console.error('❌  /public missing:', PUBLIC);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.css':  'text/css',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp',
};

// ── Static HTTP ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const raw  = (req.url || '/').split('?')[0];
  const url  = raw === '/' ? '/index.html' : raw;
  const fp   = path.normalize(path.join(PUBLIC, url));

  // Path traversal guard
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }

  fs.readFile(fp, (err, data) => {
    if (err) {
      // SPA fallback — always serve index.html for unknown routes
      fs.readFile(path.join(PUBLIC, 'index.html'), (err2, fb) => {
        if (err2) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(fb);
      });
      return;
    }
    const ext = path.extname(fp).toLowerCase();
    const ct  = MIME[ext] || 'application/octet-stream';
    const cc  = ext === '.html' ? 'no-cache' : 'public, max-age=86400';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': cc });
    res.end(data);
  });
});

// ── WebSocket signaling ───────────────────────────────────────────────────────
// noServer + explicit upgrade = survives Render's reverse proxy
const wss   = new WebSocketServer({ noServer: true });
const peers = new Map(); // fingerprint → { ws, nickname, isAlive }

server.on('upgrade', (req, socket, head) => {
  try {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } catch (e) {
    console.error('Upgrade error:', e.message);
    socket.destroy();
  }
});

wss.on('connection', ws => {
  let myFp = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let msg, str;
    try { str = raw.toString(); msg = JSON.parse(str); }
    catch { return; }
    if (!msg || typeof msg !== 'object') return;

    // ── Announce: peer joins ──
    if (msg.type === 'announce' && typeof msg.from === 'string') {
      myFp = msg.from;
      peers.set(myFp, { ws, nickname: msg.nickname || null, isAlive: true });
      console.log(`+ ${myFp.slice(0,8)} "${msg.nickname||''}" (${peers.size} online)`);

      // Send existing peers to newcomer
      for (const [fp, p] of peers) {
        if (fp !== myFp) {
          try { ws.send(JSON.stringify({ type:'peer', fingerprint:fp, nickname:p.nickname })); } catch {}
        }
      }
      // Notify everyone of newcomer
      for (const [fp, p] of peers) {
        if (fp !== myFp && p.ws.readyState === 1) {
          try { p.ws.send(JSON.stringify({ type:'peer', fingerprint:myFp, nickname:msg.nickname||null })); } catch {}
        }
      }
      return;
    }

    // ── Nickname broadcast ──
    if (msg.type === 'nick' && myFp) {
      const p = peers.get(myFp);
      if (p) p.nickname = msg.nickname;
      for (const [fp, p] of peers) {
        if (fp !== myFp && p.ws.readyState === 1) {
          try { p.ws.send(JSON.stringify({ type:'nick', fingerprint:myFp, nickname:msg.nickname })); } catch {}
        }
      }
      return;
    }

    // ── Targeted relay (WebRTC: offer/answer/ice/renegotiate-*) ──
    if (msg.to) {
      const t = peers.get(msg.to);
      if (t?.ws.readyState === 1) try { t.ws.send(str); } catch {}
      return;
    }

    // ── Broadcast (group messages, nick updates) ──
    for (const [fp, p] of peers) {
      if (fp !== myFp && p.ws.readyState === 1) try { p.ws.send(str); } catch {}
    }
  });

  ws.on('close', () => {
    if (!myFp) return;
    peers.delete(myFp);
    console.log(`- ${myFp.slice(0,8)} (${peers.size} online)`);
    for (const [, p] of peers) {
      if (p.ws.readyState === 1) {
        try { p.ws.send(JSON.stringify({ type:'peer-left', fingerprint:myFp })); } catch {}
      }
    }
  });

  ws.on('error', () => { try { ws.close(); } catch {} });
});

// ── Heartbeat (prevents Render 60s idle disconnect) ───────────────────────────
const hb = setInterval(() => {
  for (const [fp, p] of peers) {
    if (!p.ws.isAlive) {
      p.ws.terminate(); peers.delete(fp);
      console.log(`☠ ${fp.slice(0,8)} heartbeat timeout (${peers.size} online)`);
      continue;
    }
    p.ws.isAlive = false;
    try { p.ws.ping(); } catch {}
  }
}, 25_000);

wss.on('close', () => clearInterval(hb));

server.listen(PORT, () => {
  console.log(`\n🌊  Turquoise v7 · port ${PORT}\n`);
});

process.on('SIGINT',  () => { clearInterval(hb); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { clearInterval(hb); server.close(() => process.exit(0)); });
process.on('uncaughtException',  e => console.error('Uncaught:', e.message));
process.on('unhandledRejection', r => console.error('Unhandled:', r));
