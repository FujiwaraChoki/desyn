//! Asset fetching from the presigned URLs a request carries, with SSRF protection.
//!
//! The worker is reachable from the internet (render.desyn.app, called by Convex Cloud), so every URL in a request is
//! treated as hostile even though callers hold the shared secret:
//! * the scheme must be `https` (plain `http` only for hosts in `ASSET_PRIVATE_HOSTS`, or with `ASSET_ALLOW_HTTP`);
//! * the host must match `ASSET_HOST_ALLOWLIST` (S3 bucket hosts by default);
//! * every address the name resolves to must be public (no loopback, private, link-local / cloud metadata,
//!   CGNAT, multicast, documentation or reserved ranges, incl. IPv4 embedded in IPv6). The check runs inside the
//!   HTTP client's DNS resolver, so the address that was checked is the address that is connected to (no
//!   DNS-rebinding window), and on every redirect hop;
//! * no proxy from the environment, at most 3 redirects, size caps enforced while streaming, timeouts.
//!
//! URLs are logged without their query string (presigned signatures never reach logs).

use std::collections::HashMap;
use std::error::Error as StdError;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::Url;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};

use crate::config::AssetConfig;
use crate::metrics::{Counter, Metrics};

/// A host pattern: `*` (any host), `*.example.com` (any subdomain of example.com, not the apex) or an exact host
/// name / IP address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostPattern {
    /// Any host.
    Any,
    /// Exact host (lowercase, no trailing dot; IPv6 without brackets).
    Exact(String),
    /// Subdomains of a suffix (stored with its leading dot).
    Suffix(String),
}

impl HostPattern {
    /// Parses a pattern.
    pub fn parse(s: &str) -> Result<HostPattern, String> {
        let raw = s.trim().to_ascii_lowercase();
        if raw == "*" {
            return Ok(HostPattern::Any);
        }
        let valid = |h: &str| {
            !h.is_empty()
                && h.len() <= 253
                && h.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b':' | b'_'))
                && !h.starts_with('.')
                && !h.contains("..")
        };
        let bad = || format!("invalid host pattern {raw:?}");
        if let Some(rest) = raw.strip_prefix("*.") {
            // A fully qualified name may end with one dot.
            let rest = rest.strip_suffix('.').unwrap_or(rest);
            if !valid(rest) || rest.contains('*') {
                return Err(bad());
            }
            return Ok(HostPattern::Suffix(format!(".{rest}")));
        }
        let host = raw.strip_suffix('.').unwrap_or(&raw);
        let host = host.trim_start_matches('[').trim_end_matches(']');
        if !valid(host) || host.contains('*') {
            return Err(bad());
        }
        Ok(HostPattern::Exact(host.to_string()))
    }

    /// True when `host` (lowercase, no brackets) matches.
    pub fn matches(&self, host: &str) -> bool {
        match self {
            HostPattern::Any => true,
            HostPattern::Exact(h) => h == host,
            HostPattern::Suffix(suffix) => {
                host.len() > suffix.len() && host.ends_with(suffix.as_str())
            }
        }
    }
}

impl std::fmt::Display for HostPattern {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HostPattern::Any => f.write_str("*"),
            HostPattern::Exact(h) => f.write_str(h),
            HostPattern::Suffix(s) => write!(f, "*{s}"),
        }
    }
}

/// Why a URL is refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Blocked(pub String);

impl std::fmt::Display for Blocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "blocked: {}", self.0)
    }
}

impl StdError for Blocked {}

/// URL policy (scheme, host allowlist, private address exceptions).
#[derive(Debug, Clone)]
pub struct AssetPolicy {
    allow: Vec<HostPattern>,
    private: Vec<HostPattern>,
    allow_http: bool,
}

impl AssetPolicy {
    /// Policy from the configuration.
    pub fn new(cfg: &AssetConfig) -> Self {
        AssetPolicy {
            allow: cfg.allowlist.clone(),
            private: cfg.private_hosts.clone(),
            allow_http: cfg.allow_http,
        }
    }

    fn private_allowed(&self, host: &str) -> bool {
        self.private.iter().any(|p| p.matches(host))
    }

    /// Checks scheme, credentials and host of a URL (addresses are checked at resolution time; literal IP hosts
    /// here).
    pub fn check_url(&self, url: &Url) -> Result<(), Blocked> {
        let host = url_host(url).ok_or_else(|| Blocked("URL has no host".into()))?;
        let private_ok = self.private_allowed(&host);
        match url.scheme() {
            "https" => {}
            "http" if self.allow_http || private_ok => {}
            other => return Err(Blocked(format!("scheme {other:?} is not allowed"))),
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(Blocked("credentials in URLs are not allowed".into()));
        }
        if !self.allow.iter().any(|p| p.matches(&host)) && !private_ok {
            return Err(Blocked(format!(
                "host {host} is not in ASSET_HOST_ALLOWLIST"
            )));
        }
        if let Ok(ip) = host.parse::<IpAddr>()
            && !private_ok
            && !is_public_ip(ip)
        {
            return Err(Blocked(format!("address {ip} is not public")));
        }
        Ok(())
    }
}

/// Lowercase host without brackets or a trailing dot.
fn url_host(url: &Url) -> Option<String> {
    let h = url.host_str()?;
    let h = h
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.');
    (!h.is_empty()).then(|| h.to_ascii_lowercase())
}

/// True for globally routable unicast addresses.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    let n = u32::from(ip);
    let in_net = |base: [u8; 4], bits: u32| {
        let mask = if bits == 0 {
            0
        } else {
            u32::MAX << (32 - bits)
        };
        n & mask == u32::from(Ipv4Addr::from(base)) & mask
    };
    !(o[0] == 0                              // "this" network
        || o[0] == 10                        // private
        || in_net([100, 64, 0, 0], 10)       // carrier-grade NAT
        || o[0] == 127                       // loopback
        || in_net([169, 254, 0, 0], 16)      // link-local (cloud metadata 169.254.169.254)
        || in_net([172, 16, 0, 0], 12)       // private
        || in_net([192, 0, 0, 0], 24)        // IETF protocol assignments
        || in_net([192, 0, 2, 0], 24)        // TEST-NET-1
        || in_net([192, 88, 99, 0], 24)      // 6to4 relay anycast
        || in_net([192, 168, 0, 0], 16)      // private
        || in_net([198, 18, 0, 0], 15)       // benchmarking
        || in_net([198, 51, 100, 0], 24)     // TEST-NET-2
        || in_net([203, 0, 113, 0], 24)      // TEST-NET-3
        || o[0] >= 224) // multicast, reserved, broadcast
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    let embedded_v4 =
        |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    // NAT64 well-known prefix 64:ff9b::/96 carries an IPv4 address.
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] {
        return is_public_v4(embedded_v4(s[6], s[7]));
    }
    // 6to4 2002::/16 carries an IPv4 address in bits 16..48.
    if s[0] == 0x2002 {
        return is_public_v4(embedded_v4(s[1], s[2]));
    }
    // Only global unicast 2000::/3 is public; :: / ::1 / IPv4-compatible / ULA / link-local / multicast are not.
    if s[0] & 0xe000 != 0x2000 {
        return false;
    }
    !((s[0] == 0x2001 && s[1] < 0x0200)      // 2001::/23 IETF protocol assignments (Teredo, ORCHID, ...)
        || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
        || (s[0] & 0xfff0) == 0x3ff0) // 3fff::/20 documentation
}

/// DNS resolver for the asset client: drops non-public addresses (unless the host is a configured private host)
/// and fails when nothing is left.
#[derive(Debug, Clone)]
struct GuardedResolver {
    policy: Arc<AssetPolicy>,
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().trim_end_matches('.').to_ascii_lowercase();
        let private_ok = self.policy.private_allowed(&host);
        Box::pin(async move {
            let found: Vec<SocketAddr> =
                tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            let allowed: Vec<SocketAddr> = found
                .iter()
                .copied()
                .filter(|a| private_ok || is_public_ip(a.ip()))
                .collect();
            if allowed.is_empty() {
                let err: Box<dyn StdError + Send + Sync> = if found.is_empty() {
                    format!("{host} did not resolve").into()
                } else {
                    Box::new(Blocked(format!("{host} resolves to non-public addresses")))
                };
                return Err(err);
            }
            let addrs: Addrs = Box::new(allowed.into_iter());
            Ok(addrs)
        })
    }
}

/// A failed fetch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// Refused by policy (never retried).
    Blocked(String),
    /// Non-success HTTP status.
    Status(u16),
    /// Larger than the per-asset cap or the request budget.
    TooLarge(String),
    /// Timed out.
    Timeout,
    /// Connection / protocol / DNS failure.
    Network(String),
    /// The URL could not be parsed.
    InvalidUrl,
}

impl FetchError {
    /// Short machine code (metrics label, error details).
    pub fn kind(&self) -> &'static str {
        match self {
            FetchError::Blocked(_) => "blocked",
            FetchError::Status(_) => "status",
            FetchError::TooLarge(_) => "too_large",
            FetchError::Timeout => "timeout",
            FetchError::Network(_) => "error",
            FetchError::InvalidUrl => "invalid_url",
        }
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Blocked(m) => write!(f, "blocked: {m}"),
            FetchError::Status(s) => write!(f, "HTTP {s}"),
            FetchError::TooLarge(m) => write!(f, "too large: {m}"),
            FetchError::Timeout => f.write_str("timed out"),
            FetchError::Network(m) => write!(f, "network error: {m}"),
            FetchError::InvalidUrl => f.write_str("invalid URL"),
        }
    }
}

/// URL without query or fragment, for logs.
pub fn redact(url: &str) -> String {
    match Url::parse(url) {
        Ok(mut u) => {
            u.set_query(None);
            u.set_fragment(None);
            let _ = u.set_password(None);
            let _ = u.set_username("");
            u.to_string()
        }
        Err(_) => "<invalid url>".into(),
    }
}

fn classify(err: &reqwest::Error) -> FetchError {
    let mut src: Option<&(dyn StdError + 'static)> = Some(err);
    while let Some(e) = src {
        if let Some(b) = e.downcast_ref::<Blocked>() {
            return FetchError::Blocked(b.0.clone());
        }
        src = e.source();
    }
    if err.is_timeout() {
        return FetchError::Timeout;
    }
    // reqwest's message includes the URL; strip it so signatures never leak into errors / logs.
    let mut e = err.to_string();
    if let Some(u) = err.url() {
        e = e.replace(u.as_str(), &redact(u.as_str()));
    }
    FetchError::Network(e)
}

/// Bytes cache keyed by full URL (the URL is the capability: the same signed URL always names the same bytes).
struct ByteCache {
    map: HashMap<String, (Arc<[u8]>, Instant, u64)>,
    bytes: usize,
    budget: usize,
    ttl: Duration,
    tick: u64,
}

impl ByteCache {
    fn get(&mut self, url: &str) -> Option<Arc<[u8]>> {
        self.tick += 1;
        let tick = self.tick;
        let ttl = self.ttl;
        let expired = match self.map.get_mut(url) {
            Some((bytes, at, used)) if at.elapsed() <= ttl => {
                *used = tick;
                return Some(bytes.clone());
            }
            Some(_) => true,
            None => false,
        };
        if expired && let Some((b, _, _)) = self.map.remove(url) {
            self.bytes -= b.len();
        }
        None
    }

    fn put(&mut self, url: &str, bytes: Arc<[u8]>) {
        // One entry never takes more than a quarter of the budget.
        if self.budget == 0 || bytes.len() > self.budget / 4 || self.map.contains_key(url) {
            return;
        }
        self.tick += 1;
        self.bytes += bytes.len();
        self.map
            .insert(url.to_string(), (bytes, Instant::now(), self.tick));
        while self.bytes > self.budget {
            let Some(oldest) = self
                .map
                .iter()
                .min_by_key(|(_, (_, _, used))| *used)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some((b, _, _)) = self.map.remove(&oldest) {
                self.bytes -= b.len();
            }
        }
    }
}

/// One asset to fetch.
#[derive(Debug, Clone)]
pub struct FetchItem {
    /// Asset id (`AssetRef.id`).
    pub id: String,
    /// URL.
    pub url: String,
    /// Byte cap for this asset.
    pub max_bytes: usize,
}

/// A failed asset.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AssetFailure {
    /// Asset id.
    pub id: String,
    /// `blocked` | `status` | `too_large` | `timeout` | `error` | `invalid_url` | `too_many_assets`.
    pub reason: &'static str,
    /// Detail (no signed URLs).
    pub message: String,
}

/// Result of fetching a set of assets.
#[derive(Debug, Default)]
pub struct FetchReport {
    /// Bytes by asset id.
    pub bytes: HashMap<String, Arc<[u8]>>,
    /// Failures.
    pub failed: Vec<AssetFailure>,
}

/// HTTP client for assets.
pub struct Fetcher {
    client: reqwest::Client,
    policy: Arc<AssetPolicy>,
    cache: Mutex<ByteCache>,
    cfg: AssetConfig,
    metrics: Arc<Metrics>,
}

impl Fetcher {
    /// Client for the configured policy.
    pub fn new(
        cfg: &AssetConfig,
        metrics: Arc<Metrics>,
        user_agent: &str,
    ) -> Result<Fetcher, String> {
        let policy = Arc::new(AssetPolicy::new(cfg));
        let redirect_policy = policy.clone();
        let client = reqwest::Client::builder()
            .no_proxy()
            .user_agent(user_agent)
            .connect_timeout(Duration::from_secs(10).min(cfg.fetch_timeout))
            .timeout(cfg.fetch_timeout)
            .dns_resolver(Arc::new(GuardedResolver {
                policy: policy.clone(),
            }))
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() >= 3 {
                    attempt.error(Blocked("too many redirects".into()))
                } else if let Err(e) = redirect_policy.check_url(attempt.url()) {
                    attempt.error(e)
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(|e| format!("asset HTTP client: {e}"))?;
        Ok(Fetcher {
            client,
            policy,
            cache: Mutex::new(ByteCache {
                map: HashMap::new(),
                bytes: 0,
                budget: cfg.cache_bytes,
                ttl: cfg.cache_ttl,
                tick: 0,
            }),
            cfg: cfg.clone(),
            metrics,
        })
    }

    /// The URL policy.
    pub fn policy(&self) -> &AssetPolicy {
        &self.policy
    }

    /// Fetches one URL (cached), capped at `max_bytes` and the shared `budget` of the request.
    pub async fn fetch(
        &self,
        url: &str,
        max_bytes: usize,
        budget: &AtomicUsize,
    ) -> Result<Arc<[u8]>, FetchError> {
        let parsed = Url::parse(url).map_err(|_| FetchError::InvalidUrl)?;
        self.policy
            .check_url(&parsed)
            .map_err(|b| FetchError::Blocked(b.0))?;
        if let Some(hit) = self.cache.lock().expect("cache lock").get(url) {
            if hit.len() > max_bytes {
                return Err(FetchError::TooLarge(format!(
                    "{} bytes (limit {max_bytes})",
                    hit.len()
                )));
            }
            take_budget(budget, hit.len())?;
            self.metrics.inc(Counter::AssetFetches, "cached");
            return Ok(hit);
        }
        let mut resp = self
            .client
            .get(parsed)
            .send()
            .await
            .map_err(|e| classify(&e))?;
        if !resp.status().is_success() {
            return Err(FetchError::Status(resp.status().as_u16()));
        }
        if let Some(len) = resp.content_length()
            && len > max_bytes as u64
        {
            return Err(FetchError::TooLarge(format!(
                "{len} bytes (limit {max_bytes})"
            )));
        }
        let mut out: Vec<u8> =
            Vec::with_capacity(resp.content_length().unwrap_or(0).min(max_bytes as u64) as usize);
        while let Some(chunk) = resp.chunk().await.map_err(|e| classify(&e))? {
            if out.len() + chunk.len() > max_bytes {
                return Err(FetchError::TooLarge(format!("more than {max_bytes} bytes")));
            }
            take_budget(budget, chunk.len())?;
            out.extend_from_slice(&chunk);
        }
        self.metrics.asset_bytes(out.len() as u64);
        self.metrics.inc(Counter::AssetFetches, "ok");
        let bytes: Arc<[u8]> = out.into();
        self.cache
            .lock()
            .expect("cache lock")
            .put(url, bytes.clone());
        Ok(bytes)
    }

    /// Fetches many assets in parallel (`ASSET_FETCH_CONCURRENCY`), each URL once, until `deadline`.
    pub async fn fetch_all(
        self: &Arc<Self>,
        items: Vec<FetchItem>,
        deadline: tokio::time::Instant,
    ) -> FetchReport {
        let mut report = FetchReport::default();
        let mut by_url: HashMap<String, (Vec<String>, usize)> = HashMap::new();
        let mut order: Vec<String> = Vec::new();
        for (i, item) in items.into_iter().enumerate() {
            if i >= self.cfg.max_count {
                report.failed.push(AssetFailure {
                    id: item.id,
                    reason: "too_many_assets",
                    message: format!("more than {} assets in one request", self.cfg.max_count),
                });
                continue;
            }
            let entry = by_url.entry(item.url.clone()).or_insert_with(|| {
                order.push(item.url.clone());
                (Vec::new(), 0)
            });
            entry.0.push(item.id);
            entry.1 = entry.1.max(item.max_bytes);
        }
        let budget = Arc::new(AtomicUsize::new(self.cfg.max_total_bytes));
        let slots = Arc::new(tokio::sync::Semaphore::new(self.cfg.fetch_concurrency));
        let mut set = tokio::task::JoinSet::new();
        for url in order {
            let (ids, max) = by_url.remove(&url).expect("grouped above");
            let this = self.clone();
            let budget = budget.clone();
            let slots = slots.clone();
            set.spawn(async move {
                let _slot = slots.acquire_owned().await.expect("semaphore never closed");
                let r =
                    match tokio::time::timeout_at(deadline, this.fetch(&url, max, &budget)).await {
                        Ok(r) => r,
                        Err(_) => Err(FetchError::Timeout),
                    };
                (url, ids, r)
            });
        }
        while let Some(joined) = set.join_next().await {
            let Ok((url, ids, r)) = joined else { continue };
            match r {
                Ok(bytes) => {
                    for id in ids {
                        report.bytes.insert(id, bytes.clone());
                    }
                }
                Err(e) => {
                    self.metrics.inc(Counter::AssetFetches, e.kind());
                    tracing::warn!(url = %redact(&url), reason = e.kind(), error = %e, "asset fetch failed");
                    for id in ids {
                        report.failed.push(AssetFailure {
                            id,
                            reason: e.kind(),
                            message: e.to_string(),
                        });
                    }
                }
            }
        }
        report.failed.sort_by(|a, b| a.id.cmp(&b.id));
        report
    }
}

fn take_budget(budget: &AtomicUsize, n: usize) -> Result<(), FetchError> {
    budget
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
            left.checked_sub(n)
        })
        .map(|_| ())
        .map_err(|_| FetchError::TooLarge("the request's asset byte budget is exhausted".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn public_addresses() {
        for public in [
            "52.219.170.1",
            "8.8.8.8",
            "2600:1f18::1",
            "2a05:d018::1",
            "64:ff9b::808:808",
            "2002:808:808::1",
        ] {
            assert!(is_public_ip(ip(public)), "{public} should be public");
        }
        for private in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "198.18.0.1",
            "192.0.2.1",
            "::1",
            "::",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "64:ff9b::a00:1",
            "2002:7f00:1::1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "2001::1",
            "::127.0.0.1",
        ] {
            assert!(!is_public_ip(ip(private)), "{private} should be private");
        }
    }

    #[test]
    fn host_patterns() {
        let p = HostPattern::parse("*.amazonaws.com").unwrap();
        assert!(p.matches("bucket.s3.eu-central-1.amazonaws.com"));
        assert!(!p.matches("amazonaws.com"));
        assert!(!p.matches("evilamazonaws.com"));
        assert!(
            HostPattern::parse("Bucket.Example.com.")
                .unwrap()
                .matches("bucket.example.com")
        );
        assert!(HostPattern::parse("[::1]").unwrap().matches("::1"));
        assert!(HostPattern::parse("*").unwrap().matches("anything"));
        assert_eq!(
            HostPattern::parse("*.Example.com.").unwrap().to_string(),
            "*.example.com"
        );
        for bad in ["", "*.", "a..b", "*.*.x", "a b", "x*y"] {
            assert!(HostPattern::parse(bad).is_err(), "{bad:?}");
        }
    }

    fn policy(allow: &[&str], private: &[&str], http: bool) -> AssetPolicy {
        AssetPolicy {
            allow: allow
                .iter()
                .map(|s| HostPattern::parse(s).unwrap())
                .collect(),
            private: private
                .iter()
                .map(|s| HostPattern::parse(s).unwrap())
                .collect(),
            allow_http: http,
        }
    }

    #[test]
    fn url_policy() {
        let p = policy(&["*.amazonaws.com"], &["minio"], false);
        let ok = |u: &str| p.check_url(&Url::parse(u).unwrap()).is_ok();
        assert!(ok(
            "https://b.s3.eu-central-1.amazonaws.com/k?X-Amz-Signature=x"
        ));
        assert!(!ok("http://b.s3.eu-central-1.amazonaws.com/k"));
        assert!(!ok("https://example.com/k"));
        assert!(!ok("https://user:pw@b.s3.amazonaws.com/k"));
        assert!(!ok("ftp://b.s3.amazonaws.com/k"));
        assert!(!ok("file:///etc/passwd"));
        assert!(ok("http://minio:9000/bucket/k"));
        let any = policy(&["*"], &[], false);
        let ok = |u: &str| any.check_url(&Url::parse(u).unwrap()).is_ok();
        assert!(!ok("https://169.254.169.254/latest/meta-data"));
        assert!(!ok("https://[::1]/x"));
        assert!(!ok("https://127.0.0.1/x"));
        assert!(
            !ok("https://2130706433/x"),
            "decimal IPv4 is normalized by the URL parser"
        );
        assert!(ok("https://8.8.8.8/x"));
    }

    #[test]
    fn redaction_drops_signatures() {
        let r = redact("https://u:p@b.s3.amazonaws.com/a/b.png?X-Amz-Signature=secret#f");
        assert_eq!(r, "https://b.s3.amazonaws.com/a/b.png");
    }

    #[test]
    fn cache_evicts_least_recently_used() {
        let mut c = ByteCache {
            map: HashMap::new(),
            bytes: 0,
            budget: 400,
            ttl: Duration::from_secs(60),
            tick: 0,
        };
        c.put("a", vec![0; 100].into());
        c.put("b", vec![0; 100].into());
        c.put("c", vec![0; 100].into());
        assert!(c.get("a").is_some());
        c.put("d", vec![0; 100].into());
        c.put("e", vec![0; 100].into());
        assert!(c.get("b").is_none(), "least recently used goes first");
        assert!(c.get("a").is_some());
        assert!(c.bytes <= 400);
        c.put("huge", vec![0; 200].into());
        assert!(
            c.get("huge").is_none(),
            "entries above a quarter of the budget are not cached"
        );
    }
}
