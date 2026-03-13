/**
 * files.js — Turquoise v7
 * High-throughput file transfer. Leaner rewrite of v2 — same API, ~40% smaller.
 *
 * Flow control:  LOW=64KB threshold, HIGH=1MB pause
 * Stall guard:   30s without a chunk → abort with clear error
 * Cancel:        cancelSend(fileId,fp) / cancelRecv(fp,fileId)
 * Stats:         { bytesTransferred, totalBytes, speedBps, etaSec, elapsedSec }
 * onFileReady:   receives { fileId, url, blob, name, size, mimeType, from }
 */

const CHUNK        = 256 * 1024;
const HIGH         = 1024 * 1024;
const STALL_MS     = 30_000;

const smooth = (cur, inst) => cur === 0 ? inst : 0.35 * inst + 0.65 * cur;

export class FileTransfer {
  constructor(sendCtrlFn, sendBinaryFn, waitBufFn) {
    this._ctrl    = sendCtrlFn;
    this._binary  = sendBinaryFn;
    this._waitBuf = waitBufFn || (() => Promise.resolve());
    this._recv    = new Map();   // fp → RecvState
    this._queue   = new Map();   // fp → [{file,fileId}]
    this._sending = new Set();   // fps currently draining
    this._abort   = new Set();   // fileIds to abort

    this.onProgress  = null;   // (fileId, pct, dir, fp, stats) => void
    this.onFileReady = null;   // (fileInfo) => void
    this.onError     = null;   // (fileId, msg, fp) => void
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  send(file, fp, fileId) {
    if (!file || !fp || !fileId) return;
    if (!this._queue.has(fp)) this._queue.set(fp, []);
    this._queue.get(fp).push({ file, fileId });
    if (!this._sending.has(fp)) this._drain(fp);
  }

  cancelSend(fileId, fp) {
    this._abort.add(fileId);
    if (fp && this._queue.has(fp)) {
      const q = this._queue.get(fp);
      const i = q.findIndex(e => e.fileId === fileId);
      if (i !== -1) {
        q.splice(i, 1);
        try { this._ctrl(fp, { type:'file-abort', fileId }); } catch {}
        this.onError?.(fileId, 'Cancelled', fp);
      }
    }
  }

  cancelRecv(fp, fileId) {
    this._clearStall(fp);
    const s = this._recv.get(fp);
    if (s?.fileId === fileId) this._recv.delete(fp);
    this.onError?.(fileId, 'Cancelled', fp);
  }

  async _drain(fp) {
    this._sending.add(fp);
    const q = this._queue.get(fp) || [];
    while (q.length) {
      const { file, fileId } = q[0];
      try   { await this._sendOne(file, fp, fileId); }
      catch (e) {
        this.onError?.(fileId, e.message, fp);
        try { this._ctrl(fp, { type:'file-abort', fileId }); } catch {}
      }
      q.shift();
    }
    this._sending.delete(fp);
  }

  async _sendOne(file, fp, fileId) {
    // Zero-byte files
    if (file.size === 0) {
      this._ctrl(fp, { type:'file-meta', fileId, name:file.name, size:0, mimeType:file.type||'application/octet-stream', totalChunks:0 });
      this._ctrl(fp, { type:'file-end',  fileId, totalChunks:0 });
      this.onProgress?.(fileId, 1, 'send', fp, { bytesTransferred:0, totalBytes:0, speedBps:0, etaSec:0, elapsedSec:0 });
      return;
    }

    const ok = this._ctrl(fp, { type:'file-meta', fileId, name:file.name, size:file.size, mimeType:file.type||'application/octet-stream', totalChunks:Math.ceil(file.size/CHUNK) });
    if (!ok) throw new Error('Peer not connected');

    const t0 = Date.now();
    let offset=0, chunkIdx=0, lastPct=-1, wStart=t0, wBytes=0, speed=0;

    while (offset < file.size) {
      if (this._abort.has(fileId)) { this._abort.delete(fileId); throw new Error('Cancelled'); }
      await this._waitBuf(fp);
      let buf;
      try   { buf = await file.slice(offset, Math.min(offset+CHUNK, file.size)).arrayBuffer(); }
      catch (e) { throw new Error('File read error: ' + e.message); }
      if (!this._binary(fp, buf)) throw new Error('DataChannel closed during transfer');

      offset += buf.byteLength; wBytes += buf.byteLength; chunkIdx++;
      const now=Date.now(), elapsed=(now-t0)/1000, wAge=(now-wStart)/1000;
      if (wAge >= 0.4 || offset >= file.size) { speed=smooth(speed, wAge>0?wBytes/wAge:0); wStart=now; wBytes=0; }
      const pct=offset/file.size, pctInt=Math.floor(pct*100);
      if (pctInt !== lastPct || offset >= file.size) {
        this.onProgress?.(fileId, pct, 'send', fp, { bytesTransferred:offset, totalBytes:file.size, speedBps:speed, etaSec:speed>0?(file.size-offset)/speed:0, elapsedSec:elapsed });
        lastPct = pctInt;
      }
    }
    this._ctrl(fp, { type:'file-end', fileId, totalChunks:chunkIdx });
  }

  // ── Receive ───────────────────────────────────────────────────────────────

  handleCtrl(fp, msg) {
    const { type, fileId } = msg; if (!fileId) return;

    if (type === 'file-meta') {
      this._clearStall(fp);
      this._recv.set(fp, { fileId, name:msg.name||'file', size:msg.size||0, mimeType:msg.mimeType||'application/octet-stream', chunks:[], bytes:0, from:fp, t0:Date.now(), wStart:Date.now(), wBytes:0, speed:0, lastPct:-1, _stall:null });
      this._resetStall(fp);
    } else if (type === 'file-end') {
      this._clearStall(fp); this._finalize(fp, fileId);
    } else if (type === 'file-abort') {
      this._clearStall(fp); this._recv.delete(fp);
      this.onError?.(fileId, 'Transfer aborted by sender', fp);
    }
  }

  handleBinary(fp, buf) {
    const s = this._recv.get(fp);
    if (!s) { console.warn('[TQ files] binary before meta from', fp?.slice(0,8)); return; }
    s.chunks.push(buf); s.bytes += buf.byteLength; s.wBytes += buf.byteLength;
    this._resetStall(fp);
    const now=Date.now(), elapsed=(now-s.t0)/1000, wAge=(now-s.wStart)/1000;
    if (wAge >= 0.4) { s.speed=smooth(s.speed, wAge>0?s.wBytes/wAge:0); s.wStart=now; s.wBytes=0; }
    const pct=s.size>0?Math.min(s.bytes/s.size,0.999):0, pctInt=Math.floor(pct*100);
    if (pctInt !== s.lastPct) {
      this.onProgress?.(s.fileId, pct, 'recv', fp, { bytesTransferred:s.bytes, totalBytes:s.size, speedBps:s.speed, etaSec:s.speed>0?(s.size-s.bytes)/s.speed:0, elapsedSec:elapsed });
      s.lastPct = pctInt;
    }
  }

  // ── Stall detection ───────────────────────────────────────────────────────

  _resetStall(fp) {
    const s = this._recv.get(fp); if (!s) return;
    if (s._stall) clearTimeout(s._stall);
    s._stall = setTimeout(() => {
      const st = this._recv.get(fp); if (!st) return;
      this._recv.delete(fp);
      this.onError?.(st.fileId, `Transfer stalled (${STALL_MS/1000}s)`, fp);
    }, STALL_MS);
  }

  _clearStall(fp) {
    const s = this._recv.get(fp);
    if (s?._stall) { clearTimeout(s._stall); s._stall = null; }
  }

  // ── Finalize ─────────────────────────────────────────────────────────────

  _finalize(fp, fileId) {
    const s = this._recv.get(fp); if (!s || s.fileId !== fileId) return;
    this._recv.delete(fp);
    const elapsed = (Date.now() - s.t0) / 1000;
    if (s.size > 0 && s.bytes !== s.size) console.warn(`[TQ files] size mismatch ${s.name}: expected ${s.size}, got ${s.bytes}`);
    try {
      const blob = new Blob(s.chunks, { type:s.mimeType });
      const url  = URL.createObjectURL(blob);
      this.onProgress?.(fileId, 1, 'recv', fp, { bytesTransferred:s.bytes, totalBytes:s.size, speedBps:elapsed>0?s.bytes/elapsed:0, etaSec:0, elapsedSec:elapsed, done:true });
      this.onFileReady?.({ fileId, url, blob, name:s.name, size:blob.size, mimeType:s.mimeType, from:fp });
    } catch(e) { this.onError?.(fileId, 'Assembly failed: '+e.message, fp); }
  }
}
