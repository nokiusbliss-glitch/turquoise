/**
 * main.js — Turquoise v7
 * Boot: API checks → SW → identity → network → app → connect → lifecycle
 *
 * New: TQLog.liveViewer handled by app.js. main.js only sets up the log
 * export button in fatal error screens and the beforeunload cleanup.
 */

import { TQLog }            from './tqlog.js';
import { getIdentity }      from './identity.js';
import { TurquoiseNetwork } from './webrtc.js';
import { TurquoiseApp }     from './app.js';

const log = TQLog.get();
log.info('main', 'boot', 'Turquoise v7 starting', { ua:navigator.userAgent.slice(0,80), protocol:location.protocol });

let _network = null;

// ── Required APIs ─────────────────────────────────────────────────────────────
const REQUIRED = [
  ['IndexedDB',    null,           ()=>!!window.indexedDB],
  ['crypto.subtle','requires HTTPS', ()=>!!window.crypto?.subtle],
  ['WebRTC',       null,           ()=>!!window.RTCPeerConnection],
  ['WebSocket',    null,           ()=>!!window.WebSocket],
];

function missingAPIs() {
  return REQUIRED
    .filter(([,,check]) => !check())
    .map(([name,hint]) => hint ? `${name} (${hint})` : name);
}

function fatal(msg, recoverable=false) {
  log.error('main','fatal',msg);
  const root=document.getElementById('app'); if(!root) return;
  root.innerHTML='';
  const wrap=document.createElement('div');
  wrap.style.cssText='padding:2rem;font-family:"Space Mono",monospace;color:#ff6040;font-size:.85rem;background:#040a09;height:100dvh;';
  wrap.innerHTML=`
    <div style="font-family:Syne,sans-serif;font-weight:800;letter-spacing:.2em;color:#40e0d0;margin-bottom:1.5rem;font-size:1rem">TURQUOISE</div>
    <div style="opacity:.9;margin-bottom:1rem">${msg}</div>`;
  if (recoverable) {
    const row=document.createElement('div'); row.style.cssText='display:flex;gap:8px;margin-top:1rem;';
    const mkBtn=(txt,cls,fn)=>{const b=document.createElement('button');b.textContent=txt;b.style.cssText=`border:1px solid ${cls};background:transparent;color:${cls};cursor:pointer;padding:.35rem .9rem;font-family:inherit;font-size:.75rem;`;b.onclick=fn;return b;};
    row.appendChild(mkBtn('reload','#40e0d0',()=>location.reload()));
    row.appendChild(mkBtn('export log','#1a9e94',()=>log.exportToFile()));
    wrap.appendChild(row);
  }
  root.appendChild(wrap);
}

function sigUrl() {
  return `${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`;
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    reg.addEventListener('updatefound', ()=>log.info('main','sw','update found'));
    log.info('main','sw','registered', {scope:reg.scope});
  } catch(e) { log.warn('main','sw','register failed: '+e.message); }
}

async function boot() {
  const missing = missingAPIs();
  if (missing.length) { fatal('Missing browser APIs: '+missing.join(', ')); return; }
  log.info('main','boot','API checks passed');

  registerSW();   // fire-and-forget

  navigator.storage?.persist().then(ok=>log.info('main','boot',`persistent storage: ${ok?'granted':'denied'}`)).catch(()=>{});

  let identity;
  try   { identity = await getIdentity(); log.info('main','boot','identity ready',{shortId:identity.shortId}); }
  catch (e) { fatal('Identity error: '+(e?.message||e), true); return; }

  let network;
  try   { network = new TurquoiseNetwork(identity); _network = network; }
  catch (e) { fatal('Network init failed: '+(e?.message||e), true); return; }

  let app;
  try   { app = new TurquoiseApp(identity, network); await app.mount(); log.info('main','boot','app mounted'); }
  catch (e) { console.error('[TQ] app mount failed:', e); fatal('App error: '+(e?.message||e), true); return; }

  const wsUrl = sigUrl();
  log.info('main','boot','connecting signaling', {url:wsUrl});
  network.connect(wsUrl);

  // ── Lifecycle reconnects ──────────────────────────────────────────────────
  window.addEventListener('online', () => {
    log.info('main','online','network restored — forcing full reconnect');
    network.forceReconnect();
  });
  window.addEventListener('offline', () => log.warn('main','offline','browser offline'));

  // On device wake / tab restore: always force a hard reconnect.
  // Mobile browsers hold the WS in readyState OPEN even after the TCP
  // connection was killed during sleep.  The old guard (!_wsOK) silently
  // missed this — the socket looked alive but was dead.  We must close it
  // and rebuild every time the page becomes visible.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    log.info('main','visible','page visible — forcing reconnect');
    network.forceReconnect();
  });
}

boot().catch(e => {
  console.error('[TQ] fatal boot error:', e);
  log.error('main','boot.catch','fatal: '+e.message, {stack:e.stack?.slice(0,400)});
  fatal('Fatal: '+(e?.message||e), true);
});

window.addEventListener('beforeunload', () => {
  log.info('main','unload','page unloading');
  try { _network?.destroy?.(); } catch {}
});

window.addEventListener('unhandledrejection', ev => {
  // TQLog._bindGlobals already captures this — just ensure network cleanup
  console.error('[TQ] unhandled rejection:', ev.reason);
});
