//! Desyn render worker: the internal HTTP service of DOCUMENT_MODEL section 8 (render / export incl. multi-page and
//! video, thumbnail, describe, layout, measure, apply), built on desyn-core, desyn-text, desyn-raster and
//! desyn-describe. Called by Convex Cloud at `https://render.desyn.app` with the shared secret in `x-desyn-secret`.
//!
//! See `README.md` for the API, configuration and operations.

#![warn(missing_docs)]

pub mod body;
pub mod config;
pub mod error;
pub mod fonts;
pub mod http;
pub mod jobs;
pub mod metrics;
pub mod net;
pub mod plan;
pub mod runtime;

use std::future::{Future, IntoFuture};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

pub use config::Config;
pub use http::router;

use crate::fonts::FontService;
use crate::jobs::video::{FfmpegInfo, VideoEnv};
use crate::metrics::Metrics;
use crate::net::Fetcher;
use crate::runtime::Gate;

/// Everything the handlers share.
pub struct AppState {
    /// Configuration.
    pub config: Config,
    /// Metrics registry.
    pub metrics: Arc<Metrics>,
    /// Fonts.
    pub fonts: Arc<FontService>,
    /// Asset client.
    pub fetcher: Arc<Fetcher>,
    /// CPU slots.
    pub gate: Gate,
    /// ffmpeg capabilities (`None` without ffmpeg: video exports answer 501).
    pub ffmpeg: Option<FfmpegInfo>,
    /// ffmpeg settings.
    pub video: VideoEnv,
    /// Start time.
    pub started: Instant,
    /// Set once shutdown began (`/readyz` answers 503).
    pub draining: AtomicBool,
    secret_digests: Vec<[u8; 32]>,
}

impl AppState {
    /// Builds the state: indexes fonts (blocking, once) and probes ffmpeg.
    pub fn build(config: Config) -> Result<Arc<AppState>, String> {
        // ring is the process-wide TLS crypto provider (asset fetches); a second install is a harmless no-op.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let metrics = Arc::new(Metrics::new());
        let fonts = Arc::new(FontService::new(&config.fonts, metrics.clone()));
        let user_agent = format!("desyn-worker/{}", config.release);
        let fetcher = Arc::new(Fetcher::new(&config.assets, metrics.clone(), &user_agent)?);
        let ffmpeg = FfmpegInfo::probe(&config.ffmpeg_path);
        match &ffmpeg {
            Some(f) => {
                tracing::info!(ffmpeg = %f.version, mp4 = f.mp4, webm = f.webm, "video export available")
            }
            None => {
                tracing::warn!(path = %config.ffmpeg_path.display(), "ffmpeg not found: mp4 / webm exports are disabled")
            }
        }
        let gate = Gate::new(
            config.concurrency,
            config.queue_limit,
            config.queue_timeout,
            metrics.clone(),
        );
        let video = VideoEnv {
            ffmpeg: config.ffmpeg_path.clone(),
            threads: config.ffmpeg_threads,
            tmp_root: std::env::temp_dir(),
            metrics: metrics.clone(),
        };
        let secret_digests = config
            .secrets
            .iter()
            .map(|s| http::secret_digest(s.as_bytes()))
            .collect();
        Ok(Arc::new(AppState {
            config,
            metrics,
            fonts,
            fetcher,
            gate,
            ffmpeg,
            video,
            started: Instant::now(),
            draining: AtomicBool::new(false),
            secret_digests,
        }))
    }

    /// Constant-time check of a provided secret against the configured ones.
    pub fn secret_matches(&self, provided: &[u8]) -> bool {
        http::secret_in(&self.secret_digests, provided)
    }
}

/// Serves until `shutdown` resolves, then stops accepting connections and lets in-flight requests finish for at most
/// `WORKER_SHUTDOWN_GRACE_MS`.
pub async fn serve(
    listener: tokio::net::TcpListener,
    state: Arc<AppState>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let (tx, mut rx) = tokio::sync::watch::channel(false);
    let st = state.clone();
    let signal = async move {
        shutdown.await;
        st.draining.store(true, std::sync::atomic::Ordering::SeqCst);
        tracing::info!("shutdown requested: draining in-flight requests");
        let _ = tx.send(true);
    };
    let grace = state.config.shutdown_grace;
    let server = axum::serve(listener, router(state)).with_graceful_shutdown(signal);
    let force = async move {
        while !*rx.borrow() {
            if rx.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        }
        tokio::time::sleep(grace).await;
    };
    tokio::select! {
        r = server.into_future() => r,
        () = force => {
            tracing::warn!(grace_ms = grace.as_millis() as u64, "grace period over: closing remaining requests");
            Ok(())
        }
    }
}

/// Installs the global tracing subscriber (JSON lines by default; `RUST_LOG` filters, default `info`).
pub fn init_tracing(format: config::LogFormat) {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let result = match format {
        config::LogFormat::Json => tracing_subscriber::fmt()
            .json()
            .flatten_event(true)
            .with_current_span(true)
            .with_span_list(false)
            .with_target(false)
            .with_env_filter(filter)
            .try_init(),
        config::LogFormat::Pretty => tracing_subscriber::fmt().with_env_filter(filter).try_init(),
    };
    // Tests install it repeatedly; only the first succeeds.
    drop(result);
}
