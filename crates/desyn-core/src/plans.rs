//! Typed access to `config/plans.json` (embedded at compile time), the single source of truth for plan limits,
//! features, credit costs and fair-use settings. Mirrors `packages/schema/src/plans.ts`.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The raw configuration file.
pub const PLANS_JSON: &str = include_str!("../../../config/plans.json");

/// A plan limit.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Limit {
    /// No limit (`null` in the config).
    Unlimited,
    /// Maximum value.
    Max(f64),
}

impl Limit {
    /// True when `used` stays within the limit.
    pub fn allows(self, used: f64) -> bool {
        match self {
            Limit::Unlimited => true,
            Limit::Max(m) => used <= m,
        }
    }
}

/// One plan with `"ALL_TRUE"` features expanded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// Plan id (`free`, `pro`, `selfhost`).
    pub id: String,
    /// Display name.
    pub name: String,
    /// Monthly price in `currency`.
    pub price_monthly: f64,
    /// Yearly price.
    pub price_yearly: Option<f64>,
    /// Limits by key.
    pub limits: BTreeMap<String, Limit>,
    /// Features by key.
    pub features: BTreeMap<String, bool>,
}

/// Fair-use settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(missing_docs)]
pub struct FairUse {
    pub soft_limit_behavior: String,
    pub throttle_delay_ms: [f64; 2],
    pub no_overage_charges: bool,
    pub byok_bypasses_credits: bool,
    pub per_minute_ai_requests: f64,
    pub per_day_ai_requests: f64,
    pub max_concurrent_runs: f64,
    pub max_collaborators_per_design: f64,
    pub abuse_signals: Vec<String>,
}

/// The parsed configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plans {
    /// Config version.
    pub version: u32,
    /// Currency code.
    pub currency: String,
    /// Plans by id (config order is not preserved; ids are sorted).
    pub plans: BTreeMap<String, Plan>,
    /// Credits per action.
    pub credit_costs: BTreeMap<String, f64>,
    /// Fair-use settings.
    pub fair_use: FairUse,
    /// Feature keys (from the free plan's explicit map), in config order.
    pub feature_keys: Vec<String>,
    /// Limit keys (from the free plan), in config order.
    pub limit_keys: Vec<String>,
}

/// Error parsing a plans configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlansError(pub String);

impl core::fmt::Display for PlansError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "plans.json: {}", self.0)
    }
}

impl std::error::Error for PlansError {}

fn keys_in_order(json: &str, plan: &str, section: &str) -> Vec<String> {
    // serde_json maps are sorted unless `preserve_order` is enabled, so recover the textual order with a scan of
    // the free plan's section. Keys are plain identifiers in this file.
    let Some(plan_at) = json.find(&format!("\"{plan}\"")) else {
        return Vec::new();
    };
    let Some(sec_rel) = json[plan_at..].find(&format!("\"{section}\"")) else {
        return Vec::new();
    };
    let start = plan_at + sec_rel;
    let Some(open_rel) = json[start..].find('{') else {
        return Vec::new();
    };
    let body_start = start + open_rel + 1;
    let Some(close_rel) = json[body_start..].find('}') else {
        return Vec::new();
    };
    let body = &json[body_start..body_start + close_rel];
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(q) = rest.find('"') {
        let after = &rest[q + 1..];
        let Some(end) = after.find('"') else { break };
        let key = &after[..end];
        let tail = &after[end + 1..];
        if tail.trim_start().starts_with(':') {
            out.push(key.to_string());
        }
        rest = tail;
    }
    out
}

/// Parses a plans configuration (used for the embedded file; exposed for tests and tooling).
pub fn parse_plans(json: &str) -> Result<Plans, PlansError> {
    let v: Value = serde_json::from_str(json).map_err(|e| PlansError(e.to_string()))?;
    let err = |m: &str| PlansError(m.to_string());
    let raw_plans = v
        .get("plans")
        .and_then(Value::as_object)
        .ok_or_else(|| err("missing plans"))?;
    let free = raw_plans
        .get("free")
        .ok_or_else(|| err("missing free plan"))?;
    let free_features = free
        .get("features")
        .and_then(Value::as_object)
        .ok_or_else(|| err("free plan needs an explicit feature map"))?;
    let free_limits = free
        .get("limits")
        .and_then(Value::as_object)
        .ok_or_else(|| err("free plan needs limits"))?;
    let mut feature_keys = keys_in_order(json, "free", "features");
    if feature_keys.len() != free_features.len() {
        feature_keys = free_features.keys().cloned().collect();
    }
    let mut limit_keys = keys_in_order(json, "free", "limits");
    if limit_keys.len() != free_limits.len() {
        limit_keys = free_limits.keys().cloned().collect();
    }
    let mut plans = BTreeMap::new();
    for (id, raw) in raw_plans {
        let name = raw
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| PlansError(format!("plan {id} needs a name")))?;
        let price_monthly = raw
            .get("priceMonthly")
            .and_then(Value::as_f64)
            .ok_or_else(|| PlansError(format!("plan {id} needs priceMonthly")))?;
        let price_yearly = raw.get("priceYearly").and_then(Value::as_f64);
        let limits_raw = raw
            .get("limits")
            .and_then(Value::as_object)
            .ok_or_else(|| PlansError(format!("plan {id} needs limits")))?;
        let mut limits = BTreeMap::new();
        for k in &limit_keys {
            let l = match limits_raw.get(k) {
                Some(Value::Null) => Limit::Unlimited,
                Some(Value::Number(n)) => Limit::Max(n.as_f64().unwrap_or(0.0)),
                _ => {
                    return Err(PlansError(format!(
                        "plan {id} limit {k} must be a number or null"
                    )));
                }
            };
            limits.insert(k.clone(), l);
        }
        let features_raw = raw
            .get("features")
            .ok_or_else(|| PlansError(format!("plan {id} needs features")))?;
        let mut features = BTreeMap::new();
        match features_raw {
            Value::String(s) if s == "ALL_TRUE" => {
                for k in &feature_keys {
                    features.insert(k.clone(), true);
                }
            }
            Value::Object(m) => {
                for k in &feature_keys {
                    features.insert(k.clone(), m.get(k) == Some(&Value::Bool(true)));
                }
            }
            _ => return Err(PlansError(format!("plan {id} has invalid features"))),
        }
        plans.insert(
            id.clone(),
            Plan {
                id: id.clone(),
                name: name.to_string(),
                price_monthly,
                price_yearly,
                limits,
                features,
            },
        );
    }
    let credit_costs = v
        .get("creditCosts")
        .and_then(Value::as_object)
        .ok_or_else(|| err("missing creditCosts"))?
        .iter()
        .map(|(k, v)| {
            v.as_f64()
                .map(|c| (k.clone(), c))
                .ok_or_else(|| PlansError(format!("credit cost {k} must be a number")))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    let fair_use: FairUse = serde_json::from_value(
        v.get("fairUse")
            .cloned()
            .ok_or_else(|| err("missing fairUse"))?,
    )
    .map_err(|e| PlansError(e.to_string()))?;
    Ok(Plans {
        version: v.get("version").and_then(Value::as_u64).unwrap_or(1) as u32,
        currency: v
            .get("currency")
            .and_then(Value::as_str)
            .unwrap_or("usd")
            .to_string(),
        plans,
        credit_costs,
        fair_use,
        feature_keys,
        limit_keys,
    })
}

/// The embedded configuration (parsed once).
pub fn plans() -> &'static Plans {
    static PLANS: OnceLock<Plans> = OnceLock::new();
    PLANS.get_or_init(|| {
        parse_plans(PLANS_JSON).expect("config/plans.json is valid (checked by tests)")
    })
}

/// A plan by id.
pub fn plan(id: &str) -> Option<&'static Plan> {
    plans().plans.get(id)
}

/// Whether the plan includes a feature (unknown plans / features: false).
pub fn can(plan_id: &str, feature: &str) -> bool {
    plan(plan_id)
        .and_then(|p| p.features.get(feature))
        .copied()
        .unwrap_or(false)
}

/// The plan's limit for `key` (`None` for an unknown plan or key).
pub fn limit(plan_id: &str, key: &str) -> Option<Limit> {
    plan(plan_id).and_then(|p| p.limits.get(key)).copied()
}

/// True when `used` (after the action) stays within the plan's limit (unknown plan / key: false).
pub fn within_limit(plan_id: &str, key: &str, used: f64) -> bool {
    limit(plan_id, key).is_some_and(|l| l.allows(used))
}

/// Credits an action costs (`None` for unknown actions).
pub fn credit_cost(action: &str) -> Option<f64> {
    plans().credit_costs.get(action).copied()
}

/// Deployment edition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edition {
    /// desyn.app.
    Hosted,
    /// Self-hosted (every feature).
    Selfhost,
}

impl Edition {
    /// `DESYN_EDITION` semantics: anything but exactly `"hosted"` is self-hosted (no trimming or case folding, same
    /// as `parseEdition` in `@desyn/schema`, so every component derives the same edition from the same value).
    pub fn from_env_value(v: Option<&str>) -> Edition {
        if v == Some("hosted") {
            Edition::Hosted
        } else {
            Edition::Selfhost
        }
    }
}

/// Subscription state relevant for entitlement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionInfo {
    /// Subscribed plan id.
    pub plan: String,
    /// Stripe status (`active`, `trialing`, `past_due`, `canceled`, ...).
    pub status: String,
    /// ms epoch; access continues until then after cancellation.
    pub current_period_end: Option<f64>,
}

/// Effective plan id: `selfhost` for self-hosted editions; hosted users get their plan while the subscription is
/// entitled (active, trialing, past_due, or canceled before the period end), otherwise `free`.
pub fn plan_for_edition(
    edition: Edition,
    sub: Option<&SubscriptionInfo>,
    now_ms: f64,
) -> &'static str {
    if edition == Edition::Selfhost {
        return "selfhost";
    }
    let Some(s) = sub else { return "free" };
    if s.plan == "selfhost" {
        return "free";
    }
    let entitled = matches!(s.status.as_str(), "active" | "trialing" | "past_due")
        || (s.status == "canceled" && s.current_period_end.is_some_and(|end| now_ms < end));
    if entitled {
        plans()
            .plans
            .get_key_value(s.plan.as_str())
            .map(|(k, _)| k.as_str())
            .unwrap_or("free")
    } else {
        "free"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_config() {
        let p = plans();
        assert_eq!(p.plans.len(), 3);
        assert!(p.feature_keys.len() > 40);
        assert_eq!(p.feature_keys[0], "editor.core");
        assert_eq!(p.limit_keys[0], "designs");
        assert!(can("pro", "ai.agent"));
        assert!(can("selfhost", "mcp"));
        assert!(!can("free", "ai.agent"));
        assert!(can("free", "export.png"));
        assert!(!can("nope", "export.png"));
        assert_eq!(limit("free", "designs"), Some(Limit::Max(20.0)));
        assert_eq!(limit("pro", "designs"), Some(Limit::Unlimited));
        assert!(within_limit("free", "designs", 20.0));
        assert!(!within_limit("free", "designs", 21.0));
        assert_eq!(credit_cost("ai.image"), Some(3.0));
        assert_eq!(credit_cost("nope"), None);
        assert_eq!(p.fair_use.per_minute_ai_requests, 20.0);
    }

    #[test]
    fn editions() {
        let active = SubscriptionInfo {
            plan: "pro".into(),
            status: "active".into(),
            current_period_end: None,
        };
        assert_eq!(plan_for_edition(Edition::Hosted, Some(&active), 0.0), "pro");
        assert_eq!(plan_for_edition(Edition::Selfhost, None, 0.0), "selfhost");
        let canceled = SubscriptionInfo {
            plan: "pro".into(),
            status: "canceled".into(),
            current_period_end: Some(100.0),
        };
        assert_eq!(
            plan_for_edition(Edition::Hosted, Some(&canceled), 50.0),
            "pro"
        );
        assert_eq!(
            plan_for_edition(Edition::Hosted, Some(&canceled), 150.0),
            "free"
        );
        assert_eq!(Edition::from_env_value(Some("hosted")), Edition::Hosted);
        assert_eq!(Edition::from_env_value(None), Edition::Selfhost);
        // Exactly like `parseEdition`: no trimming / case folding.
        assert_eq!(Edition::from_env_value(Some(" hosted")), Edition::Selfhost);
        assert_eq!(Edition::from_env_value(Some("Hosted")), Edition::Selfhost);
    }
}
