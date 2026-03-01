/**
 * main.js — Turquoise
 * Boot sequence: checks → identity → network → app → connect
 * Render-safe WebSocket URL auto-detection
 */

import { getIdentity }      from './identity.js';
import { TurquoiseNetwork } from './webrtc.js';
import { TurquoiseApp }     from './app.js';

// ── API check ─────────────────────────────────────────────────────────────────
function checkAPIs() {
  const missing = [];
  if (!window.indexedDB)           missing.push('IndexedDB');
  if (!window.crypto?.subtle)      missing.push('crypto.subtle (needs HTTPS)');
  if (!window.RTCPeerConnection)   missing.push('WebRTC');
  if (!window.WebSocket)           missing.push('WebSocket');
  return missing;
}

function fatal(msg) {
  document.getElementById('app').innerHTML =
    `<div style="padding:2rem;font-family:monospace;color:#e05040;font-size:.9rem">
      <div style="letter-spacing:.2em;margin-bottom:1rem">TURQUOISE — startup error</div>
      <div style="opacity:.8">${msg}</div>
    </div>`;
}

// ── Signaling URL (Render-safe) ───────────────────────────────────────────────
function signalingURL() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  const missing = checkAPIs();
  if (missing.length) {
    fatal('Missing: ' + missing.join(', ')); return;
  }

  let identity;
  try {
    identity = await getIdentity();
  } catch (e) {
    fatal('Identity failed: ' + e.message); return;
  }

  let network;
  try {
    network = new TurquoiseNetwork(identity);
  } catch (e) {
    fatal('Network init failed: ' + e.message); return;
  }

  let app;
  try {
    app = new TurquoiseApp(identity, network);
    await app.mount();
  } catch (e) {
    fatal('App failed: ' + e.message);
    console.error(e); return;
  }

  // Connect to signaling server — auto-detect URL
  network.connect(signalingURL());
}

boot().catch(e => fatal('Fatal: ' + e.message));

window.addEventListener('unhandledrejection', (ev) => {
  console.error('Unhandled rejection:', ev.reason);
});
