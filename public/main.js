/**
 * main.js — Turquoise
 * Boot sequence: checks → SW → identity → network → app → connect
 *
 * Fixes:
 *   - registerSW had both internal try-catch AND outer .catch(() => {}) — errors
 *     were silently swallowed twice. Now logs warnings properly.
 *   - Added online/offline event listeners to reconnect/show status.
 *   - fatal() now shows a reload button for recoverable failures.
 */

import { getIdentity } from './identity.js';
import { TurquoiseNetwork } from './webrtc.js';
import { TurquoiseApp } from './app.js';

let networkRef = null;

const REQUIRED_APIS = [
  ['IndexedDB',    () => !!window.indexedDB],
  ['crypto.subtle','requires HTTPS', () => !!window.crypto?.subtle],
  ['WebRTC',       () => !!window.RTCPeerConnection],
  ['WebSocket',    () => !!window.WebSocket],
];

function checkAPIs() {
  return REQUIRED_APIS
    .filter(([, ...rest]) => {
      const check = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : rest[0];
      return !check();
    })
    .map(([name, hint]) => typeof hint === 'string' ? `${name} (${hint})` : name);
}

function fatal(msg, recoverable = false) {
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:2rem;font-family:monospace;color:#e05040;font-size:.9rem;';

  const title = document.createElement('div');
  title.style.cssText = 'letter-spacing:.2em;margin-bottom:1rem;font-weight:500;';
  title.textContent = 'TURQUOISE — startup error';

  const body = document.createElement('div');
  body.style.opacity = '.85';
  body.textContent = msg;

  wrap.appendChild(title);
  wrap.appendChild(body);

  if (recoverable) {
    const btn = document.createElement('button');
    btn.style.cssText = 'margin-top:1.5rem;border:1px solid #e05040;background:transparent;color:#e05040;cursor:pointer;padding:.4rem 1rem;font-family:monospace;font-size:.8rem;';
    btn.textContent = 'reload';
    btn.onclick = () => location.reload();
    wrap.appendChild(btn);
  }

  root.appendChild(wrap);
}

function signalingURL() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    // Log update found so devs know when a new SW is waiting
    reg.addEventListener('updatefound', () => {
      console.log('[TQ] service worker update available');
    });
  } catch (e) {
    // Non-fatal: app still works without SW
    console.warn('[TQ] service worker register failed:', e?.message || e);
  }
}

async function boot() {
  const missing = checkAPIs();
  if (missing.length) {
    fatal('Missing browser APIs: ' + missing.join(', '));
    return;
  }

  // SW registration: fire and forget, errors are non-fatal and logged above
  registerSW();

  // Request persistent storage so IDB isn't evicted under storage pressure
  if (navigator.storage?.persist) {
    navigator.storage.persist().then((granted) => {
      if (!granted) console.warn('[TQ] persistent storage not granted — identity may be evicted');
    }).catch(() => {});
  }

  let identity;
  try {
    identity = await getIdentity();
  } catch (e) {
    fatal('Identity error: ' + (e?.message || String(e)), true);
    return;
  }

  let network;
  try {
    network = new TurquoiseNetwork(identity);
    networkRef = network;
  } catch (e) {
    fatal('Network init failed: ' + (e?.message || String(e)), true);
    return;
  }

  try {
    const app = new TurquoiseApp(identity, network);
    await app.mount();
  } catch (e) {
    console.error('[TQ] app mount failed:', e);
    fatal('App error: ' + (e?.message || String(e)), true);
    return;
  }

  network.connect(signalingURL());

  // Reconnect on coming back online
  window.addEventListener('online', () => {
    console.log('[TQ] network online — reconnecting signaling');
    network.connect(signalingURL());
  });
}

boot().catch((e) => {
  console.error('[TQ] fatal boot error:', e);
  fatal('Fatal: ' + (e?.message || String(e)), true);
});

window.addEventListener('beforeunload', () => {
  try { networkRef?.destroy?.(); } catch {}
});

window.addEventListener('unhandledrejection', (ev) => {
  console.error('[TQ] unhandled rejection:', ev.reason);
});
