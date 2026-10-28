import { admin } from "./en/admin";
import { analytics } from "./en/analytics";
import { app } from "./en/app";
import { auth } from "./en/auth";
import { brand } from "./en/brand";
import { common } from "./en/common";
import { dashboard } from "./en/dashboard";
import { onboarding } from "./en/onboarding";
import { editor, invite, present, share } from "./en/public";
import { settings } from "./en/settings";
import { templates } from "./en/templates";

export const en = {
  common,
  analytics,
  auth,
  app,
  dashboard,
  brand,
  onboarding,
  templates,
  settings,
  admin,
  invite,
  share,
  editor,
  present,
};

export type Messages = typeof en;
