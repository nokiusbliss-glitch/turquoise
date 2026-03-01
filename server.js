/**
 * server.js — Turquoise Signaling Core
 * Render-ready: HTTP file server + WebSocket signaling relay
 * Murphy's Law: every failure path explicit, no silent crashes
 */

import http from 'http';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC    = path.join(__dirname, 'public');
const PORT      = parseInt(process.env.PORT || '3000', 10);

// ── Validate environment ───────────────────────────────────────────────────────
if (!fs.existsSync(PUBLIC)) {
  process.stderr.write(`❌ /public not found at ${PUBLIC}\n`);
  process.exit(1);
}

// ── MIME ──────────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css':  'text/css',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.woff2':'font/woff2',
};

// ── HTTP handler ──────────────────────────────────────────────────────────────
function handleHTTP(req, res) {
  // Only GET/HEAD
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end(); return;
  }

  const raw  = (req.url || '/').split('?')[0];
  const reqPath = raw === '/' ? '/index.html' : raw;

  let filePath;
  try {
    filePath = path.normalize(path.join(PUBLIC, reqPath));
  } catch {
    res.writeHead(400); res.end(); return;
  }

  // Path traversal guard
  if (!filePath.startsWith(PUBLIC + path.sep) && filePath !== PUBLIC) {
    res.writeHead(403); res.end(); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // SPA fallback
        fs.readFile(path.join(PUBLIC, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
          res.end(d2);
        });
      } else {
        res.writeHead(500); res.end();
      }
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type':  MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(handleHTTP);

server.on('error', (e) => {
  process.stderr.write(`❌ HTTP error: ${e.message}\n`);
  process.exit(1);
});

// ── WebSocket signaling (noServer = explicit upgrade handling) ─────────────────
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// ── Peer registry ─────────────────────────────────────────────────────────────
const peers = new Map(); // fingerprint → WebSocket

wss.on('connection', (ws) => {
  let fp = null;

  ws.on('error', () => { ws.terminate(); });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    // Announce: peer registers itself
    if (msg.type === 'announce' && typeof msg.from === 'string' && msg.from.length === 64) {
      fp = msg.from;
      peers.set(fp, ws);
      process.stdout.write(`+ ${fp.slice(0,8)} (${peers.size})\n`);

      // Notify newcomer of existing peers
      for (const [existing] of peers) {
        if (existing !== fp) {
          try { ws.send(JSON.stringify({ type: 'peer', fingerprint: existing })); } catch {}
        }
      }
      return;
    }

    // Relay: forward to named target
    if (msg.to && typeof msg.to === 'string') {
      const target = peers.get(msg.to);
      if (target?.readyState === 1) {
        try { target.send(raw.toString()); } catch {}
      }
      return;
    }

    // Broadcast: forward to all except sender
    if (fp) {
      for (const [pfp, peer] of peers) {
        if (pfp !== fp && peer.readyState === 1) {
          try { peer.send(raw.toString()); } catch {}
        }
      }
    }
  });

  ws.on('close', () => {
    if (fp) {
      peers.delete(fp);
      process.stdout.write(`- ${fp.slice(0,8)} (${peers.size})\n`);
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  process.stdout.write(`🚀 Turquoise — port ${PORT}\n`);
});

process.on('SIGINT',  () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('uncaughtException',  (e) => { process.stderr.write(`❌ ${e.message}\n`); process.exit(1); });
process.on('unhandledRejection', (r) => { process.stderr.write(`❌ ${r}\n`); process.exit(1); });
