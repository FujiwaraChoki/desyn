//! The connection to a Desyn cloud (hosted desyn.app or a self-hosted server): the Convex client (queries,
//! mutations, actions, live subscriptions), the native session token and the short-lived Convex JWT, plain HTTP,
//! and the GPUI global [`Cloud`] that views observe for connection and account changes.
//!
//! Everything network-bound runs on the shared tokio runtime ([`runtime`]); results come back through channels
//! any executor can await, so GPUI tasks simply `.await` the futures returned here.

pub mod api;
pub mod config;
pub mod http;
pub mod images;
pub mod runtime;
pub mod value;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use convex::{
    AuthTokenFetcher, AuthenticationToken, ConvexClient, ConvexClientBuilder, WebSocketState,
};
use futures::StreamExt as _;
use futures::channel::mpsc;
use gpui::{App, BorrowAppContext, Global};
use serde_json::Value as Json;

pub use config::Endpoints;
pub use value::CloudError;

/// Websocket state of the Convex connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Connection {
    /// No client yet (nothing asked for the cloud).
    #[default]
    Idle,
    /// Connecting or reconnecting (offline).
    Connecting,
    /// Connected.
    Online,
}

/// Network-side state shared by every call (thread-safe).
pub struct CloudCore {
    /// Endpoints.
    pub endpoints: Endpoints,
    client: tokio::sync::Mutex<Option<ConvexClient>>,
    session: Mutex<Option<String>>,
    jwt: Mutex<Option<(String, u64)>>,
    conn: tokio::sync::watch::Sender<Connection>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Expiry (ms) of a JWT, read from its payload without verifying it (the server verifies).
pub fn jwt_expiry_ms(jwt: &str) -> Option<u64> {
    use base64::Engine as _;
    let payload = jwt.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let v: Json = serde_json::from_slice(&bytes).ok()?;
    v.get("exp")
        .and_then(Json::as_f64)
        .map(|s| (s * 1000.0) as u64)
}

/// Default time limit for mutations and queries before they count as offline.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(25);
/// Actions (exports, snapshots, AI media) may run longer.
pub const ACTION_TIMEOUT: Duration = Duration::from_secs(180);

impl CloudCore {
    /// A core for these endpoints (no connection is opened until the first call).
    pub fn new(endpoints: Endpoints) -> Arc<CloudCore> {
        Arc::new(CloudCore {
            endpoints,
            client: tokio::sync::Mutex::new(None),
            session: Mutex::new(None),
            jwt: Mutex::new(None),
            conn: tokio::sync::watch::channel(Connection::Idle).0,
        })
    }

    /// Current connection state.
    pub fn connection(&self) -> Connection {
        *self.conn.borrow()
    }

    /// Watches the connection state.
    pub fn watch_connection(&self) -> tokio::sync::watch::Receiver<Connection> {
        self.conn.subscribe()
    }

    /// The native session token (bearer for HTTP routes), when signed in.
    pub fn session(&self) -> Option<String> {
        self.session.lock().ok().and_then(|s| s.clone())
    }

    /// The Convex client, created on first use. Must run on the network runtime.
    async fn client(self: &Arc<Self>) -> Result<ConvexClient, CloudError> {
        let mut guard = self.client.lock().await;
        if let Some(c) = guard.as_ref() {
            return Ok(c.clone());
        }
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let _ = self.conn.send(Connection::Connecting);
        let mut client = ConvexClientBuilder::new(&self.endpoints.convex_url)
            .with_client_id(&format!("desyn-desktop-{}", env!("CARGO_PKG_VERSION")))
            .with_on_state_change(tx)
            .build()
            .await
            .map_err(|e| CloudError::network(e.to_string()))?;
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            while let Some(s) = rx.recv().await {
                let Some(me) = me.upgrade() else { break };
                let _ = me.conn.send(match s {
                    WebSocketState::Connected => Connection::Online,
                    WebSocketState::Connecting => Connection::Connecting,
                });
            }
        });
        if self.session().is_some() {
            client.set_auth_callback(Some(self.fetcher())).await;
        }
        *guard = Some(client.clone());
        Ok(client)
    }

    fn fetcher(self: &Arc<Self>) -> AuthTokenFetcher {
        let me = Arc::downgrade(self);
        Box::new(move |force: bool| {
            let me = me.clone();
            Box::pin(async move {
                let Some(me) = me.upgrade() else {
                    return Ok(AuthenticationToken::None);
                };
                log::debug!("auth token requested (refresh: {force})");
                match me.convex_jwt(force).await {
                    Ok(Some(t)) => Ok(AuthenticationToken::User(t)),
                    Ok(None) => Ok(AuthenticationToken::None),
                    Err(e) => Err(anyhow::anyhow!(e.to_string())),
                }
            })
        })
    }

    /// A Convex JWT for the session (cached until 2 minutes before it expires). Must run on the network runtime.
    pub async fn convex_jwt(&self, force: bool) -> Result<Option<String>, CloudError> {
        let Some(session) = self.session() else {
            return Ok(None);
        };
        if !force
            && let Some((t, exp)) = self.jwt.lock().ok().and_then(|j| j.clone())
            && exp > now_ms() + 120_000
        {
            return Ok(Some(t));
        }
        let url = format!("{}/api/auth/convex/token", self.endpoints.site_url);
        match http::get_json(&url, Some(&session)).await {
            Ok(v) => {
                let token = v
                    .get("token")
                    .and_then(Json::as_str)
                    .ok_or_else(|| CloudError {
                        code: "UNAUTHENTICATED".into(),
                        message: "The session is no longer valid.".into(),
                        data: v.clone(),
                    })?
                    .to_string();
                let exp = jwt_expiry_ms(&token).unwrap_or(now_ms() + 10 * 60_000);
                if let Ok(mut j) = self.jwt.lock() {
                    *j = Some((token.clone(), exp));
                }
                Ok(Some(token))
            }
            Err(e) if e.code == "NETWORK" => {
                // Offline: keep using the cached token; the reconnect refetches it.
                Ok(self.jwt.lock().ok().and_then(|j| j.clone()).map(|(t, _)| t))
            }
            Err(e) => Err(e),
        }
    }

    /// Sets or clears the session token and re-authenticates the Convex client. Must run on the network runtime.
    pub async fn set_session(self: &Arc<Self>, token: Option<String>) {
        if let Ok(mut s) = self.session.lock() {
            *s = token.clone();
        }
        if let Ok(mut j) = self.jwt.lock() {
            *j = None;
        }
        let client = self.client.lock().await.clone();
        if let Some(mut c) = client {
            c.set_auth_callback(token.map(|_| self.fetcher())).await;
        }
    }

    /// Re-runs the auth fetcher (the cached JWT is reused while valid, refreshed near expiry).
    pub async fn refresh_auth(self: &Arc<Self>) {
        if self.session().is_none() {
            return;
        }
        let client = self.client.lock().await.clone();
        if let Some(mut c) = client {
            c.set_auth_callback(Some(self.fetcher())).await;
        }
    }

    async fn run(
        self: Arc<Self>,
        kind: CallKind,
        name: String,
        args: Json,
    ) -> Result<Json, CloudError> {
        log::debug!("call {name}");
        let mut c = self.client().await?;
        let a = value::args(&args);
        let r = match kind {
            CallKind::Query => c.query(&name, a).await,
            CallKind::Mutation => c.mutation(&name, a).await,
            CallKind::Action => c.action(&name, a).await,
        }
        .map_err(|e| CloudError::network(e.to_string()))?;
        value::result(r)
    }
}

#[derive(Debug, Clone, Copy)]
enum CallKind {
    Query,
    Mutation,
    Action,
}

/// A handle to the cloud usable from GPUI (cheap to clone).
#[derive(Clone)]
pub struct Cloud {
    /// Network-side core.
    pub core: Arc<CloudCore>,
    /// Websocket state as last seen by the UI.
    pub connection: Connection,
}

impl Global for Cloud {}

/// A live query: every new result arrives through [`LiveQuery::next`]; dropping it unsubscribes. The receiver is
/// private on purpose: closures that only touched a public field would capture just that field and drop the
/// guard (Rust 2021 disjoint captures), cancelling the subscription at once.
pub struct LiveQuery {
    results: mpsc::UnboundedReceiver<Result<Json, CloudError>>,
    _guard: runtime::TaskGuard,
}

impl LiveQuery {
    /// The next result (`None` once the subscription ended).
    pub async fn next(&mut self) -> Option<Result<Json, CloudError>> {
        self.results.next().await
    }
}

impl Cloud {
    /// Installs the global (endpoints from env + settings) and mirrors connection changes into it.
    pub fn init(cx: &mut App) {
        let settings = crate::ui::app::settings(Some(cx));
        let cloud_settings = settings
            .extensions
            .get("cloud")
            .and_then(Json::as_object)
            .cloned();
        let core = CloudCore::new(Endpoints::from_env(cloud_settings.as_ref()));
        cx.set_global(Cloud {
            core: core.clone(),
            connection: Connection::Idle,
        });
        let mut rx = core.watch_connection();
        let (tx, mut changes) = mpsc::unbounded::<Connection>();
        let _guard = runtime::TaskGuard::spawn(async move {
            while rx.changed().await.is_ok() {
                let c = *rx.borrow();
                if tx.unbounded_send(c).is_err() {
                    break;
                }
            }
        });
        cx.spawn(async move |cx| {
            let _keep = _guard;
            while let Some(c) = changes.next().await {
                cx.update(|cx| {
                    cx.update_global::<Cloud, _>(|cl, _| cl.connection = c);
                });
            }
        })
        .detach();
        // Refresh the Convex JWT before it expires (the websocket also refetches it on reconnect).
        cx.spawn(async move |_| {
            loop {
                runtime::sleep(Duration::from_secs(10 * 60)).await;
                let c = core.clone();
                let _ = runtime::spawn(async move { c.refresh_auth().await }).await;
            }
        })
        .detach();
    }

    /// The global (panics before [`Cloud::init`]).
    pub fn get(cx: &App) -> Cloud {
        cx.global::<Cloud>().clone()
    }

    /// The global when installed.
    pub fn try_get(cx: &App) -> Option<Cloud> {
        cx.try_global::<Cloud>().cloned()
    }

    /// Endpoints.
    pub fn endpoints(&self) -> &Endpoints {
        &self.core.endpoints
    }

    fn call(
        &self,
        kind: CallKind,
        name: &str,
        args: Json,
        limit: Duration,
    ) -> impl std::future::Future<Output = Result<Json, CloudError>> + Send + 'static {
        let core = self.core.clone();
        let name = name.to_string();
        let f = runtime::spawn_timeout(limit, core.run(kind, name.clone(), args));
        async move {
            f.await
                .unwrap_or_else(|| Err(CloudError::network(format!("{name} timed out"))))
        }
    }

    /// One-shot query (`"designs/designs:list"`).
    pub fn query(
        &self,
        name: &str,
        args: Json,
    ) -> impl std::future::Future<Output = Result<Json, CloudError>> + Send + 'static {
        self.call(CallKind::Query, name, args, CALL_TIMEOUT)
    }

    /// Mutation.
    pub fn mutation(
        &self,
        name: &str,
        args: Json,
    ) -> impl std::future::Future<Output = Result<Json, CloudError>> + Send + 'static {
        self.call(CallKind::Mutation, name, args, CALL_TIMEOUT)
    }

    /// Action (longer time limit).
    pub fn action(
        &self,
        name: &str,
        args: Json,
    ) -> impl std::future::Future<Output = Result<Json, CloudError>> + Send + 'static {
        self.call(CallKind::Action, name, args, ACTION_TIMEOUT)
    }

    /// Live query: every new result of `name(args)`.
    pub fn subscribe(&self, name: &str, args: Json) -> LiveQuery {
        let core = self.core.clone();
        let name = name.to_string();
        let (tx, rx) = mpsc::unbounded();
        let guard = runtime::TaskGuard::spawn(async move {
            let mut client = match core.client().await {
                Ok(c) => c,
                Err(e) => {
                    let _ = tx.unbounded_send(Err(e));
                    return;
                }
            };
            log::debug!("subscribe {name}");
            let mut sub = match client.subscribe(&name, value::args(&args)).await {
                Ok(s) => s,
                Err(e) => {
                    let _ = tx.unbounded_send(Err(CloudError::network(e.to_string())));
                    return;
                }
            };
            log::debug!("subscribed {name}");
            while let Some(r) = sub.next().await {
                if tx.unbounded_send(value::result(r)).is_err() {
                    break;
                }
            }
            log::debug!("subscription {name} ended");
        });
        LiveQuery {
            results: rx,
            _guard: guard,
        }
    }

    /// HTTP GET of bytes (images, exports) on the network runtime.
    pub fn fetch_bytes(
        &self,
        url: &str,
        max: usize,
    ) -> impl std::future::Future<Output = Result<(Vec<u8>, Option<String>), CloudError>> + Send + 'static
    {
        let url = url.to_string();
        let f = runtime::spawn(async move { http::get_bytes(&url, max).await });
        async move {
            f.await
                .unwrap_or_else(|_| Err(CloudError::network("cancelled")))
        }
    }
}

/// Runs `f` on the network runtime with the core (helper for modules with custom HTTP flows).
pub fn with_core<F, Fut, T>(
    core: Arc<CloudCore>,
    f: F,
) -> impl std::future::Future<Output = Result<T, CloudError>> + Send + 'static
where
    F: FnOnce(Arc<CloudCore>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<T, CloudError>> + Send + 'static,
    T: Send + 'static,
{
    let fut = runtime::spawn(async move { f(core).await });
    async move {
        fut.await
            .unwrap_or_else(|_| Err(CloudError::network("cancelled")))
    }
}

/// Updates the connection field (tests and the offline toggle in scripts).
pub fn set_connection(cx: &mut App, c: Connection) {
    if cx.has_global::<Cloud>() {
        cx.update_global::<Cloud, _>(|cl, _| cl.connection = c);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jwt_expiry_is_read_from_the_payload() {
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"exp":1700000000,"sub":"u"}"#);
        let jwt = format!("eyJhbGciOiJSUzI1NiJ9.{payload}.sig");
        assert_eq!(jwt_expiry_ms(&jwt), Some(1_700_000_000_000));
        assert_eq!(jwt_expiry_ms("garbage"), None);
    }
}
