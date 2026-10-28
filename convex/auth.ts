import { type AuthFunctions, createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { requireRunMutationCtx } from "@convex-dev/better-auth/utils";
import { APIError } from "better-auth/api";
import { type BetterAuthOptions, betterAuth } from "better-auth/minimal";
import { magicLink } from "better-auth/plugins/magic-link";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { onUserCreated, onUserDeleted, onUserUpdated } from "./accounts/lifecycle";
import authConfig from "./auth.config";
import { appUrl, clientIpHeaders, env, isLocalUrl, siteUrl } from "./lib/env";
import type { MailTemplateId } from "./lib/validators";

const authFunctions: AuthFunctions = internal.auth;

/**
 * Better Auth component client. Triggers run in the same transaction as the Better Auth write, so a
 * user always has a profile + personal workspace, and deleting a user schedules the data purge.
 */
export const authComponent = createClient<DataModel>(components.betterAuth, {
  authFunctions,
  triggers: {
    user: {
      onCreate: async (ctx, doc) => {
        await onUserCreated(ctx, doc);
      },
      onUpdate: async (ctx, newDoc, oldDoc) => {
        await onUserUpdated(ctx, newDoc, oldDoc);
      },
      onDelete: async (ctx, doc) => {
        await onUserDeleted(ctx, doc);
      },
    },
  },
});

export const { onCreate, onUpdate, onDelete } = authComponent.triggersApi();

/** Origins allowed to call the auth API (CSRF origin check + CORS). */
export function trustedOrigins(): string[] {
  const origins = new Set<string>([appUrl(), siteUrl()]);
  for (const extra of (env.get("AUTH_TRUSTED_ORIGINS") ?? "").split(",")) {
    if (extra.trim()) origins.add(extra.trim().replace(/\/+$/, ""));
  }
  if (isLocalUrl(appUrl())) {
    origins.add("http://localhost:4104");
    origins.add("http://127.0.0.1:4104");
  }
  // Native clients (desktop / iOS) use this scheme for callback URLs.
  origins.add("desyn://");
  return [...origins];
}

async function queueAuthEmail(
  ctx: GenericCtx<DataModel>,
  input: { to: string; template: MailTemplateId; data: Record<string, unknown>; userId?: string },
): Promise<void> {
  await requireRunMutationCtx(ctx).runMutation(internal.emails.queue.enqueue, input);
}

function socialProviders(): BetterAuthOptions["socialProviders"] {
  const providers: NonNullable<BetterAuthOptions["socialProviders"]> = {};
  const googleId = env.get("GOOGLE_CLIENT_ID");
  const googleSecret = env.get("GOOGLE_CLIENT_SECRET");
  if (googleId && googleSecret) {
    providers.google = { clientId: googleId, clientSecret: googleSecret, prompt: "select_account" };
  }
  const githubId = env.get("GITHUB_CLIENT_ID");
  const githubSecret = env.get("GITHUB_CLIENT_SECRET");
  if (githubId && githubSecret) {
    providers.github = { clientId: githubId, clientSecret: githubSecret };
  }
  return providers;
}

/** Enabled sign-in methods, for clients deciding which buttons to show. */
export function enabledAuthMethods() {
  const providers = socialProviders() ?? {};
  return {
    emailPassword: true,
    magicLink: true,
    google: "google" in providers,
    github: "github" in providers,
  };
}

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    appName: "Desyn",
    // Browsers reach the auth API through the web app's /api/auth proxy, so links and cookies live on
    // the app origin (app.desyn.app, or localhost:4104 in dev).
    baseURL: appUrl(),
    basePath: "/api/auth",
    secret: env.get("BETTER_AUTH_SECRET"),
    database: authComponent.adapter(ctx),
    trustedOrigins: trustedOrigins(),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: true,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: async ({ user, url }) => {
        await queueAuthEmail(ctx, {
          to: user.email,
          template: "resetPassword",
          data: { name: user.name, url },
          userId: user.id,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, url }) => {
        await queueAuthEmail(ctx, {
          to: user.email,
          template: "verifyEmail",
          data: { name: user.name, url, purpose: "signup" },
          userId: user.id,
        });
      },
    },
    socialProviders: socialProviders(),
    // Linking an OAuth identity to an existing account requires the provider to report the email as
    // verified (and the local account to be verified). No provider is "trusted" past that check:
    // trusting one would let an identity with an unverified copy of someone's email take over their
    // account.
    account: {
      accountLinking: { enabled: true },
    },
    databaseHooks: {
      session: {
        create: {
          // Disabled accounts (admin console) cannot start new sessions through any sign-in method,
          // including the native token exchange.
          before: async (session) => {
            const disabled = await ctx.runQuery(internal.accounts.profiles.isDisabled, {
              userId: session.userId,
            });
            if (disabled) {
              throw new APIError("FORBIDDEN", { message: "This account is disabled." });
            }
          },
        },
      },
    },
    user: {
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          await queueAuthEmail(ctx, {
            to: user.email,
            template: "verifyEmail",
            data: { name: user.name, url, purpose: "changeEmail", newEmail },
            userId: user.id,
          });
        },
      },
      deleteUser: {
        enabled: true,
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60 * 60, max: 10 },
        "/sign-in/magic-link": { window: 10 * 60, max: 5 },
        "/magic-link/verify": { window: 60, max: 10 },
        "/request-password-reset": { window: 60 * 60, max: 5 },
        "/forget-password": { window: 60 * 60, max: 5 },
        "/reset-password": { window: 60 * 60, max: 10 },
        "/send-verification-email": { window: 60 * 60, max: 5 },
        "/change-password": { window: 60 * 60, max: 10 },
        "/change-email": { window: 60 * 60, max: 5 },
        "/delete-user": { window: 60 * 60, max: 5 },
        // Session reads happen on every page load and token refresh (about three per load). They only work with
        // a valid session cookie, so a generous per-IP budget keeps users behind a shared NAT or office IP from
        // hitting 429 without weakening the credential endpoints above.
        "/get-session": { window: 60, max: 600 },
        "/convex/token": { window: 60, max: 600 },
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: clientIpHeaders() },
    },
    plugins: [
      magicLink({
        expiresIn: 15 * 60,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => {
          await queueAuthEmail(ctx, { to: email, template: "magicLink", data: { url } });
        },
      }),
      // Native apps sign in through the PKCE exchange in convex/accounts/nativeAuth.ts.
      convex({ authConfig }),
    ],
  });

export type Auth = ReturnType<typeof createAuth>;
