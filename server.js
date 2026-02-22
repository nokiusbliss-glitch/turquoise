/**
 * server.js — Turquoise (Render-Grade Signaling Core)
 *
 * - Zero framework overhead
 * - Proxy-safe WebSocket upgrade handling
 * - Non-blocking static file server
 * - Deterministic peer registry
 * - Defensive against malformed input
 *
 * Designed for clarity, resilience, and silence.
 */

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────
// Static file server (non-blocking, safe path resolution)
// ─────────────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

function serveFile(req, res) {
  let reqPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.normalize(path.join(PUBLIC, reqPath));

  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end();
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
    });
    res.end(data);
  });
}

const server = http.createServer(serveFile);

// ─────────────────────────────────────────────────────────────
// WebSocket signaling (explicit upgrade handling)
// ─────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });
const peers = new Map();

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  let fingerprint = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!msg || typeof msg !== "object") return;

    // Announce
    if (msg.type === "announce" && typeof msg.from === "string") {
      fingerprint = msg.from;
      peers.set(fingerprint, ws);

      console.log(`+ ${fingerprint.slice(0, 8)} (${peers.size})`);

      // Send existing peers to newcomer
      for (const [fp] of peers) {
        if (fp !== fingerprint) {
          ws.send(JSON.stringify({
            type: "peer",
            fingerprint: fp
          }));
        }
      }
      return;
    }

    // Direct relay
    if (msg.to && peers.has(msg.to)) {
      const target = peers.get(msg.to);
      if (target.readyState === 1) {
        target.send(raw.toString());
      }
      return;
    }

    // Broadcast fallback
    for (const [fp, client] of peers) {
      if (fp !== fingerprint && client.readyState === 1) {
        client.send(raw.toString());
      }
    }
  });

  ws.on("close", () => {
    if (fingerprint) {
      peers.delete(fingerprint);
      console.log(`- ${fingerprint.slice(0, 8)} (${peers.size})`);
    }
  });

  ws.on("error", () => {
    ws.close();
  });
});

// ─────────────────────────────────────────────────────────────
// Launch
// ─────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`🚀 Turquoise running on port ${PORT}`);
});
