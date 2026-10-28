//! The AI dock: a prompt bar anchored bottom-center that expands into the conversation (DESIGN_SYSTEM §6), and the
//! AI panel in the left rail (conversation, suggestions, recent runs). Prompts run the server-side design agent
//! (`ai.agent.startRun`; events stream from `ai.agent.runEvents`), which edits the design through ordinary
//! transactions; they arrive over the sync subscription, the touched layers pulse with the sun glow while the run
//! works and get the "sunrise" flash when it finishes, and the user's own run undoes step by step.
//!
//! Without an account the dock explains how to get the AI: sign in, or configure a local / BYOK provider in the
//! web app (keys stay in the browser there).

pub mod dock;
pub mod panel;
pub mod run;

use std::collections::{HashMap, HashSet};

use desyn_core::model::Transaction;
use gpui::{App, BorrowAppContext, Entity, EntityId, Global, Task};
use serde_json::{Value as Json, json};

use crate::auth::Account;
use crate::cloud::api::{self, RunEvents, f};
use crate::cloud::{Cloud, CloudError};
use crate::ui::editor::EditorView;
use crate::widgets::notify;
use run::RunState;

/// Run mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Edit the current design.
    Edit,
    /// Generate new content.
    Generate,
    /// Review only (no edits).
    Critique,
}

impl Mode {
    /// Wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Edit => "edit",
            Mode::Generate => "generate",
            Mode::Critique => "critique",
        }
    }
}

/// AI state of one editor.
#[derive(Default)]
pub struct EditorAi {
    /// Runs of this session, oldest first.
    pub runs: Vec<RunState>,
    /// The chat panel above the prompt bar is open.
    pub expanded: bool,
    /// Something is being started (waiting for `startRun`).
    pub starting: bool,
    /// Last error shown in the dock.
    pub error: Option<String>,
    follow: Option<Task<()>>,
}

impl EditorAi {
    /// The newest run.
    pub fn current(&self) -> Option<&RunState> {
        self.runs.last()
    }

    /// A run is working.
    pub fn busy(&self) -> bool {
        self.starting || self.runs.last().is_some_and(|r| r.is_active())
    }
}

/// AI state of every editor (GPUI global).
#[derive(Default)]
pub struct AiState {
    editors: HashMap<EntityId, EditorAi>,
    own_runs: HashSet<String>,
}

impl Global for AiState {}

/// Installs the dock, the panel and the shortcut.
pub fn install(cx: &mut App) {
    cx.set_global(AiState::default());
    dock::install(cx);
    panel::install(cx);
}

/// Read access to an editor's AI state.
pub fn with<R>(editor: &Entity<EditorView>, cx: &App, f: impl FnOnce(&EditorAi) -> R) -> Option<R> {
    cx.try_global::<AiState>()?
        .editors
        .get(&editor.entity_id())
        .map(f)
}

fn update<R>(editor: &Entity<EditorView>, cx: &mut App, f: impl FnOnce(&mut EditorAi) -> R) -> R {
    let id = editor.entity_id();
    let r = cx.update_global::<AiState, _>(|s, _| f(s.editors.entry(id).or_default()));
    editor.update(cx, |_, cx| cx.notify());
    r
}

/// Whether a run was started from this app (its changes undo locally).
pub fn owns_run(run_id: &str, cx: &App) -> bool {
    cx.try_global::<AiState>()
        .is_some_and(|s| s.own_runs.contains(run_id))
}

/// Remote transactions arrived for an editor: layers changed by a running AI run pulse with the sun glow.
pub fn on_remote(editor: &Entity<EditorView>, txs: &[Transaction], cx: &mut App) {
    let Some(state) = cx.try_global::<AiState>() else {
        return;
    };
    let Some(ai) = state.editors.get(&editor.entity_id()) else {
        return;
    };
    let Some(run) = ai.runs.last().filter(|r| r.is_active()) else {
        return;
    };
    let run_id = run.id.clone();
    let mut touched: Vec<String> = Vec::new();
    for tx in txs {
        if tx.actor.as_ref().and_then(|a| a.run_id.as_deref()) == Some(run_id.as_str()) {
            touched.extend(run::tx_targets(tx));
        }
    }
    if touched.is_empty() {
        return;
    }
    update(editor, cx, |ai| {
        if let Some(r) = ai.runs.last_mut() {
            r.touched.extend(touched.iter().cloned());
        }
    });
    editor.update(cx, |e, cx| {
        let live: Vec<String> = touched
            .into_iter()
            .filter(|id| e.session.doc.design.node(id).is_some())
            .collect();
        e.set_activity(live, cx);
    });
}

/// Why the AI cannot run for this editor right now (`None` = it can).
pub fn blocked_reason(editor: &Entity<EditorView>, cx: &App) -> Option<Blocked> {
    if !Account::signed_in(cx) {
        return Some(Blocked::SignedOut);
    }
    if let Some(p) = Account::profile(cx)
        && !p.can("ai.agent")
    {
        return Some(Blocked::Plan);
    }
    match crate::sync::link(editor, cx) {
        None => Some(Blocked::LocalDesign),
        Some(l) if !l.can_edit() => Some(Blocked::ViewOnly),
        Some(_) => None,
    }
}

/// Why the AI is not available.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Blocked {
    /// No account.
    SignedOut,
    /// The plan has no AI.
    Plan,
    /// A local file (upload it to run the server agent).
    LocalDesign,
    /// View-only access.
    ViewOnly,
}

/// Starts a run with `goal` on the editor's cloud design (uploading a local design first when asked).
pub fn start(editor: &Entity<EditorView>, goal: String, mode: Mode, cx: &mut App) {
    let goal = goal.trim().to_string();
    if goal.is_empty() {
        return;
    }
    match blocked_reason(editor, cx) {
        Some(Blocked::SignedOut) => {
            Account::start_sign_in(cx);
            return;
        }
        Some(Blocked::Plan) => {
            let url = format!("{}/settings/billing", Cloud::get(cx).endpoints().app_url);
            notify(
                cx,
                "The design agent is part of Desyn Pro. Opening plans in your browser.".into(),
            );
            cx.open_url(&url);
            return;
        }
        Some(Blocked::ViewOnly) => {
            notify(
                cx,
                "You can view this design but not edit it, so the AI cannot change it.".into(),
            );
            return;
        }
        Some(Blocked::LocalDesign) => {
            update(editor, cx, |ai| {
                ai.starting = true;
                ai.error = None;
                ai.expanded = true;
            });
            let upload = crate::sync::upload_to_cloud(editor, cx);
            let ed = editor.clone();
            cx.spawn(async move |cx| {
                let res = upload.await;
                cx.update(|cx| match res {
                    Ok(_) => {
                        notify(
                            cx,
                            "Uploaded to your Desyn cloud so the AI can work on it.".into(),
                        );
                        update(&ed, cx, |ai| ai.starting = false);
                        start(&ed, goal, mode, cx);
                    }
                    Err(e) => {
                        Account::handle_error(&e, cx);
                        update(&ed, cx, |ai| {
                            ai.starting = false;
                            ai.error =
                                Some(format!("Couldn't upload the design: {}", e.friendly()));
                        });
                    }
                });
            })
            .detach();
            return;
        }
        None => {}
    }
    let Some(design_id) = crate::sync::design_id(editor, cx) else {
        return;
    };
    let (page, selection) = {
        let e = editor.read(cx);
        (e.session.page.clone(), e.session.selection.clone())
    };
    let previous = with(editor, cx, |ai| {
        ai.runs
            .last()
            .filter(|r| !r.id.is_empty())
            .map(|r| r.id.clone())
    })
    .flatten();
    update(editor, cx, |ai| {
        ai.starting = true;
        ai.error = None;
        ai.expanded = true;
        ai.runs.push(RunState::new("", &goal));
    });
    let mut args = json!({
        "designId": design_id,
        "goal": goal,
        "mode": mode.as_str(),
        "pageId": page,
        "selection": selection,
    });
    if let Some(p) = previous {
        args["previousRunId"] = json!(p);
    }
    let call = Cloud::get(cx).mutation(f::AI_START, args);
    let ed = editor.clone();
    cx.spawn(async move |cx| {
        let res = call.await;
        cx.update(|cx| {
            match res.and_then(|v| {
                v.get("runId")
                    .and_then(Json::as_str)
                    .map(str::to_string)
                    .ok_or_else(|| CloudError::server("No run id."))
            }) {
                Ok(run_id) => {
                    cx.update_global::<AiState, _>(|s, _| {
                        s.own_runs.insert(run_id.clone());
                    });
                    update(&ed, cx, |ai| {
                        ai.starting = false;
                        if let Some(r) = ai.runs.last_mut() {
                            r.id = run_id.clone();
                        }
                    });
                    follow(&ed, run_id, cx);
                }
                Err(e) => {
                    Account::handle_error(&e, cx);
                    update(&ed, cx, |ai| {
                        ai.starting = false;
                        ai.runs.pop();
                        ai.error = Some(match e.code.as_str() {
                            "RATE_LIMITED" => {
                                "Too many AI requests right now. Try again in a minute.".into()
                            }
                            "FEATURE_UNAVAILABLE" => {
                                "The design agent is part of Desyn Pro.".into()
                            }
                            "LIMIT_REACHED" => "You've used this month's AI credits.".into(),
                            "EMAIL_NOT_VERIFIED" => {
                                "Verify your email address to use the AI.".into()
                            }
                            "NOT_CONFIGURED" => {
                                "This server has no AI provider set up. Add your own provider key in the web app under Settings → AI, then try again.".into()
                            }
                            _ => e.friendly(),
                        });
                    });
                }
            }
        });
    })
    .detach();
}

/// Follows a run's events until it ends.
fn follow(editor: &Entity<EditorView>, run_id: String, cx: &mut App) {
    let cloud = Cloud::get(cx);
    let ed = editor.downgrade();
    let task = cx.spawn(async move |cx| {
        let mut after: i64 = -1;
        loop {
            let mut live =
                cloud.subscribe(f::AI_EVENTS, json!({ "runId": run_id, "afterSeq": after }));
            let mut ended = false;
            while let Some(r) = live.next().await {
                let Some(ed) = ed.upgrade() else { return };
                let res: Result<RunEvents, CloudError> = r.and_then(api::decode);
                match res {
                    Ok(ev) => {
                        let finished = ev.done;
                        let mut flash: Option<Vec<String>> = None;
                        cx.update(|cx| {
                            update(&ed, cx, |ai| {
                                if let Some(run) = ai.runs.iter_mut().find(|r| r.id == run_id) {
                                    run.fold(&ev.events);
                                    run.update_run(&ev.run.status, ev.run.cost_credits, ev.done);
                                    after = run.last_index;
                                    if finished {
                                        flash = Some(run.touched.iter().cloned().collect());
                                    }
                                }
                            });
                            if let Some(ids) = flash.take() {
                                ed.update(cx, |e, cx| {
                                    e.set_activity(Vec::new(), cx);
                                    let live: Vec<String> = ids
                                        .into_iter()
                                        .filter(|id| e.session.doc.design.node(id).is_some())
                                        .collect();
                                    e.flash(live, cx);
                                });
                            }
                        });
                        if finished {
                            ended = true;
                            break;
                        }
                        // Page through long logs: resubscribe from the newest index now and then.
                        if ev.events.len() >= 150 {
                            break;
                        }
                    }
                    Err(e) => {
                        cx.update(|cx| {
                            Account::handle_error(&e, cx);
                            if !e.is_transient() {
                                update(&ed, cx, |ai| ai.error = Some(e.friendly()));
                            }
                        });
                        if !e.is_transient() {
                            return;
                        }
                        break;
                    }
                }
            }
            if ended {
                return;
            }
            crate::cloud::runtime::sleep(std::time::Duration::from_millis(800)).await;
        }
    });
    update(editor, cx, |ai| ai.follow = Some(task));
}

/// Stops the current run.
pub fn cancel(editor: &Entity<EditorView>, cx: &mut App) {
    let Some(run_id) = with(editor, cx, |ai| ai.current().map(|r| r.id.clone())).flatten() else {
        return;
    };
    if run_id.is_empty() {
        return;
    }
    let f = Cloud::get(cx).mutation(f::AI_CANCEL, json!({ "runId": run_id }));
    cx.spawn(async move |cx| {
        if let Err(e) = f.await {
            cx.update(|cx| notify(cx, format!("Couldn't stop the run: {}", e.friendly())));
        }
    })
    .detach();
}

/// Answers the agent's question.
pub fn answer(editor: &Entity<EditorView>, text: String, cx: &mut App) {
    let Some(run_id) = with(editor, cx, |ai| ai.current().map(|r| r.id.clone())).flatten() else {
        return;
    };
    update(editor, cx, |ai| {
        if let Some(r) = ai.runs.last_mut() {
            r.answered(&text);
        }
    });
    let f = Cloud::get(cx).mutation(f::AI_ANSWER, json!({ "runId": run_id, "answer": text }));
    cx.spawn(async move |cx| {
        if let Err(e) = f.await {
            cx.update(|cx| notify(cx, format!("Couldn't send the answer: {}", e.friendly())));
        }
    })
    .detach();
}

/// Opens / closes the conversation above the prompt bar.
pub fn set_expanded(editor: &Entity<EditorView>, on: bool, cx: &mut App) {
    update(editor, cx, |ai| ai.expanded = on);
}

/// Clears the conversation (a new chat).
pub fn new_chat(editor: &Entity<EditorView>, cx: &mut App) {
    update(editor, cx, |ai| {
        if !ai.busy() {
            ai.runs.clear();
            ai.error = None;
        }
    });
}
