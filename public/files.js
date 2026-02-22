/**
 * files.js — Turquoise v7
 *
 * ── Why this is fast ─────────────────────────────────────────────────────────
 * • 1MB chunks (vs 64KB before) — 16× fewer messages for same data
 * • Raw ArrayBuffer — no base64 encoding (33% size penalty eliminated)
 * • Unordered SCTP channel — no head-of-line blocking (UDP-like speed)
 * • Event-driven backpressure via bufferedAmountLowThreshold — no CPU polling
 * • CRC32 per chunk — app-level integrity (we own the reliability)
 * • Never loads full file into RAM — File.slice() reads 1MB at a time
 *
 * ── Binary packet format ─────────────────────────────────────────────────────
 * Header (48 bytes):
 *   [0–3]   magic:      0x54510002 (TQ v2)
 *   [4–7]   chunk index: uint32 big-endian
 *   [8–11]  crc32:      uint32 big-endian (of the data portion)
 *   [12–47] fileId:     36 ASCII bytes (UUID)
 *   [48+]   data:       raw file bytes
 *
 * Control messages (JSON, sent via ctrl channel):
 *   file-start  { type, fileId, name, size, mimeType, totalChunks, ts }
 *   file-end    { type, fileId }
 *   file-cancel { type, fileId }
 *
 * ── Murphy's Law ─────────────────────────────────────────────────────────────
 * CRC mismatch → chunk flagged, transfer fails with explicit error.
 * Missing chunks → explicit error naming which indices.
 * Channel close mid-transfer → explicit error, no silent corruption.
 */

const CHUNK_SIZE      = 1024 * 1024;     // 1 MB — tuned for WebRTC SCTP window
const MAGIC           = 0x54510002;       // TQ v2 magic
const HEADER_SIZE     = 48;
const FILE_ID_LEN     = 36;
const BUFFER_HIGH     = 8 * 1024 * 1024; // pause if ft buffer > 8 MB
const MAX_FILE_SIZE   = 100 * 1024 ** 3; // 100 GB hard cap

// ── CRC32 (fast table-based) ──────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  const bytes = new Uint8Array(buf);
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── FileTransfer engine ───────────────────────────────────────────────────────

export class FileTransfer {

  constructor(sendCtrlFn, sendBinaryFn) {
    if (typeof sendCtrlFn !== 'function')   throw new Error('FileTransfer: sendCtrlFn required.');
    if (typeof sendBinaryFn !== 'function') throw new Error('FileTransfer: sendBinaryFn required.');

    this.sendCtrl   = sendCtrlFn;   // (fp, object) → bool
    this.sendBinary = sendBinaryFn; // (fp, ArrayBuffer) → bool

    this.incoming = new Map(); // fileId → { meta, chunks[], crcOk[], received, bytesRx, startTime }
    this.outgoing = new Map(); // fileId → { cancelled }

    // Callbacks
    this.onProgress  = null; // (fileId, 0–1, 'in'|'out', bps) → void
    this.onFileReady = null; // ({ fileId, name, size, blob, url, elapsedSec, avgBps }) → void
    this.onError     = null; // (fileId, msg) → void
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  async sendFile(file, toPeerFp, fileId, getFtChannelFn) {
    if (!file)      throw new Error('sendFile: no file.');
    if (!toPeerFp)  throw new Error('sendFile: no peer fingerprint.');
    if (!fileId)    fileId = this._uid();
    if (file.size === 0) throw new Error('File is empty.');
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${this._fmtSize(file.size)} (max ${this._fmtSize(MAX_FILE_SIZE)})`);
    }

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    this.outgoing.set(fileId, { cancelled: false });

    const ok = this.sendCtrl(toPeerFp, {
      type: 'file-start', fileId,
      name: file.name || 'file',
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks, ts: Date.now(),
    });
    if (!ok) { this.outgoing.delete(fileId); throw new Error('Peer ctrl channel not open.'); }

    const startTime  = performance.now();
    let   bytesSent  = 0;

    for (let i = 0; i < totalChunks; i++) {
      if (this.outgoing.get(fileId)?.cancelled) {
        this.outgoing.delete(fileId);
        this.sendCtrl(toPeerFp, { type: 'file-cancel', fileId });
        throw new Error('Transfer cancelled by user.');
      }

      // Read only one chunk — never full file in RAM
      let chunkData;
      try {
        chunkData = await file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).arrayBuffer();
      } catch (e) {
        throw new Error(`Read chunk ${i} failed: ${e.message}`);
      }

      // Build binary packet with CRC
      const packet = this._buildPacket(i, fileId, chunkData, crc32(chunkData));

      // Backpressure: wait for ft channel buffer to drain
      if (typeof getFtChannelFn === 'function') {
        const ch = getFtChannelFn(toPeerFp);
        if (ch && ch.bufferedAmount > BUFFER_HIGH) {
          await this._drainBuffer(ch);
        }
      }

      const sent = this.sendBinary(toPeerFp, packet);
      if (!sent) {
        this.outgoing.delete(fileId);
        throw new Error(`ft channel closed at chunk ${i}/${totalChunks}.`);
      }

      bytesSent += chunkData.byteLength;
      const elapsed = (performance.now() - startTime) / 1000;
      const bps     = elapsed > 0 ? bytesSent / elapsed : 0;

      if (typeof this.onProgress === 'function') {
        this.onProgress(fileId, (i + 1) / totalChunks, 'out', bps);
      }

      // Yield every 8 chunks to keep UI paint alive
      if (i % 8 === 7) await this._tick();
    }

    this.sendCtrl(toPeerFp, { type: 'file-end', fileId });
    this.outgoing.delete(fileId);
    return fileId;
  }

  cancelSend(fileId) {
    const t = this.outgoing.get(fileId);
    if (t) t.cancelled = true;
  }

  // ── Receive: JSON control messages (via ctrl channel) ─────────────────────

  handleControl(msg) {
    if (!msg?.fileId) return;
    switch (msg.type) {
      case 'file-start':  this._onStart(msg);  break;
      case 'file-end':    this._onEnd(msg);    break;
      case 'file-cancel': this._onCancel(msg); break;
    }
  }

  // ── Receive: binary chunk (via ft channel) ────────────────────────────────

  handleBinary(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < HEADER_SIZE) return;

    const view = new DataView(buffer);
    if (view.getUint32(0, false) !== MAGIC) return; // not our packet

    const index  = view.getUint32(4, false);
    const crcRx  = view.getUint32(8, false);
    const fileId = this._readId(buffer);
    const data   = buffer.slice(HEADER_SIZE);

    // CRC check
    const crcCalc = crc32(data);
    if (crcRx !== crcCalc) {
      this._err(fileId, `CRC mismatch chunk ${index}: expected ${crcCalc.toString(16)}, got ${crcRx.toString(16)}`);
      return;
    }

    const t = this.incoming.get(fileId);
    if (!t) return; // file-start not yet received — edge case

    if (index >= t.meta.totalChunks) {
      this._err(fileId, `chunk index ${index} out of range (${t.meta.totalChunks} total)`);
      return;
    }

    if (t.chunks[index] === null) {
      t.chunks[index]  = data;
      t.crcOk[index]   = true;
      t.received++;
      t.bytesRx += data.byteLength;
    }

    const elapsed = (performance.now() - t.startTime) / 1000;
    const bps     = elapsed > 0 ? t.bytesRx / elapsed : 0;

    if (typeof this.onProgress === 'function') {
      this.onProgress(fileId, t.received / t.meta.totalChunks, 'in', bps);
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _onStart(msg) {
    if (!msg.name || !msg.totalChunks || msg.totalChunks < 1) {
      this._err(msg.fileId, 'file-start: invalid metadata.'); return;
    }
    this.incoming.set(msg.fileId, {
      meta:      msg,
      chunks:    new Array(msg.totalChunks).fill(null),
      crcOk:     new Array(msg.totalChunks).fill(false),
      received:  0,
      bytesRx:   0,
      startTime: performance.now(),
    });
  }

  _onEnd(msg) {
    const t = this.incoming.get(msg.fileId);
    if (!t) { this._err(msg.fileId, 'file-end: no active transfer.'); return; }
    this.incoming.delete(msg.fileId);

    // Verify all chunks arrived and CRC passed
    const bad = t.chunks.reduce((acc, c, i) =>
      (c === null || !t.crcOk[i]) ? [...acc, i] : acc, []);
    if (bad.length > 0) {
      this._err(msg.fileId, `${bad.length} chunk(s) failed (missing/corrupt): indices ${bad.slice(0,5).join(',')}`);
      return;
    }

    // Assemble — Blob from ArrayBuffer array, no re-encoding
    let blob;
    try {
      blob = new Blob(t.chunks, { type: t.meta.mimeType || 'application/octet-stream' });
    } catch (e) {
      this._err(msg.fileId, 'Blob assembly: ' + e.message); return;
    }

    let url;
    try { url = URL.createObjectURL(blob); }
    catch (e) { this._err(msg.fileId, 'createObjectURL: ' + e.message); return; }

    const elapsed = (performance.now() - t.startTime) / 1000;

    if (typeof this.onFileReady === 'function') {
      this.onFileReady({
        fileId: msg.fileId, name: t.meta.name,
        size: t.meta.size, mimeType: t.meta.mimeType,
        blob, url,
        elapsedSec: elapsed,
        avgBps: elapsed > 0 ? t.meta.size / elapsed : 0,
      });
    }
  }

  _onCancel(msg) {
    this.incoming.delete(msg.fileId);
    this._err(msg.fileId, 'Transfer cancelled by sender.');
  }

  _buildPacket(index, fileId, data, crc) {
    const packet = new Uint8Array(HEADER_SIZE + data.byteLength);
    const view   = new DataView(packet.buffer);
    view.setUint32(0, MAGIC,  false);
    view.setUint32(4, index,  false);
    view.setUint32(8, crc,    false);
    const idBytes = new TextEncoder().encode(fileId.padEnd(FILE_ID_LEN, '\0').slice(0, FILE_ID_LEN));
    packet.set(idBytes, 12);
    packet.set(new Uint8Array(data), HEADER_SIZE);
    return packet.buffer;
  }

  _readId(buffer) {
    const bytes = new Uint8Array(buffer, 12, FILE_ID_LEN);
    return new TextDecoder().decode(bytes).replace(/\0/g, '').trim();
  }

  _drainBuffer(ch) {
    return new Promise(resolve => {
      if (ch.bufferedAmount <= BUFFER_HIGH / 2) { resolve(); return; }
      const prev = ch.bufferedAmountLowThreshold;
      ch.bufferedAmountLowThreshold = BUFFER_HIGH / 2;
      const handler = () => {
        ch.removeEventListener('bufferedamountlow', handler);
        ch.bufferedAmountLowThreshold = prev;
        resolve();
      };
      ch.addEventListener('bufferedamountlow', handler);
    });
  }

  _tick() { return new Promise(r => setTimeout(r, 0)); }
  _uid()  { return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2); }
  _err(id, m) {
    console.error('[FT]', id?.slice?.(0,8) || '?', m);
    if (typeof this.onError === 'function') this.onError(id, m);
  }
  _fmtSize(b) {
    if (b < 1024)      return b + ' B';
    if (b < 1024**2)   return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024**3)   return (b / 1024**2).toFixed(1) + ' MB';
    return (b / 1024**3).toFixed(2) + ' GB';
  }
}
