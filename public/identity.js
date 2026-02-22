/**
 * identity.js — Turquoise v7
 * ECDSA P-256 device identity. Non-exportable private key in IndexedDB.
 * Fingerprint = SHA-256(raw public key bytes).
 * Nickname persisted in localStorage.
 */

const DB_NAME = 'tq_identity_v3';
const STORE   = 'keys';

function openDB() {
  return new Promise((res, rej) => {
    if (!window.indexedDB) { rej(new Error('IndexedDB not supported.')); return; }
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { try { r.result.createObjectStore(STORE); } catch {} };
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(new Error('Identity DB: ' + r.error?.message));
    r.onblocked = () => rej(new Error('Identity DB blocked — close other tabs.'));
  });
}

function dbGet(db, k) {
  return new Promise((res, rej) => {
    const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(k);
    r.onsuccess = () => res(r.result ?? null);
    r.onerror   = () => rej(new Error('dbGet: ' + r.error?.message));
  });
}

function dbPut(db, k, v) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(v, k);
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(new Error('dbPut: ' + tx.error?.message));
  });
}

export async function getIdentity() {
  if (!window.crypto?.subtle) {
    throw new Error('crypto.subtle unavailable — page must be served over HTTPS or localhost.');
  }
  const db = await openDB();
  let kp = await dbGet(db, 'keypair');

  if (!kp) {
    kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, ['sign', 'verify']
    );
    await dbPut(db, 'keypair', kp);
  }

  if (!kp?.publicKey || !kp?.privateKey) {
    throw new Error('Keypair malformed — open DevTools > Application > IndexedDB, delete tq_identity_v3, reload.');
  }

  const raw  = await crypto.subtle.exportKey('raw', kp.publicKey);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  const fp   = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');

  return {
    publicKey:   kp.publicKey,
    privateKey:  kp.privateKey,
    fingerprint: fp,
    shortId:     fp.slice(0, 8),
    nickname:    localStorage.getItem('tq_nick') || null,
  };
}

export function saveNickname(n) {
  if (typeof n === 'string' && n.trim()) {
    localStorage.setItem('tq_nick', n.trim().slice(0, 32));
  }
}
