/**
 * server.js — Turquoise v7
 * HTTP static + WebSocket signaling + WS data relay fallback.
 *
 * Transport layers exposed:
 *   Layer 1/2 : WebRTC P2P (STUN-assisted, browser handles)
 *   Layer 3   : Server WS relay  ← this file handles forwarding
 *
 * New in v7:
 *   - ice-config sent to each client on connect (STUN + optional TURN from env)
 *   - bin-relay forwarding for base64 binary chunks when WebRTC DataChannel down
 *   - tool-action, call-request in RELAY_TYPES
 *   - ~50% smaller than v6 (removed multi-paragraph comments, consolidated helpers)
 */

import http from 'http';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC    = path.resolve(__dirname, 'public');

if (!fs.existsSync(PUBLIC)) { process.stderr.write(`ERROR: public/ not found at ${PUBLIC}\n`); process.exit(1); }

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = (() => { const n=+(process.env.PORT||3000); if(!Number.isFinite(n)||n<1||n>65535){process.stderr.write(`ERROR: invalid PORT\n`);process.exit(1);} return n; })();
const WS_PATH    = process.env.WS_PATH     || '/ws';
const MAX_PEERS  = +(process.env.MAX_PEERS || 100);
const FP_RE      = /^[a-f0-9]{64}$/i;

// ICE config delivered to clients on connect.
// STUN servers are free/public. TURN needs self-hosting (coturn recommended).
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478'  },
  { urls: 'stun:stun.stunprotocol.org:3478' },
  ...(process.env.TURN_URL ? [{
    urls:       process.env.TURN_URL,
    username:   process.env.TURN_USER || '',
    credential: process.env.TURN_PASS || '',
  }] : []),
];

const RELAY_TYPES = new Set([
  'offer','answer','ice','chat',
  'call-invite','call-accept','call-decline','call-end','call-request',
  'offer-reneg','answer-reneg','permission-denied',
  'file-meta','file-end','file-abort','bin-relay',
  'nick-update','game','folder-manifest',
  'ping','pong','p2p-relay','tool-action',
  'circle-peer-joined','circle-peer-left',  // coordinator messages for full-mesh circle calls
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.css':  'text/css; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.woff2':'font/woff2',
};

const slog = (ev, d={}) => process.stdout.write(
  [new Date().toISOString(), ev, ...Object.entries(d).map(([k,v])=>`${k}=${v}`)].join(' ') + '\n'
);

// ── HTTP ──────────────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let pn;
  try { pn = decodeURIComponent(new URL(req.url||'/', 'http://x').pathname); }
  catch { res.writeHead(400).end(); return; }

  const file     = pn === '/' ? '/index.html' : pn;
  const resolved = path.resolve(PUBLIC, '.' + file);
  if (!resolved.startsWith(PUBLIC + path.sep) && resolved !== PUBLIC) { res.writeHead(403).end(); return; }

  const serve = (fp, fallback) => fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) {
      if (fallback) return serve(fallback, null);
      res.writeHead(404).end(); return;
    }
    const ext = path.extname(fp).toLowerCase();
    const cc  = /sw\.js$/.test(fp) || ext === '.html' ? 'no-cache' : 'public,max-age=3600';
    res.writeHead(200, {
      'Content-Type':           MIME[ext] || 'application/octet-stream',
      'Cache-Control':          cc,
      'Content-Length':         st.size,
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(fp).on('error', () => res.end()).pipe(res);
  });

  const spaFallback = !path.extname(pn) && pn !== '/sw.js'
    ? path.join(PUBLIC, 'index.html') : null;
  serve(resolved, spaFallback);
});

httpServer.on('error', e => { process.stderr.write(`HTTP error: ${e.message}\n`); process.exit(1); });

// ── WebSocket signaling ───────────────────────────────────────────────────────
const wss     = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
const peers   = new Map();  // fp  → ws
const fpOf    = new Map();  // ws  → fp
const nicks   = new Map();  // fp  → nick
const rates   = new Map();  // ip  → { n, resetAt }

const ip = req => (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress;

const rateOk = (ipAddr) => {
  if (rates.size > 4000) { const now=Date.now(); for(const[k,v] of rates) if(now>v.resetAt) rates.delete(k); }
  const now = Date.now();
  let r = rates.get(ipAddr);
  if (!r || now > r.resetAt) { r = {n:0, resetAt:now+10_000}; rates.set(ipAddr, r); }
  return ++r.n <= 200;
};
setInterval(() => { const now=Date.now(); for(const[k,v] of rates) if(now>v.resetAt) rates.delete(k); }, 30_000).unref();

const send = (ws, obj) => ws.readyState === WebSocket.OPEN && (ws.send(JSON.stringify(obj)), true);

httpServer.on('upgrade', (req, socket, head) => {
  let pn; try { pn = new URL(req.url||'/', 'http://x').pathname; } catch { socket.destroy(); return; }
  if (pn !== WS_PATH)        { socket.write('HTTP/1.1 404 Not Found\r\n\r\n');     socket.destroy(); return; }
  if (peers.size >= MAX_PEERS) { socket.write('HTTP/1.1 503 Server Full\r\n\r\n'); socket.destroy(); return; }
  if (peers.size >= MAX_PEERS * 0.8) slog('WARN_CAPACITY', {n:peers.size, max:MAX_PEERS});
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const clientIp = ip(req);
  let fp = null, alive = true;

  const hb = setInterval(() => {
    if (!alive) { clearInterval(hb); ws.terminate(); return; }
    alive = false; try { ws.ping(); } catch {}
  }, 30_000);

  ws.on('pong', () => { alive = true; });
  ws.on('error', () => { try { ws.terminate(); } catch {} });

  ws.on('message', raw => {
    if (!rateOk(clientIp)) { send(ws, {type:'error',reason:'rate-limited'}); return; }
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (!msg) return;

    // ── Announce ──────────────────────────────────────────────────────────
    if (msg.type === 'announce') {
      const fp2 = String(msg.from||'').toLowerCase();
      if (!FP_RE.test(fp2)) return;
      const old = peers.get(fp2);
      if (old && old !== ws) try { old.close(4001,'replaced'); } catch {}
      const prev = fpOf.get(ws);
      if (prev && prev !== fp2) { peers.delete(prev); nicks.delete(prev); }
      fp = fp2;
      const nick = (msg.nick||fp.slice(0,8)).slice(0,32);
      peers.set(fp, ws); fpOf.set(ws, fp); nicks.set(fp, nick);
      slog('CONNECT', {fp:fp.slice(0,8), nick, n:peers.size});
      // Deliver ICE config + existing peer list to newcomer
      send(ws, {type:'ice-config', iceServers:ICE_SERVERS});
      for (const [efp] of peers) {
        if (efp !== fp) send(ws, {type:'peer', fingerprint:efp, nick:nicks.get(efp)||efp.slice(0,8)});
      }
      return;
    }

    if (msg.type === 'ping') { send(ws, {type:'pong'}); return; }
    if (msg.type === 'pong') return;
    if (!fp) return;
    if (msg.type === 'nick-update' && msg.nick) nicks.set(fp, String(msg.nick).slice(0,32));
    if (!RELAY_TYPES.has(msg.type)) return;

    // ── Relay ─────────────────────────────────────────────────────────────
    if (msg.to && FP_RE.test(String(msg.to))) {
      const tw = peers.get(String(msg.to).toLowerCase());
      if (tw) send(tw, {...msg, from:fp});
    } else {
      const fwd = {...msg, from:fp};
      for (const [pfp, pw] of peers) if (pfp !== fp) send(pw, fwd);
    }
  });

  ws.on('close', () => {
    clearInterval(hb);
    const mfp = fpOf.get(ws) || fp;
    if (mfp && peers.get(mfp) === ws) {
      peers.delete(mfp); nicks.delete(mfp);
      slog('DISCONNECT', {fp:mfp.slice(0,8), n:peers.size});
    }
    fpOf.delete(ws);
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => slog('STARTUP', {port:PORT, ws:WS_PATH, max:MAX_PEERS, stun:ICE_SERVERS.length}));

for (const sig of ['SIGINT','SIGTERM']) process.on(sig, () => {
  slog('SHUTDOWN', {sig});
  for (const c of wss.clients) try { c.close(1001,'shutdown'); } catch {}
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});

process.on('uncaughtException',  e => { process.stderr.write(`uncaughtException: ${e.stack||e.message}\n`); process.exit(1); });
process.on('unhandledRejection', r => { process.stderr.write(`unhandledRejection: ${r}\n`); process.exit(1); });
