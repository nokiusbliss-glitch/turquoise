/**
 * server.js — Turquoise Signaling Core (hardened)
 * HTTP static serving + WebSocket signaling relay.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, 'public');
const PORT = parseInt(process.env.PORT || '3000', 10);
const WS_PATH = process.env.WS_PATH || '/ws';
const FP_RE = /^[a-f0-9]{64}$/i;

const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

if (!fs.existsSync(PUBLIC)) {
  process.stderr.write(`ERROR: /public not found at ${PUBLIC}\n`);
  process.exit(1);
}

function isInsidePublic(absPath) {
  return absPath === PUBLIC || absPath.startsWith(PUBLIC + path.sep);
}

function isOriginAllowed(origin) {
  if (ALLOWED_ORIGINS.size === 0) return true;
  if (!origin) return false;
  return ALLOWED_ORIGINS.has(origin);
}

function maybeSpaFallback(req, originalPathname) {
  if (originalPathname === '/sw.js') return false;
  if (path.extname(originalPathname)) return false;
  const accept = req.headers.accept || '';
  return accept.includes('text/html') || req.headers['sec-fetch-dest'] === 'document';
}

function writeWsReject(socket, code, text) {
  try {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
  } catch {}
  socket.destroy();
}

function sendJSON(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function serveFile(resolvedPath, req, res, onNotFound) {
  fs.stat(resolvedPath, (err, stat) => {
    if (err) {
      if (err.code === 'ENOENT') return onNotFound();
      res.writeHead(500).end();
      return;
    }

    if (stat.isDirectory()) {
      return serveFile(path.join(resolvedPath, 'index.html'), req, res, onNotFound);
    }

    if (!stat.isFile()) {
      res.writeHead(404).end();
      return;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const cacheControl = path.basename(resolvedPath) === 'sw.js'
      ? 'no-cache'
      : (ext === '.html' ? 'no-cache' : 'public, max-age=3600');

    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      'Content-Length': stat.size,
      'X-Content-Type-Options': 'nosniff',
    };

    if (req.method === 'HEAD') {
      res.writeHead(200, headers).end();
      return;
    }

    res.writeHead(200, headers);
    const stream = fs.createReadStream(resolvedPath);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    stream.pipe(res);
  });
}

function handleHTTP(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }

  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname || '/');
  } catch {
    res.writeHead(400).end();
    return;
  }

  const requested = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.resolve(PUBLIC, '.' + requested);

  if (!isInsidePublic(resolved)) {
    res.writeHead(403).end();
    return;
  }

  serveFile(resolved, req, res, () => {
    if (!maybeSpaFallback(req, pathname)) {
      res.writeHead(404).end();
      return;
    }
    serveFile(path.join(PUBLIC, 'index.html'), req, res, () => res.writeHead(404).end());
  });
}

const server = http.createServer(handleHTTP);
server.on('error', (e) => {
  process.stderr.write(`HTTP error: ${e.message}\n`);
  process.exit(1);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

// fingerprint -> ws
const peers = new Map();
// ws -> fingerprint
const socketToFingerprint = new Map();

server.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname || '/';
  } catch {
    writeWsReject(socket, 400, 'Bad Request');
    return;
  }

  if (!(pathname === WS_PATH || (WS_PATH === '/' && pathname === '/'))) {
    writeWsReject(socket, 404, 'Not Found');
    return;
  }

  if (!isOriginAllowed(req.headers.origin || '')) {
    writeWsReject(socket, 403, 'Forbidden');
    return;
  }

  socket.on('error', () => socket.destroy());

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  let fp = null;

  ws.on('error', () => {
    try { ws.terminate(); } catch {}
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'announce') {
      const announced = String(msg.from || '').toLowerCase();
      if (!FP_RE.test(announced)) return;

      const existingFp = socketToFingerprint.get(ws);
      if (existingFp && existingFp !== announced && peers.get(existingFp) === ws) {
        peers.delete(existingFp);
      }

      const existingWs = peers.get(announced);
      if (existingWs && existingWs !== ws) {
        try { existingWs.close(4001, 'replaced'); } catch {}
      }

      fp = announced;
      peers.set(fp, ws);
      socketToFingerprint.set(ws, fp);

      process.stdout.write(`+ ${fp.slice(0, 8)} (${peers.size})\n`);

      for (const [existing] of peers) {
        if (existing !== fp) sendJSON(ws, { type: 'peer', fingerprint: existing });
      }
      return;
    }

    if (!fp) return;

    if (typeof msg.to === 'string' && FP_RE.test(msg.to)) {
      const to = msg.to.toLowerCase();
      const target = peers.get(to);
      if (target && target.readyState === WebSocket.OPEN) {
        const forwarded = { ...msg, from: fp };
        sendJSON(target, forwarded);
      }
      return;
    }

    const forwarded = { ...msg, from: fp };
    for (const [peerFp, peerWs] of peers) {
      if (peerFp === fp) continue;
      if (peerWs.readyState === WebSocket.OPEN) {
        sendJSON(peerWs, forwarded);
      }
    }
  });

  ws.on('close', () => {
    const mappedFp = socketToFingerprint.get(ws) || fp;
    if (mappedFp && peers.get(mappedFp) === ws) {
      peers.delete(mappedFp);
      process.stdout.write(`- ${mappedFp.slice(0, 8)} (${peers.size})\n`);
    }
    socketToFingerprint.delete(ws);
  });
});

server.listen(PORT, () => {
  process.stdout.write(`Turquoise listening on port ${PORT} (ws path: ${WS_PATH})\n`);
});

function shutdown(exitCode) {
  for (const client of wss.clients) {
    try { client.close(1001, 'server shutdown'); } catch {}
  }
  server.close(() => process.exit(exitCode));
  setTimeout(() => process.exit(exitCode), 500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (e) => {
  process.stderr.write(`uncaughtException: ${e.message}\n`);
  shutdown(1);
});
process.on('unhandledRejection', (r) => {
  process.stderr.write(`unhandledRejection: ${String(r)}\n`);
  shutdown(1);
});
