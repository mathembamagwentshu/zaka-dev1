import { expect, test, type Page } from "@playwright/test";
import { overflowsHorizontally, reserveCard, startCheckout } from "./helpers";

/**
 * Responsive layout and degraded-network behaviour, on every project (desktop Chrome, desktop
 * WebKit, Pixel 7 / iPhone 14 / iPad emulation). Emulation is not a physical-device test.
 */

async function expectNoOverflow(page: Page, where: string) {
  expect(await overflowsHorizontally(page), `horizontal overflow on ${where}`).toBe(false);
}

const LONG_NAME = "Maximiliana Alexandra Featherstonehaugh-Montgomery";
const LONG_EMAIL = "maximiliana.alexandra.featherstonehaugh-montgomery@example.test";

test("no horizontal overflow across both journeys, with long names and emails", async ({ page }) => {
  await page.goto("/demo-store");
  await expectNoOverflow(page, "demo store");
  await startCheckout(page);
  await expectNoOverflow(page, "C1 method choice");

  await page.getByRole("button", { name: /Split across two cards/ }).click();
  await page.getByLabel("Card 1 amount").fill("135");
  await expect(page.getByText(/Can't be more than/).first()).toBeVisible();
  await expectNoOverflow(page, "C2 with a validation error");
  await page.getByLabel("Card 1 amount").fill("35");
  await page.getByRole("button", { name: "Continue to card details" }).click();
  await expect(page.getByRole("button", { name: /^Reserve/ })).toBeVisible();
  await expectNoOverflow(page, "C2 card entry");

  await startCheckout(page);
  await page.getByRole("button", { name: /Split with someone/ }).click();
  await page.getByLabel("Your name").fill(LONG_NAME);
  await page.getByLabel("Their name").fill(LONG_NAME.split(" ").reverse().join(" "));
  await page.getByLabel("Their email").fill(LONG_EMAIL);
  await page.getByLabel("Your share").fill("35");
  await expectNoOverflow(page, "C3 share setup");
  await page.getByRole("button", { name: "Lock shares and send invitation" }).click();
  await expect(page.getByText(/Invitation sent/)).toBeVisible();
  await expectNoOverflow(page, "C4 invitation sent (long email)");
  await page.getByRole("button", { name: /Pay my share/ }).click();
  await page.getByRole("button", { name: "Continue to card details" }).click();
  await reserveCard(page, "4242424242424242");
  await expect(page.getByRole("heading", { name: "Payment progress" })).toBeVisible();
  await expectNoOverflow(page, "C7 status board (long names)");
  await expect(page.getByText(LONG_NAME).first()).toBeVisible(); // wrapped, not cut off
});

test("touch targets and mobile keyboards", async ({ page }, info) => {
  test.skip(!info.project.use.isMobile, "mobile/tablet projects only");
  await startCheckout(page);
  for (const name of [/Split across two cards/, /Split with someone/]) {
    const box = await page.getByRole("button", { name }).boundingBox();
    expect(box!.height, "method buttons are comfortably tappable").toBeGreaterThanOrEqual(44);
  }
  await page.getByRole("button", { name: /Split across two cards/ }).click();
  const amount = page.getByLabel("Card 1 amount");
  await expect(amount).toHaveAttribute("inputmode", "decimal"); // numeric keypad with a decimal point
  await amount.fill("35");
  const cont = page.getByRole("button", { name: "Continue to card details" });
  expect((await cont.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // With the on-screen keyboard covering the lower half, the total and the action stay reachable.
  const vp = page.viewportSize()!;
  await page.setViewportSize({ width: vp.width, height: Math.round(vp.height / 2) });
  await amount.focus();
  await cont.scrollIntoViewIfNeeded();
  await expect(cont).toBeInViewport();
  await expect(page.getByLabel("Card 2 amount")).toHaveValue("65.00");
  await expectNoOverflow(page, "half-height viewport");
});

test("200% and 400% zoom equivalents reflow without horizontal scrolling", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop-chrome", "zoom reflow checked once, on desktop");
  // 1280px at 200% zoom ≈ a 640px viewport; 400% ≈ 320px (WCAG 1.4.10 reflow).
  for (const width of [640, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 720 }, baseURL: info.project.use.baseURL });
    const page = await context.newPage();
    await startCheckout(page);
    await expectNoOverflow(page, `C1 at ${width}px`);
    await page.getByRole("button", { name: /Split with someone/ }).click();
    await page.getByLabel("Your share").fill("35");
    await expectNoOverflow(page, `C3 at ${width}px`);
    await expect(page.getByRole("button", { name: "Lock shares and send invitation" })).toBeVisible();
    await context.close();
  }
});

test("a dropped connection is announced and the last known state is kept", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop-chrome", "network behaviour is browser-independent");
  await startCheckout(page);
  await page.getByRole("button", { name: /Split with someone/ }).click();
  await page.getByLabel("Your name").fill("Ada");
  await page.getByLabel("Their name").fill("Ben");
  await page.getByLabel("Their email").fill("ben@example.test");
  await page.getByLabel("Your share").fill("35");
  await page.getByRole("button", { name: "Lock shares and send invitation" }).click();
  await page.getByRole("button", { name: "View status" }).click();
  await expect(page.getByRole("heading", { name: "Payment progress" })).toBeVisible();

  await context.setOffline(true);
  await expect(page.getByText(/Connection lost — reconnecting/)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("main")).toContainText("$35.00"); // still showing the last known state
  await context.setOffline(false);
  await expect(page.getByText(/Connection lost/)).toHaveCount(0, { timeout: 15_000 });
});

test("an unreachable server on first load offers a retry instead of a broken link message", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chrome", "network behaviour is browser-independent");
  await startCheckout(page);
  const url = page.url();
  await page.route("**/api/v1/session/resume", (route) => route.abort("connectionrefused"));
  await page.goto("about:blank");
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "We can't reach Zaka right now" })).toBeVisible();
  await expect(page.getByText(/We can't open this link/)).toHaveCount(0);
  await page.unroute("**/api/v1/session/resume");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("How would you like to pay?")).toBeVisible();
});
