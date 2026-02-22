/**
 * main.js — Turquoise v7
 *
 * Boot sequence:
 *   1. Register Service Worker (PWA + offline)
 *   2. Check required browser APIs — show error if missing
 *   3. Load cryptographic identity
 *   4. Init network engine
 *   5. Mount UI
 *   6. Connect to signaling (auto-detects protocol + host)
 *
 * After step 1 completes, the app is installable and works offline
 * on all subsequent loads — even if the server is unreachable.
 */

import { getIdentity }      from './identity.js';
import { TurquoiseNetwork } from './webrtc.js';
import { TurquoiseApp }     from './app.js';

// ── Service Worker registration ───────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    console.log('[SW] registered:', reg.scope);
  }).catch(e => {
    console.warn('[SW] registration failed:', e.message);
    // Non-fatal — app still works online
  });
}

// ── Browser capability check ──────────────────────────────────────────────────

function checkAPIs() {
  const missing = [];
  if (!window.indexedDB)         missing.push('IndexedDB');
  if (!window.crypto?.subtle)    missing.push('crypto.subtle (requires HTTPS)');
  if (!window.RTCPeerConnection) missing.push('WebRTC');
  if (!window.WebSocket)         missing.push('WebSocket');
  return missing;
}

// ── Fatal error screen ────────────────────────────────────────────────────────

function fatal(title, detail) {
  const app = document.getElementById('app');
  if (!app) { console.error(title, detail); return; }
  app.innerHTML = `
<div style="
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  height:100dvh;padding:2rem;font-family:'Courier New',monospace;
  color:var(--err,#BF4040);background:var(--void,#030d0d);
  text-align:center;gap:var(--φ3,1rem);
">
  <div style="font-size:.55rem;letter-spacing:.6em;opacity:.4;">T·U·R·Q·U·O·I·S·E</div>
  <div style="font-size:.85rem;">${title}</div>
  ${detail ? `<div style="font-size:.68rem;opacity:.55;max-width:360px;line-height:1.9;">${detail}</div>` : ''}
  <button onclick="location.reload()" style="
    margin-top:1rem;padding:.4rem 1.2rem;
    border:1px solid #BF4040;background:transparent;
    color:#BF4040;font-family:inherit;font-size:.68rem;
    letter-spacing:.1em;cursor:pointer;
  ">reload</button>
</div>`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {

  // 1. API check
  const missing = checkAPIs();
  if (missing.length) {
    fatal(
      'Browser missing required APIs.',
      missing.map(m => '· ' + m).join('<br/>')
        + '<br/><br/>Use Chrome, Edge, or Firefox over HTTPS.'
    );
    return;
  }

  // 2. Identity
  let identity;
  try {
    identity = await getIdentity();
  } catch (e) {
    fatal('Identity initialization failed.', e.message);
    return;
  }

  // 3. Network
  let network;
  try {
    network = new TurquoiseNetwork(identity);
  } catch (e) {
    fatal('Network engine failed.', e.message);
    return;
  }

  // 4. App UI
  let app;
  try {
    app = new TurquoiseApp(identity, network);
    await app.mount();
  } catch (e) {
    fatal('App failed to mount.', e.message);
    console.error('[Boot] mount error:', e);
    return;
  }

  // 5. Connect to signaling
  //    wss:// on HTTPS (Render), ws:// on http (local dev)
  //    Same host:port — no hardcoded URL
  try {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    network.connect(`${proto}://${location.host}`);
  } catch (e) {
    console.warn('[Boot] signaling connect failed:', e.message);
    // Non-fatal — UI is up, reconnect will be attempted automatically
  }
}

boot().catch(e => {
  console.error('[Boot] fatal:', e);
  fatal('Unexpected startup error.', e?.message || String(e));
});

window.addEventListener('unhandledrejection', ev => {
  console.error('[Unhandled]', ev.reason);
});
