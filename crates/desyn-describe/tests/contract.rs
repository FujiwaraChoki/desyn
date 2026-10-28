//! Contract test: every fixture's `Description` validates against the JSON Schema that `@desyn/schema` generates
//! from the TypeScript contract (`packages/schema/json-schema/Description.json`), fixes included (they are `Op`s),
//! and `IssueCode` matches the contract vocabulary exactly.

mod support;

use desyn_describe::IssueCode;
use serde_json::Value;
use support::*;

fn schema(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../packages/schema/json-schema/{name}.json"));
    serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .expect("schema json")
}

/// Minimal JSON Schema (2020-12) validator for the keywords the generated schemas use.
struct Validator<'a> {
    root: &'a Value,
}

impl Validator<'_> {
    fn resolve<'b>(&'b self, r: &str) -> &'b Value {
        let name = r
            .strip_prefix("#/$defs/")
            .unwrap_or_else(|| panic!("unsupported $ref {r}"));
        &self.root["$defs"][name]
    }

    fn pattern(p: &str, s: &str) -> bool {
        match p {
            "^[a-z0-9]{12}$" => {
                s.len() == 12
                    && s.bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            }
            "^#(?:[0-9a-f]{6}|[0-9a-f]{8})$" => {
                (s.len() == 7 || s.len() == 9)
                    && s.starts_with('#')
                    && s[1..]
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            }
            other => panic!("pattern {other} not supported by the test validator"),
        }
    }

    fn type_ok(t: &str, v: &Value) -> bool {
        match t {
            "string" => v.is_string(),
            "number" => v.is_number(),
            "integer" => v.as_f64().is_some_and(|n| n.fract() == 0.0),
            "boolean" => v.is_boolean(),
            "object" => v.is_object(),
            "array" => v.is_array(),
            "null" => v.is_null(),
            other => panic!("type {other}"),
        }
    }

    fn validate(&self, s: &Value, v: &Value, path: &str, errs: &mut Vec<String>) {
        let Some(obj) = s.as_object() else { return };
        if let Some(r) = obj.get("$ref").and_then(Value::as_str) {
            self.validate(self.resolve(r), v, path, errs);
        }
        if let Some(t) = obj.get("type") {
            let ok = match t {
                Value::String(t) => Self::type_ok(t, v),
                Value::Array(ts) => ts
                    .iter()
                    .any(|t| Self::type_ok(t.as_str().unwrap_or(""), v)),
                _ => true,
            };
            if !ok {
                errs.push(format!("{path}: expected type {t}, got {v}"));
                return;
            }
        }
        if let Some(e) = obj.get("enum").and_then(Value::as_array)
            && !e.contains(v)
        {
            errs.push(format!("{path}: {v} not in enum"));
        }
        if let Some(c) = obj.get("const")
            && c != v
        {
            errs.push(format!("{path}: {v} != const {c}"));
        }
        if let (Some(p), Some(sv)) = (obj.get("pattern").and_then(Value::as_str), v.as_str())
            && !Self::pattern(p, sv)
        {
            errs.push(format!("{path}: {sv:?} does not match {p}"));
        }
        if let Some(n) = v.as_f64() {
            if obj
                .get("minimum")
                .and_then(Value::as_f64)
                .is_some_and(|m| n < m)
            {
                errs.push(format!("{path}: {n} below minimum"));
            }
            if obj
                .get("maximum")
                .and_then(Value::as_f64)
                .is_some_and(|m| n > m)
            {
                errs.push(format!("{path}: {n} above maximum"));
            }
        }
        if let Some(any) = obj.get("anyOf").and_then(Value::as_array) {
            let ok = any.iter().any(|sub| {
                let mut e = Vec::new();
                self.validate(sub, v, path, &mut e);
                e.is_empty()
            });
            if !ok {
                errs.push(format!("{path}: matches no anyOf branch: {v}"));
            }
        }
        if let Some(one) = obj.get("oneOf").and_then(Value::as_array) {
            let n = one
                .iter()
                .filter(|sub| {
                    let mut e = Vec::new();
                    self.validate(sub, v, path, &mut e);
                    e.is_empty()
                })
                .count();
            if n != 1 {
                errs.push(format!("{path}: matches {n} oneOf branches"));
            }
        }
        if let Some(o) = v.as_object() {
            let props = obj.get("properties").and_then(Value::as_object);
            if let Some(req) = obj.get("required").and_then(Value::as_array) {
                for r in req.iter().filter_map(Value::as_str) {
                    if !o.contains_key(r) {
                        errs.push(format!("{path}: missing required {r}"));
                    }
                }
            }
            for (k, val) in o {
                if let Some(ps) = obj.get("propertyNames") {
                    self.validate(
                        ps,
                        &Value::String(k.clone()),
                        &format!("{path}/<key {k}>"),
                        errs,
                    );
                }
                match props.and_then(|p| p.get(k)) {
                    Some(ps) => self.validate(ps, val, &format!("{path}/{k}"), errs),
                    None => match obj.get("additionalProperties") {
                        Some(Value::Bool(false)) => {
                            errs.push(format!("{path}: unexpected key {k}"))
                        }
                        Some(ap @ Value::Object(_)) => {
                            self.validate(ap, val, &format!("{path}/{k}"), errs)
                        }
                        _ => {}
                    },
                }
            }
        }
        if let Some(a) = v.as_array() {
            if obj
                .get("minItems")
                .and_then(Value::as_u64)
                .is_some_and(|m| (a.len() as u64) < m)
            {
                errs.push(format!("{path}: too few items"));
            }
            if obj
                .get("maxItems")
                .and_then(Value::as_u64)
                .is_some_and(|m| (a.len() as u64) > m)
            {
                errs.push(format!("{path}: too many items"));
            }
            let prefix = obj.get("prefixItems").and_then(Value::as_array);
            for (i, item) in a.iter().enumerate() {
                let sub = prefix.and_then(|p| p.get(i)).or_else(|| obj.get("items"));
                if let Some(sub) = sub {
                    self.validate(sub, item, &format!("{path}/{i}"), errs);
                }
            }
        }
    }
}

#[test]
fn every_fixture_description_matches_the_json_schema() {
    let schema = schema("Description");
    let v = Validator { root: &schema };
    let mut checked = 0;
    let mut fixes = 0;
    for entry in std::fs::read_dir(fixtures_dir()).expect("fixtures") {
        let path = entry.expect("entry").path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let f: Fixture = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let desc = run_fixture(&f);
        fixes += desc.issues.iter().filter(|i| i.fix.is_some()).count();
        let value = serde_json::to_value(&desc).expect("json");
        let mut errs = Vec::new();
        v.validate(&schema, &value, "", &mut errs);
        assert!(errs.is_empty(), "{}: {}", path.display(), errs.join("\n"));
        checked += 1;
    }
    assert!(
        checked >= 10 && fixes >= 10,
        "checked {checked} fixtures, {fixes} fixes"
    );

    // The validator itself rejects contract violations.
    let f: Fixture = serde_json::from_str(
        &std::fs::read_to_string(fixtures_dir().join("contrast.json")).unwrap(),
    )
    .unwrap();
    let mut bad = serde_json::to_value(run_fixture(&f)).unwrap();
    bad["issues"][0]["code"] = Value::String("bogus".into());
    bad["tree"][0]["box"]["w"] = Value::String("wide".into());
    bad["page"].as_object_mut().unwrap().remove("unit");
    let mut errs = Vec::new();
    v.validate(&schema, &bad, "", &mut errs);
    assert_eq!(errs.len(), 3, "{errs:?}");
}

#[test]
fn issue_codes_are_the_contract_vocabulary() {
    let s = schema("IssueCode");
    let want: Vec<String> = s["enum"]
        .as_array()
        .expect("enum")
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    let have: Vec<String> = IssueCode::ALL
        .iter()
        .map(|c| c.as_str().to_string())
        .collect();
    assert_eq!(have, want);
    for c in IssueCode::ALL {
        assert_eq!(
            serde_json::to_value(c).unwrap(),
            Value::String(c.as_str().into())
        );
    }
    // Every lint rule reports under a contract code, and every code has at least one rule.
    for c in IssueCode::ALL {
        assert!(
            desyn_describe::lint::RULES.iter().any(|r| r.1 == *c),
            "no rule for {}",
            c.as_str()
        );
    }
}
