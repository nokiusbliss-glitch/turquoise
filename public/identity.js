/**
 * identity.js — Turquoise
 *
 * PERMANENT cryptographic identity. Solves identity-changing bug:
 *   Old: extractable:false CryptoKey stored in IndexedDB.
 *        If IDB cleared (privacy mode, browser data wipe, storage pressure)
 *        → key gone → new identity generated → fingerprint changes.
 *   Fix: extractable:true → serialize to JWK → store in BOTH IndexedDB AND
 *        localStorage. Loading tries IDB first, localStorage fallback.
 *        Identity survives any single storage wipe.
 *
 * Export/import: full state bundle (identity + all messages + peers).
 */

const DB_NAME    = 'tq-identity';
const DB_VERSION = 3;  // bumped to trigger migration from old non-extractable format
const STORE_KEY  = 'tq-keys';
const STORE_NICK = 'tq-prefs';
const LS_KEY     = 'tq-identity-v3'; // localStorage backup key

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_KEY))  db.createObjectStore(STORE_KEY);
      if (!db.objectStoreNames.contains(STORE_NICK)) db.createObjectStore(STORE_NICK);
    };
    req.onsuccess = (e) => res(e.target.result);
    req.onerror   = () => rej(new Error('IDB open: ' + req.error?.message));
    req.onblocked = () => rej(new Error('IDB blocked — close other tabs'));
  });
}

function dbGet(db, store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function dbPut(db, store, key, value) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value, key);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

async function generateKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,              // MUST be extractable for JWK serialization
    ['sign', 'verify']
  );
}

async function importKeyPair(privJwk, pubJwk) {
  const privateKey = await crypto.subtle.importKey('jwk', privJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const publicKey  = await crypto.subtle.importKey('jwk', pubJwk,  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  return { privateKey, publicKey };
}

async function fingerprintOf(publicKey) {
  const raw  = await crypto.subtle.exportKey('raw', publicKey);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function serializeKeys(keys) {
  const privJwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
  const pubJwk  = await crypto.subtle.exportKey('jwk', keys.publicKey);
  return JSON.stringify({ privJwk, pubJwk, v: 3 });
}

async function persistKeys(db, serialized) {
  // Write to both stores — either one surviving is enough
  try { await dbPut(db, STORE_KEY, 'keypair-v3', serialized); } catch {}
  try { localStorage.setItem(LS_KEY, serialized); } catch {}
}

async function tryLoadKeys(db) {
  // 1. IndexedDB (primary)
  try {
    const raw = await dbGet(db, STORE_KEY, 'keypair-v3');
    if (typeof raw === 'string') {
      const { privJwk, pubJwk } = JSON.parse(raw);
      const keys = await importKeyPair(privJwk, pubJwk);
      // Sync to localStorage in case it was wiped
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
      // Sync back to IDB
      try { await dbPut(db, STORE_KEY, 'keypair-v3', raw); } catch {}
      console.log('[TQ identity] restored from localStorage');
      return { keys, serialized: raw };
    }
  } catch (e) { console.warn('[TQ identity] localStorage load failed:', e.message); }

  // 3. Old non-extractable format (migration — can use but can't export)
  try {
    const old = await dbGet(db, STORE_KEY, 'keypair');
    if (old?.privateKey && old?.publicKey) {
      // Can't export this key, but compute fingerprint and use until next session
      console.warn('[TQ identity] migrating from old non-extractable key — will regenerate on next reset');
      return { keys: old, serialized: null, legacy: true };
    }
  } catch {}

  return null;
}

export async function getIdentity() {
  if (!window.crypto?.subtle) throw new Error('crypto.subtle unavailable — requires HTTPS');
  if (!window.indexedDB)      throw new Error('IndexedDB unavailable');

  const db = await openDB();

  let result = await tryLoadKeys(db);
  let keys, serialized;

  if (!result) {
    // Fresh identity
    keys = await generateKeyPair();
    serialized = await serializeKeys(keys);
    await persistKeys(db, serialized);
    console.log('[TQ identity] generated new identity');
  } else if (result.legacy && !result.serialized) {
    // Migrate: generate new extractable key, but keep old fingerprint
    // Actually we can't migrate the fingerprint without user action, just use old key
    keys = result.keys;
    serialized = null; // can't export legacy
    console.warn('[TQ identity] using legacy key — fingerprint stable until reset');
  } else {
    keys = result.keys;
    serialized = result.serialized;
  }

  const fingerprint = await fingerprintOf(keys.publicKey);
  const shortId     = fingerprint.slice(0, 8);

  const savedNick = await dbGet(db, STORE_NICK, 'nickname').catch(() => null);
  const nickname  = (typeof savedNick === 'string' && savedNick.trim()) ? savedNick.trim() : shortId;
  const isNewUser = !savedNick;

  async function sign(data) {
    const encoded = new TextEncoder().encode(typeof data === 'string' ? data : JSON.stringify(data));
    const sigBuf  = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, encoded);
    return Array.from(new Uint8Array(sigBuf));
  }

  async function saveNickname(nick) {
    const trimmed = (nick || '').trim().slice(0, 32) || shortId;
    await dbPut(db, STORE_NICK, 'nickname', trimmed);
    return trimmed;
  }

  // Returns raw key material for export — null if legacy non-extractable key
  async function exportKeyData() {
    if (!serialized) return null;
    return JSON.parse(serialized);
  }

  return { fingerprint, shortId, nickname, isNewUser, sign, saveNickname, exportKeyData };
}

export async function resetIdentity() {
  const db = await openDB();
  await new Promise((res, rej) => {
    const tx = db.transaction([STORE_KEY, STORE_NICK], 'readwrite');
    tx.objectStore(STORE_KEY).clear();
    tx.objectStore(STORE_NICK).clear();
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
  });
  // Clear localStorage backup too
  try { localStorage.removeItem(LS_KEY); } catch {}
}

/**
 * Import an identity from a previously exported state bundle.
 * Overwrites current identity in both IDB and localStorage.
 */
export async function importIdentityData(identityData) {
  if (!identityData?.privJwk || !identityData?.pubJwk) throw new Error('Invalid identity data');
  // Verify the key works before writing
  const keys = await importKeyPair(identityData.privJwk, identityData.pubJwk);
  const serialized = JSON.stringify({ privJwk: identityData.privJwk, pubJwk: identityData.pubJwk, v: 3 });
  const db = await openDB();
  await persistKeys(db, serialized);
  if (identityData.nickname) {
    await dbPut(db, STORE_NICK, 'nickname', identityData.nickname);
  }
  return await fingerprintOf(keys.publicKey);
}
