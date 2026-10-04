import puppeteer from "puppeteer-core";
import { mkdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
const dir = new URL(".", import.meta.url).pathname;
const FPS = Number(process.env.FPS ?? 30);
const only = process.env.STILLS; // "t1,t2,..." to grab a few stills instead of the whole video
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--force-color-profile=srgb", "--hide-scrollbars"] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(dir + "video.html").href, { waitUntil: "networkidle0" });
await page.evaluate(() => window.ready);
const duration = await page.evaluate(() => window.DURATION);
console.log("duration", duration.toFixed(1), "s");
if (only) {
  for (const s of only.split(",")) {
    // Step up to the moment so smoothed scrolling has settled.
    for (let t = Math.max(0, Number(s) - 2); t <= Number(s); t += 1 / FPS) await page.evaluate((x) => window.renderAt(x), t);
    await page.screenshot({ path: `${dir}still-${s}.jpg`, type: "jpeg", quality: 90 });
  }
} else {
  rmSync(dir + "frames", { recursive: true, force: true });
  mkdirSync(dir + "frames");
  const n = Math.ceil(duration * FPS);
  for (let i = 0; i < n; i++) {
    await page.evaluate((x) => window.renderAt(x), i / FPS);
    await page.screenshot({ path: `${dir}frames/${String(i).padStart(5, "0")}.jpg`, type: "jpeg", quality: 92 });
    if (i % 300 === 0) console.log(`frame ${i}/${n}`);
  }
}
await browser.close();
