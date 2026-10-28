//! A server agent run as the AI dock shows it: run events (DOCUMENT_MODEL §6 / `packages/ai` `AgentEvent`, stored
//! by Convex in `aiRunEvents`) folded into a conversation (user prompt, the agent's messages, tool steps with their
//! summaries, previews, questions, the final summary) plus the layers it touched.

use std::collections::BTreeSet;

use desyn_core::model::{Op, Transaction};
use serde_json::Value as Json;

/// One line of the conversation.
#[derive(Debug, Clone, PartialEq)]
pub enum Entry {
    /// What the user asked.
    User(String),
    /// The agent wrote something.
    Agent(String),
    /// A tool step (`tool`, running / done, summary).
    Tool {
        /// Tool call id.
        call: String,
        /// Tool name.
        tool: String,
        /// Finished.
        done: bool,
        /// Succeeded.
        ok: bool,
        /// Summary.
        summary: String,
    },
    /// A rendered preview.
    Preview {
        /// Image URL.
        url: String,
        /// Width.
        width: f64,
        /// Height.
        height: f64,
    },
    /// The plan.
    Plan(Vec<(String, String)>),
    /// The agent asks something.
    Question {
        /// Question.
        question: String,
        /// Suggested answers.
        options: Vec<String>,
    },
    /// A progress note.
    Progress(String),
    /// An error.
    Error(String),
    /// The run ended.
    Done {
        /// Final status.
        status: String,
        /// Summary.
        summary: String,
        /// Credits used.
        credits: f64,
    },
}

/// Readable name of a tool ("update_elements" -> "Updating elements").
pub fn tool_label(tool: &str) -> String {
    let known = match tool {
        "read_design" => "Reading the design",
        "read_selection" => "Reading the selection",
        "render_preview" => "Looking at the result",
        "query_elements" => "Finding layers",
        "create_elements" => "Adding layers",
        "update_elements" => "Updating layers",
        "delete_elements" => "Removing layers",
        "duplicate_elements" => "Duplicating layers",
        "group_elements" => "Grouping",
        "ungroup" => "Ungrouping",
        "set_roles" => "Naming roles",
        "arrange" => "Arranging",
        "set_text" => "Writing text",
        "rewrite_text" => "Rewriting copy",
        "translate_text" => "Translating",
        "set_style" => "Styling",
        "apply_brand" => "Applying the brand",
        "add_page" => "Adding a page",
        "delete_page" => "Removing a page",
        "reorder_pages" => "Reordering pages",
        "resize_page" => "Resizing",
        "generate_image" => "Generating an image",
        "generate_svg" => "Drawing a vector",
        "remove_background" => "Removing the background",
        "inpaint" => "Editing the image",
        "outpaint" => "Extending the image",
        "upscale" => "Upscaling",
        "mockup" => "Making a mockup",
        "trace_to_vector" => "Tracing",
        "search_stock" => "Searching photos",
        "search_icons" => "Searching icons",
        "search_templates" => "Searching templates",
        "apply_template" => "Applying a template",
        "critique" => "Reviewing the design",
        "plan" => "Planning",
        "ask_user" => "Asking you",
        "run_workflow" => "Running a workflow",
        "finish" => "Wrapping up",
        _ => "",
    };
    if !known.is_empty() {
        return known.to_string();
    }
    let mut s = tool.replace('_', " ");
    if let Some(c) = s.get_mut(0..1) {
        c.make_ascii_uppercase();
    }
    s
}

/// The state of one run.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RunState {
    /// Run id.
    pub id: String,
    /// Run status (queued, running, needs-input, completed, cancelled, budget-exceeded, step-limit, failed).
    pub status: String,
    /// Conversation.
    pub entries: Vec<Entry>,
    /// Layers the run created or changed.
    pub touched: BTreeSet<String>,
    /// Index of the last event folded in.
    pub last_index: i64,
    /// Credits used so far.
    pub credits: f64,
    /// Model.
    pub model: Option<String>,
    /// All events were seen and the run ended.
    pub finished: bool,
}

/// Node ids an op touches.
pub fn op_targets(op: &Op) -> Vec<String> {
    match op {
        Op::Create(c) => c.nodes.iter().map(|n| n.id().to_string()).collect(),
        Op::Update(u) => vec![u.id.clone()],
        Op::Patch(p) => vec![p.id.clone()],
        Op::Move(m) => vec![m.id.clone()],
        _ => Vec::new(),
    }
}

/// Node ids a transaction touches (deleted nodes excluded).
pub fn tx_targets(tx: &Transaction) -> BTreeSet<String> {
    let deleted: BTreeSet<String> = tx
        .ops
        .iter()
        .filter_map(|o| match o {
            Op::Delete(d) => Some(d.id.clone()),
            _ => None,
        })
        .collect();
    tx.ops
        .iter()
        .flat_map(op_targets)
        .filter(|id| !deleted.contains(id))
        .collect()
}

/// Whether a run status is final.
pub fn is_terminal(status: &str) -> bool {
    matches!(
        status,
        "completed" | "cancelled" | "budget-exceeded" | "step-limit" | "failed"
    )
}

/// A short sentence for a final status.
pub fn status_line(status: &str) -> &'static str {
    match status {
        "completed" => "Done.",
        "cancelled" => "Stopped. Changes made so far stay (undo removes them).",
        "budget-exceeded" => "Stopped at the credit limit for this run.",
        "step-limit" => "Stopped at the step limit. Ask to continue.",
        "failed" => "The run failed.",
        "needs-input" => "Waiting for your answer.",
        _ => "",
    }
}

fn s(v: &Json, k: &str) -> String {
    v.get(k)
        .and_then(Json::as_str)
        .unwrap_or_default()
        .to_string()
}

impl RunState {
    /// A new run started from `goal`.
    pub fn new(id: &str, goal: &str) -> RunState {
        RunState {
            id: id.to_string(),
            status: "queued".into(),
            entries: vec![Entry::User(goal.to_string())],
            last_index: -1,
            ..Default::default()
        }
    }

    /// Folds `runEvents` events (each with `index` and `type`). Events at or before `last_index` are ignored.
    pub fn fold(&mut self, events: &[Json]) {
        for e in events {
            let index = e
                .get("index")
                .and_then(Json::as_i64)
                .unwrap_or(self.last_index + 1);
            if index <= self.last_index {
                continue;
            }
            self.last_index = index;
            match e.get("type").and_then(Json::as_str).unwrap_or_default() {
                "start" => {
                    self.status = "running".into();
                    let m = s(e, "model");
                    if !m.is_empty() {
                        self.model = Some(m);
                    }
                }
                "text" => {
                    let t = s(e, "text");
                    if t.trim().is_empty() {
                        continue;
                    }
                    match self.entries.last_mut() {
                        Some(Entry::Agent(prev)) => prev.push_str(&t),
                        _ => self.entries.push(Entry::Agent(t)),
                    }
                }
                "tool-call" => {
                    let tool = s(e, "tool");
                    if tool == "finish" {
                        continue;
                    }
                    self.entries.push(Entry::Tool {
                        call: s(e, "callId"),
                        tool,
                        done: false,
                        ok: true,
                        summary: String::new(),
                    });
                }
                "tool-result" => {
                    let call = s(e, "callId");
                    let ok = e.get("ok").and_then(Json::as_bool).unwrap_or(true);
                    let summary = s(e, "summary");
                    if let Some(Entry::Tool {
                        done,
                        ok: o,
                        summary: sm,
                        ..
                    }) = self
                        .entries
                        .iter_mut()
                        .rev()
                        .find(|en| matches!(en, Entry::Tool { call: c, .. } if *c == call))
                    {
                        *done = true;
                        *o = ok;
                        *sm = summary;
                    }
                }
                "applied-tx" => {
                    if let Some(t) = e.get("touched").and_then(Json::as_array) {
                        self.touched
                            .extend(t.iter().filter_map(|v| v.as_str().map(str::to_string)));
                    }
                }
                "preview" => {
                    let url = s(e, "url");
                    if !url.is_empty() {
                        self.entries.push(Entry::Preview {
                            url,
                            width: e.get("width").and_then(Json::as_f64).unwrap_or(1.0),
                            height: e.get("height").and_then(Json::as_f64).unwrap_or(1.0),
                        });
                    }
                }
                "plan" => {
                    let steps = e
                        .get("steps")
                        .and_then(Json::as_array)
                        .map(|a| {
                            a.iter()
                                .map(|st| (s(st, "title"), s(st, "status")))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    if let Some(i) = self
                        .entries
                        .iter()
                        .position(|en| matches!(en, Entry::Plan(_)))
                    {
                        self.entries[i] = Entry::Plan(steps);
                    } else {
                        self.entries.push(Entry::Plan(steps));
                    }
                }
                "progress" => {
                    let l = s(e, "label");
                    let d = s(e, "detail");
                    let text = if d.is_empty() {
                        l
                    } else {
                        format!("{l} · {d}")
                    };
                    if !text.is_empty() {
                        self.entries.push(Entry::Progress(text));
                    }
                }
                "credits" => {
                    self.credits = e.get("used").and_then(Json::as_f64).unwrap_or(self.credits);
                }
                "question" => {
                    self.status = "needs-input".into();
                    self.entries.push(Entry::Question {
                        question: s(e, "question"),
                        options: e
                            .get("options")
                            .and_then(Json::as_array)
                            .map(|a| {
                                a.iter()
                                    .filter_map(|v| v.as_str().map(str::to_string))
                                    .collect()
                            })
                            .unwrap_or_default(),
                    });
                }
                "error" => {
                    let m = s(e, "message");
                    if !m.is_empty() {
                        self.entries.push(Entry::Error(m));
                    }
                }
                "done" => {
                    let status = s(e, "status");
                    self.credits = e
                        .get("credits")
                        .and_then(Json::as_f64)
                        .unwrap_or(self.credits);
                    self.entries.push(Entry::Done {
                        status: status.clone(),
                        summary: s(e, "summary"),
                        credits: self.credits,
                    });
                    if !status.is_empty() {
                        self.status = status;
                    }
                }
                _ => {}
            }
        }
    }

    /// Applies the run view of `runEvents` (status, credits) and whether every event arrived.
    pub fn update_run(&mut self, status: &str, credits: f64, done: bool) {
        if !status.is_empty() {
            self.status = status.to_string();
        }
        self.credits = self.credits.max(credits);
        self.finished = done;
    }

    /// The run is working (not waiting, not finished).
    pub fn is_active(&self) -> bool {
        !is_terminal(&self.status) && self.status != "needs-input"
    }

    /// The pending question, when the run waits for an answer.
    pub fn question(&self) -> Option<(&str, &[String])> {
        if self.status != "needs-input" {
            return None;
        }
        self.entries.iter().rev().find_map(|e| match e {
            Entry::Question { question, options } => Some((question.as_str(), options.as_slice())),
            _ => None,
        })
    }

    /// Records an answer the user gave.
    pub fn answered(&mut self, answer: &str) {
        self.entries.push(Entry::User(answer.to_string()));
        self.status = "running".into();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn folds_a_run() {
        let mut r = RunState::new("run1", "make it premium");
        r.fold(&[
            json!({ "index": 0, "type": "start", "model": "openrouter:anthropic/claude-sonnet-5.5" }),
            json!({ "index": 1, "type": "text", "text": "Looking at " }),
            json!({ "index": 2, "type": "text", "text": "your poster." }),
            json!({ "index": 3, "type": "tool-call", "callId": "c1", "tool": "update_elements" }),
            json!({ "index": 4, "type": "applied-tx", "touched": ["n1", "n2"] }),
            json!({ "index": 5, "type": "tool-result", "callId": "c1", "tool": "update_elements", "ok": true, "summary": "2 layers restyled" }),
            json!({ "index": 6, "type": "credits", "used": 3, "remaining": 597 }),
            json!({ "index": 3, "type": "text", "text": "duplicate (ignored)" }),
        ]);
        assert_eq!(r.status, "running");
        assert_eq!(r.entries[1], Entry::Agent("Looking at your poster.".into()));
        assert!(
            matches!(&r.entries[2], Entry::Tool { done: true, ok: true, summary, .. } if summary == "2 layers restyled")
        );
        assert_eq!(r.touched.len(), 2);
        assert_eq!(r.credits, 3.0);
        assert!(r.is_active());
        r.fold(&[json!({ "index": 7, "type": "question", "question": "Which logo?", "options": ["Dark", "Light"] })]);
        assert_eq!(r.question().unwrap().1.len(), 2);
        r.answered("Dark");
        r.fold(&[json!({ "index": 8, "type": "done", "status": "completed", "summary": "Restyled.", "credits": 4 })]);
        assert!(!r.is_active());
        assert!(matches!(r.entries.last(), Some(Entry::Done { credits, .. }) if *credits == 4.0));
        assert_eq!(tool_label("generate_image"), "Generating an image");
        assert_eq!(tool_label("magic_wand"), "Magic wand");
    }

    #[test]
    fn transaction_targets() {
        let tx: Transaction = serde_json::from_value(json!({
            "id": "t1", "label": "x", "source": "ai", "ts": 0,
            "ops": [
                { "op": "update", "id": "a", "set": { "x": 1 } },
                { "op": "delete", "id": "b" },
                { "op": "patch", "id": "b", "path": ["x"], "value": 2 },
                { "op": "move", "id": "c", "parent": "p" }
            ]
        }))
        .unwrap();
        let t = tx_targets(&tx);
        assert_eq!(
            t.into_iter().collect::<Vec<_>>(),
            vec!["a".to_string(), "c".to_string()]
        );
    }
}
