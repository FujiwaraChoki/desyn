import { expect, test } from "@playwright/test";
import {
  completeOnboarding,
  mailLink,
  signUpAndVerify,
  trackConsoleErrors,
  uniqueEmail,
} from "./helpers";

const PASSWORD = "Sunlit-Studio-2026";

test.describe.configure({ mode: "serial" });

test("sign up, verify, onboard, create and organise designs, settings, sign out and back in", async ({
  page,
  browser,
}) => {
  const errors = trackConsoleErrors(page);
  const email = uniqueEmail();

  // Protected routes send visitors to sign-in and keep the destination.
  await page.goto("/settings/profile");
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fprofile/);

  await signUpAndVerify(page, { name: "Ada Sun", email, password: PASSWORD });
  await completeOnboarding(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Ada");

  // Folder from the sidebar.
  await page.getByRole("button", { name: "New folder" }).first().click();
  await page.getByLabel("Folder name").fill("Spring campaign");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("link", { name: "Spring campaign" }).first()).toBeVisible();

  // Create a design from a preset: the editor route opens with the design loaded.
  await page
    .getByRole("button", { name: /Instagram post/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/design\/[a-z0-9]+$/);
  await expect(page.getByText(/Instagram post|Untitled/).first()).toBeVisible();

  // Back home: the design is in Recent designs; rename it from its menu.
  await page.goto("/");
  const card = page
    .locator("article")
    .filter({ has: page.locator("h3") })
    .first();
  await expect(card).toBeVisible();
  await card.hover();
  await card.getByRole("button", { name: /Design actions/ }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Launch post");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Launch post" })).toBeVisible();

  // Drag the design onto the folder in the sidebar.
  await page
    .locator("article")
    .filter({ hasText: "Launch post" })
    .dragTo(page.getByRole("link", { name: "Spring campaign" }).first());
  await expect(page.getByText(/Moved “Launch post” to Spring campaign/).first()).toBeVisible();
  await page.getByRole("link", { name: "Spring campaign" }).first().click();
  await expect(page.getByRole("heading", { name: "Launch post" })).toBeVisible();

  // A view link opens the share page for anyone.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const folderCard = page.locator("article").filter({ hasText: "Launch post" });
  await folderCard.hover();
  await folderCard.getByRole("button", { name: /Design actions/ }).click();
  await page.getByRole("menuitem", { name: "Copy view link" }).click();
  await expect(page.getByText("View link copied").first()).toBeVisible();
  const shareUrl = await page.evaluate(() => navigator.clipboard.readText());
  expect(shareUrl).toMatch(/\/share\/[A-Za-z0-9_-]+$/);
  const anonymous = await browser.newContext();
  const visitor = await anonymous.newPage();
  await visitor.goto(new URL(new URL(shareUrl).pathname, page.url()).toString());
  await expect(visitor.getByRole("heading", { name: "Launch post" })).toBeVisible();
  await expect(visitor.getByText("Can view")).toBeVisible();
  await anonymous.close();

  // Settings: profile name, appearance, API key, usage.
  await page.goto("/settings/profile");
  await page.getByLabel("Name", { exact: true }).fill("Ada Sunrise");
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Profile saved").first()).toBeVisible();
  await page.goto("/settings/appearance");
  await page.getByRole("button", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Dark" }).click();
  await page.goto("/settings/api-keys");
  await page.getByRole("button", { name: "Create key" }).first().click();
  await page.getByRole("textbox", { name: "Name" }).fill("e2e key");
  await page.getByRole("dialog").getByRole("button", { name: "Create key" }).click();
  await expect(page.getByRole("heading", { name: /copy your key/i })).toBeVisible();
  await expect(page.getByLabel("API key")).toHaveValue(/\S{20,}/);
  await page.getByRole("button", { name: "I've copied it" }).click();
  await expect(page.getByText("e2e key").first()).toBeVisible();
  await page.goto("/settings/usage");
  await expect(page.getByText("Designs", { exact: true }).first()).toBeVisible();

  // Trash and restore.
  await page.goto("/");
  const recent = page.locator("article").filter({ hasText: "Launch post" });
  await recent.hover();
  await recent.getByRole("button", { name: /Design actions/ }).click();
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await expect(page.getByText(/Moved “Launch post” to trash/).first()).toBeVisible();
  await page.goto("/trash");
  const trashed = page.locator("article").filter({ hasText: "Launch post" });
  await trashed.hover();
  await trashed.getByRole("button", { name: /Design actions/ }).click();
  await page.getByRole("menuitem", { name: "Restore" }).click();
  await expect(page.getByText(/Restored “Launch post”/).first()).toBeVisible();

  // Sign out, then sign in with the password.
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Recent designs" })).toBeVisible();

  const unexpected = errors.filter(
    (e) => !/Failed to load resource: the server responded with a status of (401|404)/.test(e),
  );
  expect(unexpected).toEqual([]);
});

test("magic link and password reset", async ({ page }) => {
  const email = uniqueEmail("e2e-magic");
  await signUpAndVerify(page, { name: "Magic Moth", email, password: PASSWORD });
  await completeOnboarding(page);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);

  // Magic link.
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByRole("heading", { name: /a link is on its way/i })).toBeVisible();
  await page.goto(await mailLink(email, /\/api\/auth\/magic-link\/verify\?/));
  await expect(page).toHaveURL(/\/$/);

  // Reset password.
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.goto(`/forgot?email=${encodeURIComponent(email)}`);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("heading", { name: /check your inbox/i })).toBeVisible();
  await page.goto(await mailLink(email, /\/api\/auth\/reset-password\//));
  await expect(page).toHaveURL(/\/reset\?token=/);
  await page.getByLabel("New password").fill("Another-Sunrise-77");
  await page.getByLabel("Confirm password").fill("Another-Sunrise-77");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.getByText(/Password updated/).first()).toBeVisible();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Another-Sunrise-77");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("describe a design hands the prompt to the editor once", async ({ page }) => {
  const errors = trackConsoleErrors(page);
  const email = uniqueEmail("e2e-prompt");
  await signUpAndVerify(page, { name: "Prompt Poet", email, password: PASSWORD });
  await completeOnboarding(page);

  const prompt = "A minimal poster for a jazz night, Friday 8pm";
  const box = page.getByRole("textbox", { name: "Describe a design" });
  await box.fill(prompt);
  await box.press("Enter");
  // No server-run agent on this deployment: the editor opens with the prompt in the URL.
  await expect(page).toHaveURL(/\/design\/[a-z0-9]+\?prompt=/);
  expect(new URL(page.url()).searchParams.get("prompt")).toBe(prompt);
  // The one-time auto-start marker was consumed by the editor route, so a reload only prefills.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(sessionStorage).filter((k) => k.startsWith("desyn-autostart:")),
      ),
    )
    .toEqual([]);
  // "Poster" was inferred from the words.
  await page.goto("/");
  await expect(page.locator("article").filter({ hasText: "Poster" }).first()).toBeVisible();

  // The presenter tolerates a malformed ?slide= and offers a way out.
  const designId = await page
    .locator("article a[href^='/design/']")
    .first()
    .getAttribute("href")
    .then((h) => h?.split("/").pop());
  await page.goto(`/present/${designId}?slide=abc`);
  await expect(page.getByRole("button", { name: "Exit presentation" }).first()).toBeVisible();

  // Until convex/ai ships `ai/agent:runAgent`, the Convex client logs the missing function before
  // the dashboard falls back to `?prompt=`; that one message is expected here.
  const unexpected = errors.filter(
    (e) =>
      !/Failed to load resource: the server responded with a status of (401|404)/.test(e) &&
      !/Could not find public function for 'ai\/agent:runAgent'/.test(e),
  );
  expect(unexpected).toEqual([]);
});
