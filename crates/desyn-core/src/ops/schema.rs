//! Op schema checks that serde types cannot express (id patterns, node schemas), mirroring `OpSchema` in
//! `@desyn/schema`. A failure drops the op with `invalid-op`.

use crate::model::*;

fn node_id(name: &str, id: &str) -> Result<(), String> {
    if is_node_id(id) {
        Ok(())
    } else {
        Err(format!("{name} {id:?} is not a node id"))
    }
}

/// Validates the shape of an op before it is applied.
pub fn check_op_schema(op: &Op) -> Result<(), String> {
    match op {
        Op::Invalid { error, .. } => Err(error.clone()),
        Op::Create(o) => {
            if o.nodes.is_empty() {
                return Err("create needs at least one node".into());
            }
            node_id("parent", &o.parent)?;
            for n in &o.nodes {
                check_node_schema(n)?;
            }
            Ok(())
        }
        Op::Update(o) => node_id("id", &o.id),
        Op::Patch(o) => node_id("id", &o.id),
        Op::Delete(o) => node_id("id", &o.id),
        Op::Move(o) => {
            node_id("id", &o.id)?;
            node_id("parent", &o.parent)
        }
        Op::Asset(o) => {
            if let Some(set) = &o.set {
                for (k, a) in set {
                    if !is_id(k) {
                        return Err(format!("asset key {k:?} is not an id"));
                    }
                    check_asset_schema(a)?;
                }
            }
            if let Some(rm) = &o.remove {
                for k in rm {
                    if !is_id(k) {
                        return Err(format!("asset id {k:?} is not an id"));
                    }
                }
            }
            Ok(())
        }
        Op::Styles(_) | Op::Doc(_) => Ok(()),
    }
}
