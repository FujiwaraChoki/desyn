//! Typed views of the Convex functions the desktop uses (names exact, see `convex/`). Deserialization is
//! lenient (`default` everywhere) so a server that adds fields never breaks an older app.

use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};

use super::value::CloudError;

/// Function references (`"<folder>/<module>:<export>"`).
pub mod f {
    /// `accounts.profiles.me`
    pub const ME: &str = "accounts/profiles:me";
    /// `accounts.profiles.ensure`
    pub const ENSURE_PROFILE: &str = "accounts/profiles:ensure";
    /// `accounts.workspaces.list`
    pub const WORKSPACES: &str = "accounts/workspaces:list";
    /// `designs.designs.list`
    pub const DESIGNS_LIST: &str = "designs/designs:list";
    /// `designs.designs.get`
    pub const DESIGNS_GET: &str = "designs/designs:get";
    /// `designs.designs.create`
    pub const DESIGNS_CREATE: &str = "designs/designs:create";
    /// `designs.designs.load`
    pub const DESIGNS_LOAD: &str = "designs/designs:load";
    /// `designs.designs.commit`
    pub const DESIGNS_COMMIT: &str = "designs/designs:commit";
    /// `designs.designs.importDesign`
    pub const DESIGNS_IMPORT: &str = "designs/designs:importDesign";
    /// `designs.designs.setShare`
    pub const SET_SHARE: &str = "designs/designs:setShare";
    /// `designs.designs.listShares`
    pub const LIST_SHARES: &str = "designs/designs:listShares";
    /// `designs.designs.revokeShare`
    pub const REVOKE_SHARE: &str = "designs/designs:revokeShare";
    /// `designs.designOps.since`
    pub const SINCE: &str = "designs/designOps:since";
    /// `designs.versions.create`
    pub const VERSIONS_CREATE: &str = "designs/versions:create";
    /// `designs.versions.list`
    pub const VERSIONS_LIST: &str = "designs/versions:list";
    /// `designs.versions.restore` (action)
    pub const VERSIONS_RESTORE: &str = "designs/versions:restore";
    /// `designs.versions.rename`
    pub const VERSIONS_RENAME: &str = "designs/versions:rename";
    /// `designs.versions.remove`
    pub const VERSIONS_REMOVE: &str = "designs/versions:remove";
    /// `assets.assets.requestUpload`
    pub const ASSET_REQUEST_UPLOAD: &str = "assets/assets:requestUpload";
    /// `assets.assets.finalize` (action)
    pub const ASSET_FINALIZE: &str = "assets/assets:finalize";
    /// `assets.assets.get`
    pub const ASSET_GET: &str = "assets/assets:get";
    /// `assets.assets.designUrls`
    pub const ASSET_DESIGN_URLS: &str = "assets/assets:designUrls";
    /// `assets.assets.list`
    pub const ASSET_LIST: &str = "assets/assets:list";
    /// `assets.assets.delete`
    pub const ASSET_DELETE: &str = "assets/assets:delete";
    /// `templates.templates.search`
    pub const TEMPLATES_SEARCH: &str = "templates/templates:search";
    /// `templates.templates.list`
    pub const TEMPLATES_LIST: &str = "templates/templates:list";
    /// `templates.templates.categories`
    pub const TEMPLATES_CATEGORIES: &str = "templates/templates:categories";
    /// `templates.templates.getDesign`
    pub const TEMPLATES_DESIGN: &str = "templates/templates:getDesign";
    /// `brand.brandKits.list`
    pub const BRAND_LIST: &str = "brand/brandKits:list";
    /// `collab.comments.list`
    pub const COMMENTS_LIST: &str = "collab/comments:list";
    /// `collab.comments.create`
    pub const COMMENTS_CREATE: &str = "collab/comments:create";
    /// `collab.comments.reply`
    pub const COMMENTS_REPLY: &str = "collab/comments:reply";
    /// `collab.comments.resolve`
    pub const COMMENTS_RESOLVE: &str = "collab/comments:resolve";
    /// `collab.comments.delete`
    pub const COMMENTS_DELETE: &str = "collab/comments:delete";
    /// `collab.presence.heartbeat`
    pub const PRESENCE_HEARTBEAT: &str = "collab/presence:heartbeat";
    /// `collab.presence.leave`
    pub const PRESENCE_LEAVE: &str = "collab/presence:leave";
    /// `collab.presence.list`
    pub const PRESENCE_LIST: &str = "collab/presence:list";
    /// `exports.exports.request`
    pub const EXPORT_REQUEST: &str = "exports/exports:request";
    /// `exports.exports.status`
    pub const EXPORT_STATUS: &str = "exports/exports:status";
    /// `ai.agent.startRun`
    pub const AI_START: &str = "ai/agent:startRun";
    /// `ai.agent.cancelRun`
    pub const AI_CANCEL: &str = "ai/agent:cancelRun";
    /// `ai.agent.answer`
    pub const AI_ANSWER: &str = "ai/agent:answer";
    /// `ai.agent.runEvents`
    pub const AI_EVENTS: &str = "ai/agent:runEvents";
    /// `ai.agent.listRuns`
    pub const AI_RUNS: &str = "ai/agent:listRuns";
    /// `stock.photos.search` (action)
    pub const STOCK_SEARCH: &str = "stock/photos:search";
    /// `stock.photos.track` (action)
    pub const STOCK_TRACK: &str = "stock/photos:track";
}

/// Decodes a JSON result into `T`.
pub fn decode<T: for<'de> Deserialize<'de>>(v: Json) -> Result<T, CloudError> {
    serde_json::from_value(v).map_err(|e| CloudError::server(format!("unexpected response: {e}")))
}

/// Pagination arguments.
pub fn page(n: u32, cursor: Option<&str>) -> Json {
    json!({ "numItems": n, "cursor": cursor })
}

/// A paginated result.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Page<T> {
    /// Items.
    pub page: Vec<T>,
    /// Cursor for the next page.
    pub continue_cursor: Option<String>,
    /// No more pages.
    pub is_done: bool,
}

/// `accounts.profiles.me` (the fields the desktop shows).
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Profile {
    /// User id.
    pub user_id: String,
    /// Email.
    pub email: String,
    /// Display name.
    pub name: String,
    /// Avatar URL.
    pub image: Option<String>,
    /// Email verified.
    pub email_verified: bool,
    /// Edition ("hosted" / "selfhost").
    pub edition: String,
    /// Plan id.
    pub plan: String,
    /// Plan name.
    pub plan_name: String,
    /// Plan + flag features.
    pub features: serde_json::Map<String, Json>,
    /// Default workspace.
    pub default_workspace_id: Option<String>,
    /// Profile and personal workspace exist.
    pub provisioned: bool,
}

impl Profile {
    /// Whether a plan feature is on.
    pub fn can(&self, feature: &str) -> bool {
        self.features
            .get(feature)
            .and_then(Json::as_bool)
            .unwrap_or_else(|| desyn_core::plans::can(&self.plan, feature))
    }

    /// Initials for the avatar.
    pub fn initials(&self) -> String {
        let src = if self.name.trim().is_empty() {
            self.email.as_str()
        } else {
            self.name.as_str()
        };
        let mut out: String = src
            .split_whitespace()
            .filter_map(|w| w.chars().next())
            .take(2)
            .collect();
        if out.is_empty() {
            out.push('?');
        }
        out.to_uppercase()
    }
}

/// `accounts.workspaces.list` item.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Workspace {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// "personal" | "team".
    pub kind: String,
    /// The caller's role.
    pub role: String,
    /// Default workspace.
    pub is_default: bool,
}

/// `DesignSummary`.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DesignSummary {
    /// Convex id.
    pub id: String,
    /// `Design.id`.
    pub key: String,
    /// Name.
    pub name: String,
    /// Kind.
    pub kind: String,
    /// Workspace.
    pub workspace_id: String,
    /// Pages.
    pub page_count: u32,
    /// First page width.
    pub width: f64,
    /// First page height.
    pub height: f64,
    /// Thumbnail URL.
    pub thumbnail_url: Option<String>,
    /// "view" | "comment" | "edit" | "manage".
    pub permission: String,
    /// Last change (ms).
    pub updated_at: f64,
    /// active | archived | trashed | creating.
    pub state: String,
}

/// Header of the first `designs.load` page.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LoadHeader {
    /// Convex id.
    pub design_id: String,
    /// `Design.id`.
    pub key: String,
    /// Name.
    pub name: String,
    /// Kind.
    pub kind: String,
    /// Workspace.
    pub workspace_id: String,
    /// JSON of `Design.assets`.
    pub assets: String,
    /// JSON of `Design.styles`.
    pub styles: String,
    /// JSON of `Design.meta`.
    pub meta: String,
    /// Brand kit.
    pub brand_kit_id: Option<String>,
    /// Caller's permission.
    pub permission: String,
}

/// One `designs.load` page.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LoadPage {
    /// Header (first page only).
    pub header: Option<LoadHeader>,
    /// Server seq when read.
    pub seq: u64,
    /// Node JSON strings.
    pub nodes: Vec<String>,
    /// Next cursor.
    pub cursor: Option<String>,
    /// Last page.
    pub is_done: bool,
}

/// A `designOps.since` entry.
#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct OpEntry {
    /// Seq.
    pub seq: u64,
    /// Transaction id.
    pub tx_id: String,
    /// JSON of the accepted transaction (`ops` = server-applied ops).
    pub tx: String,
    /// Actor.
    pub actor: Option<String>,
    /// Source.
    pub source: String,
    /// Time (ms).
    pub ts: f64,
}

/// `designOps.since` result.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Since {
    /// Entries (oldest first, at most 200).
    pub ops: Vec<OpEntry>,
    /// More entries follow.
    pub has_more: bool,
    /// Entries were compacted away: reload.
    pub gap: bool,
    /// Newest seq known to the server.
    pub latest_seq: u64,
}

/// `designs.commit` result.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CommitResult {
    /// Assigned seq.
    pub seq: u64,
    /// JSON of the applied ops.
    pub applied: String,
    /// Dropped ops.
    pub dropped: Vec<Json>,
    /// Already committed earlier (idempotent replay).
    pub duplicate: bool,
}

/// `TemplateView`.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TemplateView {
    /// Id.
    pub id: String,
    /// Slug.
    pub slug: String,
    /// Title.
    pub title: String,
    /// Kind.
    pub kind: String,
    /// Category.
    pub category: String,
    /// Premium.
    pub premium: bool,
    /// Pages.
    pub page_count: u32,
    /// Width.
    pub width: f64,
    /// Height.
    pub height: f64,
    /// Thumbnails.
    pub thumbnails: Vec<Thumb>,
}

/// A thumbnail.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Thumb {
    /// URL.
    pub url: String,
    /// Width.
    pub width: f64,
    /// Height.
    pub height: f64,
}

impl TemplateView {
    /// The smallest thumbnail at least `min_w` wide (or the largest).
    pub fn thumb(&self, min_w: f64) -> Option<&Thumb> {
        let mut t: Vec<&Thumb> = self
            .thumbnails
            .iter()
            .filter(|t| !t.url.is_empty())
            .collect();
        t.sort_by(|a, b| a.width.total_cmp(&b.width));
        t.iter()
            .find(|t| t.width >= min_w)
            .copied()
            .or(t.last().copied())
    }
}

/// A brand kit color.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BrandColor {
    /// Name.
    pub name: String,
    /// `#rrggbb`.
    pub value: String,
    /// Role ("primary", ...).
    pub role: Option<String>,
}

/// A brand kit logo.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BrandLogo {
    /// Asset id.
    pub asset_id: String,
    /// Name.
    pub name: String,
    /// Variant.
    pub variant: String,
    /// Design asset ref id.
    pub ref_id: Option<String>,
    /// MIME.
    pub mime: Option<String>,
    /// Width.
    pub width: Option<f64>,
    /// Height.
    pub height: Option<f64>,
    /// Signed URL.
    pub url: Option<String>,
}

/// A brand kit font slot.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BrandFont {
    /// Family.
    pub family: String,
    /// Weight.
    pub weight: Option<f64>,
    /// Style.
    pub style: Option<String>,
}

/// Brand kit fonts.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BrandFonts {
    /// Headings.
    pub heading: Option<BrandFont>,
    /// Body.
    pub body: Option<BrandFont>,
    /// Accent.
    pub accent: Option<BrandFont>,
}

/// `brandKits` view.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BrandKit {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Logos.
    pub logos: Vec<BrandLogo>,
    /// Colors.
    pub colors: Vec<BrandColor>,
    /// Fonts.
    pub fonts: BrandFonts,
    /// Default kit.
    pub is_default: bool,
}

/// An uploaded asset (`assets.assets.list`).
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AssetView {
    /// Convex id.
    pub id: String,
    /// Ref id for designs.
    pub ref_id: String,
    /// Kind.
    pub kind: String,
    /// Name.
    pub name: String,
    /// MIME.
    pub mime: String,
    /// Bytes.
    pub bytes: f64,
    /// Width.
    pub width: Option<f64>,
    /// Height.
    pub height: Option<f64>,
    /// sha256.
    pub hash: Option<String>,
    /// Status.
    pub status: String,
    /// Storage key.
    pub storage_key: String,
    /// Signed URL.
    pub url: Option<String>,
}

/// A person (comments, presence).
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Person {
    /// User id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Avatar URL.
    pub image: Option<String>,
}

/// A comment.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Comment {
    /// Id.
    pub id: String,
    /// Body.
    pub body: String,
    /// Deleted (tombstone).
    pub deleted: bool,
    /// Author.
    pub author: Person,
    /// Created (ms).
    pub created_at: f64,
}

/// A comment thread (`comments.list`).
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Thread {
    /// Root comment id (thread id).
    pub id: String,
    /// Body.
    pub body: String,
    /// Deleted root.
    pub deleted: bool,
    /// Author.
    pub author: Person,
    /// Created (ms).
    pub created_at: f64,
    /// Anchored node.
    pub node_id: Option<String>,
    /// Page.
    pub page_id: Option<String>,
    /// Resolved.
    pub resolved: bool,
    /// Replies.
    pub replies: Vec<Comment>,
}

/// A named version.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Version {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Seq.
    pub seq: f64,
    /// pending | ready | failed.
    pub status: String,
    /// Automatic snapshot.
    pub auto: bool,
    /// Pages.
    pub page_count: f64,
    /// Author name.
    pub created_by_name: Option<String>,
    /// Created (ms).
    pub created_at: f64,
    /// Error.
    pub error: Option<String>,
}

/// A share link.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ShareLink {
    /// Id.
    pub id: String,
    /// Token.
    pub token: String,
    /// URL.
    pub url: String,
    /// view | comment | edit.
    pub permission: String,
    /// Password protected.
    pub has_password: bool,
    /// Expiry (ms).
    pub expires_at: Option<f64>,
    /// Expired.
    pub expired: bool,
}

/// A collaborator (`presence.list`).
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Presence {
    /// Session id.
    pub session_id: String,
    /// User id.
    pub user_id: String,
    /// Name.
    pub name: String,
    /// Avatar URL.
    pub image: Option<String>,
    /// `#rrggbb`.
    pub color: String,
    /// Selected node ids.
    pub selection: Vec<String>,
    /// Editing marker.
    pub editing: Option<Json>,
}

/// An export file.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportFile {
    /// Page id.
    pub page_id: Option<String>,
    /// File name.
    pub file_name: String,
    /// MIME.
    pub content_type: String,
    /// Size.
    pub bytes: f64,
    /// Signed download URL.
    pub url: Option<String>,
}

/// `exports.status`.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportStatus {
    /// Id.
    pub id: String,
    /// queued | rendering | ready | failed | expired.
    pub status: String,
    /// Files.
    pub files: Vec<ExportFile>,
    /// Error.
    pub error: Option<String>,
}

/// An AI run (`ai.agent.getRun` / `runEvents.run`).
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Run {
    /// Id.
    pub id: String,
    /// Status (queued, running, needs-input, completed, cancelled, budget-exceeded, step-limit, failed).
    pub status: String,
    /// Mode.
    pub mode: String,
    /// Goal.
    pub goal: String,
    /// Pending question.
    pub question: Option<RunQuestion>,
    /// Error.
    pub error: Option<Json>,
    /// Credits used.
    pub cost_credits: f64,
    /// Steps.
    pub steps: f64,
    /// Model.
    pub model: Option<String>,
    /// Cancel requested.
    pub cancel_requested: bool,
    /// Created (ms).
    pub created_at: f64,
}

/// A question the agent asked.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RunQuestion {
    /// Question.
    pub question: String,
    /// Suggested answers.
    pub options: Vec<String>,
}

/// `ai.agent.runEvents`.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RunEvents {
    /// The run.
    pub run: Run,
    /// Events after the requested index (each has `index`, `type`, `ts` and the event fields).
    pub events: Vec<Json>,
    /// Last index returned.
    pub next: f64,
    /// The run ended and every event was returned.
    pub done: bool,
}

/// A stock photo (`stock.photos.search`).
#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct StockPhoto {
    /// "<provider>:<id>".
    pub id: String,
    /// unsplash | pexels.
    pub provider: String,
    /// Description.
    pub description: String,
    /// Width.
    pub width: f64,
    /// Height.
    pub height: f64,
    /// Preview URL.
    pub thumb_url: String,
    /// Full-size URL.
    pub url: String,
    /// Average color.
    pub color: Option<String>,
    /// Photographer.
    pub author: String,
    /// Photographer page.
    pub author_url: String,
    /// Photo page.
    pub source_url: String,
    /// License.
    pub license: String,
    /// Unsplash download tracking endpoint.
    pub download_location: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lenient_decoding() {
        let p: Profile = decode(json!({ "userId": "u1", "name": "Ada Lovelace", "plan": "free", "features": { "versionHistory": false }, "extra": 1 })).unwrap();
        assert_eq!(p.initials(), "AL");
        assert!(!p.can("versionHistory"));
        assert!(p.can("editor.core"));
        let s: Since = decode(json!({ "ops": [{ "seq": 3, "txId": "t", "tx": "{}", "actor": null, "source": "user", "ts": 1 }], "hasMore": false, "gap": false, "latestSeq": 3 })).unwrap();
        assert_eq!(s.ops[0].seq, 3);
        let t: TemplateView = decode(json!({ "id": "x", "thumbnails": [{ "url": "a", "width": 640, "height": 1 }, { "url": "b", "width": 320, "height": 1 }] })).unwrap();
        assert_eq!(t.thumb(300.0).unwrap().url, "b");
        assert_eq!(t.thumb(1000.0).unwrap().url, "a");
    }
}
