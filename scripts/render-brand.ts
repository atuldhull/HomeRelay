import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { fromRoot } from "./env";

/**
 * Renders the add-on images from assets/brand/src/*.svg with the installed Chrome and checks each file against the
 * sizes in Amazon's add-on package docs (read 2026-10-22): light icons in all six sizes (dark optional),
 * at least one 600x900 carousel image, an optional 1200x600 banner; PNG/JPG/JPEG/WEBP. File-size limits and
 * transparency rules are not stated in the docs, so the icons are opaque (no transparency) and sizes are reported.
 *   npm run brand:render
 */
const SRC = fromRoot("assets/brand/src"); const OUT = fromRoot("assets/brand/addon");
const ICON_SIZES = [64, 72, 88, 126, 180, 241];
const jobs: { src: string; out: string; w: number; h: number }[] = [
  ...ICON_SIZES.flatMap((s) => (["light", "dark"] as const).map((v) => ({ src: `icon-${v}.svg`, out: `icon-${v}-${s}x${s}.png`, w: s, h: s }))),
  { src: "carousel.svg", out: "carousel-1-600x900.png", w: 600, h: 900 },
  { src: "banner.svg", out: "banner-1200x600.png", w: 1200, h: 600 },
];

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const j of jobs) {
  const svg = fs.readFileSync(path.join(SRC, j.src), "utf8").replace(/<svg([^>]*?)\swidth="\d+" height="\d+"/, `<svg$1 width="${j.w}" height="${j.h}"`);
  await page.setViewportSize({ width: j.w, height: j.h });
  await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
  await page.screenshot({ path: path.join(OUT, j.out), clip: { x: 0, y: 0, width: j.w, height: j.h } });
}
await browser.close();

// verify: PNG signature, IHDR dimensions, colour type (2 = RGB, no alpha), file size
let bad = 0;
for (const j of jobs) {
  const b = fs.readFileSync(path.join(OUT, j.out));
  const ok = b.subarray(1, 4).toString() === "PNG" && b.readUInt32BE(16) === j.w && b.readUInt32BE(20) === j.h;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "BAD "} ${j.out.padEnd(28)} ${b.readUInt32BE(16)}x${b.readUInt32BE(20)}  colour type ${b[25]}  ${(b.length / 1024).toFixed(1)} KiB`);
}
process.exit(bad ? 1 : 0);
