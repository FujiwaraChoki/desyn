//! `desyn-worker` binary: configuration from the environment, JSON logs, graceful shutdown on SIGTERM / SIGINT.

use std::net::SocketAddr;
use std::process::ExitCode;

use desyn_worker::{AppState, Config, init_tracing, serve};

fn main() -> ExitCode {
    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("desyn-worker: configuration error: {e}");
            return ExitCode::from(2);
        }
    };
    init_tracing(config.log_format);
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()));
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        tracing::error!(location = location.as_deref(), message, "panic");
    }));

    // Rendering runs on the blocking pool behind the CPU gate; the extra threads serve DNS lookups and file I/O
    // while every slot is busy.
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("desyn-worker")
        .max_blocking_threads(config.concurrency + 16)
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "tokio runtime");
            return ExitCode::FAILURE;
        }
    };
    let addr = SocketAddr::new(config.host, config.port);
    let result = runtime.block_on(async move {
        tracing::info!(
            release = %config.release,
            concurrency = config.concurrency,
            queue_limit = config.queue_limit,
            asset_hosts = %join(&config.assets.allowlist),
            private_hosts = %join(&config.assets.private_hosts),
            "starting"
        );
        let state = tokio::task::spawn_blocking(move || AppState::build(config))
            .await
            .map_err(|e| e.to_string())??;
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .map_err(|e| format!("bind {addr}: {e}"))?;
        tracing::info!(addr = %addr, "listening");
        serve(listener, state, shutdown_signal())
            .await
            .map_err(|e| e.to_string())
    });
    match result {
        Ok(()) => {
            tracing::info!("stopped");
            ExitCode::SUCCESS
        }
        Err(e) => {
            tracing::error!(error = %e, "worker failed");
            ExitCode::FAILURE
        }
    }
}

fn join(patterns: &[desyn_worker::net::HostPattern]) -> String {
    patterns
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = term => {},
    }
}
