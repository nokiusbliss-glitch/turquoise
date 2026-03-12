/**
 * identity.js — Turquoise
 *
 * PERMANENT cryptographic identity stored in IndexedDB + localStorage backup.
 *
 * Fixes:
 *   - Concurrent getIdentity() calls could race and generate two keypairs,
 *     with one overwriting the other. Fix: module-level promise cache so all
 *     concurrent callers await the same single initialization.
 *   - resetIdentity() now clears the in-memory cache so a fresh identity
 *     is created on the next getIdentity() call without a page reload.
 *   - Legacy key comment was misleading: "will regenerate on next reset" was
 *     false — the old key was used indefinitely. Clarified to reflect reality.
 *   - exportKeyData() guarded against legacy non-extractable keys more clearly.
 *
 * Storage strategy:
 *   extractable:true → JWK → stored in IndexedDB AND localStorage.
 *   Either store surviving a wipe is enough to restore identity.
 */

const DB_NAME    = 'tq-identity';
const DB_VERSION = 3;
const STORE_KEY  = 'tq-keys';
const STORE_NICK = 'tq-prefs';
const LS_KEY     = 'tq-identity-v3';

// ── Module-level cache ────────────────────────────────────────────────────────
// Prevents concurrent callers from racing to generate separate keypairs.
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
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

async function generateKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,   // extractable — required for JWK serialization and backup
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
  try { await dbPut(db, STORE_KEY, 'keypair-v3', serialized); } catch (e) {
    console.warn('[TQ identity] IDB persist failed:', e.message);
  }
  try { localStorage.setItem(LS_KEY, serialized); } catch (e) {
    console.warn('[TQ identity] localStorage persist failed:', e.message);
  }
}

async function tryLoadKeys(db) {
  // 1. IndexedDB (primary)
  try {
    const raw = await dbGet(db, STORE_KEY, 'keypair-v3');
    if (typeof raw === 'string') {
      const { privJwk, pubJwk } = JSON.parse(raw);
      const keys = await importKeyPair(privJwk, pubJwk);
      try { localStorage.setItem(LS_KEY, raw); } catch {}
      return { keys, serialized: raw };
    }
  } catch (e) { console.warn('[TQ identity] IDB load failed:', e.message); }

  // 2. localStorage fallback
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const { privJwk, pubJwk } = JSON.parse(raw);
      const keys = await importKeyPair(privJwk, pubJwk);
      try { await dbPut(db, STORE_KEY, 'keypair-v3', raw); } catch {}
      console.log('[TQ identity] restored identity from localStorage backup');
      return { keys, serialized: raw };
    }
  } catch (e) { console.warn('[TQ identity] localStorage load failed:', e.message); }

  // 3. Legacy non-extractable format (v1/v2) — can use but cannot export.
  //    The key is used for this session only; fingerprint stays stable.
  //    On the next reset or fresh install, a new extractable key is generated.
  try {
    const old = await dbGet(db, STORE_KEY, 'keypair');
    if (old?.privateKey && old?.publicKey) {
      console.warn('[TQ identity] found legacy non-extractable key — using for this session, cannot be exported');
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
    serialized = await serializeKeys(keys);
    await persistKeys(db, serialized);
    console.log('[TQ identity] generated new identity');
  } else {
    keys       = result.keys;
    serialized = result.serialized ?? null;
  }

  const fingerprint = await fingerprintOf(keys.publicKey);
  const shortId     = fingerprint.slice(0, 8);

  const savedNick = await dbGet(db, STORE_NICK, 'nickname').catch(() => null);
  const nickname  = (typeof savedNick === 'string' && savedNick.trim()) ? savedNick.trim() : shortId;
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
    await dbPut(db, STORE_NICK, 'nickname', trimmed);
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

  // If initialization is already in progress, await the same promise
  // (prevents concurrent callers from each generating their own keypair)
  if (_identityPromise) return _identityPromise;

  _identityPromise = _loadIdentity().then(identity => {
    _identityCache   = identity;
    _identityPromise = null;
    return identity;
  }).catch(err => {
    _identityPromise = null; // allow retry on failure
    throw err;
  });

  return _identityPromise;
}

export async function resetIdentity() {
  // Clear in-memory cache so next getIdentity() generates fresh keys
  _identityCache   = null;
  _identityPromise = null;

  const db = await openDB();
  await new Promise((res, rej) => {
    const tx = db.transaction([STORE_KEY, STORE_NICK], 'readwrite');
    tx.objectStore(STORE_KEY).clear();
    tx.objectStore(STORE_NICK).clear();
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
  });
  try { localStorage.removeItem(LS_KEY); } catch {}
}

export async function importIdentityData(identityData) {
  if (!identityData?.privJwk || !identityData?.pubJwk) {
    throw new Error('Invalid identity data: missing privJwk or pubJwk');
  }
  // Verify the key works before writing
  await importKeyPair(identityData.privJwk, identityData.pubJwk);
  const serialized = JSON.stringify({
    privJwk: identityData.privJwk,
    pubJwk:  identityData.pubJwk,
    v:       3,
  });
  const db = await openDB();
  await persistKeys(db, serialized);
  if (identityData.nickname) {
    await dbPut(db, STORE_NICK, 'nickname', identityData.nickname);
  }
  // Clear cache so getIdentity() reloads the imported identity
  _identityCache   = null;
  _identityPromise = null;

  const keys = await importKeyPair(identityData.privJwk, identityData.pubJwk);
  return fingerprintOf(keys.publicKey);
}
