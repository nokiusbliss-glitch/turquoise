/**
 * bridge.js — Turquoise Platform Bridge
 *
 * Abstracts the difference between:
 *   A) Running inside Tauri (has Rust backend)
 *   B) Running in a plain browser (Render-hosted web app)
 *
 * All Tauri-specific calls go through this module.
 * If not in Tauri, all commands return safe no-op responses.
 *
 * This means the same JS codebase runs in both environments.
 */

// Detect Tauri environment
export const IS_TAURI = typeof window.__TAURI__ !== 'undefined';

/**
 * Call a Tauri command. Returns null if not in Tauri.
 * Never throws — all errors returned as { error: string }.
 */
export async function invoke(command, args = {}) {
  if (!IS_TAURI) return null;
  try {
    const { invoke: tauriInvoke } = window.__TAURI__.tauri;
    return await tauriInvoke(command, args);
  } catch (e) {
    console.error(`[Bridge] invoke('${command}') failed:`, e);
    return { error: e?.message || String(e) };
  }
}

/**
 * Listen to a Tauri event. Returns unlisten function (or no-op).
 */
export function listen(event, callback) {
  if (!IS_TAURI) return () => {};
  try {
    const { listen: tauriListen } = window.__TAURI__.event;
    let unlisten = null;
    tauriListen(event, (ev) => callback(ev.payload)).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  } catch (e) {
    console.error(`[Bridge] listen('${event}') failed:`, e);
    return () => {};
  }
}

/**
 * Set our cryptographic identity in the Rust backend.
 * Called once at startup.
 */
export async function setIdentity(fingerprint, nickname) {
  return invoke('set_identity', { fingerprint, nickname });
}

/**
 * Get our LAN IP and server ports.
 */
export async function getNetworkInfo() {
  const info = await invoke('get_network_info');
  if (!info || info.error) return null;
  return info;
}

/**
 * Get all currently discovered LAN peers.
 */
export async function getLanPeers() {
  const peers = await invoke('get_lan_peers');
  if (!peers || peers.error) return [];
  return peers;
}

/**
 * Get the local WS URL for connecting to a peer's signaling server.
 */
export async function getPeerWsUrl(fingerprint) {
  const url = await invoke('get_peer_ws_url', { fingerprint });
  if (!url || url.error) return null;
  return url;
}

/**
 * Send a file to a peer via direct TCP (Rust backend).
 * Progress events arrive via listen('transfer-progress', ...).
 */
export async function sendFileTcp(args) {
  return invoke('send_file', { args });
}

/**
 * Open native file picker. Returns array of file paths.
 */
export async function pickFiles() {
  const paths = await invoke('pick_files');
  return Array.isArray(paths) ? paths : [];
}

/**
 * Open the system downloads folder.
 */
export async function openDownloads() {
  return invoke('open_downloads_folder');
}
