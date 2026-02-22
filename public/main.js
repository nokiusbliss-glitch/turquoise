/**
 * main.js — Turquoise Phase 3 + 4 (Render-safe version)
 *
 * Boot sequence:
 *   1. Check browser APIs
 *   2. Get cryptographic identity
 *   3. Create network (WebRTC + signaling)
 *   4. Mount app UI
 *   5. Connect to signaling server (auto-detect host + protocol)
 */

import { getIdentity }      from './identity.js';
import { TurquoiseNetwork } from './webrtc.js';
import { TurquoiseApp }     from './app.js';

// ── Browser check ─────────────────────────────────────────────────────────────

function checkAPIs() {
  const missing = [];
  if (!window.indexedDB)         missing.push('IndexedDB');
  if (!window.crypto?.subtle)    missing.push('crypto.subtle (requires HTTPS or localhost)');
  if (!window.RTCPeerConnection) missing.push('WebRTC');
  if (!window.WebSocket)         missing.push('WebSocket');
  return missing;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {

  // 1. API check
  const missing = checkAPIs();
  if (missing.length > 0) {
    document.getElementById('app').innerHTML = `
      <div style="padding:2rem;font-family:monospace;color:#e05040;">
        <div style="margin-bottom:1rem;letter-spacing:.2em;">TURQUOISE — startup failed</div>
        <div>Missing APIs:</div>
        ${missing.map(m => `<div style="margin-top:.5rem;opacity:.7;">  · ${m}</div>`).join('')}
        <div style="margin-top:1.5rem;opacity:.5;font-size:.8rem;">
          Open this page via HTTPS
        </div>
      </div>
    `;
    return;
  }

  // 2. Identity
  let identity;
  try {
    identity = await getIdentity();
  } catch (e) {
    document.getElementById('app').innerHTML =
      `<div style="padding:2rem;font-family:monospace;color:#e05040;">Identity failed: ${e.message}</div>`;
    return;
  }

  // 3. Network
  let network;
  try {
    network = new TurquoiseNetwork(identity, () => {});
  } catch (e) {
    document.getElementById('app').innerHTML =
      `<div style="padding:2rem;font-family:monospace;color:#e05040;">Network init failed: ${e.message}</div>`;
    return;
  }

  // 4. App UI
  let app;
  try {
    app = new TurquoiseApp(identity, network);
    await app.mount();
  } catch (e) {
    document.getElementById('app').innerHTML =
      `<div style="padding:2rem;font-family:monospace;color:#e05040;">App mount failed: ${e.message}</div>`;
    console.error('App mount error:', e);
    return;
  }

  // 5. Connect to signaling server (FIXED FOR RENDER)

  try {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${window.location.host}`;

    console.log("Connecting to signaling server:", url);

    network.connect(url);

  } catch (e) {
    console.error('Network connect failed:', e.message);
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────

boot().catch(err => {
  console.error('Fatal boot error:', err);
  try {
    document.getElementById('app').innerHTML =
      `<div style="padding:2rem;font-family:monospace;color:#e05040;">Fatal: ${err.message}</div>`;
  } catch {}
});

window.addEventListener('unhandledrejection', (ev) => {
  console.error('Unhandled rejection:', ev.reason);
});
