/**
 * server.js — Turquoise Cloud Signaling (Render)
 *
 * Minimal Node.js WebSocket signaling relay.
 * Stores peer announcements. Relays offers/answers/ICE.
 * Heartbeat prevents ghost peers.
 *
 * Never touches message content.
 * No auth — identity is cryptographic (handled client-side).
 *
 * Deploy: Render free tier, node server.js, port from PORT env.
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const PORT = process.env.PORT || 3000;

// ── HTTP server ───────────────────────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405); res.end(); return;
  }

  let filePath;
  if (req.url === '/' || req.url === '/index.html') {
    filePath = join('public', 'index.html');
  } else {
    filePath = join('public', req.url.split('?')[0]);
  }

  if (!existsSync(filePath)) {
    res.writeHead(404); res.end('Not found'); return;
  }

  const ext = filePath.split('.').pop();
  const types = {
    html: 'text/html', js: 'application/javascript',
    json: 'application/json', css: 'text/css',
    png: 'image/png', ico: 'image/x-icon',
    webmanifest: 'application/manifest+json',
  };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  res.end(readFileSync(filePath));
});

// ── WebSocket (noServer: true — required for Render reverse proxy) ────────────

const wss = new WebSocketServer({ noServer: true });

// Peer registry: fingerprint → ws
const peers = new Map();

httpServer.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// ── Heartbeat — prevent ghost peers ──────────────────────────────────────────

const HEARTBEAT_INTERVAL = 30_000;

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.fingerprint = null;
});

const heartbeat = setInterval(() => {
  for (const [fp, ws] of peers) {
    if (!ws.isAlive) {
      ws.terminate();
      peers.delete(fp);
      broadcast({ type: 'peer-left', fingerprint: fp });
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_INTERVAL);

wss.on('close', () => clearInterval(heartbeat));

// ── Message routing ───────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    const { type, from, to } = msg;

    if (type === 'announce') {
      if (!from) return;
      ws.fingerprint = from;
      peers.set(from, ws);

      // Tell this peer about existing peers
      for (const [fp, peer] of peers) {
        if (fp !== from && peer.readyState === 1) {
          safeSend(ws, { type: 'peer', fingerprint: fp });
          // Tell existing peer about this newcomer
          safeSend(peer, { type: 'peer', fingerprint: from, nickname: msg.nickname });
        }
      }
      return;
    }

    if (type === 'nickname-update') {
      broadcast(msg, ws);
      return;
    }

    // Directed message (offer/answer/ice/call-*)
    if (to) {
      const target = peers.get(to);
      if (target && target.readyState === 1) {
        safeSend(target, msg);
      }
      return;
    }

    // Broadcast (anything without 'to')
    broadcast(msg, ws);
  });

  ws.on('close', () => {
    if (ws.fingerprint) {
      peers.delete(ws.fingerprint);
      broadcast({ type: 'peer-left', fingerprint: ws.fingerprint });
    }
  });

  ws.on('error', (e) => {
    console.error('[WS] error:', e.message);
  });
});

function safeSend(ws, msg) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(msg)); } catch {}
}

function broadcast(msg, exclude) {
  const packet = JSON.stringify(msg);
  for (const ws of peers.values()) {
    if (ws !== exclude && ws.readyState === 1) {
      try { ws.send(packet); } catch {}
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`🚀 Turquoise signaling on port ${PORT}`);
});

process.on('uncaughtException',  (e) => console.error('[Fatal]', e));
process.on('unhandledRejection', (e) => console.error('[Fatal]', e));
