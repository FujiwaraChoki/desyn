import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Scheduled jobs. Other owners add their jobs here with additive edits (one block per job).
const crons = cronJobs();

// --- accounts / billing owner ----------------------------------------------------------------
crons.daily(
  "credit period rollover",
  { hourUTC: 0, minuteUTC: 5 },
  internal.billing.credits.rollover,
  {},
);
crons.interval(
  "release stale credit reservations",
  { minutes: 10 },
  internal.billing.credits.releaseStaleReservations,
  {},
);
crons.daily("audit retention", { hourUTC: 3, minuteUTC: 15 }, internal.accounts.audit.purgeOld, {});
crons.daily(
  "mail log retention",
  { hourUTC: 3, minuteUTC: 30 },
  internal.emails.queue.purgeOld,
  {},
);
crons.interval(
  "recover stuck mail deliveries",
  { minutes: 15 },
  internal.emails.queue.recoverStuck,
  {},
);
crons.daily(
  "stripe event retention",
  { hourUTC: 3, minuteUTC: 45 },
  internal.billing.webhook.purgeOldEvents,
  {},
);
crons.hourly(
  "native auth code cleanup",
  { minuteUTC: 20 },
  internal.accounts.nativeAuth.purgeExpired,
  {},
);
crons.interval("ship logs to axiom", { minutes: 1 }, internal.lib.telemetry.shipLogs, {});

// --- designs owner ---------------------------------------------------------------------------------------
crons.interval("presence cleanup", { minutes: 1 }, internal.collab.presence.cleanup, {});
crons.daily(
  "trash purge",
  { hourUTC: 2, minuteUTC: 10 },
  internal.designs.maintenance.purgeTrash,
  {},
);
crons.hourly("snapshot compaction", { minuteUTC: 25 }, internal.designs.maintenance.compactOps, {});
crons.hourly("orphan asset cleanup", { minuteUTC: 35 }, internal.assets.assets.cleanup, {});
crons.hourly("export cleanup", { minuteUTC: 45 }, internal.exports.exports.cleanup, {});

// --- api owner -------------------------------------------------------------------------------------------
crons.hourly("api idempotency cleanup", { minuteUTC: 50 }, internal.api.gate.purgeIdempotency, {});

// --- ai-backend owner -------------------------------------------------------------------------------------
crons.interval("ai stale-run reaper", { minutes: 5 }, internal.ai.maintenance.reapStale, {});
crons.daily("ai run retention", { hourUTC: 4, minuteUTC: 5 }, internal.ai.maintenance.purgeOld, {});
crons.interval("ai model catalog refresh", { hours: 6 }, internal.ai.models.refreshCatalogs, {});

export default crons;
