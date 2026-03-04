/**
 * main.js — Turquoise
 * Boot sequence: checks -> SW -> identity -> network -> app -> connect
 */

import { getIdentity } from './identity.js';
import { TurquoiseNetwork } from './webrtc.js';
import { TurquoiseApp } from './app.js';

let networkRef = null;

function checkAPIs() {
  const missing = [];
  if (!window.indexedDB) missing.push('IndexedDB');
  if (!window.crypto?.subtle) missing.push('crypto.subtle (needs HTTPS)');
  if (!window.RTCPeerConnection) missing.push('WebRTC');
  if (!window.WebSocket) missing.push('WebSocket');
  return missing;
}

function fatal(msg) {
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.padding = '2rem';
  wrap.style.fontFamily = 'monospace';
  wrap.style.color = '#e05040';
  wrap.style.fontSize = '.9rem';

  const title = document.createElement('div');
  title.style.letterSpacing = '.2em';
  title.style.marginBottom = '1rem';
  title.textContent = 'TURQUOISE - startup error';

  const body = document.createElement('div');
  body.style.opacity = '.85';
  body.textContent = msg;

  wrap.appendChild(title);
  wrap.appendChild(body);
  root.appendChild(wrap);
}

function signalingURL() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (e) {
    console.warn('[TQ] service worker register failed:', e?.message || e);
  }
}

async function boot() {
  const missing = checkAPIs();
  if (missing.length) {
    fatal('Missing APIs: ' + missing.join(', '));
    return;
  }

  registerSW().catch(() => {});

  let identity;
  try {
    identity = await getIdentity();
  } catch (e) {
    fatal('Identity failed: ' + (e?.message || e));
    return;
  }

  let network;
  try {
    network = new TurquoiseNetwork(identity);
    networkRef = network;
  } catch (e) {
    fatal('Network init failed: ' + (e?.message || e));
    return;
  }

  try {
    const app = new TurquoiseApp(identity, network);
    await app.mount();
  } catch (e) {
    console.error(e);
    fatal('App failed: ' + (e?.message || e));
    return;
  }

  network.connect(signalingURL());
}

boot().catch((e) => fatal('Fatal: ' + (e?.message || e)));

window.addEventListener('beforeunload', () => {
  try { networkRef?.destroy?.(); } catch {}
});

window.addEventListener('unhandledrejection', (ev) => {
  console.error('Unhandled rejection:', ev.reason);
});
