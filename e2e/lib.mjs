// Shared helpers for the end-to-end checks (headless Chromium via puppeteer-core).
// Set CHROME_PATH to use an installed Chrome/Chromium; otherwise @sparticuz/chromium (Linux) is used.
import puppeteer from 'puppeteer-core';

export async function launch() {
  let executablePath = process.env.CHROME_PATH;
  let args = ['--no-sandbox', '--font-render-hinting=none'];
  if (!executablePath) {
    const chromium = (await import('@sparticuz/chromium')).default;
    executablePath = await chromium.executablePath();
    args = [...chromium.args, '--font-render-hinting=none'];
  }
  return puppeteer.launch({ executablePath, args, headless: true, defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 } });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Records every request leaving localhost — the app must never make one. */
export function watchNetwork(page) {
  const external = [];
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname) && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) external.push(req.url());
  });
  return external;
}

export async function uploadPdf(page, path) {
  const input = await page.waitForSelector('.dropzone input[type=file]', { hidden: true });
  await input.uploadFile(path);
  await page.waitForSelector('.topbar', { timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('.page-canvas-holder canvas').length > 0, { timeout: 60000 });
}

/** Download dir handling: route downloads into `dir`. */
export async function allowDownloads(page, dir) {
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
  return cdp;
}

export async function waitForFile(dir, pred, timeout = 30000) {
  const { readdirSync, statSync } = await import('node:fs');
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const f = readdirSync(dir).find((n) => pred(n) && !n.endsWith('.crdownload'));
    if (f) {
      const p = `${dir}/${f}`;
      const s1 = statSync(p).size;
      await sleep(300);
      if (statSync(p).size === s1 && s1 > 0) return p;
    }
    await sleep(200);
  }
  throw new Error('download did not appear');
}
