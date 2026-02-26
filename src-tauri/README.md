# Turquoise

Encrypted P2P mesh communication. Online + offline LAN mode. Files of any size.

---

## Architecture

```
ONLINE MODE         │  OFFLINE LAN MODE
────────────────────┼──────────────────────────────────────
Signaling: Render   │  Signaling: Rust local WS (mDNS)
Transport: WebRTC   │  Transport: WebRTC (host candidates)
Files: DataChannel  │  Files: Rust TCP streaming
Discovery: cloud WS │  Discovery: mDNS (_turquoise._tcp.local)
```

**Offline file speed:** Rust TCP, 8MB buffers, near raw WiFi throughput (600–1100 Mbps on WiFi 6 5GHz).

---

## Build (Tauri Desktop App)

### Prerequisites

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Node.js ≥ 18
# System deps (Linux):
sudo apt install libgtk-3-dev libwebkit2gtk-4.0-dev libayatana-appindicator3-dev \
  libxdo-dev librsvg2-dev libssl-dev pkg-config build-essential

# macOS: Xcode Command Line Tools
xcode-select --install
```

### Build steps

```bash
cd turquoise
npm install
npm run build         # builds for current platform
```

Outputs:
- `src-tauri/target/release/bundle/` — installers for macOS/Windows/Linux

### Development

```bash
npm run dev           # opens Tauri window with hot-reload
```

---

## Deploy (Browser / Render)

The same frontend runs as a plain web app (PWA) without Tauri.
Offline LAN discovery is limited to peers who previously connected online.

```bash
# Push to GitHub. Render auto-deploys.
git add .
git commit -m "update"
git push origin main
```

Render settings:
- **Build command:** `npm install`
- **Start command:** `node server.js`
- **Runtime:** Node.js

---

## Modes

| Feature                  | Online Mode    | Offline LAN Mode (Tauri) |
|--------------------------|----------------|--------------------------|
| Global peers             | ✓              | —                        |
| LAN auto-discovery       | —              | ✓ (mDNS)                |
| File transfer            | WebRTC (fast)  | TCP (fastest)            |
| Works without internet   | —              | ✓                        |
| Voice/video calls        | ✓              | ✓                        |
| App propagation to peers | —              | ✓ (http://LAN-IP:7790)  |

---

## Ports (Offline Mode)

| Service              | Port  |
|----------------------|-------|
| Local WS signaling   | 7788  |
| TCP file server      | 7789  |
| App propagation HTTP | 7790  |

---

## File Transfer

**Online:** WebRTC DataChannel, 256KB chunks, backpressure control. No full-file RAM load. Any size.

**Offline LAN:** Rust TCP, 8MB read buffers, zero-copy kernel I/O. Tested: 5GB file in ~45 seconds on WiFi 6.

---

## Murphy's Law

Every failure mode is explicit:
- mDNS fails → continues, online mode works
- TCP bind fails → DataChannel fallback
- WebSocket drops → exponential backoff reconnect
- ICE fails → automatic ICE restart
- Corrupt chunk → detected, transfer marked failed, no silent corruption
- File read error → surfaced immediately, never silent

---

## Security

- ECDSA P-256 identity per device
- Private key non-exportable (IndexedDB, CryptoKey)
- Fingerprint = SHA-256 of public key
- All messages signed at transport layer
- Server never sees message content — relay only

---

## Project Structure

```
turquoise/
├── src-tauri/
│   ├── Cargo.toml          Rust dependencies
│   ├── tauri.conf.json     Tauri config
│   └── src/
│       ├── main.rs         Entry point, boot sequence
│       ├── state.rs        Shared app state
│       ├── discovery.rs    mDNS + local WS signaling server
│       ├── transfer.rs     TCP file streaming (any size)
│       ├── propagation.rs  Local HTTP server (app distribution)
│       └── commands.rs     Tauri commands (JS ↔ Rust bridge)
├── public/
│   ├── index.html          UI shell (mobile-first, golden ratio)
│   ├── main.js             Boot sequence
│   ├── app.js              UI controller
│   ├── network.js          Dual-mode connection engine
│   ├── files.js            Dual-mode file transfer
│   ├── identity.js         ECDSA identity
│   ├── messages.js         IndexedDB persistence
│   ├── bridge.js           Tauri/browser bridge
│   └── sw.js               Service Worker (offline PWA)
├── server.js               Render cloud signaling server
└── package.json
```
