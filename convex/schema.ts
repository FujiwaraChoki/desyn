import { defineSchema } from "convex/server";
import { accountsTables } from "./tables/accounts";
import { billingTables } from "./tables/billing";
import { designsTables } from "./tables/designs";
import { assetsTables } from "./tables/assets";
import { templatesTables } from "./tables/templates";
import { brandTables } from "./tables/brand";
import { collabTables } from "./tables/collab";
import { aiTables } from "./tables/ai";
import { miscTables } from "./tables/misc";
import { apiTables } from "./tables/api";
import { editorTables } from "./tables/editor";
import { panelsTables } from "./tables/panels";

// Tables live in ./tables/*.ts, one file per owner, so parallel work never edits the same file.
export default defineSchema({
  ...accountsTables,
  ...billingTables,
  ...designsTables,
  ...assetsTables,
  ...templatesTables,
  ...brandTables,
  ...collabTables,
  ...aiTables,
  ...miscTables,
  ...apiTables,
  ...editorTables,
  ...panelsTables,
});
