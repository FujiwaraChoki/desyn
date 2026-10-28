//! JSON endpoints over the engine core: `POST /v1/describe`, `/v1/layout`, `/v1/measure`, `/v1/apply`.

use std::collections::{BTreeMap, HashSet};

use desyn_core::layout::{TextMeasureRequest, TextMeasurer, normalize_all};
use desyn_core::model::{
    AssetKind, AssetRef, Design, Id, Op, ParagraphStyle, TextRun, TextStyle, Transaction,
};
use desyn_core::{ApplyOptions, apply_transaction};
use desyn_describe::{BrandKit, DescribeError, DescribeOptions, Detail, PixelSampler, describe};
use desyn_raster::assets::decode_image;
use desyn_text::TextEngine;
use desyn_text::font::{normalize_family, split_family_list};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::{AssetConfig, Limits};
use crate::error::{ApiError, ApiResult};
use crate::fonts::{FontService, register_font_assets};
use crate::net::FetchReport;
use crate::plan::{self, AssetNeeds, Want};
use crate::runtime::Cancel;

/// Longest side of a decoded image kept for contrast sampling (the sampler reads at most 4096 pixels per region).
const SAMPLE_MAX_PIXELS: f64 = 1_000_000.0;

fn engine_with_fonts(
    fonts: &FontService,
    cancel: &Cancel,
    assets: &BTreeMap<Id, AssetRef>,
    report: &FetchReport,
) -> TextEngine {
    let mut engine = fonts.engine(cancel.deadline());
    let failed = register_font_assets(&mut engine, assets, &report.bytes);
    if !failed.is_empty() {
        tracing::warn!(assets = ?failed, "font assets could not be registered");
    }
    engine
}

fn to_json<T: Serialize>(v: &T) -> ApiResult<Vec<u8>> {
    serde_json::to_vec(v).map_err(|e| ApiError::internal(format!("response serialization: {e}")))
}

// ---------------------------------------------------------------------------------------------------------------
// describe

/// `POST /v1/describe` body: the design plus `DescribeOptions` (DOCUMENT_MODEL section 7 and its change log).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DescribeRequest {
    design: Design,
    #[serde(default, alias = "page")]
    page_id: Option<Id>,
    #[serde(default)]
    selection: Option<Vec<Id>>,
    #[serde(default, alias = "depth")]
    max_depth: Option<usize>,
    #[serde(default)]
    include_hidden: Option<bool>,
    #[serde(default)]
    include_styles: Option<bool>,
    #[serde(default)]
    detail: Option<Detail>,
    #[serde(default)]
    max_nodes: Option<usize>,
    #[serde(default)]
    lint: Option<bool>,
    #[serde(default)]
    brand: Option<BrandKit>,
    #[serde(default)]
    asset_urls: Option<BTreeMap<String, String>>,
    /// Additive: decode images on the page for contrast checks of text over photos (default true).
    #[serde(default)]
    sample_images: Option<bool>,
}

/// A validated describe call.
pub struct PreparedDescribe {
    design: Design,
    opts: DescribeOptions,
    /// Assets to fetch.
    pub needs: AssetNeeds,
}

fn describe_error(e: DescribeError) -> ApiError {
    match e {
        DescribeError::PageNotFound(p) => {
            ApiError::bad_request("page_not_found", format!("no such page: {p}"))
        }
        DescribeError::NoPages => {
            ApiError::bad_request("page_not_found", "the design has no pages")
        }
    }
}

/// Validates a describe request.
pub fn prepare_describe(
    req: DescribeRequest,
    limits: &Limits,
    acfg: &AssetConfig,
) -> ApiResult<PreparedDescribe> {
    plan::check_design(&req.design, limits, false)?;
    let opts = DescribeOptions {
        page_id: req.page_id,
        selection: req.selection.unwrap_or_default(),
        max_depth: req.max_depth,
        include_hidden: req.include_hidden,
        include_styles: req.include_styles,
        detail: req.detail.unwrap_or_default(),
        max_nodes: req.max_nodes,
        lint: req.lint,
        brand: req.brand,
    };
    let (page, _) = desyn_describe::resolve_page(&req.design, &opts).map_err(describe_error)?;
    let page_id = page.base.id.clone();
    let urls = req.asset_urls.unwrap_or_default();
    let want = Want {
        images: req.sample_images.unwrap_or(true),
        fonts: true,
        media: false,
    };
    let mut needs = plan::plan(
        &req.design,
        Some(std::slice::from_ref(&page_id)),
        &urls,
        want,
        acfg,
    );
    // SVG pixels are not sampled; only raster images help the contrast checks.
    needs.items.retain(|i| {
        req.design
            .assets
            .get(&i.id)
            .is_none_or(|a| a.kind != AssetKind::Svg)
    });
    Ok(PreparedDescribe {
        design: req.design,
        opts,
        needs,
    })
}

/// Runs describe; returns the `Description` JSON.
pub fn execute_describe(
    p: PreparedDescribe,
    report: FetchReport,
    fonts: &FontService,
    cancel: &Cancel,
) -> ApiResult<Vec<u8>> {
    let mut engine = engine_with_fonts(fonts, cancel, &p.design.assets, &report);
    let mut sampler = PixelSampler::new();
    let mut sampled = 0usize;
    for (id, bytes) in &report.bytes {
        if p.design
            .assets
            .get(id)
            .is_none_or(|a| a.kind != AssetKind::Image)
        {
            continue;
        }
        cancel.check()?;
        let Ok(img) = decode_image(bytes.clone()) else {
            continue;
        };
        let (w, h) = (f64::from(img.width()), f64::from(img.height()));
        let scale = (SAMPLE_MAX_PIXELS / (w * h)).sqrt().min(1.0);
        let (level, _) = img.level_for_scale(scale);
        let mut rgba = level.data().to_vec();
        desyn_raster::assets::demultiply(&mut rgba);
        if sampler.insert(
            id.clone(),
            level.width() as usize,
            level.height() as usize,
            rgba,
        ) {
            sampled += 1;
        }
    }
    cancel.check()?;
    let sampler_ref: Option<&mut dyn desyn_describe::ImageSampler> = if sampled > 0 {
        Some(&mut sampler)
    } else {
        None
    };
    let desc = describe(&p.design, &p.opts, &mut engine, sampler_ref).map_err(describe_error)?;
    to_json(&desc)
}

// ---------------------------------------------------------------------------------------------------------------
// layout

/// `POST /v1/layout` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutRequest {
    design: Design,
    #[serde(default)]
    asset_urls: Option<BTreeMap<String, String>>,
}

/// A validated layout call.
pub struct PreparedLayout {
    design: Design,
    /// Font assets to fetch.
    pub needs: AssetNeeds,
}

/// Validates a layout request.
pub fn prepare_layout(
    req: LayoutRequest,
    limits: &Limits,
    acfg: &AssetConfig,
) -> ApiResult<PreparedLayout> {
    plan::check_design(&req.design, limits, true)?;
    let urls = req.asset_urls.unwrap_or_default();
    let needs = plan::plan(
        &req.design,
        None,
        &urls,
        Want {
            fonts: true,
            ..Want::default()
        },
        acfg,
    );
    Ok(PreparedLayout {
        design: req.design,
        needs,
    })
}

#[derive(Serialize)]
struct LayoutResponse<'a> {
    design: &'a Design,
    /// Additive: ids whose derived geometry changed.
    changed: Vec<&'a str>,
}

/// Recomputes derived geometry (text boxes with real fonts, auto-layout, constraints, groups).
pub fn execute_layout(
    p: PreparedLayout,
    report: FetchReport,
    fonts: &FontService,
    cancel: &Cancel,
) -> ApiResult<Vec<u8>> {
    let mut engine = engine_with_fonts(fonts, cancel, &p.design.assets, &report);
    let mut design = p.design;
    let changes = normalize_all(&mut design, &mut engine);
    cancel.check()?;
    let ids: Vec<Id> = changes.into_iter().map(|c| c.id).collect();
    to_json(&LayoutResponse {
        design: &design,
        changed: ids.iter().map(String::as_str).collect(),
    })
}

// ---------------------------------------------------------------------------------------------------------------
// measure

/// One text to measure.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureItem {
    text: Vec<TextRun>,
    style: TextStyle,
    paragraph: ParagraphStyle,
    #[serde(default)]
    width: Option<f64>,
    /// Additive: line cap (ellipsis truncation).
    #[serde(default)]
    max_lines: Option<u32>,
}

/// `POST /v1/measure` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureRequest {
    items: Vec<MeasureItem>,
    /// Additive: font assets (custom fonts) by id, fetched from `url` / `assetUrls`.
    #[serde(default)]
    assets: Option<BTreeMap<Id, AssetRef>>,
    #[serde(default)]
    asset_urls: Option<BTreeMap<String, String>>,
}

/// A validated measure call.
pub struct PreparedMeasure {
    items: Vec<MeasureItem>,
    assets: BTreeMap<Id, AssetRef>,
    /// Font assets to fetch.
    pub needs: AssetNeeds,
}

/// Validates a measure request.
pub fn prepare_measure(
    req: MeasureRequest,
    limits: &Limits,
    acfg: &AssetConfig,
) -> ApiResult<PreparedMeasure> {
    if req.items.len() > limits.max_measure_items {
        return Err(ApiError::too_large(
            "too_many_items",
            format!(
                "{} items (limit {})",
                req.items.len(),
                limits.max_measure_items
            ),
        ));
    }
    let text_bytes: usize = req
        .items
        .iter()
        .flat_map(|i| &i.text)
        .map(|r| r.text.len())
        .sum();
    if text_bytes > limits.max_measure_text_bytes {
        return Err(ApiError::too_large(
            "too_much_text",
            format!(
                "{text_bytes} bytes of text (limit {})",
                limits.max_measure_text_bytes
            ),
        ));
    }
    for (i, item) in req.items.iter().enumerate() {
        if let Some(w) = item.width
            && !(w.is_finite() && w >= 0.0)
        {
            return Err(ApiError::bad_request(
                "invalid_options",
                format!("items[{i}].width must be a finite number >= 0"),
            ));
        }
    }
    let mut families = HashSet::new();
    for item in &req.items {
        let styles = std::iter::once(item.style.font_family.as_str()).chain(
            item.text
                .iter()
                .filter_map(|r| r.style.as_ref()?.font_family.as_deref()),
        );
        for f in styles {
            for name in split_family_list(f) {
                families.insert(normalize_family(&name));
            }
        }
    }
    let assets = req.assets.unwrap_or_default();
    let urls = req.asset_urls.unwrap_or_default();
    let mut needs = AssetNeeds::default();
    needs.add_fonts(&assets, &families, &urls, acfg);
    Ok(PreparedMeasure {
        items: req.items,
        assets,
        needs,
    })
}

#[derive(Serialize)]
struct Size {
    w: f64,
    h: f64,
    lines: u32,
    /// Additive: first baseline from the top.
    baseline: f64,
}

/// Measures every item with real fonts.
pub fn execute_measure(
    p: PreparedMeasure,
    report: FetchReport,
    fonts: &FontService,
    cancel: &Cancel,
) -> ApiResult<Vec<u8>> {
    let mut engine = engine_with_fonts(fonts, cancel, &p.assets, &report);
    let mut sizes = Vec::with_capacity(p.items.len());
    for (i, item) in p.items.iter().enumerate() {
        if i % 64 == 0 {
            cancel.check()?;
        }
        let m = engine.measure(&TextMeasureRequest {
            runs: &item.text,
            style: &item.style,
            paragraph: &item.paragraph,
            max_width: item.width,
            max_lines: item.max_lines,
        });
        sizes.push(Size {
            w: m.width,
            h: m.height,
            lines: m.lines,
            baseline: m.baseline,
        });
    }
    to_json(&serde_json::json!({ "sizes": sizes }))
}

// ---------------------------------------------------------------------------------------------------------------
// apply

/// `POST /v1/apply` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRequest {
    design: Design,
    tx: Transaction,
    /// Additive: run layout normalization after the ops (default true: "full core semantics including layout").
    #[serde(default)]
    normalize: Option<bool>,
    #[serde(default)]
    asset_urls: Option<BTreeMap<String, String>>,
}

/// A validated apply call.
pub struct PreparedApply {
    design: Design,
    tx: Transaction,
    normalize: bool,
    /// Font assets to fetch.
    pub needs: AssetNeeds,
}

/// Every `fontFamily` string inside a JSON value (fonts named by `update` / `patch` / `styles` ops).
fn json_families(v: &Value, out: &mut HashSet<String>) {
    match v {
        Value::Object(m) => {
            for (k, val) in m {
                if k == "fontFamily"
                    && let Value::String(f) = val
                {
                    for name in split_family_list(f) {
                        out.insert(normalize_family(&name));
                    }
                } else {
                    json_families(val, out);
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|x| json_families(x, out)),
        _ => {}
    }
}

/// Validates an apply request.
pub fn prepare_apply(
    req: ApplyRequest,
    limits: &Limits,
    acfg: &AssetConfig,
) -> ApiResult<PreparedApply> {
    plan::check_design(&req.design, limits, true)?;
    let created: usize = req
        .tx
        .ops
        .iter()
        .map(|op| {
            if let Op::Create(c) = op {
                c.nodes.len()
            } else {
                0
            }
        })
        .sum();
    if req.design.nodes.len() + created > limits.max_nodes {
        return Err(ApiError::too_large(
            "too_many_nodes",
            format!(
                "the transaction would grow the design beyond {} nodes",
                limits.max_nodes
            ),
        ));
    }
    // Fonts the result may need: the design's families plus any the transaction introduces.
    let mut families = plan::families_of(req.design.nodes.values());
    let ops_json =
        serde_json::to_value(&req.tx.ops).map_err(|e| ApiError::internal(format!("ops: {e}")))?;
    json_families(&ops_json, &mut families);
    let mut assets = req.design.assets.clone();
    for op in &req.tx.ops {
        if let Op::Asset(a) = op
            && let Some(set) = &a.set
        {
            assets.extend(set.iter().map(|(k, v)| (k.clone(), v.clone())));
        }
    }
    let urls = req.asset_urls.unwrap_or_default();
    let mut needs = AssetNeeds::default();
    needs.add_fonts(&assets, &families, &urls, acfg);
    Ok(PreparedApply {
        design: req.design,
        tx: req.tx,
        normalize: req.normalize.unwrap_or(true),
        needs,
    })
}

#[derive(Serialize)]
struct ApplyResponse<'a> {
    design: &'a Design,
    inverse: &'a Transaction,
    applied: &'a [Op],
    dropped: &'a [desyn_core::Dropped],
}

/// Applies the transaction with the core semantics (drops, inverse, normalization with real fonts).
pub fn execute_apply(
    p: PreparedApply,
    report: FetchReport,
    fonts: &FontService,
    cancel: &Cancel,
) -> ApiResult<Vec<u8>> {
    let mut all_assets = p.design.assets.clone();
    for op in &p.tx.ops {
        if let Op::Asset(a) = op
            && let Some(set) = &a.set
        {
            all_assets.extend(set.iter().map(|(k, v)| (k.clone(), v.clone())));
        }
    }
    let mut engine = engine_with_fonts(fonts, cancel, &all_assets, &report);
    let mut design = p.design;
    let result = apply_transaction(
        &mut design,
        &p.tx,
        ApplyOptions {
            normalize: p.normalize,
            measurer: Some(&mut engine),
            inverse_id: None,
        },
    );
    cancel.check()?;
    to_json(&ApplyResponse {
        design: &design,
        inverse: &result.inverse,
        applied: &result.applied,
        dropped: &result.dropped,
    })
}
