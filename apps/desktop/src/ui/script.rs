//! `DESYN_SCRIPT`: drives the running app through real input paths for smoke tests and screenshots without a
//! keyboard or mouse. Steps are separated by `;` and run one per frame batch:
//!
//! ```text
//! new:<preset-id>            new design from a preset (or new:<w>x<h>)
//! open:<path>                open a file
//! tool:<id>                  select | hand | frame | rect | ellipse | polygon | star | line | arrow | pen | text
//! click:<x>,<y>              left click at canvas-local logical px (dblclick:, rclick: likewise)
//! drag:<x1>,<y1>,<x2>,<y2>[,shift][,alt][,mod]
//! move:<x>,<y>               pointer move (hover)
//! down:<x>,<y> / to:<x>,<y> / up:<x>,<y>   a gesture in steps (screenshots mid-drag)
//! key:<keystroke>            e.g. key:secondary-d, key:escape (dispatched through the keymap)
//! type:<text>                text input through the keymap and the focused input handler (text layers, fields)
//! action:<namespace::Name>   any registered action, e.g. action:editor::ZoomFitAll
//! wait:<ms>                  pause
//! log:<text>                 print a marker to stderr
//! quit
//! ```

use std::time::Duration;

use gpui::{
    AnyWindowHandle, App, AppContext, Keystroke, Modifiers, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, PlatformInput, WindowHandle, point, px,
};

use super::workspace::Workspace;
use crate::deeplink::{LaunchRequest, NewDesign};

/// Starts the script from `DESYN_SCRIPT` (no-op when unset).
pub fn start(window: WindowHandle<Workspace>, cx: &mut App) {
    let Ok(script) = std::env::var("DESYN_SCRIPT") else {
        return;
    };
    let steps: Vec<String> = script
        .split(';')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    cx.spawn(async move |cx| {
        // Let the first frames lay out the window.
        cx.background_executor()
            .timer(Duration::from_millis(600))
            .await;
        for step in steps {
            let (cmd, arg) = step
                .split_once(':')
                .map(|(a, b)| (a.to_string(), b.to_string()))
                .unwrap_or((step.clone(), String::new()));
            if cmd == "wait" {
                let ms = arg.parse().unwrap_or(250);
                cx.background_executor()
                    .timer(Duration::from_millis(ms))
                    .await;
                continue;
            }
            let ok = cx.update(|cx| run_step(window, &cmd, &arg, cx));
            if !ok {
                eprintln!("desyn script: step failed: {step}");
            }
            cx.background_executor()
                .timer(Duration::from_millis(120))
                .await;
        }
    })
    .detach();
}

fn nums(s: &str) -> (Vec<f32>, Modifiers) {
    let mut m = Modifiers::default();
    let mut v = Vec::new();
    for part in s.split(',') {
        match part.trim() {
            "shift" => m.shift = true,
            "alt" => m.alt = true,
            "mod" => {
                if cfg!(target_os = "macos") {
                    m.platform = true
                } else {
                    m.control = true
                }
            }
            n => {
                if let Ok(f) = n.parse() {
                    v.push(f)
                }
            }
        }
    }
    (v, m)
}

fn run_step(window: WindowHandle<Workspace>, cmd: &str, arg: &str, cx: &mut App) -> bool {
    let editor = window.read(cx).ok().and_then(|ws| ws.active_editor());
    let origin = editor
        .as_ref()
        .and_then(|e| e.read(cx).canvas_bounds)
        .map(|b| b.origin)
        .unwrap_or_default();
    let at = |x: f32, y: f32| point(origin.x + px(x), origin.y + px(y));
    let any: AnyWindowHandle = window.into();
    // Events go through the window like real input (never while the workspace entity is borrowed).
    let send = |ev: PlatformInput, cx: &mut App| {
        let _ = cx.update_window(any, |_, window, cx| {
            window.dispatch_event(ev, cx);
        });
    };
    match cmd {
        "log" => {
            eprintln!("desyn script: {arg}");
            true
        }
        "quit" => {
            cx.quit();
            true
        }
        "new" => {
            let req = match arg
                .split_once('x')
                .and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?)))
            {
                Some((w, h)) => NewDesign {
                    width: Some(w),
                    height: Some(h),
                    ..Default::default()
                },
                None => NewDesign {
                    preset: Some(arg.to_string()),
                    ..Default::default()
                },
            };
            window
                .update(cx, |ws, window, cx| {
                    ws.handle_request(LaunchRequest::New(req), window, cx)
                })
                .is_ok()
        }
        "open" => window
            .update(cx, |ws, window, cx| {
                ws.handle_request(LaunchRequest::Open(arg.into()), window, cx)
            })
            .is_ok(),
        "tool" => match (crate::canvas::Tool::from_id(arg), editor) {
            (Some(t), Some(e)) => {
                e.update(cx, |e, cx| {
                    e.session.set_tool(t);
                    e.after(cx);
                });
                true
            }
            _ => false,
        },
        "click" | "dblclick" | "rclick" | "move" => {
            let (v, modifiers) = nums(arg);
            let [x, y] = v[..] else { return false };
            let p = at(x, y);
            send(
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: p,
                    pressed_button: None,
                    modifiers,
                }),
                cx,
            );
            if cmd == "move" {
                return true;
            }
            let button = if cmd == "rclick" {
                MouseButton::Right
            } else {
                MouseButton::Left
            };
            let clicks = if cmd == "dblclick" { 2 } else { 1 };
            for c in 1..=clicks {
                send(
                    PlatformInput::MouseDown(MouseDownEvent {
                        button,
                        position: p,
                        modifiers,
                        click_count: c,
                        first_mouse: false,
                    }),
                    cx,
                );
                send(
                    PlatformInput::MouseUp(MouseUpEvent {
                        button,
                        position: p,
                        modifiers,
                        click_count: c,
                    }),
                    cx,
                );
            }
            true
        }
        "down" | "to" | "up" => {
            let (v, modifiers) = nums(arg);
            let [x, y] = v[..] else { return false };
            let p = at(x, y);
            let ev = match cmd {
                "down" => PlatformInput::MouseDown(MouseDownEvent {
                    button: MouseButton::Left,
                    position: p,
                    modifiers,
                    click_count: 1,
                    first_mouse: false,
                }),
                "to" => PlatformInput::MouseMove(MouseMoveEvent {
                    position: p,
                    pressed_button: Some(MouseButton::Left),
                    modifiers,
                }),
                _ => PlatformInput::MouseUp(MouseUpEvent {
                    button: MouseButton::Left,
                    position: p,
                    modifiers,
                    click_count: 1,
                }),
            };
            send(ev, cx);
            true
        }
        "drag" => {
            let (v, modifiers) = nums(arg);
            let [x1, y1, x2, y2] = v[..] else {
                return false;
            };
            let a = at(x1, y1);
            send(
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: a,
                    pressed_button: None,
                    modifiers,
                }),
                cx,
            );
            send(
                PlatformInput::MouseDown(MouseDownEvent {
                    button: MouseButton::Left,
                    position: a,
                    modifiers,
                    click_count: 1,
                    first_mouse: false,
                }),
                cx,
            );
            for i in 1..=12 {
                let t = i as f32 / 12.0;
                let p = at(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
                send(
                    PlatformInput::MouseMove(MouseMoveEvent {
                        position: p,
                        pressed_button: Some(MouseButton::Left),
                        modifiers,
                    }),
                    cx,
                );
            }
            send(
                PlatformInput::MouseUp(MouseUpEvent {
                    button: MouseButton::Left,
                    position: at(x2, y2),
                    modifiers,
                    click_count: 1,
                }),
                cx,
            );
            true
        }
        "key" => match Keystroke::parse(arg) {
            Ok(k) => cx
                .update_window(any, |_, window, cx| window.dispatch_keystroke(k, cx))
                .is_ok(),
            Err(_) => false,
        },
        "type" => cx
            .update_window(any, |_, window, cx| {
                // Each character goes through the keymap and then the focused input handler, like a real
                // keyboard (text layers, IME path, the palette and other fields).
                for ch in arg.chars() {
                    let key = match ch {
                        ' ' => "space".to_string(),
                        c => c.to_lowercase().to_string(),
                    };
                    let k = Keystroke {
                        modifiers: Modifiers {
                            shift: ch.is_uppercase(),
                            ..Default::default()
                        },
                        key,
                        key_char: Some(ch.to_string()),
                    };
                    window.dispatch_keystroke(k, cx);
                }
            })
            .is_ok(),
        "action" => match cx.build_action(arg, None) {
            Ok(a) => cx
                .update_window(any, |_, window, cx| window.dispatch_action(a, cx))
                .is_ok(),
            Err(_) => false,
        },
        _ => false,
    }
}
