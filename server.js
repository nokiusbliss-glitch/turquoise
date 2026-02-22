/**
 * server.js — Turquoise (Render Production Version)
 *
 * - Serves /public over HTTP
 * - WebSocket signaling relay for WebRTC
 * - Render provides HTTPS automatically
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');

// IMPORTANT: Render injects PORT automatically
const PORT = process.env.PORT || 3000;

if (!fs.existsSync(PUBLIC)) {
  console.error(`❌ /public folder not found at: ${PUBLIC}`);
  process.exit(1);
}

// ── MIME TYPES ─────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
};

// ── HTTP FILE SERVER ───────────────────────────────────────

const server = http.createServer((req, res) => {
  try {
    const url = (!req.url || req.url === '/') ? '/index.html' : req.url;
    const filePath = path.normalize(path.join(PUBLIC, url));

    if (!filePath.startsWith(PUBLIC)) {
      res.writeHead(403);
      res.end();
      return;
    }

    const ext = path.extname(filePath);

    try {
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'text/plain',
      });
      res.end(fs.readFileSync(filePath));
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  } catch {
    res.writeHead(500);
    res.end();
  }
});

// ── WEBSOCKET SIGNALING SERVER ─────────────────────────────

const wss = new WebSocketServer({ server });
const peers = new Map();

wss.on('connection', (ws) => {
  let myFp = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (!msg || typeof msg !== 'object') return;

    // New peer announces itself
    if (msg.type === 'announce' && typeof msg.from === 'string') {
      myFp = msg.from;
      peers.set(myFp, ws);

      console.log(`+ ${myFp.slice(0, 8)} (${peers.size} online)`);

      // Send existing peers to new peer
      for (const [fp] of peers) {
        if (fp !== myFp) {
          ws.send(JSON.stringify({
            type: 'peer',
            fingerprint: fp,
          }));
        }
      }
      return;
    }

    // Direct message
    if (msg.to) {
      const target = peers.get(msg.to);
      if (target?.readyState === 1) {
        target.send(raw.toString());
      }
      return;
    }

    // Broadcast fallback
    for (const [fp, peer] of peers) {
      if (fp !== myFp && peer.readyState === 1) {
        peer.send(raw.toString());
      }
    }
  });

  ws.on('close', () => {
    if (myFp) {
      peers.delete(myFp);
      console.log(`- ${myFp.slice(0, 8)} (${peers.size} online)`);
    }
  });
});

// ── START SERVER ───────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`🚀 Turquoise running on port ${PORT}`);
});
