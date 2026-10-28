//! Configuration from environment variables (names in the README). Every value has a safe default except the shared
//! secret, which is required: a worker without it would render for anyone who can reach it.

use std::net::IpAddr;
use std::path::PathBuf;
use std::time::Duration;

use crate::net::HostPattern;

/// Default listening port (DOCUMENT_MODEL ports: worker 4110; the container image sets `PORT=8080`).
pub const DEFAULT_PORT: u16 = 4110;
/// Google Fonts CSS2 API.
pub const GOOGLE_FONTS_CSS2: &str = "https://fonts.googleapis.com/css2";
/// Shortest accepted shared secret.
pub const MIN_SECRET_LEN: usize = 16;

/// How Google Fonts are used for families that are neither bundled nor in the font directories.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoogleFontsMode {
    /// Download on demand (disk cache in `FONT_CACHE_DIR`).
    On,
    /// Serve only what the disk cache already holds.
    CacheOnly,
    /// Never.
    Off,
}

/// Log output format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    /// One JSON object per line (production; Vector ships these to Axiom).
    Json,
    /// Human-readable lines (local development).
    Pretty,
}

/// Request limits.
#[derive(Debug, Clone)]
pub struct Limits {
    /// Largest request body on the wire (compressed when `content-encoding: gzip`).
    pub max_body_bytes: usize,
    /// Largest decompressed JSON document.
    pub max_json_bytes: usize,
    /// Most nodes in a design.
    pub max_nodes: usize,
    /// Most pages in one export.
    pub max_pages: usize,
    /// Most pixels of one rendered page / frame (raster exports, thumbnails, PDF rasterization).
    pub max_pixels: u64,
    /// Most pixels rendered in total by one animated export (frame pixels x frames).
    pub max_frame_pixels: u64,
    /// Longest animated export.
    pub max_video_ms: f64,
    /// Highest frame rate.
    pub max_fps: f64,
    /// Most items of one `/v1/measure` call.
    pub max_measure_items: usize,
    /// Most bytes of text across one `/v1/measure` call.
    pub max_measure_text_bytes: usize,
    /// Widest thumbnail.
    pub max_thumbnail_width: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_body_bytes: 64 * 1024 * 1024,
            max_json_bytes: 256 * 1024 * 1024,
            max_nodes: 50_000,
            max_pages: 500,
            max_pixels: 64_000_000,
            max_frame_pixels: 8_000_000_000,
            max_video_ms: 300_000.0,
            max_fps: 60.0,
            max_measure_items: 5_000,
            max_measure_text_bytes: 4 * 1024 * 1024,
            max_thumbnail_width: 2048,
        }
    }
}

/// Asset fetching policy and limits.
#[derive(Debug, Clone)]
pub struct AssetConfig {
    /// Hosts asset URLs may point to (`host`, `*.suffix`, or `*`).
    pub allowlist: Vec<HostPattern>,
    /// Hosts that may resolve to private / loopback addresses (self-hosted MinIO on a compose network). Empty in
    /// production: every resolved address must be public.
    pub private_hosts: Vec<HostPattern>,
    /// Allow plain `http://` URLs to any allowed host (otherwise only for `private_hosts`).
    pub allow_http: bool,
    /// Largest image / SVG / font asset.
    pub max_asset_bytes: usize,
    /// Largest audio / video asset (video exports mix their sound).
    pub max_media_bytes: usize,
    /// Most bytes fetched for one request.
    pub max_total_bytes: usize,
    /// Most assets fetched for one request.
    pub max_count: usize,
    /// Timeout of one fetch.
    pub fetch_timeout: Duration,
    /// Parallel fetches per request.
    pub fetch_concurrency: usize,
    /// In-memory cache of fetched bytes keyed by URL (0 disables).
    pub cache_bytes: usize,
    /// How long cached bytes are served.
    pub cache_ttl: Duration,
}

impl Default for AssetConfig {
    fn default() -> Self {
        AssetConfig {
            allowlist: vec![HostPattern::parse("*.amazonaws.com").expect("valid pattern")],
            private_hosts: Vec::new(),
            allow_http: false,
            max_asset_bytes: 64 * 1024 * 1024,
            max_media_bytes: 512 * 1024 * 1024,
            max_total_bytes: 1024 * 1024 * 1024,
            max_count: 1000,
            fetch_timeout: Duration::from_secs(30),
            fetch_concurrency: 8,
            cache_bytes: 256 * 1024 * 1024,
            cache_ttl: Duration::from_secs(15 * 60),
        }
    }
}

/// Font sources.
#[derive(Debug, Clone)]
pub struct FontConfig {
    /// Directories scanned at start (`FONTS_DIR`, `SYSTEM_FONTS_DIR`).
    pub dirs: Vec<PathBuf>,
    /// Google Fonts disk cache.
    pub cache_dir: PathBuf,
    /// Google Fonts usage.
    pub google: GoogleFontsMode,
    /// CSS2 endpoint (mirrors, tests).
    pub google_endpoint: String,
    /// Most Google Fonts downloads one request may trigger.
    pub max_fetches_per_request: usize,
}

/// Worker configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// Bind address.
    pub host: IpAddr,
    /// Port.
    pub port: u16,
    /// Accepted shared secrets (current first, then the previous one during a rotation).
    pub secrets: Vec<String>,
    /// CPU-bound jobs running at once (size of the blocking pool used for rendering).
    pub concurrency: usize,
    /// Requests allowed to wait for a slot; more are turned away with 503.
    pub queue_limit: usize,
    /// How long a request waits for a slot before 503.
    pub queue_timeout: Duration,
    /// Deadline of a request (except video).
    pub request_timeout: Duration,
    /// Deadline of a video export.
    pub video_timeout: Duration,
    /// Request limits.
    pub limits: Limits,
    /// Asset fetching.
    pub assets: AssetConfig,
    /// Fonts.
    pub fonts: FontConfig,
    /// ffmpeg binary.
    pub ffmpeg_path: PathBuf,
    /// Threads per ffmpeg encode.
    pub ffmpeg_threads: usize,
    /// Log format.
    pub log_format: LogFormat,
    /// Serve `/metrics` without the secret (for a scraper on a private network).
    pub metrics_public: bool,
    /// Time in-flight requests get to finish after SIGTERM.
    pub shutdown_grace: Duration,
    /// Release identifier reported by `/healthz` and `/metrics`.
    pub release: String,
}

/// A configuration problem (the worker refuses to start).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    /// Reads the process environment.
    pub fn from_env() -> Result<Config, ConfigError> {
        Config::from_lookup(|k| std::env::var(k).ok())
    }

    /// Reads configuration through `get` (tests pass a map).
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Config, ConfigError> {
        let get = |k: &str| {
            get(k)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let cpus = std::thread::available_parallelism().map_or(2, |n| n.get());

        let mut secrets = Vec::new();
        for name in ["RENDER_WORKER_SECRET", "RENDER_WORKER_SECRET_PREVIOUS"] {
            if let Some(s) = get(name) {
                check_secret(name, &s)?;
                secrets.push(s);
            }
        }
        if secrets.is_empty() || get("RENDER_WORKER_SECRET").is_none() {
            return Err(ConfigError(
                "RENDER_WORKER_SECRET is required (the shared secret callers send in x-desyn-secret)".into(),
            ));
        }

        let concurrency = num(&get, "WORKER_CONCURRENCY", cpus as u64, 1, 256)? as usize;
        let defaults = Limits::default();
        let limits = Limits {
            max_body_bytes: num(
                &get,
                "WORKER_MAX_BODY_BYTES",
                defaults.max_body_bytes as u64,
                1024,
                1 << 34,
            )? as usize,
            max_json_bytes: num(
                &get,
                "WORKER_MAX_JSON_BYTES",
                defaults.max_json_bytes as u64,
                1024,
                1 << 36,
            )? as usize,
            max_nodes: num(
                &get,
                "WORKER_MAX_NODES",
                defaults.max_nodes as u64,
                1,
                10_000_000,
            )? as usize,
            max_pages: num(
                &get,
                "WORKER_MAX_PAGES",
                defaults.max_pages as u64,
                1,
                100_000,
            )? as usize,
            max_pixels: num(
                &get,
                "WORKER_MAX_PIXELS",
                defaults.max_pixels,
                1,
                16384 * 16384,
            )?,
            max_frame_pixels: num(
                &get,
                "WORKER_MAX_FRAME_PIXELS",
                defaults.max_frame_pixels,
                1,
                u64::MAX >> 8,
            )?,
            max_video_ms: num(&get, "WORKER_MAX_VIDEO_SECONDS", 300, 1, 86_400)? as f64 * 1000.0,
            max_fps: num(&get, "WORKER_MAX_FPS", 60, 1, 120)? as f64,
            max_measure_items: num(
                &get,
                "WORKER_MAX_MEASURE_ITEMS",
                defaults.max_measure_items as u64,
                1,
                1_000_000,
            )? as usize,
            max_measure_text_bytes: num(
                &get,
                "WORKER_MAX_MEASURE_TEXT_BYTES",
                defaults.max_measure_text_bytes as u64,
                1024,
                1 << 32,
            )? as usize,
            max_thumbnail_width: num(&get, "WORKER_MAX_THUMBNAIL_WIDTH", 2048, 16, 16384)? as u32,
        };
        if limits.max_json_bytes < limits.max_body_bytes {
            return Err(ConfigError(
                "WORKER_MAX_JSON_BYTES must be at least WORKER_MAX_BODY_BYTES".into(),
            ));
        }

        let asset_defaults = AssetConfig::default();
        let assets = AssetConfig {
            allowlist: match get("ASSET_HOST_ALLOWLIST") {
                Some(list) => patterns("ASSET_HOST_ALLOWLIST", &list)?,
                None => asset_defaults.allowlist,
            },
            private_hosts: match get("ASSET_PRIVATE_HOSTS") {
                Some(list) => patterns("ASSET_PRIVATE_HOSTS", &list)?,
                None => Vec::new(),
            },
            allow_http: flag(&get, "ASSET_ALLOW_HTTP", false)?,
            max_asset_bytes: num(
                &get,
                "ASSET_MAX_BYTES",
                asset_defaults.max_asset_bytes as u64,
                1024,
                1 << 34,
            )? as usize,
            max_media_bytes: num(
                &get,
                "ASSET_MAX_MEDIA_BYTES",
                asset_defaults.max_media_bytes as u64,
                1024,
                1 << 36,
            )? as usize,
            max_total_bytes: num(
                &get,
                "ASSET_MAX_TOTAL_BYTES",
                asset_defaults.max_total_bytes as u64,
                1024,
                1 << 38,
            )? as usize,
            max_count: num(
                &get,
                "ASSET_MAX_COUNT",
                asset_defaults.max_count as u64,
                1,
                100_000,
            )? as usize,
            fetch_timeout: Duration::from_millis(num(
                &get,
                "ASSET_FETCH_TIMEOUT_MS",
                30_000,
                100,
                3_600_000,
            )?),
            fetch_concurrency: num(&get, "ASSET_FETCH_CONCURRENCY", 8, 1, 256)? as usize,
            cache_bytes: num(
                &get,
                "ASSET_CACHE_BYTES",
                asset_defaults.cache_bytes as u64,
                0,
                1 << 40,
            )? as usize,
            cache_ttl: Duration::from_secs(num(&get, "ASSET_CACHE_TTL_SECONDS", 900, 0, 86_400)?),
        };

        let mut dirs = Vec::new();
        for name in ["FONTS_DIR", "SYSTEM_FONTS_DIR"] {
            if let Some(list) = get(name) {
                // Several directories may be given, separated like PATH.
                dirs.extend(std::env::split_paths(&list).filter(|p| !p.as_os_str().is_empty()));
            }
        }
        let google = match get("GOOGLE_FONTS")
            .as_deref()
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            None | Some("on" | "true" | "1" | "yes") => GoogleFontsMode::On,
            Some("cache" | "cache-only" | "offline") => GoogleFontsMode::CacheOnly,
            Some("off" | "false" | "0" | "no") => GoogleFontsMode::Off,
            Some(other) => {
                return Err(ConfigError(format!(
                    "GOOGLE_FONTS must be on, cache or off (got {other:?})"
                )));
            }
        };
        let fonts = FontConfig {
            dirs,
            cache_dir: get("FONT_CACHE_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| std::env::temp_dir().join("desyn-fonts")),
            google,
            google_endpoint: get("GOOGLE_FONTS_ENDPOINT")
                .unwrap_or_else(|| GOOGLE_FONTS_CSS2.to_string()),
            max_fetches_per_request: num(&get, "WORKER_FONT_FETCHES_PER_REQUEST", 16, 0, 1000)?
                as usize,
        };

        let log_format = match get("LOG_FORMAT")
            .as_deref()
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            None | Some("json") => LogFormat::Json,
            Some("pretty" | "text") => LogFormat::Pretty,
            Some(other) => {
                return Err(ConfigError(format!(
                    "LOG_FORMAT must be json or pretty (got {other:?})"
                )));
            }
        };

        let host = match get("HOST") {
            Some(h) => h
                .parse()
                .map_err(|_| ConfigError(format!("HOST must be an IP address (got {h:?})")))?,
            None => IpAddr::from([0, 0, 0, 0]),
        };

        Ok(Config {
            host,
            port: num(&get, "PORT", u64::from(DEFAULT_PORT), 0, 65535)? as u16,
            secrets,
            concurrency,
            queue_limit: num(
                &get,
                "WORKER_QUEUE_LIMIT",
                (concurrency * 16) as u64,
                0,
                1_000_000,
            )? as usize,
            queue_timeout: Duration::from_millis(num(
                &get,
                "WORKER_QUEUE_TIMEOUT_MS",
                30_000,
                0,
                3_600_000,
            )?),
            request_timeout: Duration::from_millis(num(
                &get,
                "WORKER_REQUEST_TIMEOUT_MS",
                120_000,
                100,
                3_600_000,
            )?),
            video_timeout: Duration::from_millis(num(
                &get,
                "WORKER_VIDEO_TIMEOUT_MS",
                290_000,
                100,
                7_200_000,
            )?),
            limits,
            assets,
            fonts,
            ffmpeg_path: get("FFMPEG_PATH").map_or_else(|| PathBuf::from("ffmpeg"), PathBuf::from),
            ffmpeg_threads: num(&get, "FFMPEG_THREADS", 2, 1, 64)? as usize,
            log_format,
            metrics_public: flag(&get, "METRICS_PUBLIC", false)?,
            shutdown_grace: Duration::from_millis(num(
                &get,
                "WORKER_SHUTDOWN_GRACE_MS",
                25_000,
                0,
                600_000,
            )?),
            release: get("DESYN_RELEASE").unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()),
        })
    }
}

fn check_secret(name: &str, s: &str) -> Result<(), ConfigError> {
    if s.len() < MIN_SECRET_LEN {
        return Err(ConfigError(format!(
            "{name} must be at least {MIN_SECRET_LEN} characters"
        )));
    }
    // Header values: visible ASCII only (the nginx vhost enforces the same).
    if !s.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err(ConfigError(format!(
            "{name} must be visible ASCII characters"
        )));
    }
    Ok(())
}

fn num(
    get: &impl Fn(&str) -> Option<String>,
    name: &str,
    default: u64,
    min: u64,
    max: u64,
) -> Result<u64, ConfigError> {
    match get(name) {
        None => Ok(default),
        Some(v) => {
            let n: u64 = v.replace('_', "").parse().map_err(|_| {
                ConfigError(format!("{name} must be a non-negative integer (got {v:?})"))
            })?;
            if n < min || n > max {
                return Err(ConfigError(format!(
                    "{name} must be between {min} and {max} (got {n})"
                )));
            }
            Ok(n)
        }
    }
}

fn flag(
    get: &impl Fn(&str) -> Option<String>,
    name: &str,
    default: bool,
) -> Result<bool, ConfigError> {
    match get(name).as_deref().map(str::to_ascii_lowercase).as_deref() {
        None => Ok(default),
        Some("1" | "true" | "yes" | "on") => Ok(true),
        Some("0" | "false" | "no" | "off") => Ok(false),
        Some(other) => Err(ConfigError(format!(
            "{name} must be true or false (got {other:?})"
        ))),
    }
}

fn patterns(name: &str, list: &str) -> Result<Vec<HostPattern>, ConfigError> {
    list.split([',', ' ', '\n'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| HostPattern::parse(s).map_err(|e| ConfigError(format!("{name}: {e}"))))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cfg(pairs: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_lookup(|k| map.get(k).cloned())
    }

    #[test]
    fn secret_is_required_and_checked() {
        assert!(cfg(&[]).is_err());
        assert!(cfg(&[("RENDER_WORKER_SECRET", "short")]).is_err());
        assert!(cfg(&[("RENDER_WORKER_SECRET", "has space in it 123")]).is_err());
        assert!(cfg(&[("RENDER_WORKER_SECRET_PREVIOUS", "0123456789abcdef")]).is_err());
        let c = cfg(&[
            ("RENDER_WORKER_SECRET", "0123456789abcdef"),
            ("RENDER_WORKER_SECRET_PREVIOUS", "fedcba9876543210"),
        ])
        .unwrap();
        assert_eq!(c.secrets.len(), 2);
        assert_eq!(c.port, DEFAULT_PORT);
    }

    #[test]
    fn parses_values_and_rejects_garbage() {
        let s = ("RENDER_WORKER_SECRET", "0123456789abcdef");
        let c = cfg(&[
            s,
            ("PORT", "8080"),
            ("WORKER_CONCURRENCY", "3"),
            (
                "ASSET_HOST_ALLOWLIST",
                "bucket.s3.eu-central-1.amazonaws.com, *.r2.cloudflarestorage.com",
            ),
            ("ASSET_PRIVATE_HOSTS", "minio"),
            ("GOOGLE_FONTS", "off"),
            ("WORKER_MAX_VIDEO_SECONDS", "60"),
        ])
        .unwrap();
        assert_eq!(c.port, 8080);
        assert_eq!(c.concurrency, 3);
        assert_eq!(c.queue_limit, 48);
        assert_eq!(c.assets.allowlist.len(), 2);
        assert_eq!(c.assets.private_hosts.len(), 1);
        assert_eq!(c.fonts.google, GoogleFontsMode::Off);
        assert_eq!(c.limits.max_video_ms, 60_000.0);
        assert!(cfg(&[s, ("PORT", "x")]).is_err());
        assert!(cfg(&[s, ("WORKER_CONCURRENCY", "0")]).is_err());
        assert!(cfg(&[s, ("ASSET_HOST_ALLOWLIST", "*.")]).is_err());
        assert!(cfg(&[s, ("GOOGLE_FONTS", "maybe")]).is_err());
        assert!(cfg(&[s, ("ASSET_ALLOW_HTTP", "perhaps")]).is_err());
    }
}
