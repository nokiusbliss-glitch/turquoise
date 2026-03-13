/**
 * tqlog.js — Turquoise Black Box Logger v1
 *
 * Records every significant action in the app to IndexedDB with a ring buffer.
 * Like a flight recorder: always running, minimum overhead, maximum detail.
 * Upload the exported log to diagnose issues without needing a developer console.
 *
 * Design:
 *   - Ring buffer of MAX_ENTRIES (5000) in IndexedDB, oldest pruned automatically
 *   - In-memory write queue (batched every 300ms) — never blocks the call path
 *   - Structured entries: { ts, level, file, fn, msg, data }
 *   - Export to JSON with device fingerprint, app version, platform info
 *   - Session ID ties all entries in one page-load together
 *   - Errors auto-captured from window.onerror + unhandledrejection
 *   - Never throws — all internal failures are silently swallowed
 *
 * Usage:
 *   import { TQLog } from './tqlog.js';
 *
 *   // Get the singleton (auto-initialises)
 *   const log = TQLog.get();
 *
 *   // Log at different levels
 *   log.info('webrtc', '_initiate', 'connecting to peer', { fp: fp.slice(0,8) });
 *   log.warn('files', '_sendOne', 'DataChannel backpressure high');
 *   log.error('identity', 'getIdentity', 'IDB open failed', { err: e.message });
 *   log.debug('messages', 'saveMessage', 'wrote msg', { id });
 *
 *   // Export full log as downloadable JSON
 *   await log.exportToFile();
 *
 *   // Read recent entries (for in-app log viewer)
 *   const entries = await log.read(200);
 */

const DB_NAME       = 'tq-log';
const DB_VERSION    = 1;
const STORE         = 'entries';
const MAX_ENTRIES   = 5000;
const BATCH_DELAY   = 300;   // ms — write queue flush interval
const APP_VERSION   = '6.0.0';

// ── Levels ─────────────────────────────────────────────────────────────────────
export const LEVEL = Object.freeze({ DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 });
const LEVEL_NAME   = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

// ── Session ID — unique per page load ─────────────────────────────────────────
const SESSION_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ── Singleton ──────────────────────────────────────────────────────────────────
let _instance = null;

export class TQLog {
  constructor() {
    this._db         = null;
    this._dbPromise  = null;
    this._queue      = [];        // pending entries awaiting flush
    this._flushTimer = null;
    this._seq        = 0;         // monotonic counter within session
    this._minLevel   = LEVEL.DEBUG;

    // Bind global error capture
    this._bindGlobals();

    // Start IDB open in background — writes queue until ready
    this._openDB().catch(() => {}); // never throws
  }

  /** Get or create the singleton instance. */
  static get() {
    if (!_instance) _instance = new TQLog();
    return _instance;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  debug(file, fn, msg, data)  { this._write(LEVEL.DEBUG, file, fn, msg, data); }
  info (file, fn, msg, data)  { this._write(LEVEL.INFO,  file, fn, msg, data); }
  warn (file, fn, msg, data)  { this._write(LEVEL.WARN,  file, fn, msg, data); }
  error(file, fn, msg, data)  { this._write(LEVEL.ERROR, file, fn, msg, data); }

  /** Set minimum level to record (e.g. LEVEL.INFO skips DEBUG) */
  setMinLevel(level) {
    this._minLevel = level;
  }

  /**
   * Read the most recent `limit` entries from the log.
   * Returns newest-first.
   */
  async read(limit = 100) {
    try {
      const db      = await this._openDB();
      const entries = await this._idbGetAll(db);
      return entries
        .sort((a, b) => b.ts - a.ts || b.seq - a.seq)
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * Export the full log as a downloadable JSON file.
   * Includes device info and current app state snapshot.
   */
  async exportToFile(fingerprint = null) {
    try {
      const entries = await this.read(MAX_ENTRIES);
      const payload = {
        tqLogVersion: 1,
        appVersion:   APP_VERSION,
        exportedAt:   new Date().toISOString(),
        sessionId:    SESSION_ID,
        deviceFingerprint: fingerprint,
        platform: {
          ua:       navigator.userAgent,
          lang:     navigator.language,
          online:   navigator.onLine,
          cores:    navigator.hardwareConcurrency,
          memory:   navigator.deviceMemory,
          screen:   `${screen.width}×${screen.height}@${devicePixelRatio}`,
          protocol: location.protocol,
          host:     location.host,
        },
        entryCount: entries.length,
        entries:    entries.reverse(), // chronological order for reading
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `tq-log-${SESSION_ID}-${Date.now()}.json`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
      this.info('tqlog', 'exportToFile', `exported ${entries.length} entries`);
    } catch (e) {
      console.warn('[TQLog] export failed:', e?.message);
    }
  }

  /**
   * Clear all log entries (e.g. on identity reset).
   */
  async clear() {
    try {
      const db = await this._openDB();
      await new Promise((res, rej) => {
        const tx  = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).clear();
        tx.oncomplete = () => res();
        tx.onerror    = () => rej(tx.error);
      });
    } catch {}
  }

  // ── Internal write path ───────────────────────────────────────────────────────

  _write(level, file, fn, msg, data) {
    if (level < this._minLevel) return;

    const entry = {
      // IDB key: ts + seq ensures uniqueness and chronological cursor traversal
      id:      `${SESSION_ID}:${String(this._seq++).padStart(6, '0')}`,
      session: SESSION_ID,
      ts:      Date.now(),
      seq:     this._seq,
      level,
      levelName: LEVEL_NAME[level] || 'UNKNOWN',
      file:    file  || '?',
      fn:      fn    || '?',
      msg:     String(msg || ''),
      data:    data !== undefined ? this._safeData(data) : undefined,
    };

    // Console mirror — use native levels
    const pfx = `[TQ:${file}:${fn}]`;
    if      (level === LEVEL.ERROR) console.error(pfx, msg, data ?? '');
    else if (level === LEVEL.WARN)  console.warn (pfx, msg, data ?? '');
    else if (level === LEVEL.DEBUG) console.debug(pfx, msg, data ?? '');
    else                            console.log  (pfx, msg, data ?? '');

    this._queue.push(entry);
    this._scheduleFlush();
  }

  _safeData(raw) {
    if (raw === null || raw === undefined) return raw;
    try {
      // Ensure it's serialisable; strip circular refs
      return JSON.parse(JSON.stringify(raw, (_, v) => {
        if (v instanceof Error)      return { errorName: v.name, errorMsg: v.message };
        if (v instanceof ArrayBuffer) return `<ArrayBuffer ${v.byteLength}B>`;
        if (typeof v === 'function') return '<function>';
        return v;
      }));
    } catch {
      return String(raw);
    }
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flush().catch(() => {});
    }, BATCH_DELAY);
  }

  async _flush() {
    if (!this._queue.length) return;
    const batch = this._queue.splice(0); // drain queue atomically
    try {
      const db = await this._openDB();
      await this._idbPutBatch(db, batch);
      await this._pruneIfNeeded(db);
    } catch {
      // Re-queue on failure so logs aren't lost
      this._queue.unshift(...batch);
    }
  }

  // ── IndexedDB helpers ─────────────────────────────────────────────────────────

  _openDB() {
    if (this._db) return Promise.resolve(this._db);
    if (this._dbPromise) return this._dbPromise;

    this._dbPromise = new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id' });
          s.createIndex('by-ts',      'ts',      { unique: false });
          s.createIndex('by-session', 'session', { unique: false });
          s.createIndex('by-level',   'level',   { unique: false });
        }
      };
      req.onsuccess = (e) => {
        this._db = e.target.result;
        this._db.onclose  = () => { this._db = null; this._dbPromise = null; };
        this._db.onerror  = () => { this._db = null; this._dbPromise = null; };
        this._dbPromise = null;
        res(this._db);
      };
      req.onerror = () => {
        this._dbPromise = null;
        rej(new Error('TQLog IDB open: ' + req.error?.message));
      };
      req.onblocked = () => {
        this._dbPromise = null;
        rej(new Error('TQLog IDB blocked'));
      };
    });

    return this._dbPromise;
  }

  _idbPutBatch(db, entries) {
    return new Promise((res, rej) => {
      const tx    = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      entries.forEach(e => { try { store.put(e); } catch {} });
      tx.oncomplete = () => res();
      tx.onerror    = () => rej(tx.error);
    });
  }

  _idbGetAll(db) {
    return new Promise((res, rej) => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
  }

  async _pruneIfNeeded(db) {
    // Count entries; if over limit, delete oldest by timestamp
    const count = await new Promise((res, rej) => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => res(req.result || 0);
      req.onerror   = () => rej(req.error);
    });

    if (count <= MAX_ENTRIES) return;

    const excess = count - MAX_ENTRIES;
    await new Promise((res, rej) => {
      const tx  = db.transaction(STORE, 'readwrite');
      // Cursor by 'by-ts' index in ascending order — oldest first
      const req = tx.objectStore(STORE).index('by-ts').openCursor();
      let   deleted = 0;
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor || deleted >= excess) { res(); return; }
        cursor.delete();
        deleted++;
        cursor.continue();
      };
      req.onerror = () => rej(req.error);
    });
  }

  // ── Global error capture ──────────────────────────────────────────────────────

  _bindGlobals() {
    // Already captured by main.js unhandledrejection — but also capture here
    // with structured data so the log pinpoints the source.
    const origOnError = window.onerror;
    window.onerror = (msg, src, line, col, err) => {
      this._write(LEVEL.ERROR, 'GLOBAL', 'onerror',
        `Uncaught: ${msg}`,
        { src: src?.replace(location.origin, ''), line, col, err: err?.stack?.slice(0, 400) }
      );
      return origOnError ? origOnError(msg, src, line, col, err) : false;
    };

    const origOnRejection = window.onunhandledrejection;
    window.addEventListener('unhandledrejection', (ev) => {
      const r = ev.reason;
      this._write(LEVEL.ERROR, 'GLOBAL', 'unhandledRejection',
        'Unhandled Promise rejection',
        { reason: r instanceof Error ? { name: r.name, msg: r.message, stack: r.stack?.slice(0, 400) } : String(r) }
      );
    });

    // Capture visibility/online changes — key for diagnosing connection drops
    document.addEventListener('visibilitychange', () => {
      this._write(LEVEL.INFO, 'GLOBAL', 'visibilitychange',
        `page ${document.hidden ? 'hidden' : 'visible'}`, { ts: Date.now() });
    });

    window.addEventListener('online',  () => this._write(LEVEL.INFO,  'GLOBAL', 'network', 'browser: ONLINE'));
    window.addEventListener('offline', () => this._write(LEVEL.WARN,  'GLOBAL', 'network', 'browser: OFFLINE'));
    window.addEventListener('beforeunload', () => {
      this._write(LEVEL.INFO, 'GLOBAL', 'beforeunload', 'page unloading');
      // Flush synchronously on unload (best-effort)
      if (this._queue.length && this._db) {
        try {
          const tx    = this._db.transaction(STORE, 'readwrite');
          const store = tx.objectStore(STORE);
          this._queue.forEach(e => { try { store.put(e); } catch {} });
        } catch {}
      }
    });
  }
}

// ── Convenience: instrument a class method with automatic log calls ──────────
/**
 * Wrap a class instance's methods to auto-log entry/exit and errors.
 * Only wraps methods listed in `methodNames`.
 *
 * @param {object} instance
 * @param {string} fileName
 * @param {string[]} methodNames
 * @param {TQLog} logger
 */
export function instrumentClass(instance, fileName, methodNames, logger) {
  const log = logger || TQLog.get();
  for (const name of methodNames) {
    const orig = instance[name];
    if (typeof orig !== 'function') continue;
    instance[name] = function (...args) {
      log.debug(fileName, name, 'call', args.length > 0 ? { argc: args.length } : undefined);
      let result;
      try {
        result = orig.apply(this, args);
      } catch (e) {
        log.error(fileName, name, 'threw: ' + e.message);
        throw e;
      }
      if (result && typeof result.then === 'function') {
        return result.catch(e => {
          log.error(fileName, name, 'rejected: ' + e.message);
          throw e;
        });
      }
      return result;
    };
  }
}
