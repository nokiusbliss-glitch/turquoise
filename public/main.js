/**
 * main.js — Turquoise
 * Boot sequence: checks → service worker → identity → network → app → connect
 */

import { getIdentity }      from './identity.js';
import { TurquoiseNetwork } from './webrtc.js';
import { TurquoiseApp }     from './app.js';

function checkAPIs() {
  const missing = [];
  if (!window.indexedDB)         missing.push('IndexedDB');
  if (!window.crypto?.subtle)    missing.push('crypto.subtle (needs HTTPS)');
  if (!window.RTCPeerConnection) missing.push('WebRTC');
  if (!window.WebSocket)         missing.push('WebSocket');
  return missing;
}

function fatal(msg) {
  document.getElementById('app').innerHTML =
    `<div style="padding:2rem;font-family:monospace;color:#e05040;font-size:.9rem">
      <div style="letter-spacing:.2em;margin-bottom:1rem">TURQUOISE — startup error</div>
      <div style="opacity:.8">${msg}</div>
    </div>`;
}

function signalingURL() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}

// Register service worker for offline-first operation
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (e) {
    console.warn('[TQ] SW registration failed:', e.message);
  }
}

async function boot() {
  const missing = checkAPIs();
  if (missing.length) { fatal('Missing: ' + missing.join(', ')); return; }

  // Register SW (non-blocking)
  registerSW();

  let identity;
  try { identity = await getIdentity(); }
  catch (e) { fatal('Identity failed: ' + e.message); return; }

  let network;
  try { network = new TurquoiseNetwork(identity); }
  catch (e) { fatal('Network init failed: ' + e.message); return; }

  let app;
  try {
    app = new TurquoiseApp(identity, network);
    await app.mount();
  } catch (e) {
    fatal('App failed: ' + e.message);
    console.error(e); return;
  }

  network.connect(signalingURL());
}

boot().catch(e => fatal('Fatal: ' + e.message));

window.addEventListener('unhandledrejection', (ev) => {
  console.error('Unhandled rejection:', ev.reason);
});
