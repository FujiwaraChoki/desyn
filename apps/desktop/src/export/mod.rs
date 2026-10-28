//! Export dialog (mod+shift+E): every format the shared renderer writes (PNG, JPEG, WebP, SVG, PDF, print PDF with
//! bleed / crop marks / CMYK / flattening, PPTX, animated GIF) rendered locally, plus MP4 video rendered by the Desyn
//! render worker for cloud designs. Choose pages, scale, quality and transparency; files go to a remembered folder.

pub mod run;

use std::collections::BTreeSet;
use std::path::PathBuf;

use desyn_core::model::Id;
use desyn_raster::export::{Format, PdfOptions};
use gpui::{
    App, AppContext, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Subscription, Window,
    div, prelude::FluentBuilder, px,
};
use serde_json::{Value, json};

use crate::auth::Account;
use crate::cloud::api::{ExportStatus, f};
use crate::cloud::{Cloud, CloudError};
use crate::dialogs::{self, Dialog};
use crate::ui::actions;
use crate::ui::app::AppState;
use crate::ui::components::{Variant, button, icon, icon_button, label, t, tip};
use crate::ui::editor::EditorView;
use crate::ui::ext::{CommandSpec, Extensions};
use crate::ui::theme::{MONO, SANS, alpha};
use crate::widgets::number::{Label, NumberEvent, NumberField};
use crate::widgets::{Seg, row, segmented, spinner, toggle};

/// Export formats offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// PNG.
    Png,
    /// JPEG.
    Jpeg,
    /// WebP.
    Webp,
    /// SVG.
    Svg,
    /// PDF (screen).
    Pdf,
    /// PDF for print.
    PdfPrint,
    /// PowerPoint.
    Pptx,
    /// Animated GIF.
    Gif,
    /// MP4 video (cloud render).
    Mp4,
}

impl Kind {
    const ALL: [Kind; 9] = [
        Kind::Png,
        Kind::Jpeg,
        Kind::Webp,
        Kind::Svg,
        Kind::Pdf,
        Kind::PdfPrint,
        Kind::Pptx,
        Kind::Gif,
        Kind::Mp4,
    ];

    fn label(self) -> &'static str {
        match self {
            Kind::Png => "PNG",
            Kind::Jpeg => "JPG",
            Kind::Webp => "WebP",
            Kind::Svg => "SVG",
            Kind::Pdf => "PDF",
            Kind::PdfPrint => "PDF print",
            Kind::Pptx => "PPTX",
            Kind::Gif => "GIF",
            Kind::Mp4 => "MP4",
        }
    }

    fn hint(self) -> &'static str {
        match self {
            Kind::Png => "Sharp images with transparency. Best for most uses.",
            Kind::Jpeg => "Small photos for the web and email.",
            Kind::Webp => "Modern web images, smaller than PNG.",
            Kind::Svg => "Scalable vector graphics for the web and other tools.",
            Kind::Pdf => "Vector document with selectable text, every page in one file.",
            Kind::PdfPrint => "For printers: bleed, crop marks, CMYK colors.",
            Kind::Pptx => "Editable PowerPoint slides.",
            Kind::Gif => "An animated loop of each page with its animations.",
            Kind::Mp4 => "Video with animations and transitions, rendered in the cloud.",
        }
    }

    fn icon(self) -> &'static str {
        match self {
            Kind::Png | Kind::Jpeg | Kind::Webp => "icons/image.svg",
            Kind::Svg => "icons/spline.svg",
            Kind::Pdf | Kind::PdfPrint => "icons/file.svg",
            Kind::Pptx => "icons/presentation.svg",
            Kind::Gif => "icons/film.svg",
            Kind::Mp4 => "icons/play.svg",
        }
    }

    fn format(self) -> Option<Format> {
        Some(match self {
            Kind::Png => Format::Png,
            Kind::Jpeg => Format::Jpeg,
            Kind::Webp => Format::Webp,
            Kind::Svg => Format::Svg,
            Kind::Pdf | Kind::PdfPrint => Format::Pdf,
            Kind::Pptx => Format::Pptx,
            Kind::Gif => Format::Gif,
            Kind::Mp4 => return None,
        })
    }

    fn raster(self) -> bool {
        matches!(
            self,
            Kind::Png | Kind::Jpeg | Kind::Webp | Kind::Gif | Kind::Mp4
        )
    }
}

/// Which pages.
#[derive(Debug, Clone, PartialEq)]
pub enum Pages {
    /// Every page.
    All,
    /// The page on screen.
    Current,
    /// A chosen set.
    Some(BTreeSet<Id>),
}

#[derive(Debug, Clone)]
enum State {
    Idle,
    Working(String),
    Done(Vec<PathBuf>),
    Failed(String),
}

/// Registers the export action, command and top bar button.
pub fn install(cx: &mut App) {
    Extensions::update(cx, |x| {
        x.handle::<actions::Export>(open);
        x.command(CommandSpec {
            id: "export.open".into(),
            title: "Export…".into(),
            group: "File".into(),
            keywords: "download png jpg pdf svg pptx gif mp4 video print".into(),
            run: std::rc::Rc::new(|editor, window, cx| {
                if let Some(e) = editor {
                    open(e, window, cx);
                }
            }),
        });
        x.top_bar(25, |editor, window, cx| {
            let th = t(window, cx);
            let ed = editor.clone();
            icon_button("export-btn", "icons/download.svg", 32.0, false, &th)
                .tooltip(tip(
                    "Export",
                    Some(crate::ui::actions::shortcut_label("secondary-shift-e")),
                ))
                .on_click(move |_, window, cx| open(&ed, window, cx))
                .into_any_element()
        });
    });
}

/// Opens the export dialog.
pub fn open(editor: &Entity<EditorView>, window: &mut Window, cx: &mut App) {
    let ed = editor.clone();
    dialogs::open(editor, window, cx, move |window, cx| Dialog {
        title: ("export your", Some("design")),
        width: 560.0,
        view: cx.new(|cx| ExportDialog::new(ed, window, cx)).into(),
    });
}

fn default_folder(cx: &App) -> PathBuf {
    let saved = cx
        .try_global::<AppState>()
        .and_then(|s| {
            s.settings
                .extensions
                .get("export")
                .and_then(|e| e.get("folder"))
                .and_then(Value::as_str)
                .map(PathBuf::from)
        })
        .filter(|p| p.is_dir());
    if let Some(p) = saved {
        return p;
    }
    // Portable installs (DESYN_HOME) keep everything below their folder.
    if std::env::var_os("DESYN_HOME").is_some() {
        return crate::ui::app::library_dir(cx).join("Exports");
    }
    dirs::download_dir().unwrap_or_else(|| crate::ui::app::library_dir(cx).join("Exports"))
}

/// The dialog.
pub struct ExportDialog {
    editor: Entity<EditorView>,
    kind: Kind,
    pages: Pages,
    scale: f64,
    transparent: bool,
    svg_outlines: bool,
    pdf: PdfOptions,
    quality: Entity<NumberField>,
    fps: Entity<NumberField>,
    folder: PathBuf,
    state: State,
    focus: FocusHandle,
    _subs: Vec<Subscription>,
}

impl Focusable for ExportDialog {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl ExportDialog {
    fn new(
        editor: Entity<EditorView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> ExportDialog {
        let quality = cx.new(|cx| {
            NumberField::new(Label::Text("Q".into()), window, cx)
                .range(1.0, 100.0)
                .precision(0)
                .tooltip("Quality")
        });
        quality.update(cx, |f, cx| f.set_value(Some(90.0), cx));
        let fps = cx.new(|cx| {
            NumberField::new(Label::Text("fps".into()), window, cx)
                .range(1.0, 50.0)
                .precision(0)
                .tooltip("Frames per second")
        });
        fps.update(cx, |f, cx| f.set_value(Some(15.0), cx));
        let subs = vec![
            cx.subscribe(&quality, |_, _, _: &NumberEvent, cx| cx.notify()),
            cx.subscribe(&fps, |_, _, _: &NumberEvent, cx| cx.notify()),
        ];
        let folder = default_folder(cx);
        ExportDialog {
            editor,
            kind: Kind::Png,
            pages: Pages::All,
            scale: 2.0,
            transparent: false,
            svg_outlines: false,
            pdf: PdfOptions::default(),
            quality,
            fps,
            folder,
            state: State::Idle,
            focus: cx.focus_handle(),
            _subs: subs,
        }
    }

    fn chosen_pages(&self, cx: &App) -> Vec<Id> {
        let e = self.editor.read(cx);
        let all = e.session.doc.design.page_ids().to_vec();
        match &self.pages {
            Pages::All => all,
            Pages::Current => vec![e.session.page.clone()],
            Pages::Some(set) => all.into_iter().filter(|p| set.contains(p)).collect(),
        }
    }

    fn change_folder(&mut self, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Export here".into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = rx.await else {
                return;
            };
            let Some(dir) = paths.into_iter().next() else {
                return;
            };
            let _ = this.update(cx, |this, cx| {
                this.folder = dir.clone();
                AppState::update(cx, |s| {
                    let e = s
                        .settings
                        .extensions
                        .entry("export".to_string())
                        .or_insert_with(|| json!({}));
                    e["folder"] = json!(dir.display().to_string());
                    s.save_settings();
                });
                cx.notify();
            });
        })
        .detach();
    }

    fn start(&mut self, cx: &mut Context<Self>) {
        if matches!(self.state, State::Working(_)) {
            return;
        }
        let pages = self.chosen_pages(cx);
        if pages.is_empty() {
            self.state = State::Failed("Choose at least one page.".into());
            cx.notify();
            return;
        }
        if self.kind == Kind::Mp4 {
            self.start_cloud(pages, cx);
            return;
        }
        let Some(format) = self.kind.format() else {
            return;
        };
        let quality = self
            .quality
            .read(cx)
            .value()
            .unwrap_or(90.0)
            .round()
            .clamp(1.0, 100.0) as u8;
        let fps = self.fps.read(cx).value().unwrap_or(15.0).clamp(1.0, 50.0);
        let settings = run::Settings {
            format,
            pages,
            scale: if self.kind.raster() { self.scale } else { 1.0 },
            quality,
            transparent: self.transparent
                && matches!(self.kind, Kind::Png | Kind::Webp | Kind::Svg),
            pdf: if self.kind == Kind::PdfPrint {
                self.pdf.clone()
            } else {
                PdfOptions::default()
            },
            svg_outlines: self.svg_outlines,
            fps,
        };
        let (design, assets, name) = {
            let e = self.editor.read(cx);
            (
                e.session.doc.design.clone(),
                e.session.doc.assets.clone(),
                e.name(),
            )
        };
        let fonts: Vec<std::sync::Arc<Vec<u8>>> = cx
            .try_global::<crate::widgets::fonts::FontLibrary>()
            .map(|l| {
                l.loaded
                    .values()
                    .flat_map(|(_, f)| f.iter().cloned())
                    .collect()
            })
            .unwrap_or_default();
        let folder = self.folder.clone();
        self.state = State::Working(format!("Rendering {}…", self.kind.label()));
        cx.notify();
        let task = cx.background_spawn(async move {
            let outs = run::render(&design, &assets, &fonts, &name, &settings)?;
            run::write(outs, &folder, false)
        });
        cx.spawn(async move |this, cx| {
            let res = task.await;
            let _ = this.update(cx, |this, cx| {
                this.state = match res {
                    Ok(paths) => State::Done(paths),
                    Err(e) => State::Failed(e),
                };
                cx.notify();
            });
        })
        .detach();
    }

    fn start_cloud(&mut self, pages: Vec<Id>, cx: &mut Context<Self>) {
        let Some(design_id) = crate::sync::design_id(&self.editor, cx) else {
            self.state = State::Failed(
                "Video renders in the cloud: upload this design first (Share › Upload).".into(),
            );
            cx.notify();
            return;
        };
        let cloud = Cloud::get(cx);
        let all = self.editor.read(cx).session.doc.design.page_ids().len();
        let pages_arg = if pages.len() == all {
            json!("all")
        } else {
            json!(pages)
        };
        let req = cloud.mutation(f::EXPORT_REQUEST, json!({ "designId": design_id, "format": "mp4", "pages": pages_arg, "scale": self.scale.min(2.0) }));
        let folder = self.folder.clone();
        self.state = State::Working("Queued for rendering…".into());
        cx.notify();
        cx.spawn(async move |this, cx| {
            let id = match req.await.and_then(|v| {
                v.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| CloudError::server("No export id."))
            }) {
                Ok(id) => id,
                Err(e) => {
                    let _ = this.update(cx, |this, cx| {
                        Account::handle_error(&e, cx);
                        this.state = State::Failed(e.friendly());
                        cx.notify();
                    });
                    return;
                }
            };
            let mut live = cloud.subscribe(f::EXPORT_STATUS, json!({ "exportId": id }));
            while let Some(r) = live.next().await {
                let st: ExportStatus = match r.and_then(crate::cloud::api::decode) {
                    Ok(s) => s,
                    Err(e) if e.is_transient() => continue,
                    Err(e) => {
                        let _ = this.update(cx, |this, cx| {
                            this.state = State::Failed(e.friendly());
                            cx.notify();
                        });
                        return;
                    }
                };
                match st.status.as_str() {
                    "queued" | "rendering" => {
                        let label = if st.status == "queued" {
                            "Queued for rendering…"
                        } else {
                            "Rendering video in the cloud…"
                        };
                        let _ = this.update(cx, |this, cx| {
                            this.state = State::Working(label.into());
                            cx.notify();
                        });
                    }
                    "ready" => {
                        let mut written = Vec::new();
                        for file in st.files {
                            let Some(url) = file.url else { continue };
                            match cloud.fetch_bytes(&url, 1024 * 1024 * 1024).await {
                                Ok((bytes, _)) => {
                                    let name = file.file_name.clone();
                                    let res = run::write(vec![(name, bytes)], &folder, false);
                                    if let Ok(mut p) = res {
                                        written.append(&mut p);
                                    }
                                }
                                Err(e) => {
                                    let _ = this.update(cx, |this, cx| {
                                        this.state = State::Failed(format!(
                                            "Download failed: {}",
                                            e.friendly()
                                        ));
                                        cx.notify();
                                    });
                                    return;
                                }
                            }
                        }
                        let _ = this.update(cx, |this, cx| {
                            this.state = State::Done(written);
                            cx.notify();
                        });
                        return;
                    }
                    _ => {
                        let msg = st.error.unwrap_or_else(|| "The render failed.".into());
                        let _ = this.update(cx, |this, cx| {
                            this.state = State::Failed(msg);
                            cx.notify();
                        });
                        return;
                    }
                }
            }
        })
        .detach();
    }
}

impl Render for ExportDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let th = t(window, cx);
        let (pages_all, current, design) = {
            let e = self.editor.read(cx);
            (
                e.session.doc.design.page_ids().to_vec(),
                e.session.page.clone(),
                e.session.doc.design.clone(),
            )
        };
        let cloud_design = crate::sync::design_id(&self.editor, cx).is_some();
        let mut grid = div().flex().flex_wrap().gap(px(8.0));
        for k in Kind::ALL {
            let active = self.kind == k;
            let disabled = k == Kind::Mp4 && !cloud_design;
            let s3 = th.surface3;
            grid = grid.child(
                div()
                    .id(SharedString::from(format!("fmt-{}", k.label())))
                    .w(px(95.0))
                    .h(px(58.0))
                    .px(px(12.0))
                    .flex()
                    .flex_col()
                    .justify_center()
                    .gap(px(3.0))
                    .rounded(px(10.0))
                    .border_1()
                    .border_color(if active { th.accent } else { th.border_subtle })
                    .when(active, |d| d.bg(th.accent_soft))
                    .when(!active && !disabled, move |d| d.hover(move |s| s.bg(s3)))
                    .when(disabled, |d| d.opacity(0.45))
                    .cursor_pointer()
                    .tooltip(tip(
                        if disabled {
                            "Video renders in the cloud: upload this design to export MP4."
                        } else {
                            k.hint()
                        },
                        None,
                    ))
                    .child(icon(
                        k.icon(),
                        15.0,
                        if active { th.accent_text } else { th.muted },
                    ))
                    .child(
                        div()
                            .font_family(SANS)
                            .text_size(px(12.5))
                            .font_weight(gpui::FontWeight(550.0))
                            .text_color(th.fg)
                            .child(k.label()),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !disabled {
                            this.kind = k;
                            this.state = State::Idle;
                            cx.notify();
                        }
                    })),
            );
        }
        let me = cx.entity().downgrade();
        let page_mode = match &self.pages {
            Pages::All => 0,
            Pages::Current => 1,
            Pages::Some(_) => 2,
        };
        let pages_seg = segmented(
            "export-pages",
            vec![
                (0, Seg::Text(format!("All {}", pages_all.len()).into())),
                (1, Seg::Text("This page".into())),
                (2, Seg::Text("Choose…".into())),
            ],
            Some(&page_mode),
            &th,
            {
                let cur = current.clone();
                move |m, _, cx| {
                    let cur = cur.clone();
                    let _ = me.update(cx, |this, cx| {
                        this.pages = match m {
                            0 => Pages::All,
                            1 => Pages::Current,
                            _ => Pages::Some(std::iter::once(cur).collect()),
                        };
                        cx.notify();
                    });
                }
            },
        );
        let chooser = match &self.pages {
            Pages::Some(set) => Some(div().flex().flex_wrap().gap(px(6.0)).children(
                pages_all.iter().enumerate().map(|(i, p)| {
                    let on = set.contains(p);
                    let p2 = p.clone();
                    div()
                        .id(("export-page", i))
                        .w(px(36.0))
                        .h(px(30.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(7.0))
                        .border_1()
                        .border_color(if on { th.accent } else { th.border_subtle })
                        .when(on, |d| d.bg(th.accent_soft))
                        .cursor_pointer()
                        .font_family(MONO)
                        .text_size(px(11.5))
                        .text_color(if on { th.accent_text } else { th.muted })
                        .child(format!("{}", i + 1))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Pages::Some(s) = &mut this.pages
                                && !s.remove(&p2)
                            {
                                s.insert(p2.clone());
                            }
                            cx.notify();
                        }))
                }),
            )),
            _ => None,
        };
        let mut options = div().flex().flex_col().gap(px(10.0));
        if self.kind.raster() {
            let me = cx.entity().downgrade();
            let first = self
                .chosen_pages(cx)
                .first()
                .cloned()
                .unwrap_or(current.clone());
            let size = run::pixel_size(&design, &first, self.scale)
                .map(|(w, h)| format!("{w} × {h} px"))
                .unwrap_or_default();
            options = options.child(row(
                "Size",
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .child(
                        segmented(
                            "export-scale",
                            [0.5f64, 1.0, 2.0, 3.0, 4.0]
                                .iter()
                                .map(|s| {
                                    (
                                        (s * 10.0) as i64,
                                        Seg::Text(
                                            format!("{}×", crate::widgets::number::format(*s, 1))
                                                .into(),
                                        ),
                                    )
                                })
                                .collect(),
                            Some(&((self.scale * 10.0) as i64)),
                            &th,
                            move |v, _, cx| {
                                let _ = me.update(cx, |this, cx| {
                                    this.scale = v as f64 / 10.0;
                                    cx.notify();
                                });
                            },
                        )
                        .w(px(250.0)),
                    )
                    .child(
                        div()
                            .font_family(MONO)
                            .text_size(px(11.0))
                            .text_color(th.faint)
                            .child(size),
                    ),
                &th,
            ));
        }
        if matches!(self.kind, Kind::Jpeg | Kind::Webp) {
            options = options.child(row(
                "Quality",
                div().w(px(110.0)).child(self.quality.clone()),
                &th,
            ));
        }
        if matches!(self.kind, Kind::Png | Kind::Webp | Kind::Svg) {
            let me = cx.entity().downgrade();
            options = options.child(row(
                "Transparent",
                toggle(
                    "export-transparent",
                    self.transparent,
                    &th,
                    move |v, _, cx| {
                        let _ = me.update(cx, |this, cx| {
                            this.transparent = v;
                            cx.notify();
                        });
                    },
                ),
                &th,
            ));
        }
        if self.kind == Kind::Svg {
            let me = cx.entity().downgrade();
            options = options.child(row(
                "Text as paths",
                toggle(
                    "export-outlines",
                    self.svg_outlines,
                    &th,
                    move |v, _, cx| {
                        let _ = me.update(cx, |this, cx| {
                            this.svg_outlines = v;
                            cx.notify();
                        });
                    },
                ),
                &th,
            ));
        }
        if self.kind == Kind::Gif {
            options = options.child(row(
                "Frame rate",
                div().w(px(110.0)).child(self.fps.clone()),
                &th,
            ));
        }
        if self.kind == Kind::PdfPrint {
            for (key, title) in [
                ("bleed", "Include bleed"),
                ("crop", "Crop marks"),
                ("cmyk", "CMYK colors"),
                ("flatten", "Flatten pages"),
            ] {
                let on = match key {
                    "bleed" => self.pdf.bleed,
                    "crop" => self.pdf.crop_marks,
                    "cmyk" => self.pdf.cmyk,
                    _ => self.pdf.flatten,
                };
                let me = cx.entity().downgrade();
                options = options.child(row(
                    title,
                    toggle(&format!("pdf-{key}"), on, &th, move |v, _, cx| {
                        let _ = me.update(cx, |this, cx| {
                            match key {
                                "bleed" => this.pdf.bleed = v,
                                "crop" => this.pdf.crop_marks = v,
                                "cmyk" => this.pdf.cmyk = v,
                                _ => this.pdf.flatten = v,
                            }
                            cx.notify();
                        });
                    }),
                    &th,
                ));
            }
            let bleed = design
                .node(&current)
                .and_then(|n| serde_json::to_value(n).ok())
                .and_then(|v| v.get("bleed").and_then(Value::as_f64))
                .unwrap_or(0.0);
            if bleed <= 0.0 {
                options = options.child(div().font_family(SANS).text_size(px(11.5)).text_color(th.faint).child("This page has no bleed set. Add one in the inspector (Design › Print) when backgrounds run to the edge."));
            }
        }
        let status: gpui::AnyElement = match &self.state {
            State::Idle => div().into_any_element(),
            State::Working(s) => div()
                .flex()
                .items_center()
                .gap(px(10.0))
                .child(spinner("export-working", 10.0, &th))
                .child(
                    div()
                        .font_family(SANS)
                        .text_size(px(12.5))
                        .text_color(th.muted)
                        .child(s.clone()),
                )
                .into_any_element(),
            State::Done(paths) => {
                let first = paths.first().cloned();
                div()
                    .p(px(12.0))
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .rounded(px(10.0))
                    .bg(alpha(th.success, 0.1))
                    .border_1()
                    .border_color(alpha(th.success, 0.3))
                    .child(icon("icons/circle-check-big.svg", 15.0, th.success))
                    .child(
                        div()
                            .flex_1()
                            .font_family(SANS)
                            .text_size(px(12.5))
                            .text_color(th.fg)
                            .child(if paths.len() == 1 {
                                format!(
                                    "Saved {}",
                                    paths[0]
                                        .file_name()
                                        .map(|n| n.to_string_lossy().into_owned())
                                        .unwrap_or_default()
                                )
                            } else {
                                format!("Saved {} files", paths.len())
                            }),
                    )
                    .children(first.map(|p| {
                        button("export-reveal", "Show in folder", Variant::Secondary, &th)
                            .on_click(move |_, _, cx| cx.reveal_path(&p))
                    }))
                    .into_any_element()
            }
            State::Failed(e) => div()
                .flex()
                .gap(px(8.0))
                .child(icon("icons/circle-alert.svg", 14.0, th.danger))
                .child(
                    div()
                        .flex_1()
                        .font_family(SANS)
                        .text_size(px(12.5))
                        .text_color(th.danger)
                        .child(e.clone()),
                )
                .into_any_element(),
        };
        let working = matches!(self.state, State::Working(_));
        div()
            .track_focus(&self.focus)
            .flex()
            .flex_col()
            .gap(px(16.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(label("Format", &th))
                    .child(grid)
                    .child(
                        div()
                            .font_family(SANS)
                            .text_size(px(12.0))
                            .text_color(th.muted)
                            .child(self.kind.hint()),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(label("Pages", &th))
                    .child(pages_seg)
                    .children(chooser),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(label("Options", &th))
                    .child(options),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(icon("icons/folder.svg", 13.0, th.faint))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.0))
                            .truncate()
                            .font_family(MONO)
                            .text_size(px(11.0))
                            .text_color(th.faint)
                            .child(self.folder.display().to_string()),
                    )
                    .child(
                        button("export-folder", "Change…", Variant::Ghost, &th)
                            .on_click(cx.listener(|this, _, _, cx| this.change_folder(cx))),
                    ),
            )
            .child(status)
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.0))
                    .child(
                        button("export-cancel", "Close", Variant::Ghost, &th).on_click(
                            cx.listener(|this, _, _, cx| dialogs::close(&this.editor, cx)),
                        ),
                    )
                    .child(
                        button(
                            "export-go",
                            if working { "Exporting…" } else { "Export" },
                            Variant::Primary,
                            &th,
                        )
                        .w(px(140.0))
                        .child(icon("icons/download.svg", 14.0, th.accent_ink))
                        .when(!working, |b| {
                            b.on_click(cx.listener(|this, _, _, cx| this.start(cx)))
                        }),
                    ),
            )
    }
}
