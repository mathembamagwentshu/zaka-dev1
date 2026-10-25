import { expect, test } from "@playwright/test";
import { expectReconciled, reserveCard, sessionApi, startCheckout, tokenOf } from "./helpers";

test.describe("Multi-Card Split", () => {
  test("AC-01/AC-20: USD 100.00 as 35.00 + 65.00 completes and reconciles", async ({ page, request }, info) => {
    await startCheckout(page);
    await page.getByRole("button", { name: /Split across two cards/ }).click();
    await page.getByLabel("Card 1 amount").fill("35");
    await expect(page.getByLabel("Card 2 amount")).toHaveValue("65.00");
    await expect(page.getByText("Calculated", { exact: true })).toBeVisible();
    // Editing the other field flips the calculation.
    await page.getByLabel("Card 2 amount").fill("60");
    await expect(page.getByLabel("Card 1 amount")).toHaveValue("40.00");
    await page.getByLabel("Card 1 amount").fill("35.00");
    await expect(page.getByLabel("Card 2 amount")).toHaveValue("65.00");
    await page.getByRole("button", { name: "Continue to card details" }).click();

    await reserveCard(page, "4242424242424242");
    await expect(page.getByText("Card 1 is reserved")).toBeVisible();
    await reserveCard(page, "5555555555554444");
    await expect(page.getByRole("heading", { name: "Payment complete" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("$100.00 USD")).toBeVisible();
    await info.attach("completion", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

    const view = await sessionApi(request, tokenOf(page));
    expect(view.status).toBe("COMPLETED");
    expect(view.viewer.canPay).toBe(false);
    const rec = await expectReconciled(view.ref, 10000, [[3500, 6500]]);
    await info.attach("reconciliation.json", { body: JSON.stringify(rec, null, 2), contentType: "application/json" });

    await page.getByRole("link", { name: /Back to Demo Test Store/ }).click();
    await expect(page.getByRole("heading", { name: "Order paid" })).toBeVisible();
    await expect(page.getByText("Fulfilment is disabled in the sandbox")).toBeVisible();
  });

  test("AC-05: decline after an earlier reservation releases it; retry succeeds", async ({ page, request }) => {
    await startCheckout(page);
    await page.getByRole("button", { name: /Split across two cards/ }).click();
    await page.getByLabel("Card 1 amount").fill("35");
    await page.getByRole("button", { name: "Continue to card details" }).click();
    await reserveCard(page, "4242424242424242");
    await reserveCard(page, "4000000000000002");
    await expect(page.getByText("Card 2 wasn't accepted.")).toBeVisible();
    await expect(page.getByText(/released the \$35\.00 reserved on card 1 \(•••• 4242\)/)).toBeVisible();
    // Amounts unlocked: choose a new split and pay.
    await page.getByLabel("Card 2 amount").fill("50");
    await expect(page.getByLabel("Card 1 amount")).toHaveValue("50.00");
    await page.getByRole("button", { name: "Continue to card details" }).click();
    await reserveCard(page, "4242424242424242");
    await reserveCard(page, "4242424242424242");
    await expect(page.getByRole("heading", { name: "Payment complete" })).toBeVisible({ timeout: 30_000 });
    const view = await sessionApi(request, tokenOf(page));
    await expectReconciled(view.ref, 10000, [[5000, 5000]]);
  });

  for (const auth of ["fail", "abandon"] as const) {
    test(`AC-05: 3-D Secure ${auth} is a non-success and releases card 1`, async ({ page }) => {
      await startCheckout(page);
      await page.getByRole("button", { name: /Split across two cards/ }).click();
      await page.getByLabel("Card 1 amount").fill("35");
      await page.getByRole("button", { name: "Continue to card details" }).click();
      await reserveCard(page, "4242424242424242");
      await reserveCard(page, "4000002500003155", auth);
      await expect(page.getByText("Card verification wasn't completed.")).toBeVisible();
      await expect(page.getByText("Nothing was charged.")).toBeVisible();
    });
  }

  test("AC-05: 3-D Secure completed reserves the card", async ({ page }) => {
    await startCheckout(page);
    await page.getByRole("button", { name: /Split across two cards/ }).click();
    await page.getByLabel("Card 1 amount").fill("35");
    await page.getByRole("button", { name: "Continue to card details" }).click();
    await reserveCard(page, "4000002500003155", "complete");
    await expect(page.getByText("Card 1 is reserved")).toBeVisible();
  });

  test("AC-04/AC-19: invalid amounts block progression and never leave a stale remainder", async ({ page }) => {
    await startCheckout(page, "cents");
    await page.getByRole("button", { name: /Split across two cards/ }).click();
    const c1 = page.getByLabel("Card 1 amount");
    const c2 = page.getByLabel("Card 2 amount");
    const go = page.getByRole("button", { name: "Continue to card details" });
    await c1.fill("33.34");
    await expect(c2).toHaveValue("66.67"); // USD 100.01 − 33.34
    await expect(go).toBeEnabled();
    for (const [value, message] of [
      ["abc", "Use numbers only"],
      ["-5", "can't be negative"],
      ["10.001", "no more than 2 decimal places"],
      ["100.02", "Can't be more than the order total"],
      ["100.01", "Both parts need an amount"],
      ["0.49", "at least \\$0\\.50"],
    ]) {
      await c1.fill(value);
      await expect(page.getByText(new RegExp(message, "i")).first()).toBeVisible();
      await expect(go).toBeDisabled();
      if (value !== "100.01" && value !== "0.49") await expect(c2).toHaveValue("");
    }
    await c1.fill("");
    await expect(page.getByText("Enter an amount.")).toBeVisible();
    await expect(go).toBeDisabled();
  });
});

test("FR-06: an invalid link shows access denied", async ({ page }) => {
  await page.goto("/pay#zkNOTAREALTOKEN");
  await expect(page.getByRole("heading", { name: "We can't open this link" })).toBeVisible();
});
