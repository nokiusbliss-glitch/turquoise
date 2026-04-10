window.__tqBoot = window.__tqBoot || {
  started: false,
  mounted: false,
  failed: false,
  rescuing: false,
};

function setBootStatus(text, cls='') {
  const el = document.getElementById('status-line');
  if (!el) return;
  el.textContent = text;
  el.className = cls;
}

async function recoverBoot(reason) {
  const state = window.__tqBoot || (window.__tqBoot = {});
  if (state.rescuing) return;
  state.rescuing = true;
  console.warn('[TQ] boot recovery:', reason);
  setBootStatus('recovering Turquoise...', 'warn');

  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all((regs || []).map(r => r.unregister().catch(() => false)));
    }
  } catch {}

  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k).catch(() => false)));
    }
  } catch {}

  const url = new URL(location.href);
  const attempts = Number(url.searchParams.get('tq_recover') || 0);
  if (attempts >= 1) {
    state.failed = true;
    state.rescuing = false;
    setBootStatus('Turquoise needs one manual refresh', 'err');
    return;
  }
  url.searchParams.set('tq_recover', String(attempts + 1));
  url.searchParams.set('tq_v', String(Date.now()));
  location.replace(url.toString());
}

window.__tqRecoverBoot = recoverBoot;

setTimeout(() => {
  const state = window.__tqBoot || {};
  if (!document.hidden && !state.started && !state.mounted && !state.failed) {
    recoverBoot('boot never started');
  }
}, 3500);

setTimeout(() => {
  const state = window.__tqBoot || {};
  const stalled = document.getElementById('status-line')?.textContent?.trim() === 'initialising…';
  if (!document.hidden && stalled && !state.mounted && !state.failed) {
    recoverBoot('boot stalled on shell');
  }
}, 12000);

window.__tqBoot.started = true;
import('/main.js?tqv=20260411c').catch(err => {
  console.error('[TQ] main import failed:', err);
  window.__tqBoot.failed = true;
  recoverBoot('main import failed');
});
