/**
 * commands.rs — Turquoise Tauri Commands
 *
 * These are the bridge between the Web UI (JavaScript) and the Rust backend.
 * Called from JS via:   const result = await invoke('command_name', { ...args })
 *
 * Every command:
 *   - Returns Result<T, String> so JS gets either data or an error string
 *   - Never panics — all errors propagated via Err(e.to_string())
 *   - Is async (Tokio runtime)
 */

use std::{net::SocketAddr, path::PathBuf};
use anyhow::Context;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use log::info;

use crate::{
    state::{LanPeer, SharedState},
    transfer::send_file_tcp,
};

// ── Identity ──────────────────────────────────────────────────────────────────

/// Called once at startup with the JS-generated identity.
#[tauri::command]
pub async fn set_identity(
    state:       State<'_, SharedState>,
    fingerprint: String,
    nickname:    Option<String>,
) -> Result<(), String> {
    let mut s = state.lock().await;
    s.fingerprint = Some(fingerprint.clone());
    s.nickname    = nickname;
    info!("Identity set: {}", &fingerprint[..8]);
    Ok(())
}

// ── Network info ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct NetworkInfo {
    pub local_ip:   String,
    pub ws_port:    u16,
    pub tcp_port:   u16,
    pub http_port:  u16,
}

/// Returns our LAN IP and all server ports. Frontend uses this to build
/// the propagation URL to show to the user.
#[tauri::command]
pub async fn get_network_info(
    state: State<'_, SharedState>,
) -> Result<NetworkInfo, String> {
    let s = state.lock().await;
    Ok(NetworkInfo {
        local_ip:  s.local_ip.map(|ip| ip.to_string()).unwrap_or_default(),
        ws_port:   s.ws_port.unwrap_or(0),
        tcp_port:  s.tcp_port.unwrap_or(0),
        http_port: s.http_port.unwrap_or(0),
    })
}

// ── LAN peers ─────────────────────────────────────────────────────────────────

/// Returns all currently known LAN peers.
#[tauri::command]
pub async fn get_lan_peers(
    state: State<'_, SharedState>,
) -> Result<Vec<LanPeer>, String> {
    let s = state.lock().await;
    Ok(s.lan_peers.values().cloned().collect())
}

/// Returns the WS address for a specific LAN peer (used by frontend to
/// connect its WebSocket to the peer's local signaling server).
#[tauri::command]
pub async fn get_peer_ws_url(
    state:       State<'_, SharedState>,
    fingerprint: String,
) -> Result<String, String> {
    let s = state.lock().await;
    s.lan_peers
        .get(&fingerprint)
        .map(|p| format!("ws://{}", p.ws_addr))
        .ok_or_else(|| format!("Peer not found: {}", &fingerprint[..8]))
}

// ── File transfer ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SendFileArgs {
    pub file_path:  String,
    pub file_id:    String,
    pub peer_fp:    String,
    pub peer_ip:    String,
    pub peer_port:  u16,
}

/// Send a file to a LAN peer via direct TCP.
/// Returns immediately — progress events arrive via `transfer-progress` events.
#[tauri::command]
pub async fn send_file(
    app:    AppHandle,
    state:  State<'_, SharedState>,
    args:   SendFileArgs,
) -> Result<(), String> {
    let peer_addr: SocketAddr = format!("{}:{}", args.peer_ip, args.peer_port)
        .parse()
        .map_err(|e| format!("Invalid peer address: {}", e))?;

    let file_path = PathBuf::from(&args.file_path);

    // Validate file exists before spawning
    if !file_path.exists() {
        return Err(format!("File not found: {:?}", file_path));
    }

    let state_c = state.inner().clone();
    let app_c   = app.clone();

    // Run in background — progress events emitted from there
    tokio::spawn(async move {
        if let Err(e) = send_file_tcp(
            app_c, state_c, file_path,
            args.file_id, args.peer_fp, peer_addr
        ).await {
            log::error!("send_file_tcp failed: {}", e);
        }
    });

    Ok(())
}

/// Open a native file picker dialog and return selected file paths.
#[tauri::command]
pub async fn pick_files(
    app: AppHandle,
) -> Result<Vec<String>, String> {
    use tauri::api::dialog::FileDialogBuilder;
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel::<Vec<String>>();

    FileDialogBuilder::new()
        .set_title("Select files to send")
        .pick_files(move |paths| {
            let result = paths
                .unwrap_or_default()
                .into_iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            let _ = tx.send(result);
        });

    rx.await.map_err(|e| format!("File picker error: {}", e))
}

/// Open the system's default folder for received files.
#[tauri::command]
pub async fn open_downloads_folder(app: AppHandle) -> Result<(), String> {
    use tauri::api::shell;

    let dir = downloads_dir()
        .ok_or("Cannot determine downloads directory")?;

    shell::open(&app.shell_scope(), dir.to_string_lossy().to_string(), None)
        .map_err(|e| format!("Cannot open folder: {}", e))
}

// ── Utilities ─────────────────────────────────────────────────────────────────

pub fn downloads_dir() -> Option<PathBuf> {
    tauri::api::path::download_dir()
        .or_else(|| {
            dirs::home_dir().map(|h| h.join("Downloads"))
        })
}
