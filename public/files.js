/**
 * files.js — Turquoise
 * Binary streaming file transfer — any size, max WiFi speed
 *
 * Protocol:
 *   ctrl channel: file-meta (JSON) + file-end (JSON) + file-abort (JSON)
 *   data channel: raw ArrayBuffer chunks with 40-byte header
 *
 * Header format (40 bytes):
 *   [0..3]  chunkIndex (uint32 big-endian)
 *   [4..39] fileId     (36 bytes ASCII UUID)
 *   [40..]  file data
 *
 * Flow control: wait when DataChannel buffer exceeds HIGH_WATER
 * Large files (>64MB): OPFS (Origin Private File System) for zero-RAM assembly
 * Small files: Blob assembly in memory
 */

const CHUNK_SIZE  = 256 * 1024;   // 256 KB — optimal DataChannel chunk
const HIGH_WATER  = 16 * 1024 * 1024;  // 16 MB buffer high water mark
const LARGE_FILE  = 64 * 1024 * 1024;  // 64 MB threshold for OPFS
const HEADER_SIZE = 40;

// ── Binary header encoding/decoding ───────────────────────────────────────────
function encodeChunk(fileId, chunkIndex, data) {
  const buf  = new ArrayBuffer(HEADER_SIZE + data.byteLength);
  const view = new DataView(buf);
  view.setUint32(0, chunkIndex, false);  // big-endian
  const idBytes = new TextEncoder().encode(fileId.slice(0, 36).padEnd(36, ' '));
  new Uint8Array(buf).set(idBytes, 4);
  new Uint8Array(buf).set(new Uint8Array(data), HEADER_SIZE);
  return buf;
}

function decodeChunk(buf) {
  if (buf.byteLength < HEADER_SIZE) return null;
  const view       = new DataView(buf);
  const chunkIndex = view.getUint32(0, false);
  const fileId     = new TextDecoder().decode(new Uint8Array(buf, 4, 36)).trim();
  const data       = buf.slice(HEADER_SIZE);
  return { chunkIndex, fileId, data };
}

// ── OPFS writer (for large files) ─────────────────────────────────────────────
async function openOPFSWriter(fileId) {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return null;
    const fh     = await root.getFileHandle(`tq-${fileId}`, { create: true });
    const writer = await fh.createWritable({ keepExistingData: false });
    return { writer, fh };
  } catch {
    return null; // fallback to memory
  }
}

async function getOPFSFile(fileId) {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return null;
    const fh = await root.getFileHandle(`tq-${fileId}`);
    return await fh.getFile();
  } catch { return null; }
}

async function deleteOPFSFile(fileId) {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return;
    await root.removeEntry(`tq-${fileId}`);
  } catch {}
}

// ── FileTransfer ──────────────────────────────────────────────────────────────
export class FileTransfer {
  constructor(sendCtrlFn, sendBinaryFn, waitForBufferFn) {
    if (!sendCtrlFn || !sendBinaryFn) throw new Error('FileTransfer: send functions required');
    this._sendCtrl    = sendCtrlFn;    // (fp, jsonObj)   → bool
    this._sendBinary  = sendBinaryFn;  // (fp, ArrayBuf)  → bool
    this._waitBuffer  = waitForBufferFn || (() => Promise.resolve());

    this._recv   = new Map(); // fileId → RecvState
    this._active = new Set(); // fileIds being sent

    // Callbacks
    this.onProgress  = null; // (fileId, 0-1, 'send'|'recv', fp)
    this.onFileReady = null; // ({fileId, url, name, size, mimeType, from})
    this.onError     = null; // (fileId, message, fp)
  }

  // ── Send ──────────────────────────────────────────────────────────────────────
  async sendFile(file, fp, fileId) {
    if (!file instanceof File) throw new Error('sendFile: File required');
    if (!fp)     throw new Error('sendFile: fp required');
    if (!fileId) throw new Error('sendFile: fileId required');

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Send metadata over ctrl channel
    const sent = this._sendCtrl(fp, {
      type: 'file-meta',
      fileId,
      name:        file.name,
      size:        file.size,
      mimeType:    file.type || 'application/octet-stream',
      totalChunks,
    });
    if (!sent) throw new Error('Peer not connected');

    this._active.add(fileId);

    try {
      let offset     = 0;
      let chunkIndex = 0;

      while (offset < file.size) {
        if (!this._active.has(fileId)) break; // aborted

        // Flow control: wait for buffer to drain
        await this._waitBuffer(fp);

        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const data  = await slice.arrayBuffer();
        const chunk = encodeChunk(fileId, chunkIndex, data);

        const ok = this._sendBinary(fp, chunk);
        if (!ok) throw new Error('DataChannel closed during transfer');

        offset += data.byteLength;
        chunkIndex++;

        this.onProgress?.(fileId, offset / file.size, 'send', fp);
      }

      // Send completion signal
      this._sendCtrl(fp, { type: 'file-end', fileId, totalChunks: chunkIndex });
    } catch (e) {
      this._active.delete(fileId);
      this._sendCtrl(fp, { type: 'file-abort', fileId });
      throw e;
    }

    this._active.delete(fileId);
  }

  abortSend(fileId) {
    this._active.delete(fileId);
  }

  // ── Receive ────────────────────────────────────────────────────────────────────
  async handleCtrl(fp, msg) {
    if (!msg?.fileId) return;
    const { fileId } = msg;

    if (msg.type === 'file-meta') {
      await this._initReceive(fp, msg);
      return;
    }
    if (msg.type === 'file-end') {
      await this._finalizeReceive(fp, fileId, msg.totalChunks);
      return;
    }
    if (msg.type === 'file-abort') {
      await this._abortReceive(fileId);
      return;
    }
  }

  handleBinary(fp, buf) {
    const parsed = decodeChunk(buf);
    if (!parsed) return;
    const { chunkIndex, fileId, data } = parsed;
    this._storeChunk(fp, fileId, chunkIndex, data);
  }

  // ── Internal receive ──────────────────────────────────────────────────────────
  async _initReceive(fp, meta) {
    const { fileId, name, size, mimeType, totalChunks } = meta;
    const large = size >= LARGE_FILE;

    let opfsHandle = null;
    if (large) {
      opfsHandle = await openOPFSWriter(fileId);
    }

    this._recv.set(fileId, {
      fp, name, size, mimeType, totalChunks,
      received: 0,
      chunks: large ? null : new Array(totalChunks), // null = use OPFS
      opfsHandle,
      opfsOffset: 0,
    });
  }

  async _storeChunk(fp, fileId, chunkIndex, data) {
    const state = this._recv.get(fileId);
    if (!state) return;

    if (state.opfsHandle) {
      // Write at correct byte offset
      const byteOffset = chunkIndex * CHUNK_SIZE;
      try {
        await state.opfsHandle.writer.write({
          type: 'write',
          position: byteOffset,
          data,
        });
      } catch (e) {
        this.onError?.(fileId, 'OPFS write failed: ' + e.message, fp);
        return;
      }
    } else {
      if (!state.chunks) return;
      state.chunks[chunkIndex] = data;
    }

    state.received++;
    this.onProgress?.(fileId, state.received / (state.totalChunks || 1), 'recv', fp);
  }

  async _finalizeReceive(fp, fileId, reportedChunks) {
    const state = this._recv.get(fileId);
    if (!state) return;

    // Verify completeness
    const expected = state.totalChunks || reportedChunks || 0;
    if (state.received < expected) {
      const missing = expected - state.received;
      this.onError?.(fileId, `${missing} chunk${missing > 1 ? 's' : ''} missing`, fp);
      await this._abortReceive(fileId);
      return;
    }

    let url, blob;

    try {
      if (state.opfsHandle) {
        await state.opfsHandle.writer.close();
        const file = await getOPFSFile(fileId);
        if (!file) throw new Error('OPFS file missing after write');
        blob = new Blob([file], { type: state.mimeType });
      } else {
        // Filter nulls (gaps shouldn't happen but be safe)
        const parts = state.chunks.filter(Boolean);
        if (parts.length < expected) {
          throw new Error(`Only ${parts.length} of ${expected} chunks present`);
        }
        blob = new Blob(parts, { type: state.mimeType || 'application/octet-stream' });
      }

      url = URL.createObjectURL(blob);
    } catch (e) {
      this.onError?.(fileId, 'Assembly failed: ' + e.message, fp);
      await this._abortReceive(fileId);
      return;
    }

    this._recv.delete(fileId);

    this.onFileReady?.({
      fileId,
      url,
      name:     state.name,
      size:     blob.size,
      mimeType: state.mimeType,
      from:     fp,
    });
  }

  async _abortReceive(fileId) {
    const state = this._recv.get(fileId);
    if (!state) return;
    try { await state.opfsHandle?.writer.abort?.(); } catch {}
    await deleteOPFSFile(fileId);
    this._recv.delete(fileId);
  }
}
