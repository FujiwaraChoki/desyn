//! Where the cloud lives. Hosted Desyn by default (`app.desyn.app` + its Convex Cloud deployment); self-hosters
//! and developers point the app elsewhere with environment variables or the `cloud` block of `settings.json`:
//!
//! | env | settings (`extensions.cloud`) | default |
//! |---|---|---|
//! | `DESYN_APP_URL` | `appUrl` | `https://app.desyn.app` (the web app: sign-in page, share links) |
//! | `DESYN_CONVEX_URL` | `convexUrl` | `https://opulent-alpaca-530.eu-west-1.convex.cloud` |
//! | `DESYN_CONVEX_SITE_URL` | `siteUrl` | derived from the Convex URL (`.convex.cloud` -> `.convex.site`, local port + 1) |
//! | `DESYN_UPDATE_FEED` | `updateFeed` | `https://desyn.app/desktop/latest.json` |
//!
//! Environment variables win over settings so a test run never changes the user's configuration.

use serde_json::{Map, Value};

/// Hosted web app.
pub const DEFAULT_APP_URL: &str = "https://app.desyn.app";
/// Hosted Convex deployment (public identifier, see `deploy/env/public.env`).
pub const DEFAULT_CONVEX_URL: &str = "https://opulent-alpaca-530.eu-west-1.convex.cloud";
/// Update feed (see `update` module docs for the format).
pub const DEFAULT_UPDATE_FEED: &str = "https://desyn.app/desktop/latest.json";

/// Resolved endpoints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    /// Web app base URL (no trailing slash).
    pub app_url: String,
    /// Convex deployment URL (queries, mutations, subscriptions).
    pub convex_url: String,
    /// Convex HTTP actions URL (native token exchange, Better Auth).
    pub site_url: String,
    /// Update feed URL.
    pub update_feed: String,
}

fn clean(url: &str) -> Option<String> {
    let u = url.trim().trim_end_matches('/');
    let parsed = url::Url::parse(u).ok()?;
    matches!(parsed.scheme(), "http" | "https").then(|| u.to_string())
}

/// The HTTP-actions URL for a deployment URL: Convex Cloud serves them on `.convex.site`; local and self-hosted
/// backends serve them on the next port (3210 -> 3211).
pub fn site_url_for(convex_url: &str) -> String {
    if let Some(prefix) = convex_url.strip_suffix(".convex.cloud") {
        return format!("{prefix}.convex.site");
    }
    if let Ok(mut u) = url::Url::parse(convex_url)
        && let Some(port) = u.port()
        && u.set_port(Some(port.saturating_add(1))).is_ok()
    {
        return u.as_str().trim_end_matches('/').to_string();
    }
    convex_url.to_string()
}

impl Endpoints {
    /// Resolves endpoints from an environment lookup and the `extensions.cloud` settings block.
    pub fn resolve(
        env: impl Fn(&str) -> Option<String>,
        settings: Option<&Map<String, Value>>,
    ) -> Endpoints {
        let pick = |env_key: &str, setting: &str| -> Option<String> {
            env(env_key).and_then(|v| clean(&v)).or_else(|| {
                settings
                    .and_then(|s| s.get(setting))
                    .and_then(Value::as_str)
                    .and_then(clean)
            })
        };
        let convex_url =
            pick("DESYN_CONVEX_URL", "convexUrl").unwrap_or_else(|| DEFAULT_CONVEX_URL.to_string());
        let site_url =
            pick("DESYN_CONVEX_SITE_URL", "siteUrl").unwrap_or_else(|| site_url_for(&convex_url));
        Endpoints {
            app_url: pick("DESYN_APP_URL", "appUrl").unwrap_or_else(|| DEFAULT_APP_URL.to_string()),
            convex_url,
            site_url,
            update_feed: pick("DESYN_UPDATE_FEED", "updateFeed")
                .unwrap_or_else(|| DEFAULT_UPDATE_FEED.to_string()),
        }
    }

    /// From the process environment and settings.
    pub fn from_env(settings: Option<&Map<String, Value>>) -> Endpoints {
        Endpoints::resolve(|k| std::env::var(k).ok(), settings)
    }

    /// Web link to a cloud design (`/design/<id>`).
    pub fn design_url(&self, design_id: &str) -> String {
        format!("{}/design/{design_id}", self.app_url)
    }

    /// True when this is the hosted service (shown in the account menu).
    pub fn is_hosted(&self) -> bool {
        self.convex_url == DEFAULT_CONVEX_URL
    }

    /// Host name shown to people ("app.desyn.app", "localhost:4100").
    pub fn display_host(&self) -> String {
        url::Url::parse(&self.app_url)
            .ok()
            .and_then(|u| {
                u.host_str().map(|h| match u.port() {
                    Some(p) => format!("{h}:{p}"),
                    None => h.to_string(),
                })
            })
            .unwrap_or_else(|| self.app_url.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_are_the_hosted_service() {
        let e = Endpoints::resolve(|_| None, None);
        assert_eq!(e.app_url, DEFAULT_APP_URL);
        assert_eq!(e.convex_url, DEFAULT_CONVEX_URL);
        assert_eq!(
            e.site_url,
            "https://opulent-alpaca-530.eu-west-1.convex.site"
        );
        assert!(e.is_hosted());
        assert_eq!(e.display_host(), "app.desyn.app");
    }

    #[test]
    fn env_beats_settings_and_local_site_port_is_derived() {
        let s = json!({ "convexUrl": "https://self.example.com/", "appUrl": "https://studio.example.com" });
        let e = Endpoints::resolve(
            |k| (k == "DESYN_CONVEX_URL").then(|| "http://127.0.0.1:3210".to_string()),
            s.as_object(),
        );
        assert_eq!(e.convex_url, "http://127.0.0.1:3210");
        assert_eq!(e.site_url, "http://127.0.0.1:3211");
        assert_eq!(e.app_url, "https://studio.example.com");
        assert!(!e.is_hosted());
        assert_eq!(e.design_url("abc"), "https://studio.example.com/design/abc");
    }

    #[test]
    fn invalid_urls_are_ignored() {
        let e = Endpoints::resolve(|_| Some("javascript:alert(1)".into()), None);
        assert_eq!(e.app_url, DEFAULT_APP_URL);
        assert_eq!(
            site_url_for("https://x.example.com"),
            "https://x.example.com"
        );
    }
}
