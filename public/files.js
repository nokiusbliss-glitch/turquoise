const CHUNK_SIZE = 48 * 1024;
const FRAME_CHUNK = 1;

export class FileTransferEngine {
  constructor(network, hooks = {}) {
    this.network = network;
    this.hooks = hooks;
    this.offers = new Map();      // transferId -> { fp, offer }
    this.outgoing = new Map();    // transferId -> state
    this.incoming = new Map();    // transferId -> state
  }

  handleCtrl(fp, msg) {
    if (!msg?.type) return false;

    if (msg.type === 'file-offer') {
      this.offers.set(msg.id, { fp, offer: msg });
      this.hooks.onOffer?.(fp, msg);
      return true;
    }

    if (msg.type === 'file-accept') {
      const st = this.outgoing.get(msg.id);
      if (!st || st.fp !== fp) return true;
      st.accepted = true;
      this._sendLoop(st).catch(err => this._failOutgoing(st, err));
      return true;
    }

    if (msg.type === 'file-reject') {
      const st = this.outgoing.get(msg.id);
      if (!st) return true;
      st.rejected = true;
      this.hooks.onError?.({
        direction: 'send',
        transferId: st.id,
        fp: st.fp,
        fileName: st.file.name,
        error: 'Receiver declined transfer',
      });
      this.outgoing.delete(st.id);
      return true;
    }

    if (msg.type === 'file-complete') {
      const st = this.incoming.get(msg.id);
      if (!st) return true;
      this._finishIncoming(st);
      return true;
    }

    return false;
  }

  handleBinary(fp, ab) {
    const parsed = parsePacket(ab);
    if (!parsed || parsed.frameType !== FRAME_CHUNK) return false;

    const st = this.incoming.get(parsed.transferId);
    if (!st || st.fp !== fp) return true;

    st.chunks.push(parsed.payload);
    st.received += parsed.payload.byteLength;
    this._emitProgress(st, 'recv');

    return true;
  }

  async sendFile(fp, file, meta = {}) {
    const id = crypto.randomUUID();

    const st = {
      id,
      fp,
      file,
      sessionId: meta.sessionId || '',
      startedAt: performance.now(),
      lastTickAt: performance.now(),
      lastBytes: 0,
      sent: 0,
      accepted: false,
      rejected: false,
    };

    this.outgoing.set(id, st);

    this.network.sendCtrl(fp, {
      type: 'file-offer',
      id,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      sessionId: st.sessionId,
      ts: Date.now(),
    });

    this._emitProgress(st, 'send');
    return id;
  }

  acceptOffer(fp, transferId) {
    const row = this.offers.get(transferId);
    if (!row || row.fp !== fp) return;

    const offer = row.offer;
    this.offers.delete(transferId);

    this.incoming.set(transferId, {
      id: transferId,
      fp,
      fileName: offer.name,
      mime: offer.mime,
      total: offer.size,
      sessionId: offer.sessionId || '',
      chunks: [],
      received: 0,
      startedAt: performance.now(),
      lastTickAt: performance.now(),
      lastBytes: 0,
    });

    this.network.sendCtrl(fp, {
      type: 'file-accept',
      id: transferId,
      ts: Date.now(),
    });
  }

  rejectOffer(fp, transferId) {
    const row = this.offers.get(transferId);
    if (!row || row.fp !== fp) return;
    this.offers.delete(transferId);

    this.network.sendCtrl(fp, {
      type: 'file-reject',
      id: transferId,
      ts: Date.now(),
    });
  }

  async _sendLoop(st) {
    const file = st.file;
    let offset = 0;

    while (offset < file.size) {
      if (st.rejected) throw new Error('transfer rejected');
      await this.network.waitForBuffer(st.fp);

      const end = Math.min(file.size, offset + CHUNK_SIZE);
      const chunk = await readSlice(file, offset, end);
      const packet = buildPacket(st.id, chunk);

      if (!this.network.sendBinary(st.fp, packet)) {
        throw new Error('data channel unavailable');
      }

      offset = end;
      st.sent = offset;
      this._emitProgress(st, 'send');
    }

    this.network.sendCtrl(st.fp, {
      type: 'file-complete',
      id: st.id,
      ts: Date.now(),
    });

    this.hooks.onComplete?.({
      direction: 'send',
      transferId: st.id,
      fp: st.fp,
      fileName: st.file.name,
      size: st.file.size,
      sessionId: st.sessionId,
      blob: st.file,
    });

    this.outgoing.delete(st.id);
  }

  _finishIncoming(st) {
    const blob = new Blob(st.chunks, { type: st.mime || 'application/octet-stream' });

    this.hooks.onComplete?.({
      direction: 'recv',
      transferId: st.id,
      fp: st.fp,
      fileName: st.fileName,
      size: st.total,
      sessionId: st.sessionId,
      blob,
    });

    this.incoming.delete(st.id);
  }

  _emitProgress(st, direction) {
    const now = performance.now();
    const bytes = direction === 'send' ? st.sent : st.received;
    const total = direction === 'send' ? st.file.size : st.total;

    const dt = Math.max(0.001, (now - st.lastTickAt) / 1000);
    const db = bytes - st.lastBytes;
    const speed = db / dt;

    st.lastTickAt = now;
    st.lastBytes = bytes;

    const pct = total > 0 ? Math.min(100, (bytes / total) * 100) : 0;
    const remaining = Math.max(0, total - bytes);
    const etaSec = speed > 0 ? remaining / speed : Infinity;

    this.hooks.onProgress?.({
      direction,
      transferId: st.id,
      fp: st.fp,
      fileName: direction === 'send' ? st.file.name : st.fileName,
      sessionId: st.sessionId,
      bytes,
      total,
      pct,
      speed,
      etaSec,
      elapsedSec: (performance.now() - st.startedAt) / 1000,
    });
  }

  _failOutgoing(st, err) {
    this.hooks.onError?.({
      direction: 'send',
      transferId: st.id,
      fp: st.fp,
      fileName: st.file.name,
      error: err?.message || String(err),
    });
    this.outgoing.delete(st.id);
  }
}

function buildPacket(transferId, payloadAb) {
  const encoder = new TextEncoder();
  const idBytes = encoder.encode(transferId);

  const headerLen = 1 + 2 + 4 + idBytes.length;
  const out = new Uint8Array(headerLen + payloadAb.byteLength);
  const view = new DataView(out.buffer);

  out[0] = FRAME_CHUNK;
  view.setUint16(1, idBytes.length);
  view.setUint32(3, payloadAb.byteLength);

  out.set(idBytes, 7);
  out.set(new Uint8Array(payloadAb), headerLen);

  return out.buffer;
}

function parsePacket(ab) {
  if (!(ab instanceof ArrayBuffer) || ab.byteLength < 7) return null;
  const u8 = new Uint8Array(ab);
  const view = new DataView(ab);

  const frameType = u8[0];
  const idLen = view.getUint16(1);
  const payloadLen = view.getUint32(3);

  const expected = 7 + idLen + payloadLen;
  if (ab.byteLength < expected) return null;

  const idBytes = u8.slice(7, 7 + idLen);
  const transferId = new TextDecoder().decode(idBytes);
  const payload = ab.slice(7 + idLen, expected);

  return { frameType, transferId, payload };
}

function readSlice(file, start, end) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('slice read failed'));
    fr.readAsArrayBuffer(file.slice(start, end));
  });
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '-';
  if (n < 1024) return `${n.toFixed(0)} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtRate(n) {
  if (!Number.isFinite(n)) return '-';
  return `${fmtBytes(n)}/s`;
}

export function fmtEta(sec) {
  if (!Number.isFinite(sec)) return '∞';
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}
