/**
 * main.js — Turquoise Boot
 *
 * Works in both environments:
 *   A) Inside Tauri app (desktop) → full LAN + online features
 *   B) Plain browser (Render-hosted) → online-only, PWA installable
 *
 * Sequence:
 *   1. Check APIs
 *   2. Load identity
 *   3. Register Service Worker
 *   4. Mount App UI
 *   5. Connect network
 *   6. (Tauri only) set identity in Rust backend
 */

import { getIdentity }       from './identity.js';
import { TurquoiseNetwork, Mode } from './network.js';
import { TurquoiseApp }      from './app.js';
import { IS_TAURI, setIdentity } from './bridge.js';

// ── Fatal error screen ────────────────────────────────────────────────────────

function showFatal(title, detail) {
  const app = document.getElementById('app');
  if (!app) { console.error(title, detail); return; }
  app.innerHTML = `
    <div style="
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      height:100vh;padding:2rem;font-family:'Courier New',monospace;color:#d95040;
      background:#060b0b;text-align:center;gap:1rem;
    ">
      <div style="font-size:.7rem;letter-spacing:.3em;opacity:.4">TURQUOISE</div>
      <div style="font-size:.85rem">${title}</div>
      ${detail ? `<div style="font-size:.7rem;opacity:.6;max-width:360px">${detail}</div>` : ''}
    </div>`;
}

// ── API check ─────────────────────────────────────────────────────────────────

function checkAPIs() {
  const missing = [];
  if (!window.indexedDB)      missing.push('IndexedDB not available');
  if (!window.crypto?.subtle) missing.push('crypto.subtle — open via HTTPS or localhost');
  if (!window.RTCPeerConnection) missing.push('WebRTC not available');
  if (!window.WebSocket)      missing.push('WebSocket not available');
  return missing;
}

// ── Register service worker (browser only) ────────────────────────────────────

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    console.log('[SW] registered:', reg.scope);
  } catch (e) {
    console.warn('[SW] registration failed (non-fatal):', e.message);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  // 1. API check
  const missing = checkAPIs();
  if (missing.length > 0) {
    showFatal('Missing browser capabilities.', missing.map(m => '· ' + m).join('<br/>'));
    return;
  }

  // 2. Identity
  let identity;
  try {
    identity = await getIdentity();
  } catch (e) {
    showFatal('Identity error.', e.message);
    return;
  }

  // 3. Service Worker (browser PWA only — skip in Tauri)
  if (!IS_TAURI) registerSW();

  // 4. Network
  let network;
  try {
    network = new TurquoiseNetwork(identity, () => {});
  } catch (e) {
    showFatal('Network init failed.', e.message);
    return;
  }

  // 5. App UI
  let appCtrl;
  try {
    appCtrl = new TurquoiseApp(identity, network);
    await appCtrl.mount();
  } catch (e) {
    showFatal('App failed.', e.message);
    console.error('App mount error:', e);
    return;
  }

  // 6. Network connections
  try {
    // Detect initial mode from localStorage (persists user's last choice)
    const savedMode = localStorage.getItem('tq_mode') || Mode.ONLINE;
    if (savedMode !== network.mode) network.setMode(savedMode);

    // Online signaling
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const cloudUrl = `${protocol}://${window.location.host}`;

    if (network.mode === Mode.ONLINE) {
      network.connect(cloudUrl);
    } else {
      network.cloudUrl = cloudUrl;
    }

    // Save mode changes
    network.onModeChange = (mode) => {
      localStorage.setItem('tq_mode', mode);
    };
  } catch (e) {
    console.error('Network connect error:', e);
    // Non-fatal — UI is up, user can retry
  }

  // 7. Tauri: register identity with Rust backend
  if (IS_TAURI) {
    try {
      await setIdentity(identity.fingerprint, identity.nickname);
    } catch (e) {
      console.warn('[Boot] setIdentity failed:', e.message);
    }
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────

boot().catch(err => {
  console.error('Fatal boot:', err);
  showFatal('Unexpected error.', err?.message || String(err));
});

window.addEventListener('unhandledrejection', (ev) => {
  console.error('Unhandled rejection:', ev.reason);
});
