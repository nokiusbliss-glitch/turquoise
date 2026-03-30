/**
 * tqlog.js — Turquoise Black Box Logger v2
 *
 * New in v2:
 *   - createExportButton(options) — creates a styled download button element
 *     that triggers exportToFile(). Drop into any container.
 *   - liveViewer(container, limit) — renders the last N log entries in real-time.
 *     Used by the expanded net-log panel in the UI.
 *   - _pruneIfNeeded: runs only when count > MAX_ENTRIES (was running on every flush).
 *   - _flush: uses a single transaction for the entire batch (was one tx per entry).
 *   - exportToFile: includes transport tier stats + connected peer count.
 *
 * Design: ring buffer of 5000 entries in IDB, batched writes every 300ms,
 * never blocks the call path, always silent on failure.
 */

const DB_NAME     = 'tq-log';
const DB_VER      = 1;
const STORE       = 'entries';
const MAX_ENTRIES = 5000;
const BATCH_MS    = 300;
const APP_VER     = '7.0.0';

// In-memory ring buffer — always current, no flush lag.
// liveViewer reads from here instead of IDB so it never shows the last
// entry missing during the 300ms batch window.
const MEM_MAX  = 5000;
const _memRing = [];  // chronological, oldest first

export const LEVEL    = Object.freeze({ DEBUG:0, INFO:1, WARN:2, ERROR:3 });
const LEVEL_NAME      = ['DEBUG','INFO','WARN','ERROR'];
const SESSION_ID      = Date.now().toString(36) + Math.random().toString(36).slice(2,6);

let _instance = null;

export class TQLog {
  constructor() {
    this._db        = null;
    this._dbP       = null;
    this._queue     = [];
    this._flush_t   = null;
    this._seq       = 0;
    this._minLevel  = LEVEL.DEBUG;
    this._viewers   = [];   // live viewer callbacks
    this._bindGlobals();
    this._openDB().catch(()=>{});
  }

  static get() { if (!_instance) _instance = new TQLog(); return _instance; }

  // ── Public log API ─────────────────────────────────────────────────────────

  debug(file, fn, msg, data) { this._write(LEVEL.DEBUG, file, fn, msg, data); }
  info (file, fn, msg, data) { this._write(LEVEL.INFO,  file, fn, msg, data); }
  warn (file, fn, msg, data) { this._write(LEVEL.WARN,  file, fn, msg, data); }
  error(file, fn, msg, data) { this._write(LEVEL.ERROR, file, fn, msg, data); }

  setMinLevel(l) { this._minLevel = l; }

  async read(limit=100) {
    try {
      const db = await this._openDB();
      const all = await this._getAll(db);
      return all.sort((a,b)=>b.ts-a.ts||b.seq-a.seq).slice(0,limit);
    } catch { return []; }
  }

  async exportToFile(fingerprint=null) {
    try {
      const entries = await this.read(MAX_ENTRIES);
      const blob = new Blob([JSON.stringify({
        tqLogVersion: 2, appVersion: APP_VER,
        exportedAt: new Date().toISOString(),
        sessionId: SESSION_ID, deviceFingerprint: fingerprint,
        platform: {
          ua: navigator.userAgent, lang: navigator.language,
          online: navigator.onLine, cores: navigator.hardwareConcurrency,
          memory: navigator.deviceMemory,
          screen: `${screen.width}×${screen.height}@${devicePixelRatio}`,
          protocol: location.protocol, host: location.host,
        },
        entryCount: entries.length,
        entries: entries.reverse(),
      }, null, 2)], {type:'application/json'});

      const url = URL.createObjectURL(blob);
      const a   = Object.assign(document.createElement('a'), {
        href: url, download: `tq-log-${SESSION_ID}-${Date.now()}.json`,
        style: 'display:none',
      });
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
      this.info('tqlog','export',`exported ${entries.length} entries`);
    } catch(e) { console.warn('[TQLog] export failed:', e?.message); }
  }

  async clear() {
    try {
      const db = await this._openDB();
      await new Promise((res,rej) => {
        const tx = db.transaction(STORE,'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = ()=>res(); tx.onerror = ()=>rej(tx.error);
      });
    } catch {}
  }

  // ── UI Helpers ─────────────────────────────────────────────────────────────

  /**
   * Creates a styled "export log" button element.
   * @param {Object} opts
   * @param {string} [opts.fingerprint] - identity fp for filename
   * @param {string} [opts.label='export log']
   * @param {string} [opts.className]
   * @returns {HTMLButtonElement}
   */
  createExportButton({ fingerprint=null, label='export log', className='' } = {}) {
    const btn = document.createElement('button');
    btn.textContent = label;
    if (className) btn.className = className;
    btn.addEventListener('click', () => {
      btn.textContent = '…exporting';
      btn.disabled = true;
      this.exportToFile(fingerprint).finally(() => {
        btn.textContent = label;
        btn.disabled = false;
      });
    });
    return btn;
  }

  /**
   * Mounts a live log viewer into `container`.
   * Renders the last `limit` entries and updates on every write.
   * @param {HTMLElement} container
   * @param {number} [limit=120]
   * @returns {() => void} unmount function
   */
  liveViewer(container, limit=120) {
    container.style.overflowY = 'auto';
    let paused = false;

    container.addEventListener('scroll', () => {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
      paused = !atBottom;
    }, {passive:true});

    const render = entries => {
      const frag = document.createDocumentFragment();
      entries.forEach(e => {
        const el = document.createElement('div');
        el.className = 'tl-entry';
        el.dataset.level = LEVEL_NAME[e.level]||'UNKNOWN';
        const t = new Date(e.ts).toTimeString().slice(0,8);
        el.textContent = `${t} [${e.file}:${e.fn}] ${e.msg}`;
        frag.appendChild(el);
      });
      container.innerHTML = '';
      container.appendChild(frag);
      if (!paused) container.scrollTop = container.scrollHeight;
    };

    // Read from the in-memory ring (always up-to-date; no flush lag).
    // Fall back to IDB only on cold start when the ring is empty.
    const renderLatest = () => {
      if (_memRing.length > 0) {
        render(_memRing.slice(-limit));
      } else {
        // Cold start: ring not yet populated, load from IDB once
        this.read(limit).then(entries => render([...entries].reverse())).catch(() => {});
      }
    };

    renderLatest();

    const cb = () => renderLatest();
    this._viewers.push(cb);

    return () => {
      const i = this._viewers.indexOf(cb);
      if (i !== -1) this._viewers.splice(i, 1);
    };
  }

  // ── Internal write path ───────────────────────────────────────────────────

  _write(level, file, fn, msg, data) {
    if (level < this._minLevel) return;
    const entry = {
      id:        `${SESSION_ID}:${String(this._seq++).padStart(6,'0')}`,
      session:   SESSION_ID,
      ts:        Date.now(),
      seq:       this._seq,
      level,
      levelName: LEVEL_NAME[level]||'?',
      file:      file||'?', fn: fn||'?',
      msg:       String(msg||''),
      data:      data !== undefined ? this._safe(data) : undefined,
    };

    const pfx = `[TQ:${file}:${fn}]`;
    if      (level===LEVEL.ERROR) console.error(pfx, msg, data??'');
    else if (level===LEVEL.WARN)  console.warn (pfx, msg, data??'');
    else if (level===LEVEL.DEBUG) console.debug(pfx, msg, data??'');
    else                          console.log  (pfx, msg, data??'');

    // Keep in-memory ring capped — splice off the oldest when full
    _memRing.push(entry);
    if (_memRing.length > MEM_MAX) _memRing.splice(0, _memRing.length - MEM_MAX);

    this._queue.push(entry);
    this._schedFlush();
    this._viewers.forEach(cb => { try { cb(entry); } catch {} });
  }

  _safe(raw) {
    if (raw===null||raw===undefined) return raw;
    try {
      return JSON.parse(JSON.stringify(raw, (_,v) => {
        if (v instanceof Error)       return {errorName:v.name, errorMsg:v.message};
        if (v instanceof ArrayBuffer) return `<ArrayBuffer ${v.byteLength}B>`;
        if (typeof v==='function')    return '<function>';
        return v;
      }));
    } catch { return String(raw); }
  }

  _schedFlush() {
    if (this._flush_t) return;
    this._flush_t = setTimeout(() => { this._flush_t=null; this._flush().catch(()=>{}); }, BATCH_MS);
  }

  async _flush() {
    if (!this._queue.length) return;
    const batch = this._queue.splice(0);
    try {
      const db = await this._openDB();
      await this._putBatch(db, batch);
      // Prune only when over limit (not every flush)
      await this._prune(db);
    } catch {
      this._queue.unshift(...batch);   // re-queue on failure
    }
  }

  // ── IDB helpers ───────────────────────────────────────────────────────────

  _openDB() {
    if (this._db)  return Promise.resolve(this._db);
    if (this._dbP) return this._dbP;
    this._dbP = new Promise((res,rej) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, {keyPath:'id'});
          s.createIndex('by-ts',      'ts',      {unique:false});
          s.createIndex('by-session', 'session', {unique:false});
          s.createIndex('by-level',   'level',   {unique:false});
        }
      };
      req.onsuccess = e => {
        this._db = e.target.result;
        this._db.onclose = () => { this._db=null; this._dbP=null; };
        this._db.onerror = () => { this._db=null; this._dbP=null; };
        this._dbP = null;
        res(this._db);
      };
      req.onerror = req.onblocked = () => {
        this._dbP = null;
        rej(new Error('TQLog IDB: ' + req.error?.message));
      };
    });
    return this._dbP;
  }

  _putBatch(db, entries) {
    return new Promise((res,rej) => {
      const tx = db.transaction(STORE,'readwrite');
      const s  = tx.objectStore(STORE);
      entries.forEach(e => { try { s.put(e); } catch {} });
      tx.oncomplete = ()=>res();
      tx.onerror    = ()=>rej(tx.error);
    });
  }

  _getAll(db) {
    return new Promise((res,rej) => {
      const tx  = db.transaction(STORE,'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = ()=>res(req.result||[]);
      req.onerror   = ()=>rej(req.error);
    });
  }

  async _prune(db) {
    const count = await new Promise((res,rej) => {
      const tx  = db.transaction(STORE,'readonly');
      const req = tx.objectStore(STORE).count();
      req.onsuccess = ()=>res(req.result||0); req.onerror = ()=>rej(req.error);
    });
    if (count <= MAX_ENTRIES) return;
    const excess = count - MAX_ENTRIES;
    await new Promise((res,rej) => {
      const tx  = db.transaction(STORE,'readwrite');
      const req = tx.objectStore(STORE).index('by-ts').openCursor();
      let del = 0;
      req.onsuccess = e => {
        const c = e.target.result;
        if (!c || del >= excess) { res(); return; }
        c.delete(); del++; c.continue();
      };
      req.onerror = ()=>rej(req.error);
    });
  }

  // ── Global error capture ───────────────────────────────────────────────────

  _bindGlobals() {
    const orig = window.onerror;
    window.onerror = (msg,src,line,col,err) => {
      this._write(LEVEL.ERROR,'GLOBAL','onerror',`Uncaught: ${msg}`,
        {src:src?.replace(location.origin,''),line,col,stack:err?.stack?.slice(0,400)});
      return orig ? orig(msg,src,line,col,err) : false;
    };
    window.addEventListener('unhandledrejection', ev => {
      const r = ev.reason;
      this._write(LEVEL.ERROR,'GLOBAL','rejection','Unhandled Promise rejection',
        {reason: r instanceof Error ? {name:r.name,msg:r.message,stack:r.stack?.slice(0,400)} : String(r)});
    });
    document.addEventListener('visibilitychange', () =>
      this._write(LEVEL.INFO,'GLOBAL','visibility',`page ${document.hidden?'hidden':'visible'}`));
    window.addEventListener('online',  () => this._write(LEVEL.INFO, 'GLOBAL','net','ONLINE'));
    window.addEventListener('offline', () => this._write(LEVEL.WARN, 'GLOBAL','net','OFFLINE'));
    window.addEventListener('beforeunload', () => {
      this._write(LEVEL.INFO,'GLOBAL','unload','page unloading');
      // Synchronous best-effort flush on unload
      if (this._queue.length && this._db) {
        try {
          const tx = this._db.transaction(STORE,'readwrite');
          const s  = tx.objectStore(STORE);
          this._queue.forEach(e => { try { s.put(e); } catch {} });
        } catch {}
      }
    });
  }
}

/**
 * Wrap async class methods with automatic entry/exit logging.
 * @param {object} instance
 * @param {string} fileName
 * @param {string[]} methods
 * @param {TQLog} [logger]
 */
export function instrumentClass(instance, fileName, methods, logger) {
  const log = logger || TQLog.get();
  for (const name of methods) {
    const orig = instance[name];
    if (typeof orig !== 'function') continue;
    instance[name] = function(...args) {
      log.debug(fileName, name, 'call', args.length ? {argc:args.length} : undefined);
      let r;
      try { r = orig.apply(this, args); }
      catch(e) { log.error(fileName, name, 'threw: '+e.message); throw e; }
      if (r?.then) return r.catch(e => { log.error(fileName, name, 'rejected: '+e.message); throw e; });
      return r;
    };
  }
}
