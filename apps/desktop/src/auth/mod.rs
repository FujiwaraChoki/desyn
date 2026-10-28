//! Signing in to a Desyn cloud from the desktop: the browser flow (system browser + `desyn://auth/callback` deep
//! link, or a loopback redirect when the scheme is not registered) with PKCE, email + password as a fallback, the
//! session kept in the OS keychain, the profile / workspaces of the signed-in user, and signing out.
//!
//! Flow (`apps/web/app/native/authorize`, `convex/accounts/nativeAuth.ts`): open `${APP_URL}/native/authorize?client=desktop&redirect_uri=…&
//! code_challenge=…&state=…`; the web app redirects to the redirect URI with `code` + `state`; the app exchanges
//! them at `${CONVEX_SITE_URL}/auth/native/token` for its own revocable session token, which buys short-lived
//! Convex JWTs for the websocket (`cloud::CloudCore::convex_jwt`).

pub mod loopback;
pub mod pkce;
pub mod store;
pub mod ui;

use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{App, AppContext, BorrowAppContext, Global, Task};
use serde_json::{Value as Json, json};

use crate::cloud::api::{self, Profile, Workspace, f};
use crate::cloud::{Cloud, CloudError, http, runtime};
use crate::widgets::notify;
use pkce::Pkce;
use store::{KeyringStore, MemoryStore, StoredSession, TokenStore};

/// The deep-link redirect.
pub const DEEP_LINK_REDIRECT: &str = "desyn://auth/callback";

/// Sign-in state.
#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    /// Reading the keychain.
    Loading,
    /// Not signed in.
    SignedOut,
    /// Waiting for the browser to come back.
    Waiting {
        /// The authorize URL (to copy / reopen).
        url: String,
        /// When it started.
        started: Instant,
    },
    /// Signed in.
    SignedIn,
}

struct Pending {
    pkce: Pkce,
    redirect_uri: String,
    _loopback: Option<runtime::TaskGuard>,
}

/// The account (GPUI global).
pub struct Account {
    /// State.
    pub status: Status,
    /// The stored session (user id / email / name are known offline).
    pub session: Option<StoredSession>,
    /// Profile from the server (plan, features, default workspace).
    pub profile: Option<Profile>,
    /// Workspaces the user belongs to.
    pub workspaces: Vec<Workspace>,
    /// The keychain could not be used (the session then lasts until quit).
    pub keychain_error: Option<String>,
    pending: Option<Pending>,
    store: Arc<dyn TokenStore>,
}

impl Global for Account {}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Whether the OS opens `desyn://` links with this app. Linux asks xdg-mime; macOS and Windows bundles register
/// the scheme on install. `DESYN_AUTH_REDIRECT=loopback|deeplink` overrides.
pub fn deep_link_registered() -> bool {
    match std::env::var("DESYN_AUTH_REDIRECT").ok().as_deref() {
        Some("loopback") => return false,
        Some("deeplink") => return true,
        _ => {}
    }
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        return true;
    }
    std::process::Command::new("xdg-mime")
        .args(["query", "default", "x-scheme-handler/desyn"])
        .output()
        .ok()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .to_ascii_lowercase()
                .contains("desyn")
        })
        .unwrap_or(false)
}

fn device_name() -> String {
    let host = std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::env::var("HOSTNAME").ok());
    let os = match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    };
    match host {
        Some(h) => format!("Desyn Desktop on {os} ({h})"),
        None => format!("Desyn Desktop on {os}"),
    }
}

/// Parses a token-exchange answer into a stored session.
pub fn session_from_exchange(v: &Json) -> Result<StoredSession, CloudError> {
    let token = v
        .get("sessionToken")
        .and_then(Json::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| CloudError::server("The server did not return a session."))?;
    let user = v.get("user").cloned().unwrap_or(Json::Null);
    Ok(StoredSession {
        session_token: token.to_string(),
        expires_at: v.get("expiresAt").and_then(Json::as_f64).unwrap_or(0.0),
        user_id: user
            .get("id")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string(),
        email: user
            .get("email")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string(),
        name: user
            .get("name")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

impl Account {
    /// Installs the global and restores a stored session in the background.
    pub fn init(cx: &mut App) {
        let cloud = Cloud::get(cx);
        let store: Arc<dyn TokenStore> =
            if std::env::var("DESYN_AUTH_STORE").as_deref() == Ok("memory") {
                Arc::new(MemoryStore::default())
            } else {
                Arc::new(KeyringStore::new(&cloud.endpoints().convex_url))
            };
        cx.set_global(Account {
            status: Status::Loading,
            session: None,
            profile: None,
            workspaces: Vec::new(),
            keychain_error: None,
            pending: None,
            store: store.clone(),
        });
        let load = cx.background_spawn(async move { store.load() });
        cx.spawn(async move |cx| {
            let res = load.await;
            cx.update(|cx| match res {
                Ok(Some(s)) if s.expires_at == 0.0 || s.expires_at > now_ms() => {
                    Account::adopt(s, false, cx);
                }
                Ok(_) => Account::set_status(Status::SignedOut, cx),
                Err(e) => {
                    log::warn!("keychain: {e}");
                    cx.update_global::<Account, _>(|a, _| {
                        a.keychain_error = Some(e);
                        a.status = Status::SignedOut;
                    });
                }
            });
        })
        .detach();
    }

    /// The global.
    pub fn get(cx: &App) -> &Account {
        cx.global::<Account>()
    }

    /// Signed in (a session exists, possibly offline).
    pub fn signed_in(cx: &App) -> bool {
        cx.try_global::<Account>()
            .is_some_and(|a| a.status == Status::SignedIn)
    }

    /// The profile when loaded.
    pub fn profile(cx: &App) -> Option<Profile> {
        cx.try_global::<Account>().and_then(|a| a.profile.clone())
    }

    /// The workspace new cloud designs go to (default, else the first).
    pub fn workspace_id(cx: &App) -> Option<String> {
        let a = cx.try_global::<Account>()?;
        a.profile
            .as_ref()
            .and_then(|p| p.default_workspace_id.clone())
            .or_else(|| {
                a.workspaces
                    .iter()
                    .find(|w| w.is_default)
                    .map(|w| w.id.clone())
            })
            .or_else(|| a.workspaces.first().map(|w| w.id.clone()))
    }

    /// Display name / email for the account chip.
    pub fn display_name(cx: &App) -> Option<String> {
        let a = cx.try_global::<Account>()?;
        let s = a.session.as_ref()?;
        Some(
            a.profile
                .as_ref()
                .map(|p| p.name.clone())
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| {
                    if s.name.trim().is_empty() {
                        s.email.clone()
                    } else {
                        s.name.clone()
                    }
                }),
        )
    }

    fn set_status(status: Status, cx: &mut App) {
        cx.update_global::<Account, _>(|a, _| a.status = status);
    }

    fn adopt(s: StoredSession, fresh: bool, cx: &mut App) {
        let cloud = Cloud::get(cx);
        let token = s.session_token.clone();
        let core = cloud.core.clone();
        cx.update_global::<Account, _>(|a, _| {
            a.session = Some(s.clone());
            a.status = Status::SignedIn;
            a.pending = None;
        });
        cx.spawn(async move |cx| {
            let _ = runtime::spawn(async move { core.set_session(Some(token)).await }).await;
            cx.update(|cx| {
                Account::refresh(cx);
                if fresh {
                    let who = if s.name.trim().is_empty() {
                        s.email.clone()
                    } else {
                        s.name.clone()
                    };
                    notify(cx, format!("Signed in as {who}."));
                }
            });
        })
        .detach();
    }

    /// Reloads the profile and workspaces (creating them on first sign-in).
    pub fn refresh(cx: &mut App) {
        let cloud = Cloud::get(cx);
        cx.spawn(async move |cx| {
            let me = cloud.query(f::ME, json!({})).await;
            let me = match me {
                Ok(Json::Null) => {
                    cx.update(Account::expired);
                    return;
                }
                Ok(v) => api::decode::<Profile>(v),
                Err(e) => Err(e),
            };
            let mut profile = match me {
                Ok(p) => p,
                Err(e) => {
                    log::warn!("profile: {e}");
                    cx.update(|cx| Account::handle_error(&e, cx));
                    return;
                }
            };
            if !profile.provisioned {
                let _ = cloud.mutation(f::ENSURE_PROFILE, json!({})).await;
                if let Ok(Ok(p)) = cloud
                    .query(f::ME, json!({}))
                    .await
                    .map(api::decode::<Profile>)
                {
                    profile = p;
                }
            }
            let ws = cloud
                .query(f::WORKSPACES, json!({}))
                .await
                .and_then(api::decode::<Vec<Workspace>>)
                .unwrap_or_default();
            cx.update(|cx| {
                cx.update_global::<Account, _>(|a, _| {
                    a.profile = Some(profile);
                    a.workspaces = ws;
                });
            });
        })
        .detach();
    }

    /// Reacts to a cloud error: an ended session signs out locally (with a notice).
    pub fn handle_error(e: &CloudError, cx: &mut App) {
        if e.is_auth() && Account::signed_in(cx) {
            Account::expired(cx);
        }
    }

    fn expired(cx: &mut App) {
        Account::clear_local(cx);
        notify(
            cx,
            "Your session ended. Sign in again to keep syncing.".into(),
        );
    }

    fn clear_local(cx: &mut App) {
        let store = cx.global::<Account>().store.clone();
        let core = Cloud::get(cx).core.clone();
        cx.update_global::<Account, _>(|a, _| {
            a.session = None;
            a.profile = None;
            a.workspaces.clear();
            a.status = Status::SignedOut;
            a.pending = None;
        });
        cx.background_spawn(async move {
            if let Err(e) = store.clear() {
                log::warn!("keychain: {e}");
            }
        })
        .detach();
        cx.spawn(async move |_| {
            let _ = runtime::spawn(async move { core.set_session(None).await }).await;
        })
        .detach();
    }

    /// Opens the browser to sign in.
    pub fn start_sign_in(cx: &mut App) {
        let endpoints = Cloud::get(cx).endpoints().clone();
        let pkce = Pkce::new();
        let (redirect_uri, guard) = if deep_link_registered() {
            (DEEP_LINK_REDIRECT.to_string(), None)
        } else {
            match loopback::start(Duration::from_secs(15 * 60)) {
                Ok(loopback::Loopback {
                    redirect_uri: uri,
                    params,
                    task,
                }) => {
                    cx.spawn(async move |cx| {
                        if let Ok(p) = params.await {
                            cx.update(|cx| Account::finish(&p, cx));
                        }
                    })
                    .detach();
                    (uri, Some(task))
                }
                Err(e) => {
                    log::warn!("loopback: {e}");
                    (DEEP_LINK_REDIRECT.to_string(), None)
                }
            }
        };
        let url = pkce::authorize_url(&endpoints.app_url, &redirect_uri, &pkce);
        cx.update_global::<Account, _>(|a, _| {
            a.pending = Some(Pending {
                pkce,
                redirect_uri,
                _loopback: guard,
            });
            a.status = Status::Waiting {
                url: url.clone(),
                started: Instant::now(),
            };
        });
        cx.open_url(&url);
    }

    /// Stops waiting for the browser.
    pub fn cancel_sign_in(cx: &mut App) {
        cx.update_global::<Account, _>(|a, _| {
            a.pending = None;
            if matches!(a.status, Status::Waiting { .. }) {
                a.status = Status::SignedOut;
            }
        });
    }

    /// Finishes the browser flow with the redirect's parameters (`code`, `state`, or `error`).
    pub fn finish(params: &[(String, String)], cx: &mut App) {
        let get = |k: &str| params.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        if let Some(err) = get("error") {
            Account::cancel_sign_in(cx);
            notify(cx, format!("Sign-in was not completed ({err})."));
            return;
        }
        let (Some(code), Some(state)) = (get("code"), get("state")) else {
            notify(
                cx,
                "That sign-in link is incomplete. Try signing in again.".into(),
            );
            return;
        };
        let matches = match &cx.global::<Account>().pending {
            None => {
                notify(
                    cx,
                    "No sign-in is in progress. Start again from Desyn.".into(),
                );
                return;
            }
            Some(p) => pkce::constant_time_eq(p.pkce.state.as_bytes(), state.as_bytes()),
        };
        if !matches {
            // A link this sign-in did not produce (stale, or opened by someone else): ignore it and keep
            // waiting for the real redirect.
            notify(
                cx,
                "That sign-in link was not started here. Finish signing in from the browser window Desyn opened."
                    .into(),
            );
            return;
        }
        let Some(pending) = cx.global_mut::<Account>().pending.take() else {
            return;
        };
        let cloud = Cloud::get(cx);
        let url = format!("{}/auth/native/token", cloud.endpoints().site_url);
        let body = json!({
            "code": code,
            "codeVerifier": pending.pkce.verifier,
            "redirectUri": pending.redirect_uri,
            "deviceName": device_name(),
        });
        let exchange = runtime::spawn(async move { http::post_json(&url, &body, None).await });
        cx.spawn(async move |cx| {
            let res = exchange
                .await
                .unwrap_or_else(|_| Err(CloudError::network("cancelled")))
                .and_then(|v| session_from_exchange(&v));
            cx.update(|cx| match res {
                Ok(s) => Account::persist_and_adopt(s, cx),
                Err(e) => {
                    Account::set_status(Status::SignedOut, cx);
                    notify(
                        cx,
                        match e.message.as_str() {
                            "invalid_grant" => "That sign-in expired. Try again.".into(),
                            "slow_down" => {
                                "Too many sign-in attempts. Wait a minute and try again.".into()
                            }
                            _ => format!("Couldn't sign in: {}", e.friendly()),
                        },
                    );
                }
            });
        })
        .detach();
    }

    fn persist_and_adopt(s: StoredSession, cx: &mut App) {
        let store = cx.global::<Account>().store.clone();
        let s2 = s.clone();
        let save = cx.background_spawn(async move { store.save(&s2) });
        cx.spawn(async move |cx| {
            if let Err(e) = save.await {
                log::warn!("keychain: {e}");
                cx.update(|cx| {
                    cx.update_global::<Account, _>(|a, _| a.keychain_error = Some(e.clone()));
                    notify(cx, e);
                });
            }
        })
        .detach();
        Account::adopt(s, true, cx);
    }

    /// Signs in with email and password (accounts without a browser at hand).
    pub fn sign_in_with_password(
        email: String,
        password: String,
        cx: &mut App,
    ) -> Task<Result<(), String>> {
        let cloud = Cloud::get(cx);
        let site = cloud.endpoints().site_url.clone();
        let call = runtime::spawn(async move {
            let v = http::post_json(
                &format!("{site}/api/auth/sign-in/email"),
                &json!({ "email": email, "password": password }),
                None,
            )
            .await?;
            let token = v
                .get("token")
                .and_then(Json::as_str)
                .filter(|t| !t.is_empty())
                .ok_or_else(|| CloudError::server("The server did not return a session."))?
                .to_string();
            let session = http::get_json(&format!("{site}/api/auth/get-session"), Some(&token))
                .await
                .unwrap_or(Json::Null);
            let user = v.get("user").cloned().unwrap_or(Json::Null);
            Ok::<StoredSession, CloudError>(StoredSession {
                session_token: token,
                expires_at: session
                    .get("session")
                    .and_then(|s| s.get("expiresAt"))
                    .and_then(Json::as_str)
                    .and_then(parse_iso_ms)
                    .unwrap_or(0.0),
                user_id: user
                    .get("id")
                    .and_then(Json::as_str)
                    .unwrap_or("")
                    .to_string(),
                email: user
                    .get("email")
                    .and_then(Json::as_str)
                    .unwrap_or("")
                    .to_string(),
                name: user
                    .get("name")
                    .and_then(Json::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
        });
        cx.spawn(async move |cx| {
            let res = call
                .await
                .unwrap_or_else(|_| Err(CloudError::network("cancelled")));
            match res {
                Ok(s) => {
                    cx.update(|cx| Account::persist_and_adopt(s, cx));
                    Ok(())
                }
                Err(e) => Err(match e.code.as_str() {
                    "UNAUTHENTICATED" | "INVALID_ARGUMENT" => {
                        "That email and password don't match.".into()
                    }
                    "FORBIDDEN" => {
                        if e.message.to_ascii_lowercase().contains("verif") {
                            "Verify your email first (check your inbox), then try again.".into()
                        } else {
                            e.message
                        }
                    }
                    _ => e.friendly(),
                }),
            }
        })
    }

    /// Signs out: revokes the session on the server (best effort) and forgets it here.
    pub fn sign_out(cx: &mut App) {
        let token = cx
            .global::<Account>()
            .session
            .as_ref()
            .map(|s| s.session_token.clone());
        let site = Cloud::get(cx).endpoints().site_url.clone();
        if let Some(token) = token {
            let f = runtime::spawn(async move {
                http::post_json(
                    &format!("{site}/api/auth/sign-out"),
                    &json!({}),
                    Some(&token),
                )
                .await
            });
            cx.background_spawn(async move {
                let _ = f.await;
            })
            .detach();
        }
        Account::clear_local(cx);
        notify(cx, "Signed out. Your designs stay on this computer.".into());
    }
}

/// Milliseconds of an ISO 8601 UTC timestamp (`2026-11-19T10:00:00.000Z`).
pub fn parse_iso_ms(s: &str) -> Option<f64> {
    let s = s.trim().trim_end_matches('Z');
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let mut t = time.split(':');
    let h: i64 = t.next()?.parse().ok()?;
    let min: i64 = t.next()?.parse().ok()?;
    let sec: f64 = t.next().unwrap_or("0").parse().ok()?;
    // Days from civil (Howard Hinnant's algorithm).
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + h * 3600 + min * 60) as f64 + sec) * 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exchange_answer_becomes_a_session() {
        let s = session_from_exchange(&json!({
            "tokenType": "bearer", "sessionToken": "tok", "expiresAt": 1.9e12,
            "user": { "id": "u1", "email": "a@b.co", "name": "Ada", "emailVerified": true }
        }))
        .unwrap();
        assert_eq!(s.session_token, "tok");
        assert_eq!(s.user_id, "u1");
        assert!(session_from_exchange(&json!({ "sessionToken": "" })).is_err());
    }

    #[test]
    fn iso_dates() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0.0));
        assert_eq!(
            parse_iso_ms("2026-10-20T12:00:00Z"),
            Some(1_792_497_600_000.0)
        );
        assert_eq!(parse_iso_ms("nope"), None);
        assert!(device_name().starts_with("Desyn Desktop on"));
    }
}
