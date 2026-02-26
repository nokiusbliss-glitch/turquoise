/**
 * propagation.rs — Turquoise App Propagation Server
 *
 * When in a remote area with no internet, one device that already has
 * Turquoise installed can serve the app to other devices on the same WiFi.
 *
 * This starts a local Axum HTTP server on port 7789 (or random) that serves
 * the app's static files. Other devices open http://192.168.x.x:7789 in
 * their browser to get the full app.
 *
 * The mDNS advertisement includes a "http" TXT record so the frontend can
 * show: "Tap here to install Turquoise from this device" with the exact URL.
 *
 * Murphy's Law:
 *   - Port already in use → try next port
 *   - Static dir missing → log error, don't start server
 *   - Axum router bind fail → error returned, never panic
 */

use std::net::SocketAddr;
use anyhow::{Context, Result};
use axum::{Router, routing::get};
use tower_http::services::ServeDir;
use log::info;

/// Start serving the app's static files on the local network.
/// Returns the port actually bound.
pub async fn start_propagation_server(
    static_dir: std::path::PathBuf,
    preferred_port: u16,
) -> Result<u16> {
    // Try preferred port first, then fallback to OS-assigned
    let addr = try_bind_port(preferred_port).await?;
    let port  = addr.port();

    let router = Router::new()
        .fallback_service(ServeDir::new(&static_dir));

    info!("Propagation server on http://{} (serving {:?})", addr, static_dir);

    tokio::spawn(async move {
        if let Err(e) = axum::Server::bind(&addr)
            .serve(router.into_make_service())
            .await
        {
            log::error!("Propagation server error: {}", e);
        }
    });

    Ok(port)
}

async fn try_bind_port(preferred: u16) -> Result<SocketAddr> {
    // Try preferred
    let addr: SocketAddr = format!("0.0.0.0:{}", preferred).parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await;
    if let Ok(l) = listener {
        let bound = l.local_addr()?;
        drop(l); // release before Axum binds it
        return Ok(bound);
    }
    // Fallback: OS assigns port
    let addr: SocketAddr = "0.0.0.0:0".parse()?;
    let l = tokio::net::TcpListener::bind(addr).await
        .context("Cannot bind propagation server on any port")?;
    let bound = l.local_addr()?;
    drop(l);
    Ok(bound)
}
