import { execFileSync } from "node:child_process";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { e2eEnv } from "../../playwright.config";

export type CartKey = "bundle" | "cents" | "large";
const CART_LABEL: Record<CartKey, string> = { bundle: "Weekend bundle", cents: "Odd-cents cart", large: "Bigger basket" };

export async function startCheckout(page: Page, cart: CartKey = "bundle") {
  await page.goto("/demo-store");
  await page.getByText(CART_LABEL[cart], { exact: true }).click();
  await page.getByRole("button", { name: "Check out with Zaka" }).click();
  await page.waitForURL(/\/pay#zk/);
  await expect(page.getByText("How would you like to pay?")).toBeVisible();
}

export const tokenOf = (page: Page) => new URL(page.url()).hash.slice(1);

export async function sessionApi(request: APIRequestContext, token: string) {
  const res = await request.get("/api/v1/session", { headers: { authorization: `Bearer ${token}` } });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/** Reserve the card currently offered, via the simulated form or Stripe's Payment Element. */
export async function reserveCard(page: Page, cardNumber: string, auth?: "complete" | "fail" | "abandon") {
  const button = page.getByRole("button", { name: /^Reserve \$/ });
  await expect(button).toBeEnabled();
  const label = await button.textContent();
  if (await page.getByText("Simulated card entry").isVisible()) {
    await page.getByLabel("Card number").fill(cardNumber);
    await button.click();
    if (auth) {
      const dialog = page.getByRole("dialog", { name: "Verify this payment" });
      await expect(dialog).toBeVisible();
      const names = { complete: "Complete verification", fail: "Fail verification", abandon: "Close without verifying" };
      await dialog.getByRole("button", { name: names[auth] }).click();
    }
  } else {
    const frame = page.frameLocator('iframe[title*="Secure payment input"]').first();
    await frame.locator('input[name="number"]').fill(cardNumber);
    await frame.locator('input[name="expiry"]').fill("12 / 34");
    await frame.locator('input[name="cvc"]').fill("123");
    const postal = frame.locator('input[name="postalCode"]');
    if (await postal.isVisible().catch(() => false)) await postal.fill("10001");
    await button.click();
    if (auth) {
      const challenge = page.frameLocator('iframe[name^="__privateStripeFrame"]').last().frameLocator("#challengeFrame");
      const text = auth === "complete" ? "Complete" : "Fail";
      if (auth === "abandon") await page.keyboard.press("Escape");
      else await challenge.getByRole("button", { name: new RegExp(text, "i") }).click();
    }
  }
  // Wait until processing finished and this card is no longer the one being offered.
  await expect(page.getByRole("button", { name: /Reserving/ })).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: label ?? "" })).toHaveCount(0, { timeout: 20_000 });
}

export function ops(...args: string[]) {
  const outText = execFileSync("npx", ["tsx", "scripts/ops.ts", ...args], {
    env: { ...process.env, ...e2eEnv, ZAKA_LOG_SILENT: "true" },
    encoding: "utf8",
  });
  return JSON.parse(outText);
}

export async function expectReconciled(ref: string, totalMinor: number, cards: number[][]) {
  const rec = ops("reconcile", ref);
  expect(rec.status).toBe("COMPLETED");
  expect(rec.consistent).toBe(true);
  expect(rec.capturedMinor).toBe(totalMinor);
  const captured = rec.allocations.filter((a: { dbStatus: string }) => a.dbStatus === "CAPTURED");
  for (const [i, amounts] of cards.entries()) {
    expect(captured.filter((a: { participantPosition: number }) => a.participantPosition === i + 1).map((a: { amountMinor: number }) => a.amountMinor)).toEqual(amounts);
  }
  return rec;
}

/**
 * Read the contributor's invitation from the labelled local email preview (/dev/emails), the
 * way the contributor would receive it, and return the personal link it contains.
 */
export async function invitationLinkFromPreview(page: Page, sessionRef: string): Promise<string> {
  await expect(async () => {
    await page.goto("/dev/emails");
    await page.getByRole("link", { name: new RegExp(`invitation.*${sessionRef}`) }).click();
    await expect(page.getByTestId("email-subject")).toContainText(/asked you to pay/);
  }).toPass({ timeout: 20_000 });
  const text = await page.getByTestId("email-text").textContent();
  const link = /https?:\/\/\S+\/pay#zk[A-Za-z0-9_-]{43}/.exec(text ?? "")?.[0];
  expect(link, "invitation email contains a payer link").toBeTruthy();
  return link!;
}

/** True when the page scrolls horizontally (the layout overflows the viewport). */
export async function overflowsHorizontally(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}
