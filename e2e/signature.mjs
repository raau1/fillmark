// Signatures: draw in the pad (lines appear under the pointer), choose an ink colour, undo a stroke,
// recolour from the field's Colour setting afterwards, and export the signature in that colour inside its box.
// Usage: serve the build (npx vite preview --port 5173), then: node e2e/signature.mjs path/to/form.pdf
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  launch,
  uploadPdf,
  sleep,
  allowDownloads,
  waitForFile,
} from "./lib.mjs";

const PDF = process.argv[2] ?? process.env.FILLMARK_SAMPLE_PDF;
if (!PDF) {
  console.error(
    "Pass the sample form: node e2e/signature.mjs path/to/form.pdf (or set FILLMARK_SAMPLE_PDF)",
  );
  process.exit(2);
}
const URL_ = process.env.APP_URL ?? "http://localhost:5173/";
const DL = mkdtempSync(join(tmpdir(), "fillmark-sig-"));
const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(["PASS", name]);
  } catch (e) {
    results.push(["FAIL", name, e.message]);
  }
};
const BOX = { x: 330, y: 120, w: 200, h: 46 };

const b = await launch();
const page = await b.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await allowDownloads(page, DL);
await page.goto(URL_, { waitUntil: "networkidle0" });
await page.evaluate(() => localStorage.setItem("pff.lang", "en"));
await page.reload({ waitUntil: "networkidle0" });
await uploadPdf(page, PDF);

// place a signature field on page 1 and give it exact geometry
await page.click('.toolbox button[aria-label="Signature"]');
{
  const r = await page.$eval('.page[data-page="0"]', (el) =>
    el.getBoundingClientRect().toJSON(),
  );
  const s = r.width / 595.32;
  await page.mouse.click(r.left + (BOX.x + 20) * s, r.top + (BOX.y + 10) * s);
}
for (const [i, v] of [BOX.x, BOX.y, BOX.w, BOX.h].entries()) {
  const el = await page.$(`.grid4 label:nth-child(${i + 1}) input`);
  await el.click();
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await el.type(String(v));
  await page.keyboard.press("Tab");
}
await sleep(300);
if (process.env.SHOTS)
  await page.screenshot({ path: `${process.env.SHOTS}/1-placed.png` });

// fill it in
await page.click(".mode-btn:nth-child(2)");
await page.waitForSelector(".fill-field .btn.small");
await page.click(".fill-field .btn.small");
await page.waitForSelector(".sig-canvas");
await sleep(500); // let the dialog finish opening

const canvas = async () =>
  page.$eval(".sig-canvas", (c) => ({
    ...c.getBoundingClientRect().toJSON(),
    cw: c.clientWidth,
  }));
const pixel = (x, y) =>
  page.$eval(
    ".sig-canvas",
    (c, x, y) => {
      // screen point -> canvas pixel (inside the 1px border, at the canvas's device-pixel resolution)
      const r = c.getBoundingClientRect();
      const dpr = c.width / c.clientWidth;
      const px =
        ((x - r.left) * (c.offsetWidth / r.width) - c.clientLeft) * dpr;
      const py =
        ((y - r.top) * (c.offsetHeight / r.height) - c.clientTop) * dpr;
      const d = c
        .getContext("2d")
        .getImageData(Math.floor(px), Math.floor(py), 1, 1).data;
      return [...d];
    },
    x,
    y,
  );
const stroke = async (pts) => {
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.up();
};

await page.click('.sig-colours .swatch[aria-label="Black"]');
let c = await canvas();
const y0 = c.top + c.height * 0.55;
await stroke([
  [c.left + 40, y0],
  [c.left + 90, y0 - 40],
  [c.left + 140, y0 + 10],
  [c.left + 200, y0 - 30],
]);
await stroke([
  [c.left + 60, y0 + 30],
  [c.left + 220, y0 + 30],
]);
c = await canvas();
if (process.env.SHOTS)
  await page.screenshot({ path: `${process.env.SHOTS}/2-pad.png` });
const onLine = await pixel(c.left + 140, y0 + 30); // middle of the straight second stroke
check(
  "ink appears exactly under the pointer, in the chosen colour (black)",
  () => {
    assert.ok(onLine[3] > 200, `alpha ${onLine[3]}`);
    assert.ok(
      onLine[0] < 40 && onLine[1] < 40 && onLine[2] < 40,
      onLine.join(","),
    );
  },
);
await page.click('.sig-colours .swatch[aria-label="Green"]');
await sleep(100);
const recoloured = await pixel(c.left + 140, y0 + 30);
check(
  "changing the ink colour in the pad recolours what is already drawn",
  () => {
    assert.deepEqual(recoloured.slice(0, 3), [0x1f, 0x6f, 0x3a]);
  },
);
// a stray third stroke, then Undo removes just that one
await stroke([
  [c.left + 250, y0 - 50],
  [c.left + 320, y0 + 40],
]);
const stray = await pixel(c.left + 285, y0 - 5);
await page.click('.modal-actions button[title="Undo the last stroke"]');
await sleep(100);
const afterUndo = await pixel(c.left + 285, y0 - 5);
const keep = await pixel(c.left + 140, y0 + 30);
check("Undo removes only the last stroke", () => {
  assert.ok(stray[3] > 200, "stray stroke was drawn");
  assert.equal(afterUndo[3], 0);
  assert.ok(keep[3] > 200);
});
await page.click(".modal-actions .btn.primary");
await page.waitForSelector(".sig-canvas", { hidden: true });
await sleep(300);

const overlay = async () =>
  page.evaluate(() => {
    const g = document.querySelector(".content-svg .sig-ink");
    if (!g) return null;
    const pg = g.closest(".page").getBoundingClientRect();
    const s = pg.width / 595.32;
    const r = g.getBoundingClientRect();
    return {
      color: g.getAttribute("stroke"),
      paths: g.querySelectorAll("path").length,
      box: {
        x: (r.left - pg.left) / s,
        y: (r.top - pg.top) / s,
        w: r.width / s,
        h: r.height / s,
      },
      thumb: !!document.querySelector("svg.sig-thumb .sig-ink"),
    };
  });
const o1 = await overlay();
check(
  "the signature appears on the page in the pad colour, inside its box, with the thumbnail in the form",
  () => {
    assert.ok(o1, "no signature drawn");
    assert.equal(o1.color, "#1f6f3a");
    assert.equal(o1.paths, 2);
    assert.ok(o1.thumb);
    assert.ok(
      o1.box.x >= BOX.x - 0.5 && o1.box.y >= BOX.y - 0.5,
      JSON.stringify(o1.box),
    );
    assert.ok(
      o1.box.x + o1.box.w <= BOX.x + BOX.w + 0.5 &&
        o1.box.y + o1.box.h <= BOX.y + BOX.h + 0.5,
      JSON.stringify(o1.box),
    );
  },
);

// recolour from the field's Colour setting (Edit form)
await page.click(".mode-btn:nth-child(1)");
await sleep(200);
await page.click(".field-box");
await page.waitForSelector(".prop-section input[type=color]");
const colourHint = await page.$$eval(".prop-row .hint", (els) =>
  els.map((e) => e.textContent).join(" "),
);
await page.$eval(".prop-section input[type=color]", (el) => {
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  ).set;
  set.call(el, "#ff0000");
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await sleep(200);
const o2 = await overlay();
check("changing the field Colour recolours the signature", () => {
  assert.equal(o2.color, "#ff0000");
  assert.match(colourHint, /ink colour of a drawn signature/);
});

// export: the signature is printed in red, inside the box
await page.click(".topbar .btn.primary");
await page.waitForSelector("#exp-name");
await page.click(".modal-actions .btn.primary");
const file = await waitForFile(DL, (n) => n.endsWith(".pdf"), 60000);
await page.waitForSelector(".check-block.ok");
const dir = mkdtempSync(join(tmpdir(), "r-"));
execFileSync("pdftoppm", [
  "-r",
  "144",
  "-cropbox",
  "-f",
  "1",
  "-l",
  "1",
  "-singlefile",
  file,
  join(dir, "o"),
]);
const buf = readFileSync(join(dir, "o.ppm"));
const [, w] = buf.subarray(0, 40).toString("latin1").split(/\s+/).map(Number);
const data = buf.subarray(buf.indexOf(Buffer.from("255\n")) + 4);
let x0 = 1e9,
  y0r = 1e9,
  x1 = -1,
  y1 = -1,
  n = 0;
// look only around the box (the cover page has red printing of its own elsewhere)
const k = 2; // 144 dpi
for (let y = Math.floor((BOX.y - 6) * k); y < (BOX.y + BOX.h + 6) * k; y++)
  for (let x = Math.floor((BOX.x - 6) * k); x < (BOX.x + BOX.w + 6) * k; x++) {
    const i = y * w + x;
    const [R, G, B] = [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
    if (R > 180 && G < 90 && B < 90) {
      n++;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0r = Math.min(y0r, y);
      y1 = Math.max(y1, y);
    }
  }
const red = { x0: x0 / k, y0: y0r / k, x1: (x1 + 1) / k, y1: (y1 + 1) / k, n };
check(
  "exported PDF: signature printed in the field colour, inside its box, where it was on screen",
  () => {
    assert.ok(n > 50, `red pixels: ${n}`);
    assert.ok(
      red.x0 >= BOX.x - 0.5 &&
        red.y0 >= BOX.y - 0.5 &&
        red.x1 <= BOX.x + BOX.w + 0.5 &&
        red.y1 <= BOX.y + BOX.h + 0.5,
      JSON.stringify(red),
    );
    // matches the on-screen drawing (stroke ends are round, so allow about a pen width)
    assert.ok(
      Math.abs(red.x0 - o2.box.x) < 1.5 &&
        Math.abs(red.x1 - (o2.box.x + o2.box.w)) < 1.5,
      `${JSON.stringify(red)} vs ${JSON.stringify(o2.box)}`,
    );
    assert.ok(
      Math.abs(red.y0 - o2.box.y) < 1.5 &&
        Math.abs(red.y1 - (o2.box.y + o2.box.h)) < 1.5,
      `${JSON.stringify(red)} vs ${JSON.stringify(o2.box)}`,
    );
  },
);
check("no errors in the browser console", () => assert.deepEqual(errors, []));
await b.close();

for (const r of results) console.log(r[0], r[1], r[2] ? `\n      ${r[2]}` : "");
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
