/**
 * main.js — Turquoise v6
 * Boot sequence: checks → SW → identity → network → app → connect
 *
 * ── Changes from v5 ──────────────────────────────────────────────────────────
 *   - TQLog (black box logger) initialised as the very first action.
 *   - All boot steps log to TQLog for full trace from first load.
 *   - online/offline listeners: reconnect WS on online, log on offline.
 *   - visibilitychange: reconnect WS on page becoming visible (handles
 *     device wake from sleep — primary cause of "connection drop on resume").
 *   - fatal() now shows a reload button for recoverable failures.
 *   - Added in-app log viewer trigger (long-press on the net-log panel).
 *   - Export log button wired through app settings menu.
 */

import { TQLog }             from './tqlog.js';
import { getIdentity }       from './identity.js';
import { TurquoiseNetwork }  from './webrtc.js';
import { TurquoiseApp }      from './app.js';

// ── Logger: initialise before everything else ──────────────────────────────
const log = TQLog.get();
log.info('main', 'boot', 'Turquoise starting', {
  ua: navigator.userAgent.slice(0, 120),
  protocol: location.protocol,
  host: location.host,
});

let networkRef = null;
let appRef     = null;

// ── Required browser API checks ────────────────────────────────────────────
const REQUIRED_APIS = [
  ['IndexedDB',    () => !!window.indexedDB],
  ['crypto.subtle', 'requires HTTPS', () => !!window.crypto?.subtle],
  ['WebRTC',       () => !!window.RTCPeerConnection],
  ['WebSocket',    () => !!window.WebSocket],
];

function checkAPIs() {
  return REQUIRED_APIS
    .filter(([, ...rest]) => {
      const check = typeof rest[rest.length - 1] === 'function'
        ? rest[rest.length - 1]
        : rest[0];
      return !check();
    })
    .map(([name, hint]) => typeof hint === 'string' ? `${name} (${hint})` : name);
}

function fatal(msg, recoverable = false) {
  log.error('main', 'fatal', msg);
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

    const logBtn = document.createElement('button');
    logBtn.style.cssText = 'margin-top:.5rem;margin-left:.5rem;border:1px solid #3d7a74;background:transparent;color:#3d7a74;cursor:pointer;padding:.4rem 1rem;font-family:monospace;font-size:.8rem;';
    logBtn.textContent = 'export log';
    logBtn.onclick = () => log.exportToFile();
    wrap.appendChild(logBtn);
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
    reg.addEventListener('updatefound', () => {
      log.info('main', 'registerSW', 'service worker update available');
    });
    log.info('main', 'registerSW', 'service worker registered', { scope: reg.scope });
  } catch (e) {
    log.warn('main', 'registerSW', 'SW register failed: ' + (e?.message || e));
  }
}

async function boot() {
  const missing = checkAPIs();
  if (missing.length) {
    log.error('main', 'boot', 'Missing APIs: ' + missing.join(', '));
    fatal('Missing browser APIs: ' + missing.join(', '));
    return;
  }

  log.info('main', 'boot', 'API check passed');

  // SW: fire and forget
  registerSW();

  // Request persistent storage
  if (navigator.storage?.persist) {
    navigator.storage.persist().then((granted) => {
      log.info('main', 'boot', `persistent storage: ${granted ? 'granted' : 'denied'}`);
      if (!granted) console.warn('[TQ] persistent storage not granted — identity may be evicted');
    }).catch(() => {});
  }

  let identity;
  try {
    identity = await getIdentity();
    log.info('main', 'boot', 'identity ready', {
      shortId: identity.shortId,
      isNewUser: identity.isNewUser,
    });
  } catch (e) {
    fatal('Identity error: ' + (e?.message || String(e)), true);
    return;
  }

  let network;
  try {
    network = new TurquoiseNetwork(identity);
    networkRef = network;
    log.info('main', 'boot', 'network created');
  } catch (e) {
    fatal('Network init failed: ' + (e?.message || String(e)), true);
    return;
  }

  try {
    const app = new TurquoiseApp(identity, network);
    appRef = app;
    await app.mount();
    log.info('main', 'boot', 'app mounted');
  } catch (e) {
    console.error('[TQ] app mount failed:', e);
    log.error('main', 'boot', 'app mount failed: ' + e.message);
    fatal('App error: ' + (e?.message || String(e)), true);
    return;
  }

  const wsUrl = signalingURL();
  log.info('main', 'boot', 'connecting to signaling', { url: wsUrl });
  network.connect(wsUrl);

  // ── Reconnect when browser reports online ────────────────────────────────
  window.addEventListener('online', () => {
    log.info('main', 'network-online', 'browser online event — reconnecting signaling');
    network.connect(wsUrl);
  });

  window.addEventListener('offline', () => {
    log.warn('main', 'network-offline', 'browser offline event');
  });

  // ── Reconnect on page becoming visible (device wake / tab switch) ────────
  // This is the #1 cause of "stuck connection" — device sleeps, WS dies,
  // RTCPeerConnection sometimes doesn't fire state changes until activity.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    log.info('main', 'visibilitychange', 'page visible — refreshing signaling');
    // Only re-connect WS; the heartbeat in webrtc.js handles P2P channels.
    if (!network._wsOK) {
      network.connect(wsUrl);
    }
  });

  // ── Wire log export to net-log panel (long-press) ────────────────────────
  const netLog = document.getElementById('net-log');
  if (netLog) {
    let pressTimer = null;
    const startPress = () => {
      pressTimer = setTimeout(() => {
        log.info('main', 'log-export', 'log export triggered via long-press');
        log.exportToFile(identity.fingerprint);
      }, 1500);
    };
    const clearPress = () => { clearTimeout(pressTimer); };
    netLog.addEventListener('mousedown',  startPress);
    netLog.addEventListener('touchstart', startPress, { passive: true });
    netLog.addEventListener('mouseup',    clearPress);
    netLog.addEventListener('mouseleave', clearPress);
    netLog.addEventListener('touchend',   clearPress);

    // Show hint in log panel
    const hint = document.createElement('div');
    hint.className = 'entry';
    hint.style.cssText = 'color:#1d4440;font-size:.5rem;';
    hint.textContent = 'long-press to export diagnostic log';
    netLog.appendChild(hint);
  }
}

boot().catch((e) => {
  console.error('[TQ] fatal boot error:', e);
  log.error('main', 'boot.catch', 'fatal: ' + e.message, { stack: e.stack?.slice(0, 400) });
  fatal('Fatal: ' + (e?.message || String(e)), true);
});

window.addEventListener('beforeunload', () => {
  log.info('main', 'beforeunload', 'page unloading');
  try { networkRef?.destroy?.(); } catch {}
});

window.addEventListener('unhandledrejection', (ev) => {
  console.error('[TQ] unhandled rejection:', ev.reason);
  // TQLog already captures this in its global binding — no double-log needed
});
