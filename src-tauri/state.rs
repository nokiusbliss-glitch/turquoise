/**
 * state.rs — Turquoise Shared State
 *
 * Single source of truth for the entire Rust backend.
 * All fields are Arc<Mutex<T>> — safe across Tokio tasks and Tauri commands.
 *
 * Peer entry contains everything we know about a discovered LAN peer:
 *   - fingerprint (from their mDNS TXT record)
 *   - ip:port for their local WS signaling server
 *   - ip:port for their TCP file transfer server
 */

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
};
use tokio::sync::Mutex;
use serde::{Deserialize, Serialize};

/// A discovered LAN peer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanPeer {
    /// SHA-256 fingerprint of their public key (hex string).
    pub fingerprint: String,
    /// Short 8-char display ID.
    pub short_id: String,
    /// Display nickname (optional).
    pub nickname: Option<String>,
    /// Address of their local WebSocket signaling server.
    pub ws_addr: SocketAddr,
    /// Address of their TCP file-transfer server.
    pub tcp_addr: SocketAddr,
    /// Unix ms when we last saw their mDNS announcement.
    pub last_seen: u64,
}

/// Running transfer tracked in state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TransferDirection {
    Send,
    Receive,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveTransfer {
    pub file_id:   String,
    pub direction: TransferDirection,
    pub file_name: String,
    pub total:     u64,
    pub progress:  u64,    // bytes sent/received
    pub peer_fp:   String,
}

/// The whole app state.
#[derive(Debug, Default)]
pub struct AppState {
    /// LAN peers discovered via mDNS, keyed by fingerprint.
    pub lan_peers: HashMap<String, LanPeer>,

    /// Active file transfers (file_id → transfer).
    pub transfers: HashMap<String, ActiveTransfer>,

    /// Our own LAN IP (populated once at startup).
    pub local_ip: Option<std::net::IpAddr>,

    /// Port our local WS signaling server is on.
    pub ws_port: Option<u16>,

    /// Port our TCP file-transfer server is on.
    pub tcp_port: Option<u16>,

    /// Port our local HTTP propagation server is on.
    pub http_port: Option<u16>,

    /// Our fingerprint (set by JS via set_identity command).
    pub fingerprint: Option<String>,
    pub nickname:    Option<String>,
}

/// Alias for the shared state handle used everywhere.
pub type SharedState = Arc<Mutex<AppState>>;

pub fn new_shared_state() -> SharedState {
    Arc::new(Mutex::new(AppState::default()))
}
