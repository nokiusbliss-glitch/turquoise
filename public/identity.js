/**
 * identity.js — Turquoise (unchanged from Phase 2)
 *
 * ECDSA P-256 device identity stored in IndexedDB.
 * No Base64 key encoding — keys stored as native CryptoKey objects.
 */

const DB_NAME = 'turquoise_identity';
const STORE   = 'keys';

function openDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB not supported.')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(new Error('Identity DB error: ' + req.error?.message));
    req.onblocked = () => reject(new Error('Identity DB blocked.'));
  });
}

function dbGet(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(new Error('dbGet: ' + req.error?.message));
  });
}

function dbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(new Error('dbPut: ' + tx.error?.message));
  });
}

export async function getIdentity() {
  if (!window.crypto?.subtle) {
    throw new Error('crypto.subtle unavailable — open via https:// or localhost.');
  }

  const db = await openDB();
  let keypair = await dbGet(db, 'keypair');

  if (!keypair) {
    keypair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, ['sign', 'verify']
    );
    await dbPut(db, 'keypair', keypair);
  }

  if (!keypair?.publicKey || !keypair?.privateKey) {
    throw new Error('Stored keypair malformed — clear IndexedDB and reload.');
  }

  const rawPub      = await crypto.subtle.exportKey('raw', keypair.publicKey);
  const hashBuf     = await crypto.subtle.digest('SHA-256', rawPub);
  const fingerprint = Array.from(new Uint8Array(hashBuf))
                           .map(b => b.toString(16).padStart(2, '0')).join('');

  return {
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    fingerprint,
    shortId: fingerprint.slice(0, 8),
  };
}

export async function signMessage(identity, text) {
  if (!identity?.privateKey) throw new Error('signMessage: no privateKey.');
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.privateKey,
    new TextEncoder().encode(text)
  );
  return new Uint8Array(sig);
}

export async function verifyMessage(identity, text, signature) {
  if (!identity?.publicKey) throw new Error('verifyMessage: no publicKey.');
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.publicKey,
    signature,
    new TextEncoder().encode(text)
  );
}
