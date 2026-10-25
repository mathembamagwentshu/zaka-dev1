import { devices, expect, test, type Page } from "@playwright/test";
import { ops, reserveCard, sessionApi, startCheckout, tokenOf } from "./helpers";

/** Captures every screen template for visual review: evidence/screens/<project>/<name>.png */
test.describe("@tour screen templates", () => {

  const shot = async (page: Page, name: string) =>
    page.screenshot({ path: `evidence/screens/${test.info().project.name}/${name}.png`, fullPage: true });

  test("tour", async ({ page, browser, request }) => {
    test.skip(!["desktop-chrome", "mobile-iphone", "tablet-ipad"].includes(test.info().project.name), "captured on three devices only");
    await page.goto("/demo-store");
    await shot(page, "00-demo-store");
    await startCheckout(page);
    await shot(page, "C1-choose-method");

    await page.getByRole("button", { name: /Split across two cards/ }).click();
    await page.getByLabel("Card 1 amount").fill("35");
    await shot(page, "C2-standalone-allocation");
    await page.getByLabel("Card 1 amount").fill("135");
    await shot(page, "C2-invalid-amount");
    await page.getByLabel("Card 1 amount").fill("35");
    await page.getByRole("button", { name: "Continue to card details" }).click();
    await expect(page.getByRole("button", { name: /^Reserve/ })).toBeVisible();
    await shot(page, "C2-card-entry-1");
    await reserveCard(page, "4242424242424242");
    await expect(page.getByRole("button", { name: /Reserve \$65\.00 on card 2/ })).toBeVisible();
    await page.getByLabel("Card number").fill("4000002500003155");
    await page.getByRole("button", { name: /^Reserve/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, "C6-authentication");
    await page.getByRole("button", { name: "Fail verification" }).click();
    await expect(page.getByText("Card 2 wasn't accepted")).toBeVisible();
    await shot(page, "C6-declined-released");
    await page.getByLabel("Card 1 amount").fill("35");
    await page.getByRole("button", { name: "Continue to card details" }).click();
    await reserveCard(page, "4242424242424242");
    await reserveCard(page, "5555555555554444");
    await expect(page.getByRole("heading", { name: "Payment complete" })).toBeVisible({ timeout: 30_000 });
    await shot(page, "C8-standalone-complete");

    // Contributor flow
    await startCheckout(page);
    await page.getByRole("button", { name: /Split with someone/ }).click();
    await page.getByLabel("Your name").fill("Ada");
    await page.getByLabel("Their name").fill("Ben");
    await page.getByLabel("Their email").fill("ben@example.test");
    await page.getByLabel("Your share").fill("35");
    await shot(page, "C3-share-setup");
    await page.getByRole("button", { name: "Lock shares and send invitation" }).click();
    await expect(page.getByText(/Invitation sent/)).toBeVisible();
    await shot(page, "C4-invitation-sent");
    const { contributorLink, ref } = await sessionApi(request, tokenOf(page));
    await page.getByRole("button", { name: /Pay my share/ }).click();
    await page.getByText("Two cards", { exact: true }).click();
    await page.getByLabel("Card 1 amount").fill("20");
    await shot(page, "C5-initiator-two-cards");
    await page.getByRole("button", { name: "Continue to card details" }).click();
    await reserveCard(page, "4242424242424242");
    await reserveCard(page, "4242424242424242");
    await expect(page.getByText("Your share is reserved.")).toBeVisible();
    await shot(page, "C7-status-waiting");

    const mail = await page.context().newPage();
    await mail.goto("/dev/emails");
    await mail.getByRole("link", { name: new RegExp(`invitation.*${ref}`) }).click();
    await expect(mail.getByTestId("email-subject")).toContainText("asked you to pay");
    await shot(mail, "dev-email-preview-invitation");
    await mail.close();

    const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices["iPhone 14"];
    const ctx = await browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL: test.info().project.use.baseURL });
    const ben = await ctx.newPage();
    await ben.goto(contributorLink);
    await expect(ben.getByText("Ada is splitting")).toBeVisible();
    await ben.screenshot({ path: `evidence/screens/${test.info().project.name}/C5-contributor-landing.png`, fullPage: true });
    await ben.getByRole("button", { name: "Continue to card details" }).click();
    await reserveCard(ben, "4242424242424242");
    await expect(ben.getByRole("heading", { name: "Payment complete" })).toBeVisible({ timeout: 30_000 });
    await ben.screenshot({ path: `evidence/screens/${test.info().project.name}/C8-contributor-complete.png`, fullPage: true });
    await expect(page.getByRole("heading", { name: "Payment complete" })).toBeVisible({ timeout: 30_000 });
    await shot(page, "C8-initiator-complete");
    await ctx.close();
    expect(ops("reconcile", ref).consistent).toBe(true);

    // Partial-capture exception (controlled fault injection) and expiry
    await startCheckout(page);
    await page.getByRole("button", { name: /Split across two cards/ }).click();
    const view = await sessionApi(request, tokenOf(page));
    ops("fault", view.ref, "2", "tour");
    await page.getByLabel("Card 1 amount").fill("35");
    await page.getByRole("button", { name: "Continue to card details" }).click();
    await reserveCard(page, "4242424242424242");
    await reserveCard(page, "4242424242424242");
    await expect(page.getByRole("heading", { name: "We couldn't complete this payment" })).toBeVisible({ timeout: 30_000 });
    await shot(page, "C6-partial-capture-exception");
    ops("reverse", view.ref, "tour", "visual tour reversal");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Payment reversed" })).toBeVisible();
    await shot(page, "C6-reversed");

    await startCheckout(page);
    const v2 = await sessionApi(request, tokenOf(page));
    ops("expire-now", v2.ref, "tour");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Time ran out" })).toBeVisible();
    await shot(page, "C7-expired");
    await page.goto("/pay#zkINVALID");
    await expect(page.getByRole("heading", { name: "We can't open this link" })).toBeVisible();
    await shot(page, "access-denied");
  });
});
