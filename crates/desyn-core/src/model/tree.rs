//! Tree navigation helpers over the flat node map.

use super::design::Design;
use super::node::{Node, NodeType};
use super::primitives::{Id, ROOT_ID};

impl Design {
    /// Index of `id` in its parent's children.
    pub fn index_in_parent(&self, id: &str) -> Option<usize> {
        let parent = self.node(id)?.parent()?;
        self.node(parent)?.child_ids().iter().position(|c| c == id)
    }

    /// Ancestors of `id` from its parent up to the root (excluding `id`). Stops on a broken link or a cycle. Linear in
    /// the depth (designs can nest arbitrarily deep).
    pub fn ancestors(&self, id: &str) -> Vec<Id> {
        let mut out: Vec<Id> = Vec::new();
        let mut seen: rustc_hash::FxHashSet<&str> = Default::default();
        seen.insert(id);
        let mut cur = self.node(id).and_then(Node::parent);
        while let Some(p) = cur {
            if !seen.insert(p) {
                break;
            }
            out.push(p.to_string());
            cur = self.node(p).and_then(Node::parent);
        }
        out
    }

    /// True if `ancestor` is `id` or one of its ancestors.
    pub fn is_ancestor_or_self(&self, ancestor: &str, id: &str) -> bool {
        if ancestor == id {
            return true;
        }
        let mut cur = self.node(id).and_then(Node::parent);
        let mut guard = 0usize;
        while let Some(p) = cur {
            if p == ancestor {
                return true;
            }
            guard += 1;
            if guard > self.nodes.len() {
                return false;
            }
            cur = self.node(p).and_then(Node::parent);
        }
        false
    }

    /// The page containing `id` (the page itself for a page id).
    pub fn page_of(&self, id: &str) -> Option<&str> {
        let mut cur = self.node(id)?;
        let mut guard = 0usize;
        loop {
            if cur.node_type() == NodeType::Page {
                return Some(cur.id());
            }
            let p = cur.parent()?;
            cur = self.node(p)?;
            guard += 1;
            if guard > self.nodes.len() {
                return None;
            }
        }
    }

    /// Depth of a node (root = 0, pages = 1).
    pub fn depth(&self, id: &str) -> usize {
        let mut seen: rustc_hash::FxHashSet<&str> = Default::default();
        seen.insert(id);
        let mut n = 0;
        let mut cur = self.node(id).and_then(Node::parent);
        while let Some(p) = cur {
            if !seen.insert(p) {
                break;
            }
            n += 1;
            cur = self.node(p).and_then(Node::parent);
        }
        n
    }

    /// Pre-order list of `id` and all its descendants (`id` first). Children follow `children` order.
    pub fn subtree_ids(&self, id: &str) -> Vec<Id> {
        let mut out = Vec::new();
        if self.node(id).is_none() {
            return out;
        }
        let mut seen: rustc_hash::FxHashSet<Id> = Default::default();
        let mut stack = vec![id.to_string()];
        while let Some(cur) = stack.pop() {
            if !seen.insert(cur.clone()) {
                continue;
            }
            if let Some(n) = self.node(&cur) {
                for c in n.child_ids().iter().rev() {
                    stack.push(c.clone());
                }
            }
            out.push(cur);
        }
        out
    }

    /// Pre-order walk calling `f(node, depth)` for `id` and its descendants; return false from `f` to skip a subtree.
    /// Iterative (an explicit stack), so arbitrarily deep designs cannot overflow the call stack; descent stops at
    /// depth `nodes.len()`, which only malformed (cyclic) child lists reach.
    pub fn walk<'a>(&'a self, id: &str, f: &mut dyn FnMut(&'a Node, usize) -> bool) {
        let Some(start) = self.node(id) else { return };
        let limit = self.nodes.len();
        let mut stack: Vec<(&'a Node, usize)> = vec![(start, 0)];
        while let Some((n, depth)) = stack.pop() {
            if f(n, depth) && depth < limit {
                for c in n.child_ids().iter().rev() {
                    if let Some(cn) = self.node(c) {
                        stack.push((cn, depth + 1));
                    }
                }
            }
        }
    }

    /// Topmost-level ids among `ids`: removes ids that have an ancestor in the set. Keeps input order.
    pub fn top_level_ids(&self, ids: &[Id]) -> Vec<Id> {
        let set: rustc_hash::FxHashSet<&str> = ids.iter().map(String::as_str).collect();
        ids.iter()
            .filter(|id| !self.ancestors(id).iter().any(|a| set.contains(a.as_str())))
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .fold(Vec::new(), |mut acc, id| {
                if !acc.contains(&id) {
                    acc.push(id);
                }
                acc
            })
    }

    /// Sorts ids by paint order (document pre-order: back-to-front).
    pub fn sort_by_paint_order(&self, ids: &mut [Id]) {
        let mut order: rustc_hash::FxHashMap<&str, usize> = Default::default();
        let mut i = 0usize;
        self.walk(ROOT_ID, &mut |n, _| {
            order.insert(n.id(), i);
            i += 1;
            true
        });
        ids.sort_by_key(|id| order.get(id.as_str()).copied().unwrap_or(usize::MAX));
    }
}
