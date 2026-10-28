//! Operations and transactions (DOCUMENT_MODEL section 5).

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::num::{i64_lenient, nn, opt_i64_lenient};
use serde_json::{Map, Value};

use super::design::{AssetRef, DesignKind};
use super::node::Node;
use super::primitives::{Id, string_enum};

/// One segment of a deep path: object key or array index. Integral JSON numbers (also `1.0`) are indices.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(untagged)]
pub enum PathSeg {
    /// Array index (negative values parse but never resolve).
    Index(i64),
    /// Object key.
    Key(String),
}

impl<'de> Deserialize<'de> for PathSeg {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Key(String),
            #[serde(deserialize_with = "i64_lenient")]
            Index(i64),
        }
        match Raw::deserialize(d) {
            Ok(Raw::Key(k)) => Ok(PathSeg::Key(k)),
            Ok(Raw::Index(i)) => Ok(PathSeg::Index(i)),
            Err(_) => Err(serde::de::Error::custom(
                "path segments are strings or integers",
            )),
        }
    }
}

impl From<&str> for PathSeg {
    fn from(s: &str) -> Self {
        PathSeg::Key(s.to_string())
    }
}

impl From<usize> for PathSeg {
    fn from(i: usize) -> Self {
        PathSeg::Index(i as i64)
    }
}

/// `create`: insert a subtree. `nodes[0]` is the subtree root (its `parent` is overwritten with `parent`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateOp {
    /// Subtree root first, then its descendants.
    pub nodes: Vec<Node>,
    /// Parent container.
    pub parent: Id,
    /// Insert position in the parent's children (clamped); omitted = top (end).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "opt_i64_lenient"
    )]
    pub index: Option<i64>,
}

/// `update`: shallow top-level property merge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateOp {
    /// Target node.
    pub id: Id,
    /// Keys to set (whole values).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub set: Option<Map<String, Value>>,
    /// Keys to remove.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub unset: Option<Vec<String>>,
}

/// `patch`: deep set at a path inside a node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PatchOp {
    /// Target node.
    pub id: Id,
    /// Path (first segment is a top-level node key).
    pub path: Vec<PathSeg>,
    /// New value.
    pub value: Value,
}

/// `delete`: remove a node and its subtree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeleteOp {
    /// Target node.
    pub id: Id,
}

/// `move`: reparent / reorder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MoveOp {
    /// Node to move.
    pub id: Id,
    /// New parent.
    pub parent: Id,
    /// Position in the new parent's children after removal from the old position (clamped); omitted = top.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "opt_i64_lenient"
    )]
    pub index: Option<i64>,
}

/// `asset`: add / replace / remove asset references.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssetOp {
    /// Assets to add or replace (whole).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub set: Option<BTreeMap<Id, AssetRef>>,
    /// Asset ids to remove.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub remove: Option<Vec<Id>>,
}

/// `styles`: deep set into `Design.styles`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StylesOp {
    /// Path inside `styles`.
    pub path: Vec<PathSeg>,
    /// New value.
    pub value: Value,
}

/// Fields of a `doc` op (unknown keys are rejected, as in `@desyn/doc-ops`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocSet {
    /// New name.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub name: Option<String>,
    /// New kind.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub kind: Option<DesignKind>,
    /// New brand kit id.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub brand_kit_id: Option<String>,
    /// New meta (replaced whole).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub meta: Option<Map<String, Value>>,
}

/// Design field that a `doc` op may remove (only `brandKitId` is optional).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DocField {
    /// `brandKitId`.
    #[serde(rename = "brandKitId")]
    BrandKitId,
}

/// `doc`: set (and optionally remove) design-level fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocOp {
    /// Fields to set.
    pub set: DocSet,
    /// Fields to remove (additive contract change 2026-10-20).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub unset: Option<Vec<DocField>>,
}

/// An operation. Malformed JSON ops deserialize into [`Op::Invalid`] (instead of failing the whole transaction)
/// so the applier can drop them individually.
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    /// Insert a subtree.
    Create(CreateOp),
    /// Shallow merge.
    Update(UpdateOp),
    /// Deep set.
    Patch(PatchOp),
    /// Remove subtree.
    Delete(DeleteOp),
    /// Reparent / reorder.
    Move(MoveOp),
    /// Asset refs.
    Asset(AssetOp),
    /// Styles deep set.
    Styles(StylesOp),
    /// Design fields.
    Doc(DocOp),
    /// An op that failed to parse; serialized back verbatim, always dropped by the applier.
    Invalid {
        /// Original JSON.
        raw: Value,
        /// Parse error message.
        error: String,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum OpRepr {
    Create(CreateOp),
    Update(UpdateOp),
    Patch(PatchOp),
    Delete(DeleteOp),
    Move(MoveOp),
    Asset(AssetOp),
    Styles(StylesOp),
    Doc(DocOp),
}

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum OpReprRef<'a> {
    Create(&'a CreateOp),
    Update(&'a UpdateOp),
    Patch(&'a PatchOp),
    Delete(&'a DeleteOp),
    Move(&'a MoveOp),
    Asset(&'a AssetOp),
    Styles(&'a StylesOp),
    Doc(&'a DocOp),
}

impl Serialize for Op {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let r = match self {
            Op::Create(o) => OpReprRef::Create(o),
            Op::Update(o) => OpReprRef::Update(o),
            Op::Patch(o) => OpReprRef::Patch(o),
            Op::Delete(o) => OpReprRef::Delete(o),
            Op::Move(o) => OpReprRef::Move(o),
            Op::Asset(o) => OpReprRef::Asset(o),
            Op::Styles(o) => OpReprRef::Styles(o),
            Op::Doc(o) => OpReprRef::Doc(o),
            Op::Invalid { raw, .. } => return raw.serialize(s),
        };
        r.serialize(s)
    }
}

impl<'de> Deserialize<'de> for Op {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = Value::deserialize(d)?;
        Ok(Op::from_value(raw))
    }
}

impl From<OpRepr> for Op {
    fn from(r: OpRepr) -> Self {
        match r {
            OpRepr::Create(o) => Op::Create(o),
            OpRepr::Update(o) => Op::Update(o),
            OpRepr::Patch(o) => Op::Patch(o),
            OpRepr::Delete(o) => Op::Delete(o),
            OpRepr::Move(o) => Op::Move(o),
            OpRepr::Asset(o) => Op::Asset(o),
            OpRepr::Styles(o) => Op::Styles(o),
            OpRepr::Doc(o) => Op::Doc(o),
        }
    }
}

impl Op {
    /// Parses an op from a JSON value; never fails (malformed input becomes [`Op::Invalid`]).
    pub fn from_value(raw: Value) -> Op {
        if !matches!(raw.get("op"), Some(Value::String(_))) {
            return Op::Invalid {
                raw,
                error: "`op` must be a string".into(),
            };
        }
        let mut typed = raw.clone();
        // `create` overwrites the subtree root's `parent` with the op's `parent` before anything looks at it, so
        // whatever the root carries there (even a non-string) must not make the op unparseable.
        if typed["op"] == "create"
            && typed["parent"].is_string()
            && let Some(head) = typed
                .get_mut("nodes")
                .and_then(Value::as_array_mut)
                .and_then(|n| n.first_mut())
                .and_then(Value::as_object_mut)
            && head
                .get("parent")
                .is_some_and(|p| !p.is_string() && !p.is_null())
        {
            head.insert("parent".into(), raw["parent"].clone());
        }
        match serde_json::from_value::<OpRepr>(typed) {
            Ok(r) => r.into(),
            Err(e) => Op::Invalid {
                raw,
                error: e.to_string(),
            },
        }
    }

    /// The `op` discriminant string.
    pub fn kind(&self) -> &'static str {
        match self {
            Op::Create(_) => "create",
            Op::Update(_) => "update",
            Op::Patch(_) => "patch",
            Op::Delete(_) => "delete",
            Op::Move(_) => "move",
            Op::Asset(_) => "asset",
            Op::Styles(_) => "styles",
            Op::Doc(_) => "doc",
            Op::Invalid { .. } => "invalid",
        }
    }

    /// Convenience: `update` with a `set` map.
    pub fn update_set(id: impl Into<Id>, set: Map<String, Value>) -> Op {
        Op::Update(UpdateOp {
            id: id.into(),
            set: Some(set),
            unset: None,
        })
    }

    /// Convenience: `delete`.
    pub fn delete(id: impl Into<Id>) -> Op {
        Op::Delete(DeleteOp { id: id.into() })
    }

    /// Convenience: `move`.
    pub fn move_to(id: impl Into<Id>, parent: impl Into<Id>, index: Option<i64>) -> Op {
        Op::Move(MoveOp {
            id: id.into(),
            parent: parent.into(),
            index,
        })
    }

    /// Convenience: `patch`.
    pub fn patch(id: impl Into<Id>, path: Vec<PathSeg>, value: Value) -> Op {
        Op::Patch(PatchOp {
            id: id.into(),
            path,
            value,
        })
    }

    /// Convenience: `create`.
    pub fn create(nodes: Vec<Node>, parent: impl Into<Id>, index: Option<i64>) -> Op {
        Op::Create(CreateOp {
            nodes,
            parent: parent.into(),
            index,
        })
    }
}

string_enum!(
    /// Who produced a transaction.
    TxSource { User = "user", Ai = "ai", Workflow = "workflow", Import = "import", Template = "template", System = "system" }
);

/// Transaction author details.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    /// User id.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub user_id: Option<String>,
    /// AI run id.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub run_id: Option<String>,
    /// Agent name.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub agent: Option<String>,
}

/// An atomic, undoable group of ops.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    /// Client-generated id (idempotency key).
    pub id: Id,
    /// History label.
    pub label: String,
    /// Ops applied in order.
    pub ops: Vec<Op>,
    /// Source.
    pub source: TxSource,
    /// Author.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nn"
    )]
    pub actor: Option<Actor>,
    /// ms epoch (informational).
    pub ts: f64,
}

impl Transaction {
    /// New user transaction with `ts = 0`.
    pub fn new(id: impl Into<Id>, label: impl Into<String>, ops: Vec<Op>) -> Self {
        Transaction {
            id: id.into(),
            label: label.into(),
            ops,
            source: TxSource::User,
            actor: None,
            ts: 0.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_parse_and_invalid() {
        let tx: Transaction = serde_json::from_str(
            r#"{"id":"t","label":"x","source":"user","ts":1,"ops":[{"op":"delete","id":"a"},{"op":"bogus"},{"op":"move","id":"a","parent":"b","index":2}]}"#,
        )
        .unwrap();
        assert!(matches!(tx.ops[0], Op::Delete(_)));
        assert!(matches!(tx.ops[1], Op::Invalid { .. }));
        assert!(matches!(tx.ops[2], Op::Move(MoveOp { index: Some(2), .. })));
        let back = serde_json::to_value(&tx).unwrap();
        assert_eq!(back["ops"][1], serde_json::json!({"op":"bogus"}));
        assert_eq!(back["ops"][0], serde_json::json!({"op":"delete","id":"a"}));
    }

    #[test]
    fn doc_unset() {
        let op: Op =
            serde_json::from_str(r#"{"op":"doc","set":{},"unset":["brandKitId"]}"#).unwrap();
        let Op::Doc(d) = &op else { panic!() };
        assert_eq!(d.unset, Some(vec![DocField::BrandKitId]));
        assert_eq!(
            serde_json::to_string(&op).unwrap(),
            r#"{"op":"doc","set":{},"unset":["brandKitId"]}"#
        );
        let op: Op = serde_json::from_str(r#"{"op":"doc","set":{},"unset":["name"]}"#).unwrap();
        assert!(matches!(op, Op::Invalid { .. }));
    }

    #[test]
    fn patch_path_mixed() {
        let op: Op = serde_json::from_str(
            r##"{"op":"patch","id":"a","path":["fills",0,"color"],"value":"#000000"}"##,
        )
        .unwrap();
        let Op::Patch(p) = op else { panic!() };
        assert_eq!(
            p.path,
            vec![
                PathSeg::Key("fills".into()),
                PathSeg::Index(0),
                PathSeg::Key("color".into())
            ]
        );
    }
}
