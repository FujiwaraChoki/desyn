//! Deep get / set on JSON values by `(string | number)[]` paths (used by `patch` and `styles`).

use serde_json::Value;

use crate::model::PathSeg;

/// Result of a deep set.
pub(crate) struct DeepSet {
    /// Previous value at the leaf (`None` when the leaf was created: new object key or appended array element).
    pub old_leaf: Option<Value>,
    /// Previous value of the leaf's container (only captured when `old_leaf` is `None`).
    pub old_parent: Option<Value>,
}

/// Immutable lookup.
#[cfg(test)]
pub(crate) fn get_path<'a>(root: &'a Value, path: &[PathSeg]) -> Option<&'a Value> {
    let mut cur = root;
    for seg in path {
        cur = match (cur, seg) {
            (Value::Object(m), PathSeg::Key(k)) => m.get(k)?,
            (Value::Array(a), PathSeg::Index(i)) if *i >= 0 => a.get(*i as usize)?,
            _ => return None,
        };
    }
    Some(cur)
}

fn get_path_mut<'a>(root: &'a mut Value, path: &[PathSeg]) -> Option<&'a mut Value> {
    let mut cur = root;
    for seg in path {
        cur = match (cur, seg) {
            (Value::Object(m), PathSeg::Key(k)) => m.get_mut(k)?,
            (Value::Array(a), PathSeg::Index(i)) if *i >= 0 => a.get_mut(*i as usize)?,
            _ => return None,
        };
    }
    Some(cur)
}

/// Sets `value` at `path` inside `root`. Every intermediate segment must exist; the leaf may be a new object key or
/// the index one past the end of an array (append). Returns `None` when the path does not resolve.
/// An empty path replaces the root itself (reported as an existing leaf).
pub(crate) fn set_path(root: &mut Value, path: &[PathSeg], value: Value) -> Option<DeepSet> {
    let Some((last, parent_path)) = path.split_last() else {
        let old = std::mem::replace(root, value);
        return Some(DeepSet {
            old_leaf: Some(old),
            old_parent: None,
        });
    };
    let parent = get_path_mut(root, parent_path)?;
    match (parent, last) {
        (Value::Object(m), PathSeg::Key(k)) => {
            if m.contains_key(k) {
                let old = m.insert(k.clone(), value);
                Some(DeepSet {
                    old_leaf: old,
                    old_parent: None,
                })
            } else {
                let snapshot = Value::Object(m.clone());
                m.insert(k.clone(), value);
                Some(DeepSet {
                    old_leaf: None,
                    old_parent: Some(snapshot),
                })
            }
        }
        (Value::Array(a), PathSeg::Index(i)) if *i >= 0 => {
            let i = *i as usize;
            if i < a.len() {
                let old = std::mem::replace(&mut a[i], value);
                Some(DeepSet {
                    old_leaf: Some(old),
                    old_parent: None,
                })
            } else if i == a.len() {
                let snapshot = Value::Array(a.clone());
                a.push(value);
                Some(DeepSet {
                    old_leaf: None,
                    old_parent: Some(snapshot),
                })
            } else {
                None
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(v: Value) -> Vec<PathSeg> {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn set_and_get() {
        let mut v = json!({"a": {"b": [1, 2]}});
        let r = set_path(&mut v, &p(json!(["a", "b", 1])), json!(5)).unwrap();
        assert_eq!(r.old_leaf, Some(json!(2)));
        let r = set_path(&mut v, &p(json!(["a", "b", 2])), json!(7)).unwrap();
        assert!(r.old_leaf.is_none());
        assert_eq!(r.old_parent, Some(json!([1, 5])));
        assert!(set_path(&mut v, &p(json!(["a", "b", 9])), json!(7)).is_none());
        assert!(set_path(&mut v, &p(json!(["a", "x", "y"])), json!(7)).is_none());
        assert!(set_path(&mut v, &p(json!(["a", 0])), json!(7)).is_none());
        let r = set_path(&mut v, &p(json!(["a", "c"])), json!(true)).unwrap();
        assert_eq!(r.old_parent, Some(json!({"b": [1, 5, 7]})));
        assert_eq!(get_path(&v, &p(json!(["a", "c"]))), Some(&json!(true)));
        assert!(set_path(&mut v, &p(json!(["a", "b", -1])), json!(0)).is_none());
        let r = set_path(&mut v, &[], json!(1)).unwrap();
        assert_eq!(r.old_leaf.unwrap()["a"]["c"], json!(true));
        assert_eq!(v, json!(1));
    }
}
