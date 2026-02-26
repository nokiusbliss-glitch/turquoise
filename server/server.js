import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

process.on("uncaughtException", (err) => {
  console.error("FATAL:", err);
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  console.error("FATAL PROMISE:", err);
  process.exit(1);
});

const PUBLIC_DIR = path.join(__dirname, "../public");
const UPLOAD_DIR = path.join(__dirname, "../uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}

app.use(express.static(PUBLIC_DIR));
app.use(express.json({ limit: "10gb" }));

/* ---------- GROUP MEMORY ---------- */

const groups = new Map();

function id() {
  return crypto.randomBytes(6).toString("hex");
}

/* ---------- FILE STREAMING ---------- */

app.post("/upload/:group", (req, res) => {
  const group = req.params.group;

  if (!groups.has(group)) {
    return res.status(404).send("Invalid group");
  }

  const fileId = id();
  const filePath = path.join(UPLOAD_DIR, fileId);
  const stream = fs.createWriteStream(filePath);

  req.pipe(stream);

  stream.on("finish", () => {
    res.json({ fileId });
  });

  stream.on("error", (err) => {
    console.error(err);
    res.status(500).send("File write failed");
  });
});

app.get("/download/:fileId", (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.fileId);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found");
  }

  res.download(filePath);
});

/* ---------- WEBSOCKET ---------- */

wss.on("connection", (ws) => {
  let groupId = null;

  ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.type === "create") {
      const gid = id();
      groups.set(gid, new Set([ws]));
      groupId = gid;
      ws.send(JSON.stringify({ type: "created", id: gid }));
    }

    if (data.type === "join") {
      const group = groups.get(data.id);
      if (!group) {
        return ws.send(JSON.stringify({ type: "error", message: "Group not found" }));
      }

      group.add(ws);
      groupId = data.id;

      ws.send(JSON.stringify({ type: "joined", id: data.id }));
    }

    if (data.type === "signal") {
      const group = groups.get(groupId);
      if (!group) return;

      group.forEach((client) => {
        if (client !== ws && client.readyState === 1) {
          client.send(JSON.stringify(data));
        }
      });
    }
  });

  ws.on("close", () => {
    if (groupId && groups.has(groupId)) {
      groups.get(groupId).delete(ws);
    }
  });
});

app.get("*", (_, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log("Turquoise Phase 2 live on", PORT);
});