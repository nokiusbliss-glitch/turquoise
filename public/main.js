/**
 * main.js — Turquoise (Production Boot)
 *
 * Boot sequence:
 *   1. Check browser APIs — show clear error if anything missing
 *   2. Load cryptographic identity
 *   3. Initialize network layer
 *   4. Mount full application UI
 *   5. Connect to signaling server (auto-detects protocol/host)
 *
 * Works on:
 *   - Render (https://turquoise-xxxx.onrender.com → wss://…)
 *   - Local dev (https://localhost:3443 → wss://localhost:3443)
 *   - Any HTTPS host (auto-detects)
 *
 * Murphy's Law: every step catches its own errors and shows a clear
 *               message on screen. Nothing fails invisibly.
 */

import { getIdentity }      from './identity.js';
import { TurquoiseNetwork } from './webrtc.js';
import { TurquoiseApp }     from './app.js';

// ── Browser capability check ──────────────────────────────────────────────────

function checkAPIs() {
  const missing = [];
  if (!window.indexedDB)                  missing.push('IndexedDB (not supported in this browser)');
  if (!window.crypto?.subtle)             missing.push('crypto.subtle — open via HTTPS or localhost');
  if (!window.RTCPeerConnection)          missing.push('WebRTC — not supported in this browser');
  if (!window.WebSocket)                  missing.push('WebSocket — not supported in this browser');
  if (!navigator.mediaDevices?.getUserMedia) {
    // Not fatal — just disables voice/video
    console.warn('getUserMedia not available — voice/video disabled.');
  }
  return missing;
}

// ── Fatal error screen ─────────────────────────────────────────────────────────

function showFatal(title, detail) {
  const app = document.getElementById('app');
  if (!app) { console.error(title, detail); return; }
  app.innerHTML = `
    <div style="
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      height:100vh; padding:2rem; font-family:'Courier New',monospace; color:#d95040;
      background:#060b0b; text-align:center; gap:1rem;
    ">
      <div style="font-size:.75rem;letter-spacing:.3em;opacity:.5;">TURQUOISE</div>
      <div style="font-size:.875rem;">${title}</div>
      ${detail ? `<div style="font-size:.72rem;opacity:.6;max-width:400px;">${detail}</div>` : ''}
    </div>
  `;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {

  // 1. API check
  const missing = checkAPIs();
  if (missing.length > 0) {
    showFatal(
      'Browser capabilities missing.',
      missing.map(m => '· ' + m).join('<br/>')
    );
    return;
  }

  // 2. Cryptographic identity
  let identity;
  try {
    identity = await getIdentity();
  } catch (e) {
    showFatal('Identity failed.', e.message);
    return;
  }

  // 3. Network
  let network;
  try {
    network = new TurquoiseNetwork(identity, () => {});
  } catch (e) {
    showFatal('Network init failed.', e.message);
    return;
  }

  // 4. App UI
  let app;
  try {
    app = new TurquoiseApp(identity, network);
    await app.mount();
  } catch (e) {
    showFatal('App failed to load.', e.message);
    console.error('App mount error:', e);
    return;
  }

  // 5. Connect to signaling server
  //    Auto-detect: https → wss, http → ws
  //    No port suffix — Render uses the same host and port for both HTTP and WS.
  //    Works locally too if served over https://localhost:3443
  try {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url      = `${protocol}://${window.location.host}`;
    network.connect(url);
  } catch (e) {
    console.error('Network connect failed:', e.message);
    // Non-fatal — UI is up, user can still see it. Network will retry.
  }
}

// ── Run ────────────────────────────────────────────────────────────────────────

boot().catch(err => {
  console.error('Fatal boot error:', err);
  showFatal('Unexpected error.', err?.message || String(err));
});

window.addEventListener('unhandledrejection', (ev) => {
  console.error('Unhandled promise rejection:', ev.reason);
});
