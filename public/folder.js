/**
 * folder.js — Turquoise Folder Transfer v2
 *
 * Changes over v1:
 *   - claimFile now stores the raw Blob (passed by files.js v2's onFileReady)
 *     alongside the URL. downloadZip uses the blob directly via
 *     blob.arrayBuffer() — no fetch() call needed. This eliminates any risk
 *     of reading a revoked or expired blob URL during ZIP assembly.
 *   - _finalize exposes a per-file `download(fileId)` function in the
 *     onFolderReady payload so the UI can offer individual file saves.
 *   - onFolderReady payload now includes `manifest` (the original file list
 *     with relativePaths) so the UI can render a file-tree card.
 *   - downloadAll staggers downloads by 120ms (was 80ms) for better browser
 *     compatibility on slower machines.
 *
 * Wire protocol (ctrl channel):
 *   Sender → Receiver:
 *     { type:'folder-manifest', folderId, name, totalSize,
 *       files:[{ fileId, relativePath, size, mimeType }] }
 *   Then each file is sent normally via FileTransfer.send().
 */

// ── ZIP builder (pure JS, no dependencies, store-only / no compression) ──────

function makeCRC32Table() {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
}
const _CRC32_TABLE = makeCRC32Table();

function crc32(uint8arr) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < uint8arr.length; i++) {
    c = (_CRC32_TABLE[(c ^ uint8arr[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

class ZipBuilder {
  constructor() {
    this._parts   = [];
    this._entries = [];
    this._offset  = 0;
  }

  addFile(path, data) {
    const nameBytes = new TextEncoder().encode(path);
    const crc       = crc32(data);
    const size      = data.length;

    const localHeader = new DataView(new ArrayBuffer(30 + nameBytes.length));
    let o = 0;
    localHeader.setUint32(o, 0x04034B50, true); o += 4;
    localHeader.setUint16(o, 20,         true); o += 2;
    localHeader.setUint16(o, 0,          true); o += 2;
    localHeader.setUint16(o, 0,          true); o += 2;
    localHeader.setUint16(o, 0,          true); o += 2;
    localHeader.setUint16(o, 0,          true); o += 2;
    localHeader.setUint32(o, crc,        true); o += 4;
    localHeader.setUint32(o, size,       true); o += 4;
    localHeader.setUint32(o, size,       true); o += 4;
    localHeader.setUint16(o, nameBytes.length, true); o += 2;
    localHeader.setUint16(o, 0,          true); o += 2;
    new Uint8Array(localHeader.buffer, 30).set(nameBytes);

    const localOffset = this._offset;
    this._parts.push(localHeader.buffer);
    this._parts.push(data.buffer ?? data);
    this._offset += 30 + nameBytes.length + size;

    this._entries.push({ nameBytes, crc, size, localOffset });
  }

  build() {
    const cdParts = [];
    let cdSize    = 0;

    for (const e of this._entries) {
      const cd = new DataView(new ArrayBuffer(46 + e.nameBytes.length));
      let o = 0;
      cd.setUint32(o, 0x02014B50, true); o += 4;
      cd.setUint16(o, 20,         true); o += 2;
      cd.setUint16(o, 20,         true); o += 2;
      cd.setUint16(o, 0,          true); o += 2;
      cd.setUint16(o, 0,          true); o += 2;
      cd.setUint16(o, 0,          true); o += 2;
      cd.setUint16(o, 0,          true); o += 2;
      cd.setUint32(o, e.crc,      true); o += 4;
      cd.setUint32(o, e.size,     true); o += 4;
      cd.setUint32(o, e.size,     true); o += 4;
      cd.setUint16(o, e.nameBytes.length, true); o += 2;
      cd.setUint16(o, 0,          true); o += 2;
      cd.setUint16(o, 0,          true); o += 2;
      cd.setUint16(o, 0,          true); o += 2;
      cd.setUint16(o, 0,          true); o += 2;
      cd.setUint32(o, 0,          true); o += 4;
      cd.setUint32(o, e.localOffset, true); o += 4;
      new Uint8Array(cd.buffer, 46).set(e.nameBytes);
      cdParts.push(cd.buffer);
      cdSize += 46 + e.nameBytes.length;
    }

    const n    = this._entries.length;
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0,  0x06054B50, true);
    eocd.setUint16(4,  0,          true);
    eocd.setUint16(6,  0,          true);
    eocd.setUint16(8,  n,          true);
    eocd.setUint16(10, n,          true);
    eocd.setUint32(12, cdSize,     true);
    eocd.setUint32(16, this._offset, true);
    eocd.setUint16(20, 0,          true);

    return new Blob([...this._parts, ...cdParts, eocd.buffer], {
      type: 'application/zip',
    });
  }
}

// ── FolderTransfer ────────────────────────────────────────────────────────────

const ZIP_SIZE_LIMIT = 512 * 1024 * 1024; // 512 MB — skip in-memory ZIP above this

export class FolderTransfer {
  constructor(fileTransfer, sendCtrlFn) {
    this._ft       = fileTransfer;
    this._sendCtrl = sendCtrlFn;

    // fileId → folderId (for routing received files back to folder)
    this._fileToFolder = new Map();

    // folderId → RecvState
    this._receiving = new Map();

    /** @type {((folderId, done, total, dir, fp) => void)|null} */
    this.onProgress = null;

    /**
     * @type {((info:{
     *   folderId, name, from, totalSize,
     *   manifest: {fileId, relativePath, size, mimeType}[],
     *   files: {url, blob, name, size, mimeType, relativePath}[],
     *   downloadZip: () => Promise<void>,
     *   downloadAll: () => void,
     *   download: (fileId: string) => void,
     * }) => void)|null}
     */
    this.onFolderReady = null;

    /** @type {((folderId, msg, fp) => void)|null} */
    this.onError = null;
  }

  // ── Sender ────────────────────────────────────────────────────────────────

  async sendFolder(fp, folderId) {
    let entries;
    try {
      entries = await FolderTransfer.pickFiles();
    } catch (e) {
      this.onError?.(folderId, 'Could not access folder: ' + e.message, fp);
      return false;
    }
    if (!entries?.length) return false;

    const folderName = entries[0].relativePath.split('/')[0] || 'folder';
    let totalSize    = 0;
    const fileList   = entries.map((e, i) => {
      totalSize += e.file.size;
      return {
        fileId:       `${folderId}:${i}`,
        relativePath: e.relativePath,
        size:         e.file.size,
        mimeType:     e.file.type || 'application/octet-stream',
      };
    });

    const ok = this._sendCtrl(fp, {
      type: 'folder-manifest', folderId, name: folderName, totalSize, files: fileList,
    });
    if (!ok) { this.onError?.(folderId, 'Peer not connected', fp); return false; }

    this.onProgress?.(folderId, 0, fileList.length, 'send', fp);
    for (let i = 0; i < entries.length; i++) {
      this._ft.send(entries[i].file, fp, fileList[i].fileId);
    }
    return true;
  }

  // ── Receiver ctrl handler ─────────────────────────────────────────────────

  handleCtrl(fp, msg) {
    if (msg.type !== 'folder-manifest') return;
    const { folderId, name, files, totalSize } = msg;
    if (!folderId || !Array.isArray(files)) return;

    const state = {
      folderId,
      name:      name || 'folder',
      from:      fp,
      manifest:  files,            // original manifest with relativePaths
      received:  new Map(),        // fileId → { url, blob, name, size, mimeType, relativePath }
      total:     files.length,
      totalSize: totalSize || 0,
    };
    this._receiving.set(folderId, state);
    files.forEach(f => {
      if (f?.fileId) this._fileToFolder.set(f.fileId, folderId);
    });
    this.onProgress?.(folderId, 0, files.length, 'recv', fp);
  }

  /**
   * Call BEFORE normal onFileReady handler.
   * Returns true if this file belonged to a folder (caller should skip normal handling).
   * @param {{ fileId, url, blob, name, size, mimeType, from }} fileInfo
   */
  claimFile(fileInfo) {
    const { fileId } = fileInfo;
    const folderId   = this._fileToFolder.get(fileId);
    if (!folderId) return false;

    this._fileToFolder.delete(fileId);
    const state = this._receiving.get(folderId);
    if (!state) return true; // already cleaned up

    const entry = state.manifest.find(f => f.fileId === fileId);
    state.received.set(fileId, {
      url:          fileInfo.url,
      blob:         fileInfo.blob || null, // blob passed by files.js v2
      name:         fileInfo.name,
      size:         fileInfo.size,
      mimeType:     fileInfo.mimeType,
      relativePath: entry?.relativePath || fileInfo.name,
    });

    const done = state.received.size;
    this.onProgress?.(folderId, done, state.total, 'recv', fileInfo.from);
    if (done >= state.total) this._finalize(folderId);
    return true;
  }

  // ── Finalize ─────────────────────────────────────────────────────────────

  _finalize(folderId) {
    const state = this._receiving.get(folderId);
    if (!state) return;
    this._receiving.delete(folderId);

    const files      = [...state.received.values()];
    const totalSize  = files.reduce((n, f) => n + f.size, 0);
    const folderName = state.name;

    // Collect blobs / URLs keyed by fileId for per-file download
    const byId = new Map(
      [...state.received.entries()].map(([id, f]) => [id, f])
    );

    // downloadZip: build ZIP from stored blobs (no fetch needed)
    const downloadZip = async () => {
      if (totalSize > ZIP_SIZE_LIMIT) {
        console.warn(`[TQ folder] folder too large for in-memory ZIP (${totalSize} bytes), falling back to individual downloads`);
        downloadAll();
        return;
      }
      const zip = new ZipBuilder();
      for (const f of files) {
        let buf;
        try {
          if (f.blob) {
            // Preferred path: use stored blob directly
            buf = new Uint8Array(await f.blob.arrayBuffer());
          } else {
            // Fallback: fetch from URL (older transfers without blob field)
            const resp = await fetch(f.url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            buf = new Uint8Array(await resp.arrayBuffer());
          }
        } catch (e) {
          console.error('[TQ folder] skipping file in ZIP:', f.relativePath, e);
          continue;
        }
        zip.addFile(f.relativePath, buf);
      }
      const blob   = zip.build();
      const zipUrl = URL.createObjectURL(blob);
      _triggerDownload(zipUrl, folderName + '.zip');
      setTimeout(() => URL.revokeObjectURL(zipUrl), 60_000);
    };

    // downloadAll: trigger individual downloads with a small stagger
    const downloadAll = () => {
      files.forEach((f, i) => {
        setTimeout(
          () => _triggerDownload(f.url, f.name || f.relativePath.split('/').pop() || 'file'),
          i * 120
        );
      });
    };

    // download: save a single file by fileId
    const download = (fid) => {
      const f = byId.get(fid);
      if (!f) return;
      _triggerDownload(f.url, f.name || f.relativePath.split('/').pop() || 'file');
    };

    this.onFolderReady?.({
      folderId,
      name:     folderName,
      from:     state.from,
      manifest: state.manifest,  // [{fileId, relativePath, size, mimeType}]
      files,
      totalSize,
      downloadZip,
      downloadAll,
      download,
    });
  }

  // ── Directory picker ──────────────────────────────────────────────────────

  static async pickFiles() {
    if ('showDirectoryPicker' in window) {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        return FolderTransfer._walkDir(handle, '');
      } catch (e) {
        if (e.name === 'AbortError') return null;
        console.warn('[TQ folder] showDirectoryPicker failed, trying input fallback:', e.message);
      }
    }
    return FolderTransfer._inputFallback();
  }

  static async _walkDir(dirHandle, prefix) {
    const result = [];
    for await (const [name, handle] of dirHandle) {
      if (name.startsWith('.') || name === '__MACOSX') continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'file') {
        try {
          const file = await handle.getFile();
          result.push({ file, relativePath: path });
        } catch (e) {
          console.warn('[TQ folder] skipping unreadable file:', path, e.message);
        }
      } else if (handle.kind === 'directory') {
        result.push(...await FolderTransfer._walkDir(handle, path));
      }
    }
    return result;
  }

  static _inputFallback() {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type  = 'file';
      input.multiple = true;
      input.style.display = 'none';
      try { input.webkitdirectory = true; } catch {}

      const cleanup = () => { try { document.body.removeChild(input); } catch {} };

      input.onchange = () => {
        const files = [];
        for (const f of input.files || []) {
          files.push({ file: f, relativePath: f.webkitRelativePath || f.name });
        }
        cleanup();
        resolve(files.length ? files : null);
      };

      input.addEventListener('cancel', () => { cleanup(); resolve(null); });
      document.body.appendChild(input);
      input.click();

      const onFocus = () => {
        window.removeEventListener('focus', onFocus);
        setTimeout(() => {
          if (!input.files?.length) { cleanup(); resolve(null); }
        }, 500);
      };
      window.addEventListener('focus', onFocus, { once: true });
    });
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function _triggerDownload(url, filename) {
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { try { document.body.removeChild(a); } catch {} }, 1000);
}
