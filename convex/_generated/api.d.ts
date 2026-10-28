/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounts_apiKeys from "../accounts/apiKeys.js";
import type * as accounts_audit from "../accounts/audit.js";
import type * as accounts_cleanup from "../accounts/cleanup.js";
import type * as accounts_config from "../accounts/config.js";
import type * as accounts_counters from "../accounts/counters.js";
import type * as accounts_folders from "../accounts/folders.js";
import type * as accounts_invites from "../accounts/invites.js";
import type * as accounts_lifecycle from "../accounts/lifecycle.js";
import type * as accounts_memberships from "../accounts/memberships.js";
import type * as accounts_nativeAuth from "../accounts/nativeAuth.js";
import type * as accounts_profiles from "../accounts/profiles.js";
import type * as accounts_sessions from "../accounts/sessions.js";
import type * as accounts_workspaces from "../accounts/workspaces.js";
import type * as admin_e2e from "../admin/e2e.js";
import type * as admin_flags from "../admin/flags.js";
import type * as admin_operator from "../admin/operator.js";
import type * as admin_system from "../admin/system.js";
import type * as admin_users from "../admin/users.js";
import type * as ai_agent from "../ai/agent.js";
import type * as ai_agentNode from "../ai/agentNode.js";
import type * as ai_api from "../ai/api.js";
import type * as ai_catalog from "../ai/catalog.js";
import type * as ai_internal from "../ai/internal.js";
import type * as ai_maintenance from "../ai/maintenance.js";
import type * as ai_media from "../ai/media.js";
import type * as ai_mediaJobs from "../ai/mediaJobs.js";
import type * as ai_models from "../ai/models.js";
import type * as ai_platform from "../ai/platform.js";
import type * as ai_prefs from "../ai/prefs.js";
import type * as ai_providers from "../ai/providers.js";
import type * as ai_settings from "../ai/settings.js";
import type * as ai_tools from "../ai/tools.js";
import type * as ai_workflows from "../ai/workflows.js";
import type * as ai_workflowsNode from "../ai/workflowsNode.js";
import type * as api_account from "../api/account.js";
import type * as api_assets from "../api/assets.js";
import type * as api_brand from "../api/brand.js";
import type * as api_brandNode from "../api/brandNode.js";
import type * as api_designs from "../api/designs.js";
import type * as api_exports from "../api/exports.js";
import type * as api_gate from "../api/gate.js";
import type * as api_templates from "../api/templates.js";
import type * as assets_assets from "../assets/assets.js";
import type * as auth from "../auth.js";
import type * as billing_credits from "../billing/credits.js";
import type * as billing_normalize from "../billing/normalize.js";
import type * as billing_signature from "../billing/signature.js";
import type * as billing_stripeActions from "../billing/stripeActions.js";
import type * as billing_subscription from "../billing/subscription.js";
import type * as billing_usage from "../billing/usage.js";
import type * as billing_webhook from "../billing/webhook.js";
import type * as brand_brandKits from "../brand/brandKits.js";
import type * as collab_comments from "../collab/comments.js";
import type * as collab_presence from "../collab/presence.js";
import type * as crons from "../crons.js";
import type * as designs_designOps from "../designs/designOps.js";
import type * as designs_designs from "../designs/designs.js";
import type * as designs_internal from "../designs/internal.js";
import type * as designs_maintenance from "../designs/maintenance.js";
import type * as designs_renderNode from "../designs/renderNode.js";
import type * as designs_snapshotNode from "../designs/snapshotNode.js";
import type * as designs_versions from "../designs/versions.js";
import type * as editor_autosave from "../editor/autosave.js";
import type * as editor_prefs from "../editor/prefs.js";
import type * as emails_queue from "../emails/queue.js";
import type * as emails_send from "../emails/send.js";
import type * as emails_templates from "../emails/templates.js";
import type * as emails_transport from "../emails/transport.js";
import type * as exports_exports from "../exports/exports.js";
import type * as exports_node from "../exports/node.js";
import type * as http from "../http.js";
import type * as lib_ai_access from "../lib/ai_access.js";
import type * as lib_ai_backend from "../lib/ai_backend.js";
import type * as lib_ai_brand from "../lib/ai_brand.js";
import type * as lib_ai_host from "../lib/ai_host.js";
import type * as lib_ai_net from "../lib/ai_net.js";
import type * as lib_ai_providers from "../lib/ai_providers.js";
import type * as lib_ai_runs from "../lib/ai_runs.js";
import type * as lib_ai_start from "../lib/ai_start.js";
import type * as lib_apiKeys from "../lib/apiKeys.js";
import type * as lib_api_ai from "../lib/api_ai.js";
import type * as lib_api_handlers from "../lib/api_handlers.js";
import type * as lib_api_http from "../lib/api_http.js";
import type * as lib_api_limits from "../lib/api_limits.js";
import type * as lib_api_principal from "../lib/api_principal.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_billing_attribution from "../lib/billing_attribution.js";
import type * as lib_credits from "../lib/credits.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_designs_access from "../lib/designs_access.js";
import type * as lib_designs_assets from "../lib/designs_assets.js";
import type * as lib_designs_blob from "../lib/designs_blob.js";
import type * as lib_designs_commit from "../lib/designs_commit.js";
import type * as lib_designs_compress from "../lib/designs_compress.js";
import type * as lib_designs_create from "../lib/designs_create.js";
import type * as lib_designs_doc from "../lib/designs_doc.js";
import type * as lib_designs_limits from "../lib/designs_limits.js";
import type * as lib_designs_materialize from "../lib/designs_materialize.js";
import type * as lib_designs_s3 from "../lib/designs_s3.js";
import type * as lib_designs_summary from "../lib/designs_summary.js";
import type * as lib_designs_svg from "../lib/designs_svg.js";
import type * as lib_designs_templates from "../lib/designs_templates.js";
import type * as lib_designs_upload from "../lib/designs_upload.js";
import type * as lib_designs_wire from "../lib/designs_wire.js";
import type * as lib_designs_worker from "../lib/designs_worker.js";
import type * as lib_entitlements from "../lib/entitlements.js";
import type * as lib_env from "../lib/env.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_flags from "../lib/flags.js";
import type * as lib_guards from "../lib/guards.js";
import type * as lib_index from "../lib/index.js";
import type * as lib_logger from "../lib/logger.js";
import type * as lib_plans from "../lib/plans.js";
import type * as lib_posthog from "../lib/posthog.js";
import type * as lib_rateLimits from "../lib/rateLimits.js";
import type * as lib_roles from "../lib/roles.js";
import type * as lib_telemetry from "../lib/telemetry.js";
import type * as lib_usage from "../lib/usage.js";
import type * as lib_validators from "../lib/validators.js";
import type * as panels_assetFolders from "../panels/assetFolders.js";
import type * as panels_stock from "../panels/stock.js";
import type * as routes_api from "../routes/api.js";
import type * as routes_auth from "../routes/auth.js";
import type * as routes_health from "../routes/health.js";
import type * as routes_mcp from "../routes/mcp.js";
import type * as routes_og from "../routes/og.js";
import type * as routes_stripe from "../routes/stripe.js";
import type * as stock_photos from "../stock/photos.js";
import type * as tables_accounts from "../tables/accounts.js";
import type * as tables_ai from "../tables/ai.js";
import type * as tables_api from "../tables/api.js";
import type * as tables_assets from "../tables/assets.js";
import type * as tables_billing from "../tables/billing.js";
import type * as tables_brand from "../tables/brand.js";
import type * as tables_collab from "../tables/collab.js";
import type * as tables_designs from "../tables/designs.js";
import type * as tables_editor from "../tables/editor.js";
import type * as tables_misc from "../tables/misc.js";
import type * as tables_panels from "../tables/panels.js";
import type * as tables_templates from "../tables/templates.js";
import type * as templates_admin from "../templates/admin.js";
import type * as templates_templates from "../templates/templates.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "accounts/apiKeys": typeof accounts_apiKeys;
  "accounts/audit": typeof accounts_audit;
  "accounts/cleanup": typeof accounts_cleanup;
  "accounts/config": typeof accounts_config;
  "accounts/counters": typeof accounts_counters;
  "accounts/folders": typeof accounts_folders;
  "accounts/invites": typeof accounts_invites;
  "accounts/lifecycle": typeof accounts_lifecycle;
  "accounts/memberships": typeof accounts_memberships;
  "accounts/nativeAuth": typeof accounts_nativeAuth;
  "accounts/profiles": typeof accounts_profiles;
  "accounts/sessions": typeof accounts_sessions;
  "accounts/workspaces": typeof accounts_workspaces;
  "admin/e2e": typeof admin_e2e;
  "admin/flags": typeof admin_flags;
  "admin/operator": typeof admin_operator;
  "admin/system": typeof admin_system;
  "admin/users": typeof admin_users;
  "ai/agent": typeof ai_agent;
  "ai/agentNode": typeof ai_agentNode;
  "ai/api": typeof ai_api;
  "ai/catalog": typeof ai_catalog;
  "ai/internal": typeof ai_internal;
  "ai/maintenance": typeof ai_maintenance;
  "ai/media": typeof ai_media;
  "ai/mediaJobs": typeof ai_mediaJobs;
  "ai/models": typeof ai_models;
  "ai/platform": typeof ai_platform;
  "ai/prefs": typeof ai_prefs;
  "ai/providers": typeof ai_providers;
  "ai/settings": typeof ai_settings;
  "ai/tools": typeof ai_tools;
  "ai/workflows": typeof ai_workflows;
  "ai/workflowsNode": typeof ai_workflowsNode;
  "api/account": typeof api_account;
  "api/assets": typeof api_assets;
  "api/brand": typeof api_brand;
  "api/brandNode": typeof api_brandNode;
  "api/designs": typeof api_designs;
  "api/exports": typeof api_exports;
  "api/gate": typeof api_gate;
  "api/templates": typeof api_templates;
  "assets/assets": typeof assets_assets;
  auth: typeof auth;
  "billing/credits": typeof billing_credits;
  "billing/normalize": typeof billing_normalize;
  "billing/signature": typeof billing_signature;
  "billing/stripeActions": typeof billing_stripeActions;
  "billing/subscription": typeof billing_subscription;
  "billing/usage": typeof billing_usage;
  "billing/webhook": typeof billing_webhook;
  "brand/brandKits": typeof brand_brandKits;
  "collab/comments": typeof collab_comments;
  "collab/presence": typeof collab_presence;
  crons: typeof crons;
  "designs/designOps": typeof designs_designOps;
  "designs/designs": typeof designs_designs;
  "designs/internal": typeof designs_internal;
  "designs/maintenance": typeof designs_maintenance;
  "designs/renderNode": typeof designs_renderNode;
  "designs/snapshotNode": typeof designs_snapshotNode;
  "designs/versions": typeof designs_versions;
  "editor/autosave": typeof editor_autosave;
  "editor/prefs": typeof editor_prefs;
  "emails/queue": typeof emails_queue;
  "emails/send": typeof emails_send;
  "emails/templates": typeof emails_templates;
  "emails/transport": typeof emails_transport;
  "exports/exports": typeof exports_exports;
  "exports/node": typeof exports_node;
  http: typeof http;
  "lib/ai_access": typeof lib_ai_access;
  "lib/ai_backend": typeof lib_ai_backend;
  "lib/ai_brand": typeof lib_ai_brand;
  "lib/ai_host": typeof lib_ai_host;
  "lib/ai_net": typeof lib_ai_net;
  "lib/ai_providers": typeof lib_ai_providers;
  "lib/ai_runs": typeof lib_ai_runs;
  "lib/ai_start": typeof lib_ai_start;
  "lib/apiKeys": typeof lib_apiKeys;
  "lib/api_ai": typeof lib_api_ai;
  "lib/api_handlers": typeof lib_api_handlers;
  "lib/api_http": typeof lib_api_http;
  "lib/api_limits": typeof lib_api_limits;
  "lib/api_principal": typeof lib_api_principal;
  "lib/audit": typeof lib_audit;
  "lib/billing_attribution": typeof lib_billing_attribution;
  "lib/credits": typeof lib_credits;
  "lib/crypto": typeof lib_crypto;
  "lib/designs_access": typeof lib_designs_access;
  "lib/designs_assets": typeof lib_designs_assets;
  "lib/designs_blob": typeof lib_designs_blob;
  "lib/designs_commit": typeof lib_designs_commit;
  "lib/designs_compress": typeof lib_designs_compress;
  "lib/designs_create": typeof lib_designs_create;
  "lib/designs_doc": typeof lib_designs_doc;
  "lib/designs_limits": typeof lib_designs_limits;
  "lib/designs_materialize": typeof lib_designs_materialize;
  "lib/designs_s3": typeof lib_designs_s3;
  "lib/designs_summary": typeof lib_designs_summary;
  "lib/designs_svg": typeof lib_designs_svg;
  "lib/designs_templates": typeof lib_designs_templates;
  "lib/designs_upload": typeof lib_designs_upload;
  "lib/designs_wire": typeof lib_designs_wire;
  "lib/designs_worker": typeof lib_designs_worker;
  "lib/entitlements": typeof lib_entitlements;
  "lib/env": typeof lib_env;
  "lib/errors": typeof lib_errors;
  "lib/flags": typeof lib_flags;
  "lib/guards": typeof lib_guards;
  "lib/index": typeof lib_index;
  "lib/logger": typeof lib_logger;
  "lib/plans": typeof lib_plans;
  "lib/posthog": typeof lib_posthog;
  "lib/rateLimits": typeof lib_rateLimits;
  "lib/roles": typeof lib_roles;
  "lib/telemetry": typeof lib_telemetry;
  "lib/usage": typeof lib_usage;
  "lib/validators": typeof lib_validators;
  "panels/assetFolders": typeof panels_assetFolders;
  "panels/stock": typeof panels_stock;
  "routes/api": typeof routes_api;
  "routes/auth": typeof routes_auth;
  "routes/health": typeof routes_health;
  "routes/mcp": typeof routes_mcp;
  "routes/og": typeof routes_og;
  "routes/stripe": typeof routes_stripe;
  "stock/photos": typeof stock_photos;
  "tables/accounts": typeof tables_accounts;
  "tables/ai": typeof tables_ai;
  "tables/api": typeof tables_api;
  "tables/assets": typeof tables_assets;
  "tables/billing": typeof tables_billing;
  "tables/brand": typeof tables_brand;
  "tables/collab": typeof tables_collab;
  "tables/designs": typeof tables_designs;
  "tables/editor": typeof tables_editor;
  "tables/misc": typeof tables_misc;
  "tables/panels": typeof tables_panels;
  "tables/templates": typeof tables_templates;
  "templates/admin": typeof templates_admin;
  "templates/templates": typeof templates_templates;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
