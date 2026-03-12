/**
 * folder.js — Turquoise Folder Transfer
 *
 * Sends an entire directory tree to one or more peers, preserving the
 * folder structure. The receiver can download all files as a ZIP.
 *
 * Works on top of the existing FileTransfer (files.js) — it reuses the same
 * binary data channel and ctrl messages, just adds a folder-manifest envelope.
 *
 * ── Integration (app.js) ────────────────────────────────────────────────────
 *   import { FolderTransfer } from './folder.js';
 *
 *   // In TurquoiseApp constructor:
 *   this.folderTransfer = new FolderTransfer(
 *     this.ft,
 *     (fp, msg) => network.sendCtrl(fp, msg),
 *   );
 *   this.folderTransfer.onProgress    = (folderId, done, total, dir, fp) => { ... };
 *   this.folderTransfer.onFolderReady = ({ folderId, name, files, from, downloadZip }) => { ... };
 *
 *   // In _dispatch, add:
 *   if (msg.type === 'folder-manifest') { this.folderTransfer.handleCtrl(fp, msg); return; }
 *
 *   // In _onFileReady, add BEFORE normal file handling:
 *   if (this.folderTransfer.claimFile(f)) return; // folder owns this fileId
 *
 *   // In _buildPlusMenu, add:
 *   <div id="pmi-folder">📁 send folder</div>
 *   $('pmi-folder').addEventListener('click', () => {
 *     this.folderTransfer.sendFolder(targetFp, crypto.randomUUID());
 *   });
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Wire protocol (ctrl channel):
 *   Sender → Receiver:
 *     { type:'folder-manifest', folderId, name, totalSize,
 *       files:[{ fileId, relativePath, size, mimeType }] }
 *   Then each file is sent normally via FileTransfer.send().
 *   No folder-end message needed: receiver counts files.
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
    this._parts   = [];  // Blobs/ArrayBuffers for local headers + data
    this._entries = [];  // Metadata for central directory
    this._offset  = 0;   // Running byte offset
  }

  /**
   * Add a file to the ZIP (store, no compression).
   * @param {string}     path     - Slash-separated path within the ZIP
   * @param {Uint8Array} data     - File bytes
   */
  addFile(path, data) {
    const nameBytes = new TextEncoder().encode(path);
    const crc       = crc32(data);
    const size      = data.length;

    // Local file header (30 bytes + name)
    const localHeader = new DataView(new ArrayBuffer(30 + nameBytes.length));
    let o = 0;
    localHeader.setUint32(o, 0x04034B50, true); o += 4; // signature
    localHeader.setUint16(o, 20,         true); o += 2; // version needed (2.0)
    localHeader.setUint16(o, 0,          true); o += 2; // general purpose flags
    localHeader.setUint16(o, 0,          true); o += 2; // compression (0=store)
    localHeader.setUint16(o, 0,          true); o += 2; // last mod time
    localHeader.setUint16(o, 0,          true); o += 2; // last mod date
    localHeader.setUint32(o, crc,        true); o += 4; // CRC-32
    localHeader.setUint32(o, size,       true); o += 4; // compressed size
    localHeader.setUint32(o, size,       true); o += 4; // uncompressed size
    localHeader.setUint16(o, nameBytes.length, true); o += 2; // file name length
    localHeader.setUint16(o, 0,          true); o += 2; // extra field length
    new Uint8Array(localHeader.buffer, 30).set(nameBytes);

    const localOffset = this._offset;
    this._parts.push(localHeader.buffer);
    this._parts.push(data.buffer ?? data); // accept both Uint8Array and ArrayBuffer
    this._offset += 30 + nameBytes.length + size;

    this._entries.push({ nameBytes, crc, size, localOffset });
  }

  /** Build and return the complete ZIP as a Blob. */
  build() {
    const cdParts = [];
    let cdSize    = 0;

    for (const e of this._entries) {
      const cd = new DataView(new ArrayBuffer(46 + e.nameBytes.length));
      let o = 0;
      cd.setUint32(o, 0x02014B50, true); o += 4; // central dir signature
      cd.setUint16(o, 20,         true); o += 2; // version made by
      cd.setUint16(o, 20,         true); o += 2; // version needed
      cd.setUint16(o, 0,          true); o += 2; // flags
      cd.setUint16(o, 0,          true); o += 2; // compression
      cd.setUint16(o, 0,          true); o += 2; // mod time
      cd.setUint16(o, 0,          true); o += 2; // mod date
      cd.setUint32(o, e.crc,      true); o += 4;
      cd.setUint32(o, e.size,     true); o += 4; // compressed size
      cd.setUint32(o, e.size,     true); o += 4; // uncompressed size
      cd.setUint16(o, e.nameBytes.length, true); o += 2;
      cd.setUint16(o, 0,          true); o += 2; // extra field
      cd.setUint16(o, 0,          true); o += 2; // comment
      cd.setUint16(o, 0,          true); o += 2; // disk start
      cd.setUint16(o, 0,          true); o += 2; // internal attributes
      cd.setUint32(o, 0,          true); o += 4; // external attributes
      cd.setUint32(o, e.localOffset, true); o += 4; // local header offset
      new Uint8Array(cd.buffer, 46).set(e.nameBytes);
      cdParts.push(cd.buffer);
      cdSize += 46 + e.nameBytes.length;
    }

    const n    = this._entries.length;
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0,  0x06054B50, true); // end of central dir signature
    eocd.setUint16(4,  0,          true); // disk number
    eocd.setUint16(6,  0,          true); // start disk
    eocd.setUint16(8,  n,          true); // entries on disk
    eocd.setUint16(10, n,          true); // total entries
    eocd.setUint32(12, cdSize,     true); // central dir size
    eocd.setUint32(16, this._offset, true); // central dir offset
    eocd.setUint16(20, 0,          true); // comment length

    return new Blob([...this._parts, ...cdParts, eocd.buffer], {
      type: 'application/zip',
    });
  }
}

// ── FolderTransfer ────────────────────────────────────────────────────────────

// Threshold above which we skip in-memory ZIP and offer individual downloads
const ZIP_SIZE_LIMIT = 512 * 1024 * 1024; // 512 MB

export class FolderTransfer {
  /**
   * @param {import('./files.js').FileTransfer} fileTransfer
   * @param {(fp:string, msg:object) => boolean} sendCtrlFn
   */
  constructor(fileTransfer, sendCtrlFn) {
    this._ft        = fileTransfer;
    this._sendCtrl  = sendCtrlFn;

    // fileId → folderId (for routing received files back to folder)
    this._fileToFolder = new Map();

    // folderId → RecvState
    this._receiving = new Map();

    /** @type {((folderId:string, done:number, total:number, dir:'send'|'recv', fp:string) => void) | null} */
    this.onProgress    = null;

    /** @type {((info:{folderId:string, name:string, from:string, files:object[], totalSize:number, downloadZip:()=>Promise<void>, downloadAll:()=>void}) => void) | null} */
    this.onFolderReady = null;

    /** @type {((folderId:string, msg:string, fp:string) => void) | null} */
    this.onError = null;
  }

  // ── Sender ────────────────────────────────────────────────────────────────

  /**
   * Prompt the user to pick a folder, then send it to `fp`.
   * Returns false if the user cancels, true if transfer was queued.
   * @param {string}   fp       - Peer fingerprint
   * @param {string}   folderId - Unique ID for this folder transfer
   */
  async sendFolder(fp, folderId) {
    let entries;
    try {
      entries = await FolderTransfer.pickFiles();
    } catch (e) {
      this.onError?.(folderId, 'Could not access folder: ' + e.message, fp);
      return false;
    }

    if (!entries?.length) return false; // user cancelled

    // Derive folder name from the first entry's top-level component
    const folderName = entries[0].relativePath.split('/')[0] || 'folder';
    let totalSize    = 0;

    const fileList = entries.map((e, i) => {
      totalSize += e.file.size;
      return {
        fileId:       `${folderId}:${i}`,
        relativePath: e.relativePath,
        size:         e.file.size,
        mimeType:     e.file.type || 'application/octet-stream',
      };
    });

    // Send manifest so receiver knows what's coming
    const ok = this._sendCtrl(fp, {
      type:      'folder-manifest',
      folderId,
      name:      folderName,
      totalSize,
      files:     fileList,
    });
    if (!ok) {
      this.onError?.(folderId, 'Peer not connected', fp);
      return false;
    }

    this.onProgress?.(folderId, 0, fileList.length, 'send', fp);

    // Queue every file via FileTransfer — they drain serially per peer
    for (let i = 0; i < entries.length; i++) {
      this._ft.send(entries[i].file, fp, fileList[i].fileId);
    }

    return true;
  }

  // ── Receiver ctrl handler ─────────────────────────────────────────────────

  /**
   * Call this from app.js _dispatch when msg.type === 'folder-manifest'.
   */
  handleCtrl(fp, msg) {
    if (msg.type !== 'folder-manifest') return;
    const { folderId, name, files, totalSize } = msg;
    if (!folderId || !Array.isArray(files)) return;

    const state = {
      folderId,
      name:      name || 'folder',
      from:      fp,
      manifest:  files,
      received:  new Map(), // fileId → { url, name, size, mimeType, relativePath }
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
   * Call this BEFORE the normal onFileReady handler.
   * Returns true if this file belonged to a folder transfer (caller should skip normal handling).
   * @param {{ fileId:string, url:string, name:string, size:number, mimeType:string, from:string }} fileInfo
   */
  claimFile(fileInfo) {
    const { fileId } = fileInfo;
    const folderId   = this._fileToFolder.get(fileId);
    if (!folderId) return false;

    this._fileToFolder.delete(fileId);
    const state = this._receiving.get(folderId);
    if (!state) return true; // folder already cleaned up

    const entry = state.manifest.find(f => f.fileId === fileId);
    state.received.set(fileId, {
      url:          fileInfo.url,
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

  async _finalize(folderId) {
    const state = this._receiving.get(folderId);
    if (!state) return;
    this._receiving.delete(folderId);

    const files      = [...state.received.values()];
    const totalSize  = files.reduce((n, f) => n + f.size, 0);
    const folderName = state.name;

    // downloadZip: fetch blobs back from object URLs and build a ZIP
    const downloadZip = async () => {
      if (totalSize > ZIP_SIZE_LIMIT) {
        // Too large to hold in memory — fall back to individual downloads
        console.warn(`[TQ folder] folder too large for in-memory ZIP (${totalSize} bytes), falling back to individual downloads`);
        downloadAll();
        return;
      }

      const zip = new ZipBuilder();
      for (const f of files) {
        let buf;
        try {
          const resp = await fetch(f.url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          buf = new Uint8Array(await resp.arrayBuffer());
        } catch (e) {
          console.error('[TQ folder] failed to fetch blob for ZIP:', f.relativePath, e);
          continue;
        }
        zip.addFile(f.relativePath, buf);
      }
      const blob   = zip.build();
      const zipUrl = URL.createObjectURL(blob);
      triggerDownload(zipUrl, folderName + '.zip');
      setTimeout(() => URL.revokeObjectURL(zipUrl), 60_000);
    };

    // downloadAll: trigger individual browser downloads for each file
    const downloadAll = () => {
      files.forEach((f, i) => {
        // Stagger downloads to avoid browser blocking multiple simultaneous downloads
        setTimeout(() => triggerDownload(f.url, f.name || f.relativePath.split('/').pop()), i * 80);
      });
    };

    this.onFolderReady?.({
      folderId,
      name:      folderName,
      from:      state.from,
      files,
      totalSize,
      downloadZip,
      downloadAll,
    });
  }

  // ── Directory picker ──────────────────────────────────────────────────────

  /**
   * Pick a directory using the File System Access API (Chrome/Edge) or
   * the `<input webkitdirectory>` fallback (Firefox/Safari).
   * Resolves to an array of { file: File, relativePath: string }
   * or null if the user cancelled.
   */
  static async pickFiles() {
    if ('showDirectoryPicker' in window) {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        return FolderTransfer._walkDir(handle, '');
      } catch (e) {
        if (e.name === 'AbortError') return null;
        // Fall through to input fallback on other errors (e.g. SecurityError)
        console.warn('[TQ folder] showDirectoryPicker failed, trying input fallback:', e.message);
      }
    }
    return FolderTransfer._inputFallback();
  }

  static async _walkDir(dirHandle, prefix) {
    const result = [];
    for await (const [name, handle] of dirHandle) {
      // Skip hidden files and macOS metadata
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
        const sub = await FolderTransfer._walkDir(handle, path);
        result.push(...sub);
      }
    }
    return result;
  }

  static _inputFallback() {
    return new Promise((resolve) => {
      const input     = document.createElement('input');
      input.type      = 'file';
      input.multiple  = true;
      input.style.display = 'none';

      // webkitdirectory is supported by Chrome, Firefox, Safari 11.1+
      try { input.webkitdirectory = true; } catch {}

      const cleanup = () => {
        try { document.body.removeChild(input); } catch {}
      };

      input.onchange = () => {
        const files = [];
        for (const f of input.files || []) {
          // webkitRelativePath: "folderName/path/to/file.ext"
          const rel = f.webkitRelativePath || f.name;
          files.push({ file: f, relativePath: rel });
        }
        cleanup();
        resolve(files.length ? files : null);
      };

      // Some browsers fire 'cancel' on the input element
      input.addEventListener('cancel', () => { cleanup(); resolve(null); });

      document.body.appendChild(input);
      input.click();

      // If focus returns to window without a change event, the user cancelled
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

function triggerDownload(url, filename) {
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { try { document.body.removeChild(a); } catch {} }, 1000);
}
