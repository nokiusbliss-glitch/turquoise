/**
 * main.rs — Turquoise Entry Point
 *
 * Boot sequence:
 *   1. Get local LAN IP
 *   2. Start local WebSocket signaling server (offline P2P signaling)
 *   3. Start TCP file receiver server
 *   4. Start app propagation HTTP server
 *   5. Start mDNS broadcast + discovery
 *   6. Register all Tauri commands
 *   7. Launch Tauri window
 *
 * Everything starts before the window opens so by the time JS runs,
 * all backend services are ready.
 *
 * Murphy's Law:
 *   - Each service failure is logged but does NOT prevent the app from opening
 *   - If mDNS fails → offline mode still works via manual/future fallback
 *   - If TCP bind fails → file transfer falls back to WebRTC DataChannel
 *   - No panic! in production paths
 */

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod discovery;
mod propagation;
mod state;
mod transfer;

use anyhow::Context;
use log::{error, info, warn};
use state::new_shared_state;
use std::path::PathBuf;
use tauri::{
    AppHandle, CustomMenuItem, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu,
};

// Fixed ports — deterministic, discoverable via mDNS
const WS_PORT:   u16 = 7788;
const TCP_PORT:  u16 = 7789;
const HTTP_PORT: u16 = 7790;

fn main() {
    // Initialize logging
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info")
    ).init();

    let state = new_shared_state();

    // ── System tray ───────────────────────────────────────────────────────────
    let tray = SystemTray::new().with_menu(
        SystemTrayMenu::new()
            .add_item(CustomMenuItem::new("show".to_string(), "Show Turquoise"))
            .add_item(CustomMenuItem::new("quit".to_string(), "Quit")),
    );

    // ── Build Tauri app ───────────────────────────────────────────────────────
    tauri::Builder::default()
        .manage(state.clone())
        .system_tray(tray)
        .on_system_tray_event(on_tray_event)
        .setup(move |app| {
            let app_handle = app.handle();
            let state_c    = state.clone();

            // Boot all backend services in async context
            tauri::async_runtime::spawn(async move {
                if let Err(e) = boot_services(app_handle, state_c).await {
                    error!("Backend boot error: {}", e);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::set_identity,
            commands::get_network_info,
            commands::get_lan_peers,
            commands::get_peer_ws_url,
            commands::send_file,
            commands::pick_files,
            commands::open_downloads_folder,
        ])
        .on_window_event(|event| {
            // On macOS, closing window should hide to tray, not quit
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event.event() {
                event.window().hide().ok();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("Turquoise failed to start");
}

/// Boot all backend services. Called once after Tauri initializes.
async fn boot_services(app: AppHandle, state: state::SharedState) -> anyhow::Result<()> {
    // ── 1. LAN IP ─────────────────────────────────────────────────────────────
    let local_ip = match local_ip_address::local_ip() {
        Ok(ip) => {
            info!("Local IP: {}", ip);
            let mut s = state.lock().await;
            s.local_ip = Some(ip);
            ip
        }
        Err(e) => {
            warn!("Cannot get local IP: {}. LAN features may be limited.", e);
            return Ok(()); // Don't abort — app can still run online-only
        }
    };

    // ── 2. Local WS signaling server ─────────────────────────────────────────
    {
        let app_c   = app.clone();
        let state_c = state.clone();
        let port    = WS_PORT;

        tokio::spawn(async move {
            if let Err(e) = discovery::start_local_ws_server(
                app_c, state_c, "0.0.0.0", port
            ).await {
                error!("Local WS server failed: {}", e);
            }
        });

        let mut s = state.lock().await;
        s.ws_port = Some(WS_PORT);
    }

    // ── 3. TCP file receiver ──────────────────────────────────────────────────
    let save_dir = downloads_dir(&app);
    tokio::fs::create_dir_all(&save_dir).await
        .with_context(|| format!("Cannot create downloads dir: {:?}", save_dir))?;

    match transfer::start_tcp_receiver(
        app.clone(), state.clone(), TCP_PORT, save_dir
    ).await {
        Ok(port) => {
            let mut s = state.lock().await;
            s.tcp_port = Some(port);
            info!("TCP receiver on port {}", port);
        }
        Err(e) => warn!("TCP receiver failed: {}. Large file transfer may be limited.", e),
    }

    // ── 4. Propagation HTTP server ────────────────────────────────────────────
    let static_dir = app.path_resolver()
        .resource_dir()
        .map(|d| d.join("public"))
        .unwrap_or_else(|| PathBuf::from("public"));

    match propagation::start_propagation_server(static_dir, HTTP_PORT).await {
        Ok(port) => {
            let mut s = state.lock().await;
            s.http_port = Some(port);
            info!("Propagation HTTP server on port {}", port);
        }
        Err(e) => warn!("Propagation server failed: {}", e),
    }

    // ── 5. mDNS (needs identity to be set first — retry loop) ────────────────
    tokio::spawn(async move {
        // Wait up to 10s for JS to call set_identity
        for attempt in 0..20 {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            let has_fp = {
                let s = state.lock().await;
                s.fingerprint.is_some()
            };
            if has_fp { break; }
            if attempt == 19 {
                warn!("mDNS: identity never set after 10s. Using fallback.");
            }
        }

        let (ws_port, tcp_port) = {
            let s = state.lock().await;
            (s.ws_port.unwrap_or(WS_PORT), s.tcp_port.unwrap_or(TCP_PORT))
        };

        if let Err(e) = discovery::start_mdns(
            app, state, local_ip, ws_port, tcp_port
        ).await {
            error!("mDNS failed: {}", e);
        }
    });

    Ok(())
}

fn downloads_dir(app: &AppHandle) -> PathBuf {
    tauri::api::path::download_dir()
        .unwrap_or_else(|| {
            app.path_resolver()
                .app_data_dir()
                .map(|d| d.join("received"))
                .unwrap_or_else(|| PathBuf::from("downloads"))
        })
}

fn on_tray_event(app: &AppHandle, event: SystemTrayEvent) {
    match event {
        SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
            "show" => {
                if let Some(window) = app.get_window("main") {
                    window.show().ok();
                    window.set_focus().ok();
                }
            }
            "quit" => {
                std::process::exit(0);
            }
            _ => {}
        },
        SystemTrayEvent::DoubleClick { .. } => {
            if let Some(window) = app.get_window("main") {
                window.show().ok();
                window.set_focus().ok();
            }
        }
        _ => {}
    }
}
