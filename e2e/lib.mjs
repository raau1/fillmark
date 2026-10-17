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

/**
 * Files the app saves end up in `dir`: plain downloads, and files saved through the
 * system Save dialog, which is replaced by a stand-in that "chooses" `dir` and records
 * each call in window.__savePickerLog. Call before the first page load.
 */
export async function allowDownloads(page, dir) {
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
  const { existsSync, writeFileSync } = await import('node:fs');
  await page.exposeFunction('__e2eWriteFile', (name, b64) => {
    // like a browser download: never overwrite, add " (1)" etc.
    let n = name;
    for (let i = 1; existsSync(`${dir}/${n}`); i++) n = name.replace(/(\.[^.]+)?$/, ` (${i})$1`);
    writeFileSync(`${dir}/${n}`, Buffer.from(b64, 'base64'));
    return n;
  });
  await page.evaluateOnNewDocument(() => {
    window.__savePickerLog = [];
    window.showSaveFilePicker = async (o) => {
      window.__savePickerLog.push(o.suggestedName);
      const h = {
        kind: 'file',
        name: o.suggestedName,
        queryPermission: async () => 'granted',
        createWritable: async () => {
          const parts = [];
          return {
            write: async (b) => parts.push(b),
            close: async () => {
              const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
              let bin = '';
              for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
              await window.__e2eWriteFile(o.suggestedName, btoa(bin));
            },
            abort: async () => {},
          };
        },
      };
      return h;
    };
  });
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
