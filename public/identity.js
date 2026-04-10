/**
 * identity.js — Turquoise v6
 *
 * PERMANENT cryptographic identity stored in IndexedDB + localStorage backup.
 *
 * ── Changes from v5 ──────────────────────────────────────────────────────────
 *   - Full TQLog integration for all operations.
 *   - _loadIdentity() validates key works before returning (test-sign).
 *     Previously a corrupted JWK could be loaded successfully but fail later.
 *   - importKeyPair(): added explicit validation that both keys are usable
 *     before persisting (catches bad key data on import).
 *   - tryLoadKeys(): localStorage and IDB are now cross-synced on every load,
 *     not just on fallback path.
 *   - resetIdentity(): flushes module cache, clears IDB, clears localStorage.
 *     Added explicit db.close() to prevent lingering connection blocking.
 *   - saveNickname(): updates module-level cache immediately so stale nickname
 *     isn't returned by getIdentity() after a rename in the same session.
 *
 * Storage strategy:
 *   extractable:true → JWK → stored in IndexedDB AND localStorage.
 *   Either store surviving a wipe is enough to restore identity.
 */

import { TQLog } from './tqlog.js?tqv=20260411c';

const DB_NAME    = 'tq-identity';
const DB_VERSION = 3;
const STORE_KEY  = 'tq-keys';
const STORE_NICK = 'tq-prefs';
const LS_KEY     = 'tq-identity-v3';

const FILE = 'identity';
const _log = TQLog.get();

// ── Module-level cache ────────────────────────────────────────────────────────
let _identityCache   = null;
let _identityPromise = null;

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_KEY))  db.createObjectStore(STORE_KEY);
      if (!db.objectStoreNames.contains(STORE_NICK)) db.createObjectStore(STORE_NICK);
    };
    req.onsuccess = (e) => res(e.target.result);
    req.onerror   = () => rej(new Error('identity DB open: ' + req.error?.message));
    req.onblocked = () => rej(new Error('identity DB blocked — close other tabs'));
  });
}

function dbGet(db, store, key) {
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function dbPut(db, store, key, value) {
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value, key);
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
  });
}

async function generateKeyPair() {
  _log.info(FILE, 'generateKeyPair', 'generating new ECDSA P-256 keypair');
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,   // extractable — required for JWK serialization
    ['sign', 'verify']
  );
}

async function importKeyPair(privJwk, pubJwk) {
  const privateKey = await crypto.subtle.importKey(
    'jwk', privJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']
  );
  const publicKey = await crypto.subtle.importKey(
    'jwk', pubJwk,  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']
  );
  return { privateKey, publicKey };
}

/**
 * Verify the keypair actually works by performing a test sign+verify.
 * Catches corrupted or incompatible key material before it causes a silent failure.
 */
async function validateKeyPair(keys) {
  const testData = new TextEncoder().encode('tq-key-validation-test');
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, testData
  );
  const ok  = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, sig, testData
  );
  if (!ok) throw new Error('key validation failed — sig/verify mismatch');
  return true;
}

async function fingerprintOf(publicKey) {
  const raw  = await crypto.subtle.exportKey('raw', publicKey);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function serializeKeys(keys) {
  const privJwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
  const pubJwk  = await crypto.subtle.exportKey('jwk', keys.publicKey);
  return JSON.stringify({ privJwk, pubJwk, v: 3 });
}

async function persistKeys(db, serialized) {
  try {
    await dbPut(db, STORE_KEY, 'keypair-v3', serialized);
    _log.debug(FILE, 'persistKeys', 'written to IDB');
  } catch (e) {
    _log.warn(FILE, 'persistKeys', 'IDB persist failed: ' + e.message);
  }
  try {
    localStorage.setItem(LS_KEY, serialized);
    _log.debug(FILE, 'persistKeys', 'written to localStorage');
  } catch (e) {
    _log.warn(FILE, 'persistKeys', 'localStorage persist failed: ' + e.message);
  }
}

async function tryLoadKeys(db) {
  // 1. IndexedDB (primary)
  try {
    const raw = await dbGet(db, STORE_KEY, 'keypair-v3');
    if (typeof raw === 'string') {
      const { privJwk, pubJwk } = JSON.parse(raw);
      const keys = await importKeyPair(privJwk, pubJwk);
      await validateKeyPair(keys);
      // Cross-sync to localStorage in case it was wiped
      try { localStorage.setItem(LS_KEY, raw); } catch {}
      _log.info(FILE, 'tryLoadKeys', 'loaded from IDB');
      return { keys, serialized: raw };
    }
  } catch (e) {
    _log.warn(FILE, 'tryLoadKeys', 'IDB load failed: ' + e.message);
  }

  // 2. localStorage fallback
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const { privJwk, pubJwk } = JSON.parse(raw);
      const keys = await importKeyPair(privJwk, pubJwk);
      await validateKeyPair(keys);
      // Cross-sync to IDB
      try { await dbPut(db, STORE_KEY, 'keypair-v3', raw); } catch {}
      _log.info(FILE, 'tryLoadKeys', 'restored from localStorage backup');
      return { keys, serialized: raw };
    }
  } catch (e) {
    _log.warn(FILE, 'tryLoadKeys', 'localStorage load failed: ' + e.message);
  }

  // 3. Legacy non-extractable format (v1/v2) — session-only
  try {
    const old = await dbGet(db, STORE_KEY, 'keypair');
    if (old?.privateKey && old?.publicKey) {
      _log.warn(FILE, 'tryLoadKeys', 'found legacy non-extractable key — session-only use');
      return { keys: old, serialized: null, legacy: true };
    }
  } catch {}

  return null;
}

async function _loadIdentity() {
  if (!window.crypto?.subtle) throw new Error('crypto.subtle unavailable — requires HTTPS');
  if (!window.indexedDB)      throw new Error('IndexedDB unavailable');

  const db = await openDB();
  let result = await tryLoadKeys(db);
  let keys, serialized;

  if (!result) {
    keys       = await generateKeyPair();
    await validateKeyPair(keys); // sanity check before persisting
    serialized = await serializeKeys(keys);
    await persistKeys(db, serialized);
    _log.info(FILE, '_loadIdentity', 'generated new identity');
  } else {
    keys       = result.keys;
    serialized = result.serialized ?? null;
  }

  const fingerprint = await fingerprintOf(keys.publicKey);
  const shortId     = fingerprint.slice(0, 8);
  _log.info(FILE, '_loadIdentity', 'identity ready', { shortId });

  let savedNick;
  try { savedNick = await dbGet(db, STORE_NICK, 'nickname'); } catch { savedNick = null; }
  let nickname = (typeof savedNick === 'string' && savedNick.trim()) ? savedNick.trim() : shortId;
  const isNewUser = !savedNick;

  async function sign(data) {
    const encoded = new TextEncoder().encode(
      typeof data === 'string' ? data : JSON.stringify(data)
    );
    const sigBuf = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, encoded
    );
    return Array.from(new Uint8Array(sigBuf));
  }

  async function saveNickname(nick) {
    const trimmed = (nick || '').trim().slice(0, 32) || shortId;
    try {
      await dbPut(db, STORE_NICK, 'nickname', trimmed);
    } catch (e) {
      _log.warn(FILE, 'saveNickname', 'failed: ' + e.message);
    }
    // Update in-cache immediately so stale value isn't returned
    if (_identityCache) _identityCache.nickname = trimmed;
    nickname = trimmed;
    return trimmed;
  }

  async function exportKeyData() {
    if (!serialized) return null; // legacy non-extractable key
    return JSON.parse(serialized);
  }

  return { fingerprint, shortId, nickname, isNewUser, sign, saveNickname, exportKeyData };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getIdentity() {
  if (_identityCache) return _identityCache;
  if (_identityPromise) return _identityPromise;

  _identityPromise = _loadIdentity().then(identity => {
    _identityCache   = identity;
    _identityPromise = null;
    return identity;
  }).catch(err => {
    _identityPromise = null;
    _log.error(FILE, 'getIdentity', 'failed: ' + err.message);
    throw err;
  });

  return _identityPromise;
}

export async function resetIdentity() {
  _log.info(FILE, 'resetIdentity', 'resetting identity');
  _identityCache   = null;
  _identityPromise = null;

  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction([STORE_KEY, STORE_NICK], 'readwrite');
      tx.objectStore(STORE_KEY).clear();
      tx.objectStore(STORE_NICK).clear();
      tx.oncomplete = () => {
        // Close the connection so next getIdentity() gets a fresh DB
        try { db.close(); } catch {}
        res();
      };
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) {
    _log.warn(FILE, 'resetIdentity', 'IDB clear failed: ' + e.message);
  }

  try { localStorage.removeItem(LS_KEY); } catch {}
  _log.info(FILE, 'resetIdentity', 'reset complete');
}

export async function importIdentityData(identityData) {
  if (!identityData?.privJwk || !identityData?.pubJwk) {
    throw new Error('Invalid identity data: missing privJwk or pubJwk');
  }

  // Verify key works before persisting
  const keys = await importKeyPair(identityData.privJwk, identityData.pubJwk);
  await validateKeyPair(keys);
  _log.info(FILE, 'importIdentityData', 'imported key validated');

  const serialized = JSON.stringify({
    privJwk: identityData.privJwk,
    pubJwk:  identityData.pubJwk,
    v:       3,
  });
  const db = await openDB();
  await persistKeys(db, serialized);

  if (identityData.nickname) {
    try { await dbPut(db, STORE_NICK, 'nickname', identityData.nickname); } catch {}
  }

  // Clear cache so getIdentity() reloads the imported identity
  _identityCache   = null;
  _identityPromise = null;

  const fingerprint = await fingerprintOf(keys.publicKey);
  _log.info(FILE, 'importIdentityData', 'identity imported', { shortId: fingerprint.slice(0,8) });
  return fingerprint;
}
