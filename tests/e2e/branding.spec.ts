import { expect, test, type Page } from "@playwright/test";
import { startCheckout } from "./helpers";

/**
 * Product identity and finish: icons load, titles are right and private, nothing is broken, and
 * the framework's default pages never appear.
 */

test.describe("identity and assets", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop-chrome", "asset checks run once"));

  test("favicon, SVG icon, Apple touch icon and manifest load with the right types", async ({ page, request }) => {
    await page.goto("/");
    const icons = await page.locator('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]').evaluateAll((els) =>
      els.map((e) => ({ rel: e.getAttribute("rel"), href: e.getAttribute("href"), type: e.getAttribute("type") })),
    );
    const hrefs = icons.map((i) => i.href ?? "");
    expect(hrefs.some((h) => h.startsWith("/favicon.ico"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/icon.svg"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/apple-icon.png"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("/manifest.webmanifest"))).toBe(true);
    for (const href of hrefs) {
      const res = await request.get(href);
      expect(res.status(), href).toBe(200);
      expect((await res.body()).length, href).toBeGreaterThan(100);
    }
    const manifest = await (await request.get("/manifest.webmanifest")).json();
    expect(manifest.name).toBe("Zaka Lite");
    for (const icon of manifest.icons) expect((await request.get(icon.src)).status()).toBe(200);
    const svg = await (await request.get("/icon.svg")).text();
    expect(svg).toContain("<svg");
  });

  test("nothing is indexable; robots.txt disallows everything", async ({ page, request }) => {
    const res = await page.goto("/");
    expect(res!.headers()["x-robots-tag"]).toContain("noindex");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    expect(await (await request.get("/robots.txt")).text()).toMatch(/Disallow: \//);
  });

  test("unknown URLs show the branded not-found page with a way back", async ({ page }) => {
    const res = await page.goto("/no-such-page");
    expect(res!.status()).toBe(404);
    await expect(page).toHaveTitle("Page not found · Zaka Lite");
    await expect(page.getByRole("heading", { name: "We couldn't find that page" })).toBeVisible();
    await expect(page.getByText("This page could not be found")).toHaveCount(0); // framework default
    await page.getByRole("link", { name: "Go to the start page" }).click();
    await expect(page).toHaveURL("/");
  });
});

async function collectProblems(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("/no-such")) problems.push(`${r.status()} ${r.url()}`);
  });
  page.on("requestfailed", (r) => {
    // A route prefetch cancelled because the user navigated on is normal browser behaviour.
    if (r.url().includes("_rsc=") && r.failure()?.errorText === "net::ERR_ABORTED") return;
    problems.push(`failed ${r.url()} ${r.failure()?.errorText}`);
  });
  return problems;
}

test("a first-time journey has no console errors, broken assets or failed requests, and private titles", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-chrome", "checked once");
  const problems = await collectProblems(page);
  await page.goto("/");
  await expect(page).toHaveTitle("Zaka Lite");
  await page.getByRole("link", { name: /Try it in the demo store/ }).click();
  await expect(page).toHaveTitle("Demo store · Zaka Lite");
  await startCheckout(page);
  await expect(page).toHaveTitle("Choose how to pay · Zaka Lite");
  await expect(page.getByText("Test mode · Simulated")).toBeVisible();
  await page.getByRole("button", { name: /Split with someone/ }).click();
  await expect(page).toHaveTitle("Split with someone · Zaka Lite");
  await page.getByLabel("Your name").fill("Ada");
  await page.getByLabel("Their name").fill("Ben");
  await page.getByLabel("Their email").fill("ben@example.test");
  await page.getByLabel("Your share").fill("35");
  await page.getByRole("button", { name: "Lock shares and send invitation" }).click();
  await expect(page).toHaveTitle("Invitation sent · Zaka Lite");
  const title = await page.title();
  expect(title).not.toMatch(/Ada|Ben|\$|@|zk[A-Za-z0-9_-]{10}/); // no names, amounts or tokens
  // Every image on the way rendered.
  const broken = await page.locator("img").evaluateAll((imgs) => imgs.filter((i) => !(i as HTMLImageElement).complete || (i as HTMLImageElement).naturalWidth === 0).length);
  expect(broken).toBe(0);
  expect(problems).toEqual([]);
});
