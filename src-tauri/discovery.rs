/**
 * discovery.rs — Turquoise LAN Discovery + Local Signaling
 *
 * TWO things happen here:
 *
 * 1. mDNS Advertisement + Discovery
 *    We register "_turquoise._tcp.local." with our fingerprint, WS port,
 *    TCP port in TXT records. Other Turquoise devices on the same LAN
 *    see this and emit a `lan-peer-found` event to the frontend.
 *
 * 2. Local WebSocket Signaling Server
 *    Acts as a mini signaling server that only LAN peers can reach.
 *    Peers connect to it (address discovered via mDNS) and exchange
 *    WebRTC SDP offers/answers and ICE candidates. This replaces the
 *    Render signaling server in offline mode.
 *
 * Murphy's Law:
 *   - mDNS can fail silently → we log and continue, never panic.
 *   - WS connections can drop mid-handshake → each connection is independent.
 *   - Messages that can't be parsed → logged and discarded, never crash.
 */

use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use log::{error, info, warn};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{broadcast, Mutex},
};
use tokio_tungstenite::{accept_async, tungstenite::Message as WsMessage};
use uuid::Uuid;

use crate::state::{LanPeer, SharedState};

const SERVICE_TYPE: &str = "_turquoise._tcp.local.";
const WS_BIND_ADDR: &str = "0.0.0.0";

// ── Message types relayed by local signaling server ───────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SignalMsg {
    #[serde(rename = "type")]
    kind: String,
    #[serde(flatten)]
    fields: HashMap<String, Value>,
}

// ── Channel used to broadcast signal messages to connected peers ──────────────
type SignalTx = broadcast::Sender<String>;

// ─────────────────────────────────────────────────────────────────────────────

/// Start mDNS advertisement and discovery loop.
/// Emits `lan-peer-found` and `lan-peer-lost` events to Tauri frontend.
pub async fn start_mdns(
    app:        AppHandle,
    state:      SharedState,
    local_ip:   IpAddr,
    ws_port:    u16,
    tcp_port:   u16,
) -> Result<()> {
    let fingerprint = {
        let s = state.lock().await;
        s.fingerprint.clone().unwrap_or_else(|| "unknown".to_string())
    };
    let nickname = {
        let s = state.lock().await;
        s.nickname.clone().unwrap_or_default()
    };

    let daemon = ServiceDaemon::new()
        .context("Failed to create mDNS daemon")?;

    // Build our service advertisement
    let instance_name = format!("turquoise-{}", &fingerprint[..8]);
    let host_ipv4 = match local_ip {
        IpAddr::V4(v4) => v4,
        IpAddr::V6(_)  => {
            warn!("mDNS: IPv6 not fully supported, skipping advertisement");
            return Ok(());
        }
    };

    let mut props = HashMap::new();
    props.insert("fp".to_string(),   fingerprint.clone());
    props.insert("nick".to_string(), nickname);
    props.insert("tcp".to_string(),  tcp_port.to_string());

    let service = ServiceInfo::new(
        SERVICE_TYPE,
        &instance_name,
        &format!("{}.local.", hostname()),
        host_ipv4,
        ws_port,
        Some(props),
    ).context("Failed to create ServiceInfo")?;

    daemon.register(service)
        .context("mDNS register failed")?;

    info!("mDNS: advertising '{}' on port {}", instance_name, ws_port);

    // Browse for other Turquoise devices
    let receiver = daemon.browse(SERVICE_TYPE)
        .context("mDNS browse failed")?;

    tokio::spawn(async move {
        loop {
            match receiver.recv_async().await {
                Ok(event) => {
                    match event {
                        ServiceEvent::ServiceResolved(info) => {
                            handle_peer_found(&app, &state, &info, &fingerprint).await;
                        }
                        ServiceEvent::ServiceRemoved(_, fullname) => {
                            handle_peer_lost(&app, &state, &fullname).await;
                        }
                        _ => {}
                    }
                }
                Err(e) => {
                    warn!("mDNS event error: {}", e);
                    break;
                }
            }
        }
    });

    Ok(())
}

async fn handle_peer_found(
    app:        &AppHandle,
    state:      &SharedState,
    info:       &ServiceInfo,
    our_fp:     &str,
) {
    let props     = info.get_properties();
    let fp        = match props.get_property_val_str("fp") {
        Some(f) => f.to_string(),
        None    => { warn!("mDNS: peer missing fp TXT record"); return; }
    };

    // Don't announce ourselves
    if fp == our_fp { return; }

    let nick     = props.get_property_val_str("nick").map(|s| s.to_string());
    let tcp_port_str = props.get_property_val_str("tcp").unwrap_or("7788");
    let tcp_port: u16 = tcp_port_str.parse().unwrap_or(7788);

    // Get the first resolved IPv4 address
    let ip = match info.get_addresses_v4().into_iter().next() {
        Some(ip) => IpAddr::V4(*ip),
        None     => {
            warn!("mDNS: no IPv4 for peer {}", &fp[..8]);
            return;
        }
    };

    let ws_port  = info.get_port();
    let ws_addr  = SocketAddr::new(ip, ws_port);
    let tcp_addr = SocketAddr::new(ip, tcp_port);
    let short_id = fp[..8].to_string();

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let peer = LanPeer {
        fingerprint: fp.clone(),
        short_id:    short_id.clone(),
        nickname:    nick.clone(),
        ws_addr,
        tcp_addr,
        last_seen:   now,
    };

    {
        let mut s = state.lock().await;
        s.lan_peers.insert(fp.clone(), peer.clone());
    }

    info!("LAN peer found: {}  ws={}", short_id, ws_addr);

    // Emit to frontend
    let _ = app.emit_all("lan-peer-found", &peer);
}

async fn handle_peer_lost(
    app:    &AppHandle,
    state:  &SharedState,
    fullname: &str,
) {
    // Extract instance name from fullname like "turquoise-abc12345._turquoise._tcp.local."
    let instance = fullname.split('.').next().unwrap_or(fullname);

    let fp_to_remove: Option<String> = {
        let s = state.lock().await;
        s.lan_peers.values()
            .find(|p| {
                let name = format!("turquoise-{}", &p.fingerprint[..8]);
                name == instance
            })
            .map(|p| p.fingerprint.clone())
    };

    if let Some(fp) = fp_to_remove {
        let mut s = state.lock().await;
        s.lan_peers.remove(&fp);
        drop(s);
        info!("LAN peer lost: {}", &fp[..8]);
        let _ = app.emit_all("lan-peer-lost", serde_json::json!({ "fingerprint": fp }));
    }
}

// ── Local WebSocket Signaling Server ──────────────────────────────────────────

/// Start a local WebSocket server that relays signaling messages between
/// LAN peers for WebRTC handshakes.
///
/// Unlike the Render server, this is LAN-only — no internet required.
/// Each message carries a "to" field (fingerprint). Server looks up the
/// corresponding connection and forwards it.
pub async fn start_local_ws_server(
    app:       AppHandle,
    state:     SharedState,
    bind_addr: &str,
    port:      u16,
) -> Result<()> {
    let addr = format!("{}:{}", bind_addr, port);
    let listener = TcpListener::bind(&addr).await
        .with_context(|| format!("Local WS server bind failed: {}", addr))?;

    info!("Local signaling WS server on ws://{}", addr);

    // Broadcast channel: all connected WS clients subscribe to this
    let (tx, _) = broadcast::channel::<String>(256);
    let tx: Arc<SignalTx> = Arc::new(tx);

    // Map: fingerprint → connection_id (for directed messages)
    let conn_map: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));

    loop {
        let (stream, peer_addr) = match listener.accept().await {
            Ok(c)  => c,
            Err(e) => {
                error!("WS accept error: {}", e);
                continue;
            }
        };

        let tx      = Arc::clone(&tx);
        let app_h   = app.clone();
        let state_c = Arc::clone(&state);
        let cmap    = Arc::clone(&conn_map);

        tokio::spawn(async move {
            handle_ws_connection(stream, peer_addr, tx, app_h, state_c, cmap).await;
        });
    }
}

async fn handle_ws_connection(
    stream:    TcpStream,
    peer_addr: SocketAddr,
    tx:        Arc<SignalTx>,
    app:       AppHandle,
    _state:    SharedState,
    conn_map:  Arc<Mutex<HashMap<String, String>>>,
) {
    let ws = match accept_async(stream).await {
        Ok(ws)  => ws,
        Err(e)  => { warn!("WS upgrade error from {}: {}", peer_addr, e); return; }
    };

    let conn_id = Uuid::new_v4().to_string();
    let mut rx  = tx.subscribe();
    let (mut ws_tx, mut ws_rx) = ws.split();
    let mut registered_fp: Option<String> = None;

    info!("WS local: new connection {} from {}", &conn_id[..8], peer_addr);

    loop {
        tokio::select! {
            // Incoming from this WS client
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(WsMessage::Text(text))) => {
                        // Parse the signal message
                        match serde_json::from_str::<Value>(&text) {
                            Ok(mut v) => {
                                // Track fingerprint → conn_id mapping for directed routing
                                if let Some(fp) = v.get("from").and_then(|f| f.as_str()) {
                                    let mut map = conn_map.lock().await;
                                    map.insert(fp.to_string(), conn_id.clone());
                                    registered_fp = Some(fp.to_string());
                                    drop(map);
                                }

                                // Inject conn_id for routing
                                v["_conn_id"] = Value::String(conn_id.clone());

                                // Broadcast to all subscribers (they filter by "to")
                                let _ = tx.send(v.to_string());

                                // Also emit to frontend (this device's own WS server relay)
                                let _ = app.emit_all("lan-signal", &v);
                            }
                            Err(e) => warn!("WS local: parse error: {}", e),
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None => break,
                    Some(Err(e)) => { warn!("WS local: recv error: {}", e); break; }
                    _ => {}
                }
            }

            // Broadcast from other connections
            broadcast_msg = rx.recv() => {
                match broadcast_msg {
                    Ok(text) => {
                        match serde_json::from_str::<Value>(&text) {
                            Ok(v) => {
                                // Only forward if:
                                //   (a) message is directed to our registered fp, OR
                                //   (b) message is a broadcast (no "to" field)
                                let to_fp     = v.get("to").and_then(|f| f.as_str());
                                let from_conn = v.get("_conn_id").and_then(|f| f.as_str())
                                                 .unwrap_or("");

                                // Don't echo back to sender
                                if from_conn == conn_id { continue; }

                                let should_forward = match to_fp {
                                    Some(fp) => registered_fp.as_deref() == Some(fp),
                                    None     => true, // broadcast
                                };

                                if should_forward {
                                    if let Err(e) = ws_tx.send(WsMessage::Text(text)).await {
                                        warn!("WS local: send error: {}", e);
                                        break;
                                    }
                                }
                            }
                            Err(_) => {}
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!("WS local: broadcast lagged {} messages", n);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    // Clean up connection mapping
    if let Some(fp) = registered_fp {
        let mut map = conn_map.lock().await;
        map.remove(&fp);
    }
    info!("WS local: connection {} closed", &conn_id[..8]);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn hostname() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "turquoise-host".to_string())
}
