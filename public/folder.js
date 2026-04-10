/**
 * folder.js — Turquoise v7
 * Folder transfer + in-memory ZIP builder. Leaner rewrite of v2 (~45% smaller).
 *
 * Wire protocol:
 *   Sender → Receiver:  { type:'folder-manifest', folderId, name, totalSize,
 *                          files:[{fileId, relativePath, size, mimeType}] }
 *   Then each file via FileTransfer.send().
 *
 * ZIP: pure-JS store (no compression), capped at ZIP_LIMIT (512 MB).
 * Blobs from files.js v2+ are used directly — no fetch() needed.
 */

// ── CRC-32 ────────────────────────────────────────────────────────────────────
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[i]=c>>>0;}
  return t;
})();
const crc32 = u8 => { let c=0xFFFFFFFF; for(let i=0;i<u8.length;i++) c=(CRC[(c^u8[i])&0xFF]^(c>>>8))>>>0; return (c^0xFFFFFFFF)>>>0; };

// ── ZIP builder (store-only) ──────────────────────────────────────────────────
class ZipBuilder {
  constructor() { this._parts=[]; this._entries=[]; this._offset=0; }

  addFile(path, u8) {
    const name = new TextEncoder().encode(path);
    const crc  = crc32(u8), sz = u8.length;
    const lh   = new DataView(new ArrayBuffer(30 + name.length));
    // Local file header
    [[0,0x04034B50],[4,20],[6,0],[8,0],[10,0],[12,0],[16,crc],[20,sz],[24,sz]].forEach(([o,v])=>lh.setUint32(o,v,true));
    lh.setUint16(26, name.length, true);
    new Uint8Array(lh.buffer, 30).set(name);
    const localOffset = this._offset;
    // Slice the exact byte range — u8.buffer may be a larger backing buffer
    // when u8 is a subarray; using it directly would write excess bytes and
    // corrupt the ZIP entry.
    const dataSlice = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    this._parts.push(lh.buffer, dataSlice);
    this._offset += 30 + name.length + sz;
    this._entries.push({ name, crc, sz, localOffset });
  }

  build() {
    const cdParts=[]; let cdSize=0;
    for (const e of this._entries) {
      const cd = new DataView(new ArrayBuffer(46+e.name.length));
      [[0,0x02014B50],[4,20],[6,20],[8,0],[10,0],[12,0],[14,0],[16,e.crc],[20,e.sz],[24,e.sz],[42,e.localOffset]].forEach(([o,v])=>cd.setUint32(o,v,true));
      cd.setUint16(28, e.name.length, true);
      new Uint8Array(cd.buffer, 46).set(e.name);
      cdParts.push(cd.buffer); cdSize += 46+e.name.length;
    }
    const n=this._entries.length, eocd=new DataView(new ArrayBuffer(22));
    [[0,0x06054B50],[8,n],[10,n],[12,cdSize],[16,this._offset]].forEach(([o,v])=>eocd.setUint32(o,v,true));
    return new Blob([...this._parts,...cdParts,eocd.buffer],{type:'application/zip'});
  }
}

// ── FolderTransfer ────────────────────────────────────────────────────────────
const ZIP_LIMIT = 512*1024*1024;

export class FolderTransfer {
  constructor(fileTransfer, sendCtrlFn) {
    this._ft       = fileTransfer;
    this._ctrl     = sendCtrlFn;
    this._f2folder = new Map();   // fileId → folderId
    this._recv     = new Map();   // folderId → state

    this.onProgress    = null;   // (folderId, done, total, dir, fp) => void
    this.onFolderReady = null;   // (info) => void
    this.onError       = null;   // (folderId, msg, fp) => void
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  async sendFolder(fp, folderId) {
    let entries;
    try   { entries = await FolderTransfer.pickFiles(); }
    catch (e) { this.onError?.(folderId,'Could not access folder: '+e.message,fp); return false; }
    if (!entries?.length) return false;

    const name  = entries[0].relativePath.split('/')[0] || 'folder';
    let total   = 0;
    const files = entries.map((e,i) => { total+=e.file.size; return { fileId:`${folderId}:${i}`, relativePath:e.relativePath, size:e.file.size, mimeType:e.file.type||'application/octet-stream' }; });

    const ok = this._ctrl(fp, { type:'folder-manifest', folderId, name, totalSize:total, files });
    if (!ok) { this.onError?.(folderId,'Peer not connected',fp); return false; }
    this.onProgress?.(folderId, 0, files.length, 'send', fp);
    entries.forEach((e,i) => this._ft.send(e.file, fp, files[i].fileId));
    return true;
  }

  // ── Receive ───────────────────────────────────────────────────────────────

  handleCtrl(fp, msg) {
    if (msg.type !== 'folder-manifest') return;
    const { folderId, name, files, totalSize } = msg;
    if (!folderId || !Array.isArray(files)) return;
    let state = this._recv.get(folderId);
    if (!state) {
      state = { folderId, name:name||'folder', from:fp, manifest:files, received:new Map(), total:files.length, totalSize:totalSize||0 };
      this._recv.set(folderId, state);
    } else {
      state.name = name || state.name || 'folder';
      state.from = fp;
      state.manifest = files;
      state.total = files.length;
      state.totalSize = totalSize || state.totalSize || 0;
    }
    files.forEach(f => {
      if (f?.fileId && !state.received.has(f.fileId)) this._f2folder.set(f.fileId, folderId);
    });
    this.onProgress?.(folderId, state.received.size, files.length, 'recv', fp);
  }

  /**
   * Call from app's onFileReady handler FIRST.
   * Returns true if this file belongs to a folder (skip normal handling).
   */
  claimFile(fileInfo) {
    const { fileId } = fileInfo;
    const folderId   = this._f2folder.get(fileId);
    if (!folderId) return false;
    this._f2folder.delete(fileId);
    const state = this._recv.get(folderId);
    if (!state) return true;
    const entry = state.manifest.find(f => f.fileId === fileId);
    state.received.set(fileId, { url:fileInfo.url, blob:fileInfo.blob||null, name:fileInfo.name, size:fileInfo.size, mimeType:fileInfo.mimeType, relativePath:entry?.relativePath||fileInfo.name });
    this.onProgress?.(folderId, state.received.size, state.total, 'recv', fileInfo.from);
    if (state.received.size >= state.total) this._finalize(folderId);
    return true;
  }

  handleFileError(fileId, from, msg) {
    const folderId = this._f2folder.get(fileId);
    if (!folderId) return false;
    this._fail(folderId, msg, from);
    return true;
  }

  // ── Finalize ─────────────────────────────────────────────────────────────

  _finalize(folderId) {
    const state = this._recv.get(folderId); if (!state) return;
    this._recv.delete(folderId);
    const files   = [...state.received.values()];
    const total   = files.reduce((n,f) => n+f.size, 0);
    const byId    = new Map([...state.received.entries()]);

    const downloadZip = async () => {
      if (total > ZIP_LIMIT) { downloadAll(); return; }
      const zip = new ZipBuilder();
      for (const f of files) {
        try {
          const u8 = new Uint8Array(f.blob ? await f.blob.arrayBuffer() : await (await fetch(f.url)).arrayBuffer());
          zip.addFile(f.relativePath, u8);
        } catch(e) { console.error('[TQ folder] skip in ZIP:', f.relativePath, e.message); }
      }
      const blob=zip.build(), url=URL.createObjectURL(blob);
      _dl(url, state.name+'.zip');
      setTimeout(()=>URL.revokeObjectURL(url), 60_000);
    };

    const downloadAll = () => files.forEach((f,i) => setTimeout(()=>_dl(f.url, f.name||f.relativePath.split('/').pop()||'file'), i*120));
    const download    = fid => { const f=byId.get(fid); if(f) _dl(f.url, f.name||f.relativePath.split('/').pop()||'file'); };

    this.onFolderReady?.({ folderId, name:state.name, from:state.from, manifest:state.manifest, files, totalSize:total, downloadZip, downloadAll, download });
  }

  _fail(folderId, msg, fp) {
    const state = this._recv.get(folderId);
    if (!state) return;
    this._recv.delete(folderId);
    (state.manifest || []).forEach(f => {
      if (f?.fileId) this._f2folder.delete(f.fileId);
    });
    this.onError?.(folderId, msg, fp);
  }

  // ── Directory picker ──────────────────────────────────────────────────────

  static async pickFiles() {
    if ('showDirectoryPicker' in window) {
      try {
        const h = await window.showDirectoryPicker({ mode:'read' });
        return FolderTransfer._walkDir(h, '');
      } catch(e) { if (e.name==='AbortError') return null; }
    }
    return FolderTransfer._inputFallback();
  }

  static async _walkDir(dir, prefix) {
    const out = [];
    for await (const [name, h] of dir) {
      if (name.startsWith('.')||name==='__MACOSX') continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (h.kind==='file') { try { out.push({ file:await h.getFile(), relativePath:path }); } catch {} }
      else if (h.kind==='directory') out.push(...await FolderTransfer._walkDir(h, path));
    }
    return out;
  }

  static _inputFallback() {
    return new Promise(res => {
      const inp = Object.assign(document.createElement('input'), { type:'file', multiple:true, style:'display:none' });
      try { inp.webkitdirectory = true; } catch {}
      const cleanup = () => { try { document.body.removeChild(inp); } catch {} };
      inp.onchange = () => {
        const files = [...(inp.files||[])].map(f=>({file:f, relativePath:f.webkitRelativePath||f.name}));
        cleanup(); res(files.length ? files : null);
      };
      inp.addEventListener('cancel', ()=>{cleanup();res(null);});
      document.body.appendChild(inp); inp.click();
      window.addEventListener('focus', ()=>setTimeout(()=>{if(!inp.files?.length){cleanup();res(null);}},500), {once:true});
    });
  }
}

function _dl(url, name) {
  const a = Object.assign(document.createElement('a'), { href:url, download:name, style:'display:none' });
  document.body.appendChild(a); a.click();
  setTimeout(()=>{try{document.body.removeChild(a);}catch{}}, 1000);
}
