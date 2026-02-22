/**
 * server.js — Turquoise (Production · Render-Ready)
 *
 * Jobs:
 *   1. Serve /public over HTTP (Render provides HTTPS automatically)
 *   2. WebSocket signaling relay for WebRTC peer discovery
 *   3. Heartbeat ping/pong to detect dead connections before Render's
 *      load balancer does — prevents ghost peers in the registry
 *
 * Murphy's Law: every code path has a fallback. Nothing crashes the process.
 * Da Vinci: minimum viable signaling — no state, no storage, pure relay.
 */

import http          from 'http';
import fs            from 'fs';
import path          from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC    = path.join(__dirname, 'public');
const PORT      = process.env.PORT || 3000;

// ── Verify public folder exists ───────────────────────────────────────────────

if (!fs.existsSync(PUBLIC)) {
  console.error(`❌ /public not found at: ${PUBLIC}`);
  process.exit(1);
}

// ── MIME types ────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.css':  'text/css',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.woff2':'font/woff2',
};

// ── Static file server (async reads — never blocks event loop) ────────────────

function serveStatic(req, res) {
  const raw      = req.url.split('?')[0]; // strip query strings
  const urlPath  = (!raw || raw === '/') ? '/index.html' : raw;
  const filePath = path.normalize(path.join(PUBLIC, urlPath));

  // Block path traversal
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403); res.end(); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Serve index.html for any unresolved path (SPA fallback)
      fs.readFile(path.join(PUBLIC, 'index.html'), (err2, fallback) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fallback);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type':  MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);

// ── WebSocket signaling relay ─────────────────────────────────────────────────
// noServer: true + explicit upgrade handler = proxy-safe on Render
// Without this, Render's load balancer can silently drop upgrade requests

const wss   = new WebSocketServer({ noServer: true });
const peers = new Map(); // fingerprint → { ws, nickname, alive }

// Upgrade handling — explicit for Render proxy compatibility
server.on('upgrade', (req, socket, head) => {
  try {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } catch (e) {
    console.error('Upgrade error:', e.message);
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  let myFp = null;

  // Heartbeat state
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (rawBuf) => {
    let raw, msg;
    try {
      raw = rawBuf.toString();
      msg = JSON.parse(raw);
    } catch { return; }

    if (!msg || typeof msg !== 'object') return;

    // ── Peer announces itself ──
    if (msg.type === 'announce' && typeof msg.from === 'string') {
      myFp = msg.from;
      peers.set(myFp, { ws, nickname: msg.nickname || null, alive: true });
      console.log(`  + ${myFp.slice(0, 8)} "${msg.nickname || '?'}"  (${peers.size} online)`);

      // Send list of existing peers to newcomer
      for (const [fp, peer] of peers) {
        if (fp !== myFp) {
          try {
            ws.send(JSON.stringify({
              type:        'peer',
              fingerprint: fp,
              nickname:    peer.nickname,
            }));
          } catch {}
        }
      }
      return;
    }

    // ── Nickname update broadcast ──
    if (msg.type === 'nickname-update' && myFp) {
      const peer = peers.get(myFp);
      if (peer) peer.nickname = msg.nickname;

      // Broadcast to all others
      for (const [fp, p] of peers) {
        if (fp !== myFp && p.ws.readyState === 1) {
          try {
            p.ws.send(JSON.stringify({
              type:        'nickname-update',
              fingerprint: myFp,
              nickname:    msg.nickname,
            }));
          } catch {}
        }
      }
      return;
    }

    // ── Direct relay: to one specific peer ──
    if (msg.to && typeof msg.to === 'string') {
      const target = peers.get(msg.to);
      if (target?.ws.readyState === 1) {
        try { target.ws.send(raw); } catch {}
      }
      return;
    }

    // ── Broadcast relay: to all other peers ──
    for (const [fp, p] of peers) {
      if (fp !== myFp && p.ws.readyState === 1) {
        try { p.ws.send(raw); } catch {}
      }
    }
  });

  ws.on('close', () => {
    if (myFp) {
      peers.delete(myFp);
      console.log(`  - ${myFp.slice(0, 8)}  (${peers.size} online)`);

      // Notify remaining peers of departure
      for (const [, p] of peers) {
        if (p.ws.readyState === 1) {
          try {
            p.ws.send(JSON.stringify({ type: 'peer-left', fingerprint: myFp }));
          } catch {}
        }
      }
    }
  });

  ws.on('error', () => {
    try { ws.close(); } catch {}
  });
});

// ── Heartbeat: ping all peers every 30s, kill dead connections ────────────────
// Render's load balancer has a 60s idle timeout.
// We ping every 30s so connections never look idle to the proxy.

const heartbeat = setInterval(() => {
  for (const [fp, peer] of peers) {
    if (!peer.ws.isAlive) {
      peer.ws.terminate();
      peers.delete(fp);
      console.log(`  ☠ ${fp.slice(0, 8)} timed out (${peers.size} online)`);
      continue;
    }
    peer.ws.isAlive = false;
    try { peer.ws.ping(); } catch {}
  }
}, 30_000);

wss.on('close', () => clearInterval(heartbeat));

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n🌊 Turquoise running on port ${PORT}\n`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

const shutdown = () => {
  clearInterval(heartbeat);
  server.close(() => process.exit(0));
};
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException',  (e) => { console.error('Uncaught:', e.message); });
process.on('unhandledRejection', (r) => { console.error('Unhandled:', r);        });
