/**
 * server.js — Turquoise Signaling Core v6
 * HTTP static serving + WebSocket signaling relay.
 *
 * ── Changes from v5 ──────────────────────────────────────────────────────────
 *
 * RELAY TYPES: added 'p2p-relay' to RELAY_TYPES so the offline mesh
 *   signaling (webrtc.js _sig() P2P fallback) works when the server is present.
 *
 * NICK-INDEX: the server now tracks fp → nick so when a newcomer arrives
 *   we can send full peer entries including nicks, reducing the "?" display
 *   that previously required a round-trip hello exchange.
 *
 * GRACEFUL MAX_PEERS: instead of hard-reject at MAX_PEERS, a configurable
 *   SOFT_MAX_PEERS (default 80) triggers a warning log; at MAX_PEERS (100)
 *   we reject with 503.
 *
 * RATE LIMIT TUNING: raised to 200 msgs / 10s (was 100) to accommodate
 *   folder transfers with many file-meta ctrl messages.
 *
 * LOGGING: structured stdout lines for each key event, parseable by log
 *   aggregators: timestamp | event | fp | peer-count | details
 *
 * MEMORY LEAK: rate-limiter cleanup was every 60s but the map could grow
 *   unboundedly between cleanups if IPs are spoofed. Added size cap (MAX_RATE_ENTRIES).
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

const WS_PATH        = process.env.WS_PATH        || '/ws';
const MAX_PEERS      = parseInt(process.env.MAX_PEERS  || '100', 10);
const SOFT_MAX_PEERS = Math.floor(MAX_PEERS * 0.8);     // warn threshold
const FP_RE          = /^[a-f0-9]{64}$/i;

// Whitelisted relay message types — unknown types are silently dropped
const RELAY_TYPES = new Set([
  'offer', 'answer', 'ice', 'chat',
  'call-invite', 'call-accept', 'call-decline', 'call-end',
  'offer-reneg', 'answer-reneg', 'permission-denied',
  'file-meta', 'file-end', 'file-abort',
  'nick-update', 'game', 'folder-manifest',
  'ping', 'pong',
  'p2p-relay',   // NEW: offline mesh forwarding
]);

const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
);

// ── Rate limit config ─────────────────────────────────────────────────────────
const RATE_WINDOW_MS   = 10_000;
const RATE_MAX_MSGS    = 200;         // raised from 100 (folder transfers are chatty)
const MAX_RATE_ENTRIES = 5_000;       // cap map size to prevent spoofed-IP memory leak

// ── Heartbeat config ──────────────────────────────────────────────────────────
const PING_INTERVAL_MS = 30_000;
const PONG_DEADLINE_MS = 10_000;

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

// ── Structured logger ─────────────────────────────────────────────────────────
function slog(event, data = {}) {
  const ts = new Date().toISOString();
  const parts = [ts, event];
  for (const [k, v] of Object.entries(data)) parts.push(`${k}=${v}`);
  process.stdout.write(parts.join(' ') + '\n');
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
    if (!stat.isFile()) { res.writeHead(404).end(); return; }

    const ext          = path.extname(resolvedPath).toLowerCase();
    const isSW         = path.basename(resolvedPath) === 'sw.js';
    const cacheControl = isSW ? 'no-cache' : (ext === '.html' ? 'no-cache' : 'public, max-age=3600');

    const headers = {
      'Content-Type':           MIME[ext] || 'application/octet-stream',
      'Cache-Control':          cacheControl,
      'Content-Length':         stat.size,
      'X-Content-Type-Options': 'nosniff',
    };

    if (req.method === 'HEAD') { res.writeHead(200, headers).end(); return; }
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

  if (!isInsidePublic(resolved)) { res.writeHead(403).end(); return; }

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

// fp → WebSocket
const peers = new Map();
// WebSocket → fp
const socketToFp = new Map();
// fp → nick (for sending to newcomers)
const peerNicks = new Map();

// Per-IP rate limiter
const rateLimiter = new Map();

function isRateLimited(ip) {
  // Cap map size to prevent memory exhaustion from spoofed IPs
  if (rateLimiter.size > MAX_RATE_ENTRIES) {
    // Prune expired entries
    const now = Date.now();
    for (const [k, v] of rateLimiter) {
      if (now > v.resetAt) rateLimiter.delete(k);
      if (rateLimiter.size <= MAX_RATE_ENTRIES / 2) break;
    }
  }

  const now  = Date.now();
  let   slot = rateLimiter.get(ip);
  if (!slot || now > slot.resetAt) {
    slot = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateLimiter.set(ip, slot);
  }
  slot.count++;
  return slot.count > RATE_MAX_MSGS;
}

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

  if (peers.size >= MAX_PEERS) {
    slog('REJECT_FULL', { peers: peers.size, max: MAX_PEERS });
    writeWsReject(socket, 503, 'Server Full');
    return;
  }

  if (peers.size >= SOFT_MAX_PEERS) {
    slog('WARN_CAPACITY', { peers: peers.size, softMax: SOFT_MAX_PEERS });
  }

  socket.on('error', () => socket.destroy());
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  let fp  = null;
  const ip = clientIP(req);

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  let isAlive   = true;
  let pongTimer = null;

  const pingInterval = setInterval(() => {
    if (!isAlive) {
      slog('HEARTBEAT_TIMEOUT', { fp: fp?.slice(0,8) || ip });
      clearInterval(pingInterval);
      ws.terminate();
      return;
    }
    isAlive   = false;
    pongTimer = setTimeout(() => {
      if (!isAlive) ws.terminate();
    }, PONG_DEADLINE_MS);
    try { ws.ping(); } catch {}
  }, PING_INTERVAL_MS);

  ws.on('pong', () => {
    isAlive = true;
    clearTimeout(pongTimer);
  });

  ws.on('error', () => { try { ws.terminate(); } catch {} });

  ws.on('message', (raw) => {
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

      // Remove stale entry for this socket
      const existingFp = socketToFp.get(ws);
      if (existingFp && existingFp !== announced && peers.get(existingFp) === ws) {
        peers.delete(existingFp);
        peerNicks.delete(existingFp);
      }

      // Close any other socket claiming the same fingerprint
      const existingWs = peers.get(announced);
      if (existingWs && existingWs !== ws) {
        try { existingWs.close(4001, 'replaced'); } catch {}
      }

      fp = announced;
      const nick = typeof msg.nick === 'string' ? msg.nick.slice(0, 32) : fp.slice(0, 8);
      peers.set(fp, ws);
      socketToFp.set(ws, fp);
      peerNicks.set(fp, nick);

      slog('CONNECT', { fp: fp.slice(0,8), nick, peers: peers.size });

      // Send existing peers (with nicks) to newcomer
      for (const [existingFp] of peers) {
        if (existingFp !== fp) {
          sendJSON(ws, {
            type:        'peer',
            fingerprint: existingFp,
            nick:        peerNicks.get(existingFp) || existingFp.slice(0, 8),
          });
        }
      }
      return;
    }

    // ── Ping / Pong (application-level) ───────────────────────────────────
    if (msg.type === 'ping') { sendJSON(ws, { type: 'pong' }); return; }
    if (msg.type === 'pong') { return; }

    // All relay messages require an announced fingerprint
    if (!fp) return;

    // Update nick if provided in any message (e.g. nick-update)
    if (msg.type === 'nick-update' && typeof msg.nick === 'string') {
      peerNicks.set(fp, msg.nick.slice(0, 32));
    }

    // Drop unknown types
    if (!RELAY_TYPES.has(msg.type)) return;

    // ── Unicast ───────────────────────────────────────────────────────────
    if (typeof msg.to === 'string' && FP_RE.test(msg.to)) {
      const to     = msg.to.toLowerCase();
      const target = peers.get(to);
      if (target?.readyState === WebSocket.OPEN) {
        sendJSON(target, { ...msg, from: fp });
      }
      return;
    }

    // ── Broadcast ─────────────────────────────────────────────────────────
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
      peerNicks.delete(mappedFp);
      slog('DISCONNECT', { fp: mappedFp.slice(0,8), peers: peers.size });
    }
    socketToFp.delete(ws);
  });
});

// ── Startup ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  slog('STARTUP', { port: PORT, ws: WS_PATH, maxPeers: MAX_PEERS, softMax: SOFT_MAX_PEERS });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(exitCode) {
  slog('SHUTDOWN', { code: exitCode });
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
