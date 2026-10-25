import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandMark } from "@/components/brand";

/**
 * Regenerates every app icon from the BrandMark component (run after changing the mark):
 *   npx tsx scripts/generate-icons.tsx
 * Outputs src/app/icon.svg, src/app/favicon.ico (16/32/48), src/app/apple-icon.png (180) and
 * public/icons/icon-{192,512}.png for the web app manifest.
 */

const svg = renderToStaticMarkup(<BrandMark />)
  .replace(' class="shrink-0"', "")
  .replace("<svg ", '<svg width="64" height="64" ');
writeFileSync("src/app/icon.svg", `${svg}\n`);

async function rasterise(size: number, opts: { background?: string; inset?: number } = {}) {
  const inset = opts.inset ?? 0;
  const inner = Math.round(size * (1 - inset * 2));
  const html = `<html><body style="margin:0;background:${opts.background ?? "transparent"}">
    <div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center">
      ${svg.replace('width="64" height="64"', `width="${inner}" height="${inner}"`)}
    </div></body></html>`;
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(html);
  const png = await page.screenshot({ omitBackground: !opts.background, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  return png;
}

/** ICO container holding PNG images (supported by every current browser). */
function ico(images: { size: number; png: Buffer }[]) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map((x) => x.png)]);
}

let browser: Awaited<ReturnType<typeof chromium.launch>>;

async function main() {
  browser = await chromium.launch();
  const sizes = [16, 32, 48];
  writeFileSync("src/app/favicon.ico", ico(await Promise.all(sizes.map(async (size) => ({ size, png: await rasterise(size) })))));
  // Home-screen icons sit on an opaque tile; platforms apply their own corner mask.
  writeFileSync("src/app/apple-icon.png", await rasterise(180, { background: "#ffffff", inset: 0.12 }));
  writeFileSync("public/icons/icon-192.png", await rasterise(192, { background: "#ffffff", inset: 0.12 }));
  writeFileSync("public/icons/icon-512.png", await rasterise(512, { background: "#ffffff", inset: 0.12 }));
  await browser.close();
  console.log("icons written");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
