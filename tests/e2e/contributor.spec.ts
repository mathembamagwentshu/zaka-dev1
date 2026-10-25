import { devices, expect, test, type Browser, type Page } from "@playwright/test";
import { expectReconciled, reserveCard, sessionApi, startCheckout, tokenOf } from "./helpers";

async function secondDevice(browser: Browser, projectName: string) {
  // The other person uses a different device class from the initiator.
  const device = projectName.startsWith("mobile") ? devices["Desktop Chrome"] : devices["iPhone 14"];
  const { defaultBrowserType: _ignored, ...options } = device;
  const context = await browser.newContext({ ...options, baseURL: test.info().project.use.baseURL });
  return context.newPage();
}

async function setUpShares(page: Page, initiatorShare: string) {
  await page.getByRole("button", { name: /Split with someone/ }).click();
  await page.getByLabel("Your name").fill("Ada");
  await page.getByLabel(/Your email/).fill("ada@example.test");
  await page.getByLabel("Their name").fill("Ben");
  await page.getByLabel("Their email").fill("ben@example.test");
  await page.getByLabel("Your share").fill("35");
  await expect(page.getByLabel("Ben's share")).toHaveValue("65.00");
  await page.getByLabel("Ben's share").fill("60");
  await expect(page.getByLabel("Your share")).toHaveValue("40.00"); // AC-19
  await page.getByLabel("Your share").fill(initiatorShare);
  await page.getByRole("button", { name: "Lock shares and send invitation" }).click();
  await expect(page.getByText(/Invitation sent to b\*\*\*@example\.test/)).toBeVisible();
}

async function payShare(page: Page, cards: string[] | null, shareLabel = "$65.00") {
  if (cards && cards.length === 2) {
    await page.getByText("Two cards", { exact: true }).click();
    await page.getByLabel("Card 1 amount").fill(cards[0]);
    await expect(page.getByLabel("Card 2 amount")).toHaveValue(cards[1]);
  }
  await page.getByRole("button", { name: "Continue to card details" }).click();
  for (let i = 0; i < (cards?.length ?? 1); i++) await reserveCard(page, i === 0 ? "4242424242424242" : "5555555555554444");
  void shareLabel;
}

test.describe("Contributor Split — two people, two devices", () => {
  test("AC-02: 35/65 shares with 20+15 and 40+25 cards (four cards)", async ({ page, browser, request }, info) => {
    await startCheckout(page);
    await setUpShares(page, "35");
    const initiatorView = await sessionApi(request, tokenOf(page));
    const contributorLink: string = initiatorView.contributorLink;
    expect(contributorLink).toMatch(/\/pay#zk/);

    await page.getByRole("button", { name: /Pay my share/ }).click();
    await payShare(page, ["20", "15.00"]);
    await expect(page.getByRole("heading", { name: "Payment progress" })).toBeVisible();
    await expect(page.getByText("Your share is reserved.")).toBeVisible();
    // One funded participant never completes the order (AC-06).
    expect((await sessionApi(request, tokenOf(page))).status).toBe("AWAITING_PAYMENT");

    const ben = await secondDevice(browser, info.project.name);
    await ben.goto(contributorLink);
    await expect(ben.getByText("Ada is splitting this order with you")).toBeVisible();
    await expect(ben.getByText("$65.00").first()).toBeVisible();
    await payShare(ben, ["40", "25.00"]);
    await expect(ben.getByRole("heading", { name: "Payment complete" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Payment complete" })).toBeVisible({ timeout: 30_000 });

    // Privacy: Ben sees his own cards, Ada's share total, not Ada's cards or email.
    const benText = await ben.locator("main").innerText();
    expect(benText).toContain("$40.00");
    expect(benText).not.toContain("$20.00");
    expect(benText).not.toContain("ada@example.test");
    await info.attach("initiator-complete", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    await info.attach("contributor-complete", { body: await ben.screenshot({ fullPage: true }), contentType: "image/png" });

    const rec = await expectReconciled(initiatorView.ref, 10000, [
      [2000, 1500],
      [4000, 2500],
    ]);
    await info.attach("reconciliation.json", { body: JSON.stringify(rec, null, 2), contentType: "application/json" });
    await ben.context().close();
  });

  test("AC-03: one card for the initiator, two for the contributor", async ({ page, browser, request }, info) => {
    await startCheckout(page);
    await setUpShares(page, "35");
    const { contributorLink, ref } = await sessionApi(request, tokenOf(page));
    await page.getByRole("button", { name: /Pay my share/ }).click();
    await payShare(page, null);
    const ben = await secondDevice(browser, info.project.name);
    await ben.goto(contributorLink);
    await payShare(ben, ["40", "25.00"]);
    await expect(ben.getByRole("heading", { name: "Payment complete" })).toBeVisible({ timeout: 30_000 });
    await expectReconciled(ref, 10000, [[3500], [4000, 2500]]);
    await ben.context().close();
  });

  test("AC-09: initiator cancels; holds are released and the contributor link stops taking payment", async ({ page, browser, request }, info) => {
    await startCheckout(page);
    await setUpShares(page, "35");
    const { contributorLink } = await sessionApi(request, tokenOf(page));
    await page.getByRole("button", { name: /Pay my share/ }).click();
    await payShare(page, null);
    await page.getByRole("button", { name: "Cancel this split payment" }).click();
    await page.getByRole("button", { name: "Yes, cancel" }).click();
    await expect(page.getByRole("heading", { name: "This split payment was cancelled" })).toBeVisible();
    await expect(page.getByText("Released").first()).toBeVisible({ timeout: 15_000 });

    const ben = await secondDevice(browser, info.project.name);
    await ben.goto(contributorLink);
    await expect(ben.getByRole("heading", { name: "This split payment was cancelled" })).toBeVisible();
    await expect(ben.getByRole("button", { name: "Continue to card details" })).toHaveCount(0);
    await ben.context().close();
  });
});
