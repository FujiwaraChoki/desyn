//! The Convex wire format of design content (DOCUMENT_MODEL change log, "Convex wire format"; the TypeScript twin
//! is `convex/lib/designs_wire.ts`): transactions and ops travel as JSON strings, `designs.load` pages carry node
//! JSON strings plus a header with assets / styles / meta JSON.

use desyn_core::model::{Design, Op, Transaction};
use serde_json::{Map, Value};

use crate::cloud::api::{LoadPage, OpEntry};

/// Serializes a transaction for `designs.commit({ tx })`.
pub fn encode_tx(tx: &Transaction) -> String {
    serde_json::to_string(tx).unwrap_or_else(|_| "{}".into())
}

/// Parses a transaction from `designOps.since` (`entry.tx`).
pub fn decode_tx(json: &str) -> Result<Transaction, String> {
    serde_json::from_str(json).map_err(|e| format!("transaction: {e}"))
}

/// Parses the `applied` ops of `designs.commit`.
pub fn decode_ops(json: &str) -> Result<Vec<Op>, String> {
    let raw: Vec<Value> = serde_json::from_str(json).map_err(|e| format!("ops: {e}"))?;
    Ok(raw.into_iter().map(Op::from_value).collect())
}

/// A decoded `designOps.since` entry.
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteTx {
    /// Seq.
    pub seq: u64,
    /// The accepted transaction (ops as the server applied them).
    pub tx: Transaction,
}

/// Decodes since entries (an undecodable entry becomes an empty transaction so seq stays contiguous).
pub fn decode_entries(entries: &[OpEntry]) -> Vec<RemoteTx> {
    entries
        .iter()
        .map(|e| RemoteTx {
            seq: e.seq,
            tx: decode_tx(&e.tx).unwrap_or_else(|err| {
                log::warn!(
                    "sync: seq {} could not be decoded ({err}); treating it as empty",
                    e.seq
                );
                Transaction::new(e.tx_id.clone(), "Unreadable change", Vec::new())
            }),
        })
        .collect()
}

/// Assembles a `Design` from `designs.load` pages. Returns the design and the seq to subscribe from (the lowest
/// page seq: replaying ops after it converges because ops are last-writer-wins and drop when they no longer apply).
pub fn assemble(pages: &[LoadPage]) -> Result<(Design, u64), String> {
    let header = pages
        .first()
        .and_then(|p| p.header.as_ref())
        .ok_or("the first load page has no header")?;
    let mut nodes = Map::new();
    let mut seq = u64::MAX;
    for p in pages {
        seq = seq.min(p.seq);
        for n in &p.nodes {
            let v: Value = serde_json::from_str(n).map_err(|e| format!("node: {e}"))?;
            if let Some(id) = v.get("id").and_then(Value::as_str) {
                nodes.insert(id.to_string(), v);
            }
        }
    }
    let parse = |s: &str, what: &str| -> Result<Value, String> {
        if s.is_empty() {
            return Ok(Value::Object(Map::new()));
        }
        serde_json::from_str(s).map_err(|e| format!("{what}: {e}"))
    };
    let mut d = Map::new();
    d.insert("schema".into(), Value::from(1));
    d.insert("id".into(), Value::from(header.key.clone()));
    d.insert("name".into(), Value::from(header.name.clone()));
    d.insert("kind".into(), Value::from(header.kind.clone()));
    d.insert("nodes".into(), Value::Object(nodes));
    d.insert("assets".into(), parse(&header.assets, "assets")?);
    let mut styles = parse(&header.styles, "styles")?;
    if let Some(o) = styles.as_object_mut() {
        for k in ["colors", "text", "effects", "variables"] {
            o.entry(k).or_insert_with(|| Value::Object(Map::new()));
        }
    }
    d.insert("styles".into(), styles);
    d.insert("meta".into(), parse(&header.meta, "meta")?);
    if let Some(b) = &header.brand_kit_id {
        d.insert("brandKitId".into(), Value::from(b.clone()));
    }
    let design =
        Design::from_json(&Value::Object(d).to_string()).map_err(|e| format!("design: {e}"))?;
    Ok((design, if seq == u64::MAX { 0 } else { seq }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::api::LoadHeader;

    #[test]
    fn assembles_pages() {
        let d = Design::with_page(
            "design000001",
            "Poster",
            desyn_core::model::DesignKind::Poster,
            "page00000001",
            100.0,
            200.0,
        );
        let nodes: Vec<String> = d
            .nodes
            .values()
            .map(|n| serde_json::to_string(n).unwrap())
            .collect();
        let (a, b) = nodes.split_at(1);
        let pages = vec![
            LoadPage {
                header: Some(LoadHeader {
                    key: "design000001".into(),
                    name: "Poster".into(),
                    kind: "poster".into(),
                    assets: "{}".into(),
                    styles: r#"{"colors":{},"text":{},"effects":{},"variables":{}}"#.into(),
                    meta: "{}".into(),
                    ..Default::default()
                }),
                seq: 7,
                nodes: a.to_vec(),
                cursor: Some("c".into()),
                is_done: false,
            },
            LoadPage {
                header: None,
                seq: 9,
                nodes: b.to_vec(),
                cursor: None,
                is_done: true,
            },
        ];
        let (got, seq) = assemble(&pages).unwrap();
        assert_eq!(seq, 7);
        assert_eq!(got.canonical_json(), d.canonical_json());
    }

    #[test]
    fn tx_roundtrip_keeps_color_refs() {
        let json = r##"{"id":"tx0000000001","label":"Fill","ops":[{"op":"update","id":"n1","set":{"fills":[{"type":"solid","color":{"$var":"brand.primary"}}]}}],"source":"user","ts":1}"##;
        let tx = decode_tx(json).unwrap();
        assert!(encode_tx(&tx).contains("$var"));
        let ops = decode_ops(r#"[{"op":"delete","id":"n1"},{"op":"bogus"}]"#).unwrap();
        assert_eq!(ops.len(), 2);
        let e = decode_entries(&[OpEntry {
            seq: 3,
            tx_id: "x".into(),
            tx: "not json".into(),
            ..Default::default()
        }]);
        assert_eq!(e[0].seq, 3);
        assert!(e[0].tx.ops.is_empty());
    }
}
