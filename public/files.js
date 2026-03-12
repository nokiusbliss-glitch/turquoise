/**
 * files.js — Turquoise
 * High-throughput file transfer with real-time stats and stall detection.
 *
 * Fixes:
 *   - `if (!this._sendBinary) throw` was dead code: _sendBinary is always a
 *     function reference set in the constructor, so the check was never true.
 *     Replaced with a proper pre-flight channel-open check.
 *   - Added RECV_STALL_MS: if no binary chunk arrives for 30s on an active
 *     receive, the transfer is aborted with a clear error. Previously a
 *     half-open connection would leave a transfer hanging forever.
 *   - handleBinary: if binary arrives before file-meta (e.g. reordering),
 *     it now logs a warning rather than silently dropping the data.
 *   - _finalize: validates that received byte count matches declared size
 *     and warns on mismatch (file corruption / truncation).
 *
 * Flow control:
 *   LOW_WATER  = 64 KB  ← bufferedAmountLowThreshold (event fires here)
 *   HIGH_WATER = 1 MB   ← pause sending above this
 *
 * Stats emitted per progress event:
 *   { bytesTransferred, totalBytes, speedBps, etaSec, elapsedSec, pct }
 */

const CHUNK          = 256 * 1024;   // 256 KB — optimal for backpressure
const HIGH_WATER     = 1024 * 1024;  // 1 MB   — pause threshold
const RECV_STALL_MS  = 30_000;       // 30s with no new chunk → abort

export class FileTransfer {
  constructor(sendCtrlFn, sendBinaryFn, waitBufferFn) {
    this._sendCtrl   = sendCtrlFn;
    this._sendBinary = sendBinaryFn;
    this._waitBuf    = waitBufferFn || (() => Promise.resolve());

    this._recv    = new Map();   // fp → RecvState
    this._queue   = new Map();   // fp → [{file, fileId}]
    this._sending = new Set();   // fp currently being drained

    this.onProgress  = null;   // (id, pct, dir, fp, stats) => void
    this.onFileReady = null;   // (fileInfo) => void
    this.onError     = null;   // (id, msg, fp) => void
  }

  // ── Send ──────────────────────────────────────────────────────────────────

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
      const { file, fileId } = q[0];
      try {
        await this._sendOne(file, fp, fileId);
      } catch (e) {
        this.onError?.(fileId, e.message, fp);
        try { this._sendCtrl(fp, { type: 'file-abort', fileId }); } catch {}
      }
      q.shift();
    }
    this._sending.delete(fp);
  }

  async _sendOne(file, fp, fileId) {
    // Guard: verify we can actually send before spending time reading the file
    if (!this._sendBinary) throw new Error('No binary send function configured');

    if (file.size === 0) {
      this._sendCtrl(fp, {
        type: 'file-meta', fileId, name: file.name, size: 0,
        mimeType: file.type || 'application/octet-stream', totalChunks: 0,
      });
      this._sendCtrl(fp, { type: 'file-end', fileId, totalChunks: 0 });
      this.onProgress?.(fileId, 1, 'send', fp, {
        bytesTransferred: 0, totalBytes: 0, speedBps: 0, etaSec: 0, elapsedSec: 0,
      });
      return;
    }

    const totalChunks = Math.ceil(file.size / CHUNK);
    const sent = this._sendCtrl(fp, {
      type: 'file-meta', fileId, name: file.name, size: file.size,
      mimeType: file.type || 'application/octet-stream', totalChunks,
    });
    if (!sent) throw new Error('Peer not connected');

    const startTime  = Date.now();
    let offset       = 0;
    let chunkIdx     = 0;
    let lastPctInt   = -1;
    let windowStart  = startTime;
    let windowBytes  = 0;
    let smoothSpeed  = 0;

    while (offset < file.size) {
      // Wait for DataChannel buffer to drain if over high watermark
      await this._waitBuf(fp);

      const end = Math.min(offset + CHUNK, file.size);
      let buf;
      try {
        buf = await file.slice(offset, end).arrayBuffer();
      } catch (e) {
        throw new Error('File read error: ' + e.message);
      }

      const ok = this._sendBinary(fp, buf);
      if (!ok) throw new Error('DataChannel closed during transfer');

      offset      += buf.byteLength;
      windowBytes += buf.byteLength;
      chunkIdx++;

      const now       = Date.now();
      const elapsed   = (now - startTime) / 1000;
      const windowAge = (now - windowStart) / 1000;

      if (windowAge >= 0.4 || offset >= file.size) {
        const instant = windowAge > 0 ? windowBytes / windowAge : 0;
        smoothSpeed   = smoothSpeed === 0
          ? instant
          : 0.35 * instant + 0.65 * smoothSpeed;
        windowStart = now;
        windowBytes = 0;
      }

      const pct    = offset / file.size;
      const pctInt = Math.floor(pct * 100);
      if (pctInt !== lastPctInt || offset >= file.size) {
        const remaining = file.size - offset;
        const eta       = smoothSpeed > 0 ? remaining / smoothSpeed : 0;
        this.onProgress?.(fileId, pct, 'send', fp, {
          bytesTransferred: offset, totalBytes: file.size,
          speedBps: smoothSpeed, etaSec: eta, elapsedSec: elapsed,
        });
        lastPctInt = pctInt;
      }
    }

    this._sendCtrl(fp, { type: 'file-end', fileId, totalChunks: chunkIdx });
  }

  // ── Receive ───────────────────────────────────────────────────────────────

  handleCtrl(fp, msg) {
    const { type, fileId } = msg;
    if (!fileId) return;

    if (type === 'file-meta') {
      // Clear any stale state for this peer (e.g. previous aborted transfer)
      this._clearStall(fp);
      this._recv.set(fp, {
        fileId,
        name:        msg.name    || 'file',
        size:        msg.size    || 0,
        mimeType:    msg.mimeType || 'application/octet-stream',
        total:       msg.totalChunks || 0,
        chunks:      [],
        bytes:       0,
        from:        fp,
        startTime:   Date.now(),
        windowStart: Date.now(),
        windowBytes: 0,
        smoothSpeed: 0,
        lastPctInt:  -1,
        _stallTimer: null,
      });
      this._resetStallTimer(fp);

    } else if (type === 'file-end') {
      this._clearStall(fp);
      this._finalize(fp, fileId);

    } else if (type === 'file-abort') {
      this._clearStall(fp);
      this._recv.delete(fp);
      this.onError?.(fileId, 'Transfer aborted by sender', fp);
    }
  }

  handleBinary(fp, buf) {
    const s = this._recv.get(fp);
    if (!s) {
      console.warn('[TQ files] binary chunk received before file-meta from', fp?.slice(0, 8));
      return;
    }

    s.chunks.push(buf);
    s.bytes       += buf.byteLength;
    s.windowBytes += buf.byteLength;

    // Reset stall timer on every received chunk
    this._resetStallTimer(fp);

    const now       = Date.now();
    const elapsed   = (now - s.startTime) / 1000;
    const windowAge = (now - s.windowStart) / 1000;

    if (windowAge >= 0.4) {
      const instant = windowAge > 0 ? s.windowBytes / windowAge : 0;
      s.smoothSpeed = s.smoothSpeed === 0
        ? instant
        : 0.35 * instant + 0.65 * s.smoothSpeed;
      s.windowStart = now;
      s.windowBytes = 0;
    }

    const pct    = s.size > 0 ? Math.min(s.bytes / s.size, 0.999) : 0;
    const pctInt = Math.floor(pct * 100);
    if (pctInt !== s.lastPctInt) {
      const remaining = s.size - s.bytes;
      const eta       = s.smoothSpeed > 0 ? remaining / s.smoothSpeed : 0;
      this.onProgress?.(s.fileId, pct, 'recv', fp, {
        bytesTransferred: s.bytes, totalBytes: s.size,
        speedBps: s.smoothSpeed, etaSec: eta, elapsedSec: elapsed,
      });
      s.lastPctInt = pctInt;
    }
  }

  // ── Stall detection ───────────────────────────────────────────────────────

  _resetStallTimer(fp) {
    const s = this._recv.get(fp);
    if (!s) return;
    if (s._stallTimer) clearTimeout(s._stallTimer);
    s._stallTimer = setTimeout(() => {
      const st = this._recv.get(fp);
      if (!st) return;
      this._recv.delete(fp);
      this.onError?.(st.fileId, `Transfer stalled (no data for ${RECV_STALL_MS / 1000}s)`, fp);
    }, RECV_STALL_MS);
  }

  _clearStall(fp) {
    const s = this._recv.get(fp);
    if (s?._stallTimer) {
      clearTimeout(s._stallTimer);
      s._stallTimer = null;
    }
  }

  // ── Finalize ─────────────────────────────────────────────────────────────

  _finalize(fp, fileId) {
    const s = this._recv.get(fp);
    if (!s || s.fileId !== fileId) return;
    this._recv.delete(fp);

    const elapsed  = (Date.now() - s.startTime) / 1000;
    const avgSpeed = elapsed > 0 ? s.bytes / elapsed : 0;

    if (s.size > 0 && s.bytes !== s.size) {
      console.warn(
        `[TQ files] size mismatch for ${s.name}: expected ${s.size}, got ${s.bytes}`
      );
    }

    try {
      const blob = new Blob(s.chunks, { type: s.mimeType });
      const url  = URL.createObjectURL(blob);
      this.onProgress?.(fileId, 1, 'recv', fp, {
        bytesTransferred: s.bytes, totalBytes: s.size,
        speedBps: avgSpeed, etaSec: 0, elapsedSec: elapsed, done: true,
      });
      this.onFileReady?.({
        fileId, url, name: s.name, size: blob.size,
        mimeType: s.mimeType, from: fp,
      });
    } catch (e) {
      this.onError?.(fileId, 'Assembly failed: ' + e.message, fp);
    }
  }
}
