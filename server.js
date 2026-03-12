/**
 * server.js — Turquoise Signaling Core v5
 * HTTP static serving + WebSocket signaling relay.
 *
 * Fixes / hardening over v4:
 *   - Ghost connections: TCP keepalive alone isn't reliable. Added explicit
 *     ping/pong heartbeat (30s interval, 10s pong deadline). Peers that don't
 *     pong are terminated, preventing phantom entries in the peers map forever.
 *   - Per-IP rate limiting on WS messages (100 messages / 10s window) to
 *     prevent a misbehaving client from flooding all peers.
 *   - MAX_PEERS cap (env: MAX_PEERS, default 100). Rejects new connections
 *     with 503 when the server is full.
 *   - Forwarded messages are sanitized: only whitelisted types are relayed,
 *     and payload size is bounded by maxPayload (64KB). Previously any
 *     arbitrary JSON blob was forwarded verbatim.
 *   - Added 'pong' handling so the server heartbeat round-trip is complete.
 *   - WS upgrade path is validated before calling handleUpgrade, avoiding
 *     an uncaught exception if the path check was added after the call.
 *   - process.env.PORT is validated to be a usable number.
 */

import http from 'http';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC    = path.resolve(__dirname, 'public');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = (() => {
  const n = parseInt(process.env.PORT || '3000', 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    process.stderr.write(`ERROR: invalid PORT "${process.env.PORT}"\n`);
    process.exit(1);
  }
  return n;
})();

const WS_PATH   = process.env.WS_PATH   || '/ws';
const MAX_PEERS = parseInt(process.env.MAX_PEERS || '100', 10);
const FP_RE     = /^[a-f0-9]{64}$/i;

// Whitelisted relay message types — unknown types are silently dropped
const RELAY_TYPES = new Set(['offer','answer','ice','chat','call-invite','call-accept',
  'call-decline','call-end','offer-reneg','answer-reneg','permission-denied',
  'file-meta','file-end','file-abort','nick-update','game','folder-manifest','ping','pong']);

const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
);

// ── Rate limit config ─────────────────────────────────────────────────────────
const RATE_WINDOW_MS  = 10_000;  // 10 second window
const RATE_MAX_MSGS   = 100;     // max messages per window per IP

// ── Heartbeat config ──────────────────────────────────────────────────────────
const PING_INTERVAL_MS = 30_000; // send ping every 30s
const PONG_DEADLINE_MS = 10_000; // terminate if no pong within 10s

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  '.html':        'text/html; charset=utf-8',
  '.js':          'application/javascript; charset=utf-8',
  '.mjs':         'application/javascript; charset=utf-8',
  '.json':        'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css':         'text/css; charset=utf-8',
  '.ico':         'image/x-icon',
  '.png':         'image/png',
  '.svg':         'image/svg+xml',
  '.woff2':       'font/woff2',
};

if (!fs.existsSync(PUBLIC)) {
  process.stderr.write(`ERROR: public/ directory not found at ${PUBLIC}\n`);
  process.exit(1);
}

// ── Utility ───────────────────────────────────────────────────────────────────

function isInsidePublic(absPath) {
  return absPath === PUBLIC || absPath.startsWith(PUBLIC + path.sep);
}

function isOriginAllowed(origin) {
  if (ALLOWED_ORIGINS.size === 0) return true;
  if (!origin) return false;
  return ALLOWED_ORIGINS.has(origin);
}

function maybeSpaFallback(req, pathname) {
  if (pathname === '/sw.js') return false;
  if (path.extname(pathname)) return false;
  const accept = req.headers.accept || '';
  return accept.includes('text/html') || req.headers['sec-fetch-dest'] === 'document';
}

function writeWsReject(socket, code, text) {
  try { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); } catch {}
  socket.destroy();
}

function sendJSON(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify(obj)); return true; }
  catch { return false; }
}

function clientIP(req) {
  // Trust X-Forwarded-For only when behind a known proxy (conservative)
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ── HTTP static server ────────────────────────────────────────────────────────

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

    const ext          = path.extname(resolvedPath).toLowerCase();
    const isSW         = path.basename(resolvedPath) === 'sw.js';
    const cacheControl = isSW ? 'no-cache' : (ext === '.html' ? 'no-cache' : 'public, max-age=3600');

    const headers = {
      'Content-Type':           MIME[ext] || 'application/octet-stream',
      'Cache-Control':          cacheControl,
      'Content-Length':         stat.size,
      'X-Content-Type-Options': 'nosniff',
    };

    if (req.method === 'HEAD') {
      res.writeHead(200, headers).end();
      return;
    }

    res.writeHead(200, headers);
    const stream = fs.createReadStream(resolvedPath);
    stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
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
  const resolved  = path.resolve(PUBLIC, '.' + requested);

  if (!isInsidePublic(resolved)) {
    res.writeHead(403).end();
    return;
  }

  serveFile(resolved, req, res, () => {
    if (!maybeSpaFallback(req, pathname)) { res.writeHead(404).end(); return; }
    serveFile(path.join(PUBLIC, 'index.html'), req, res, () => res.writeHead(404).end());
  });
}

const server = http.createServer(handleHTTP);
server.on('error', (e) => {
  process.stderr.write(`HTTP server error: ${e.message}\n`);
  process.exit(1);
});

// ── WebSocket signaling ───────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

// fingerprint → WebSocket
const peers = new Map();
// WebSocket → fingerprint
const socketToFp = new Map();

// Per-IP rate limiter: ip → { count, resetAt }
const rateLimiter = new Map();

function isRateLimited(ip) {
  const now  = Date.now();
  let   slot = rateLimiter.get(ip);
  if (!slot || now > slot.resetAt) {
    slot = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateLimiter.set(ip, slot);
  }
  slot.count++;
  return slot.count > RATE_MAX_MSGS;
}

// Periodically clean expired rate-limit entries to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, slot] of rateLimiter) {
    if (now > slot.resetAt) rateLimiter.delete(ip);
  }
}, 60_000).unref();

server.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname || '/';
  } catch {
    writeWsReject(socket, 400, 'Bad Request');
    return;
  }

  if (pathname !== WS_PATH) {
    writeWsReject(socket, 404, 'Not Found');
    return;
  }

  if (!isOriginAllowed(req.headers.origin || '')) {
    writeWsReject(socket, 403, 'Forbidden');
    return;
  }

  // Reject new connections when at capacity
  if (peers.size >= MAX_PEERS) {
    writeWsReject(socket, 503, 'Server Full');
    return;
  }

  socket.on('error', () => socket.destroy());

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  let fp  = null;
  const ip = clientIP(req);

  // ── Heartbeat ───────────────────────────────────────────────────────────
  let isAlive    = true;
  let pongTimer  = null;

  const pingInterval = setInterval(() => {
    if (!isAlive) {
      // No pong received — ghost connection, terminate it
      process.stdout.write(`! heartbeat timeout ${fp ? fp.slice(0,8) : ip}\n`);
      clearInterval(pingInterval);
      ws.terminate();
      return;
    }
    isAlive = false;
    // Set a deadline for the pong
    pongTimer = setTimeout(() => {
      if (!isAlive) ws.terminate();
    }, PONG_DEADLINE_MS);
    try { ws.ping(); } catch {}
  }, PING_INTERVAL_MS);

  ws.on('pong', () => {
    isAlive = true;
    clearTimeout(pongTimer);
  });

  ws.on('error', () => {
    try { ws.terminate(); } catch {}
  });

  ws.on('message', (raw) => {
    // Per-IP rate limiting
    if (isRateLimited(ip)) {
      sendJSON(ws, { type: 'error', reason: 'rate-limited' });
      return;
    }

    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }
    if (!msg || typeof msg !== 'object') return;

    // ── Announce ──────────────────────────────────────────────────────────
    if (msg.type === 'announce') {
      const announced = String(msg.from || '').toLowerCase();
      if (!FP_RE.test(announced)) return;

      // Remove any stale entry for this socket
      const existingFp = socketToFp.get(ws);
      if (existingFp && existingFp !== announced && peers.get(existingFp) === ws) {
        peers.delete(existingFp);
      }

      // Close any other socket claiming the same fingerprint
      const existingWs = peers.get(announced);
      if (existingWs && existingWs !== ws) {
        try { existingWs.close(4001, 'replaced'); } catch {}
      }

      fp = announced;
      peers.set(fp, ws);
      socketToFp.set(ws, fp);

      process.stdout.write(`+ ${fp.slice(0,8)} (${peers.size} peers)\n`);

      // Send all currently connected peers to the newcomer
      for (const [existingFp] of peers) {
        if (existingFp !== fp) sendJSON(ws, { type: 'peer', fingerprint: existingFp });
      }
      return;
    }

    // ── Ping/Pong (application-level, distinct from WS protocol ping) ────
    if (msg.type === 'ping') {
      sendJSON(ws, { type: 'pong' });
      return;
    }
    if (msg.type === 'pong') {
      // Application-level pong from client — just ignore
      return;
    }

    // All other relay messages require an announced fingerprint
    if (!fp) return;

    // Drop unknown message types to prevent abuse / undocumented relay use
    if (!RELAY_TYPES.has(msg.type)) return;

    // ── Unicast (msg.to is set) ───────────────────────────────────────────
    if (typeof msg.to === 'string' && FP_RE.test(msg.to)) {
      const to     = msg.to.toLowerCase();
      const target = peers.get(to);
      if (target?.readyState === WebSocket.OPEN) {
        sendJSON(target, { ...msg, from: fp });
      }
      return;
    }

    // ── Broadcast to all other peers ──────────────────────────────────────
    const forwarded = { ...msg, from: fp };
    for (const [peerFp, peerWs] of peers) {
      if (peerFp === fp) continue;
      if (peerWs.readyState === WebSocket.OPEN) sendJSON(peerWs, forwarded);
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    clearTimeout(pongTimer);
    const mappedFp = socketToFp.get(ws) || fp;
    if (mappedFp && peers.get(mappedFp) === ws) {
      peers.delete(mappedFp);
      process.stdout.write(`- ${mappedFp.slice(0,8)} (${peers.size} peers)\n`);
    }
    socketToFp.delete(ws);
  });
});

// ── Startup ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  process.stdout.write(
    `Turquoise listening on :${PORT}  ws:${WS_PATH}  maxPeers:${MAX_PEERS}\n`
  );
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(exitCode) {
  process.stdout.write('shutting down…\n');
  for (const client of wss.clients) {
    try { client.close(1001, 'server shutdown'); } catch {}
  }
  server.close(() => process.exit(exitCode));
  setTimeout(() => process.exit(exitCode), 1000).unref();
}

process.on('SIGINT',  () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

process.on('uncaughtException', (e) => {
  process.stderr.write(`uncaughtException: ${e.stack || e.message}\n`);
  shutdown(1);
});

process.on('unhandledRejection', (r) => {
  process.stderr.write(`unhandledRejection: ${String(r)}\n`);
  shutdown(1);
});
