import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { reserveCard, startCheckout } from "./helpers";

async function axe(page: Page, name: string) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const serious = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  await test.info().attach(`axe-${name}.json`, { body: JSON.stringify(result.violations, null, 2), contentType: "application/json" });
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`), name).toEqual([]);
}

test.describe("FR-16 accessibility", () => {
  test.skip(() => !["desktop-chrome", "mobile-iphone"].includes(test.info().project.name), "two-device sample");

  test("no serious/critical WCAG 2.1 AA violations on key screens", async ({ page }) => {
    await page.goto("/demo-store");
    await axe(page, "demo-store");
    await startCheckout(page);
    await axe(page, "C1");
    await page.getByRole("button", { name: /Split across two cards/ }).click();
    await page.getByLabel("Card 1 amount").fill("135");
    await axe(page, "C2-invalid");
    await page.getByLabel("Card 1 amount").fill("35");
    await page.getByRole("button", { name: "Continue to card details" }).click();
    await expect(page.getByRole("button", { name: /^Reserve/ })).toBeVisible();
    await axe(page, "C2-card-entry");
    await reserveCard(page, "4242424242424242");
    await reserveCard(page, "4242424242424242");
    await expect(page.getByRole("heading", { name: "Payment complete" })).toBeVisible({ timeout: 30_000 });
    await axe(page, "C8");
    await startCheckout(page);
    await page.getByRole("button", { name: /Split with someone/ }).click();
    await axe(page, "C3");
    await page.goto("/pay#zkINVALID");
    await expect(page.getByRole("heading", { name: "We can't open this link" })).toBeVisible();
    await axe(page, "access-denied");
  });

  test("keyboard-only Multi-Card Split purchase", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop-chrome", "keyboard test on desktop");
    await startCheckout(page);
    await page.keyboard.press("Tab");
    // Tab until the first method card is focused, then activate it with Enter.
    for (let i = 0; i < 10 && !(await page.getByRole("button", { name: /Split across two cards/ }).evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press("Tab");
    }
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Card 1 amount")).toBeVisible();
    await page.getByLabel("Card 1 amount").focus();
    await page.keyboard.type("35");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Card 2 amount")).toBeFocused();
    await expect(page.getByLabel("Card 2 amount")).toHaveValue("65.00");
    await page.keyboard.press("Enter"); // submits the form
    await expect(page.getByLabel("Card number")).toBeVisible();
    for (let n = 0; n < 2; n++) {
      await expect(page.getByRole("button", { name: /^Reserve/ })).toBeVisible();
      await page.getByLabel("Card number").focus();
      await page.keyboard.type("4242424242424242");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: /Reserving/ })).toHaveCount(0, { timeout: 20_000 });
    }
    await expect(page.getByRole("heading", { name: "Payment complete" })).toBeVisible({ timeout: 30_000 });
  });
});
