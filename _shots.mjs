import { chromium } from "@playwright/test";
const [out, ...urls] = process.argv.slice(2);
const browser = await chromium.launch();
for (const [w, h, tag] of [[1280, 800, "d"], [390, 844, "m"]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: tag === "m" ? 2 : 1 });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
  for (const u of urls) {
    await page.goto(`http://localhost:3000${u}`, { waitUntil: "networkidle" });
    const name = `${out}/${tag}-${u.replace(/[^a-z0-9]+/gi, "_") || "home"}.png`;
    await page.screenshot({ path: name, fullPage: true });
    console.log(name, (await page.title()));
  }
  if (errors.length) console.log("ERRORS", errors);
  await page.close();
}
await browser.close();
