/**
 * files.js — Turquoise
 * High-throughput file transfer over WebRTC DataChannel.
 *
 * Design:
 *   - ctrl channel: file-meta → file-end | file-abort (JSON)
 *   - data channel: raw ArrayBuffer chunks — NO per-chunk header
 *   - 1MB chunks for minimal JS overhead — targets 5–7 MB/s on 5GHz WiFi
 *   - Flow control: only wait when DataChannel buffer exceeds 16MB
 *   - Progress updates throttled to ~200ms to avoid DOM thrashing
 *   - One transfer per peer at a time (queued)
 *   - Chunks arrive in order (ordered:true DataChannel guarantee)
 *
 * Speed math: 15MB file = 15 × 1MB chunks
 *   At 5 MB/s: 3 seconds total (vs 30s with 64KB chunks)
 *   Buffer allows 16+ chunks in-flight — no artificial throttling
 */

const CHUNK = 1 * 1024 * 1024; // 1MB per chunk

export class FileTransfer {
  constructor(sendCtrlFn, sendBinaryFn, waitBufferFn) {
    this._sendCtrl   = sendCtrlFn;
    this._sendBinary = sendBinaryFn;
    this._waitBuf    = waitBufferFn || (() => Promise.resolve());

    this._recv    = new Map(); // fp → recv state
    this._queue   = new Map(); // fp → [{file, fileId}]
    this._sending = new Set();

    this.onProgress  = null;
    this.onFileReady = null;
    this.onError     = null;
  }

  // ── Send ────────────────────────────────────────────────────────────────────
  send(file, fp, fileId) {
    if (!file || !fp || !fileId) return;
    if (!this._queue.has(fp)) this._queue.set(fp, []);
    this._queue.get(fp).push({ file, fileId });
    if (!this._sending.has(fp)) this._drain(fp);
  }

  async _drain(fp) {
    this._sending.add(fp);
    const q = this._queue.get(fp) || [];
    while (q.length) {
      const item = q[0];
      try {
        await this._sendOne(item.file, fp, item.fileId);
      } catch (e) {
        this.onError?.(item.fileId, e.message, fp);
        try { this._sendCtrl(fp, { type: 'file-abort', fileId: item.fileId }); } catch {}
      }
      q.shift();
    }
    this._sending.delete(fp);
  }

  async _sendOne(file, fp, fileId) {
    if (file.size === 0) {
      // Empty file — send meta + immediate end
      this._sendCtrl(fp, { type: 'file-meta', fileId, name: file.name, size: 0, mimeType: file.type || 'application/octet-stream', totalChunks: 0 });
      this._sendCtrl(fp, { type: 'file-end', fileId, totalChunks: 0 });
      this.onProgress?.(fileId, 1, 'send', fp);
      return;
    }

    const totalChunks = Math.ceil(file.size / CHUNK);
    const ok = this._sendCtrl(fp, {
      type: 'file-meta', fileId,
      name: file.name, size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks,
    });
    if (!ok) throw new Error('Peer not connected');

    let offset = 0;
    let chunkIdx = 0;
    let lastProgress = Date.now();

    while (offset < file.size) {
      // Only throttle if DataChannel buffer is near-full (16MB)
      // Check every 4 chunks to reduce overhead
      if (chunkIdx % 4 === 0) {
        await this._waitBuf(fp);
      }

      const end = Math.min(offset + CHUNK, file.size);
      let buf;
      try { buf = await file.slice(offset, end).arrayBuffer(); }
      catch (e) { throw new Error('File read failed: ' + e.message); }

      if (!this._sendBinary(fp, buf)) throw new Error('DataChannel closed during transfer');

      offset = end;
      chunkIdx++;

      // Throttle progress DOM updates to ~200ms
      const now = Date.now();
      if (now - lastProgress > 200 || offset >= file.size) {
        this.onProgress?.(fileId, offset / file.size, 'send', fp);
        lastProgress = now;
      }
    }

    this._sendCtrl(fp, { type: 'file-end', fileId, totalChunks: chunkIdx });
  }

  // ── Receive ─────────────────────────────────────────────────────────────────
  handleCtrl(fp, msg) {
    const { type, fileId } = msg;
    if (!fileId) return;

    if (type === 'file-meta') {
      this._recv.set(fp, {
        fileId,
        name:     msg.name     || 'file',
        size:     msg.size     || 0,
        mimeType: msg.mimeType || 'application/octet-stream',
        total:    msg.totalChunks || 0,
        chunks:   [],
        bytes:    0,
        from:     fp,
        lastProgress: 0,
      });
    } else if (type === 'file-end') {
      this._finalize(fp, fileId);
    } else if (type === 'file-abort') {
      this._recv.delete(fp);
      this.onError?.(fileId, 'Transfer aborted by sender', fp);
    }
  }

  handleBinary(fp, buf) {
    const s = this._recv.get(fp);
    if (!s) return;
    s.chunks.push(buf);
    s.bytes += buf.byteLength;

    // Throttle progress updates
    const now = Date.now();
    if (now - s.lastProgress > 200) {
      const pct = s.size > 0 ? Math.min(s.bytes / s.size, 0.99) : 0;
      this.onProgress?.(s.fileId, pct, 'recv', fp);
      s.lastProgress = now;
    }
  }

  _finalize(fp, fileId) {
    const s = this._recv.get(fp);
    if (!s || s.fileId !== fileId) return;
    this._recv.delete(fp);
    try {
      const blob = new Blob(s.chunks, { type: s.mimeType });
      const url  = URL.createObjectURL(blob);
      this.onProgress?.(fileId, 1, 'recv', fp);
      this.onFileReady?.({ fileId, url, name: s.name, size: blob.size, mimeType: s.mimeType, from: fp });
    } catch (e) {
      this.onError?.(fileId, 'Assembly failed: ' + e.message, fp);
    }
  }
}
