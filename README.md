# Fillmark — fill in PDF forms without changing how they look

Fillmark is a browser application for filling in existing PDF documents such as clinical questionnaires and patient intake forms. You open a PDF, place (or automatically detect) answer fields on top of the original pages, fill them in, and download a completed copy of the **original** PDF with the answers written onto it.

Everything runs locally. No backend, no accounts, no analytics, no third-party requests.

## Windows desktop app (Fillmark.exe)

`Fillmark.exe` is a single file (about 35 MB) that contains the whole app.

**Installing**

1. Double-click `Fillmark.exe`. Because the file is not code-signed, Windows may show *“Windows protected your PC”*: click **More info → Run anyway** (only the first time).
2. Fillmark explains what it will install; click **OK**. It installs for your Windows user only — no administrator rights:
   - program in `%LOCALAPPDATA%\Programs\Fillmark`
   - **Fillmark** in the Start menu and on the desktop
   - right-click a PDF → **Open with → Fillmark** (your default PDF program is not changed; Fillmark also appears in **Settings → Default apps** if you want it as the default)
   - double-clicking a `.fillmark` project file opens it in Fillmark
   - an entry in **Settings → Apps** to uninstall it

   Then open Fillmark from the Start menu like any program. The downloaded file is no longer needed.
3. Running a downloaded `Fillmark.exe` again just opens the installed Fillmark — or, if the download is a newer version, updates it first (no questions).
4. If an earlier test build (called *InkWell* or *Casilla*) is installed, Fillmark removes its shortcuts and file associations and keeps its saved projects; old `.inkwell` and `.casilla` project files still open.

To use Fillmark without installing it (e.g. from a USB stick), start it with `Fillmark.exe --portable`.

**How it works.** Fillmark opens in its own window (no address bar or tabs) using the Microsoft Edge engine that is part of Windows 10/11 (Google Chrome is used if Edge is missing). Behind the window, `Fillmark.exe` serves the app on `127.0.0.1` only — nothing is reachable from the network, and file hand-over requires a secret token that changes on every start. The window has its own browser profile in `%LOCALAPPDATA%\Fillmark\profile`, separate from your normal browsing; saved projects live there. Exporting asks where to save each file. Fillmark closes itself a few seconds after its last window is closed. Opening another PDF while Fillmark is running opens a second window in the same app.

**Uninstalling.** Settings → Apps → Fillmark → Uninstall (or `Fillmark.exe --uninstall`). You choose whether to also delete the projects saved by Fillmark; `.fillmark` files and PDFs you saved elsewhere are never touched.

**Building it.** Requires Node.js 20+ and Go 1.22+ (no other downloads; it cross-compiles on Windows, macOS or Linux):

```bash
npm install
npm run build:desktop     # → release/Fillmark.exe
```

The launcher source is in `desktop/` (Go standard library only). `desktop/rsrc_windows_amd64.syso` holds the icon, version information and manifest; it is regenerated from `desktop/fillmark.rc` when `llvm-rc` and `llvm-cvtres` are available.

## Quick start (web version / development)

Requirements: Node.js 20+ (tested with Node 22) and a current Chrome, Edge, Firefox or Safari.

```bash
npm install
npm run dev          # http://localhost:5173
```

Production build (static files you can serve from any web server or intranet):

```bash
npm run build        # output in dist/
npm run preview      # serves dist/ at http://localhost:4173
```

`npm run dev` / `npm run build` first copy the runtime data the app needs (pdf.js fonts and decoders, the OCR engine and Spanish/English language data) from `node_modules` into `public/`, so they are served by the app itself.

## Using it

1. **Open a PDF** — drag it onto the start page or choose a file. Recent projects are listed below the drop zone.
2. **Edit form** — set up the answer fields:
   - **Detect fields** looks at each page image for empty boxes, squares and circles to tick, and blank lines after a label. Existing interactive PDF fields can be imported from the same dialog. When a page has no selectable text (scans, or PDFs whose text was converted to outlines, like the DIVA-5 example), labels can be read with OCR that runs on this computer.
   - Detected fields are **suggestions**: they have an orange outline until you check them (select a field, or use *Accept all* in the Fields tab).
   - Or place fields by hand: pick a tool (text, long text, checkbox, option, date, number, dropdown, signature, fixed note), then click on the page or drag to draw the size. After detection, clicking inside a printed box snaps the new field to it.
   - Move fields by dragging, resize with the handles, nudge with the arrow keys (Shift = 10 pt), align/distribute several fields, duplicate (Ctrl+D), copy/paste between pages, undo/redo (Ctrl+Z / Ctrl+Shift+Z).
   - The right panel sets label, section, type, exact position (points), font, size (automatic or fixed), colour, alignment, line spacing, overflow behaviour (shrink or keep size), check-mark style, border, background, required, default value, dropdown options and option groups.
3. **Fill form** — answer in the side panel (grouped by section, with search and progress) or click directly on the page: clicking a checkbox ticks it, clicking a text box lets you type straight onto the page (Enter or a click elsewhere to finish). Answers that are too long for their box shrink to fit as you type; if text gets very small (under 5 pt) the form shows a notice. Focusing an input in the side panel scrolls the page to its box.
4. **Preview PDF** — shows the actual generated PDF, page by page.
5. **Export PDF** — choose a file name and
   - **Final copy** (recommended): answers are drawn onto the pages (flattened);
   - **Editable form**: answers stay in real PDF form fields.
   The dialog warns about empty required fields, text that does not fit, and unchecked suggestions.

**Saving work.** Projects (the PDF, field definitions and answers) are saved automatically in this browser's storage (IndexedDB). Browser storage can be cleared, so keep your work in a `.fillmark` project file as well:

- **Save** (Ctrl+S) writes the project to its file. The first time, it asks where to save; after that it overwrites the same file, like any desktop program. A project opened from a file (double-clicked in Explorer, *Open a project file…*, or dropped on the window) saves back to that file. The status line says *Saved to …* or *Changes not saved to …*, and Fillmark warns before closing with unsaved changes.
- **Save as…** (Ctrl+Shift+S) always asks for a new name or place.
- In browsers without file access (Firefox, Safari), Save downloads a copy instead.

Saving a project is separate from exporting the completed PDF.

## Privacy

- PDFs and answers are processed in the browser and never uploaded. There is no server component, telemetry or analytics, and field values are never written to the console.
- The production build carries a Content-Security-Policy that only allows connections to the app's own origin, so the browser itself blocks any third-party request. The end-to-end tests also record every network request and fail if one leaves `localhost`.
- The OCR engine and language data are served by the app; their CDN defaults are never used.
- Project data stays in IndexedDB until the project is deleted from the start page or the browser data is cleared. Downloaded project files contain patient data in clear text: store them like any other clinical document.
- This application has **not** been assessed for compliance with GDPR, HIPAA or any other health-data regulation. Follow your organisation's rules for patient information.

## How accuracy is achieved

- **The PDF is the source of truth.** Pages are rendered with pdf.js; fields are overlays; the export writes onto the original pages with pdf-lib. The document is never re-created.
- **One coordinate system.** Field rectangles are stored in *display points* (1/72 in, origin top-left of the page as displayed, after `/Rotate` and relative to the CropBox). Zoom only multiplies by the scale, so overlays stay aligned at any zoom level, window size or screen density. Conversion to PDF user space (bottom-left origin, unrotated, CropBox offset) happens in one place, `src/core/coords.ts`, and is tested against pdf.js's own viewport transforms for 0/90/180/270° pages with offset crop boxes.
- **One text layout.** `src/core/layout.ts` decides font size (auto-fit or shrink), line breaks, alignment and baselines using the font metrics of the embedded font. The on-screen overlay draws exactly those lines (each forced to its measured width), and the exporter draws the same lines into the PDF, so what you see is what you get. With the default *Shrink text* setting, text that is too long shrinks (to 0.1 pt precision) until all of it fits, and very small results are pointed out in the form and before export. Text is only cut off when it cannot fit even at 1 pt, or when a field is set to *Keep size*; that is always flagged (badge on the page, message in the form, warning before export) — never clipped silently.
- **Unicode.** Answers use bundled DejaVu fonts (subset-embedded), so á é í ó ú ñ ü ¿ « » ≥ etc. come out as real, searchable text. The PDF standard fonts (Helvetica, Times, Courier) are also available; characters they cannot encode automatically fall back to DejaVu with a warning.
- **Editable export** uses custom appearance streams built from the same layout, so the editable PDF looks like the flattened one in readers that respect them.
- **Existing interactive fields** can be imported (position, type, options, current values). On export the originals are removed and replaced so nothing is drawn twice; dangling references left by pdf-lib are pruned so readers do not report damage.

## Tests

```bash
npm test               # unit + export-alignment tests (Vitest; needs poppler-utils: pdftoppm, pdftotext, pdfinfo)
```

- `tests/coords.test.ts` — display ↔ PDF transforms vs pdf.js, all rotations, crop boxes.
- `tests/layout.test.ts` — auto size, shrink, wrapping, overflow reporting, alignment, font fallback, check-mark geometry.
- `tests/export.test.ts` — exports flattened and editable PDFs onto rotated/cropped pages, **rasterises them with poppler** (an independent renderer) and checks every tick/text lands inside its reference frame; Unicode extraction; untouched pages are pixel-identical; page sizes/rotations preserved.
- `tests/acroform.test.ts` — importing interactive fields (incl. rotated pages and radio /Opt values) and replacing them on export without damage.
- `tests/detect.test.ts` — detection on a synthetic form (boxes, checkboxes, radios, lines; no false positives on large letters or banners), grouping/labelling logic, and page 2 of the DIVA-5 questionnaire when `FILLMARK_SAMPLE_PDF` points to it (the questionnaire itself is not included in this repository).

End-to-end checks (headless Chromium; start `npm run dev` or `npm run preview` first; set `APP_URL` for the preview server and `CHROME_PATH` to use an installed Chrome):

```bash
node e2e/run.mjs path/to/form.pdf     # manual placement, fill, alignment at 5 zoom/screen setups, export + raster checks,
                                      # preview, browser-storage reopen, project file round trip, invalid/encrypted files, no external requests
node e2e/detect.mjs path/to/form.pdf  # detection + OCR labels, accept all, fill, export: every tick inside its printed square
node e2e/rotated.mjs                  # drag fields on rotated/cropped pages in the UI, export, verify
node e2e/desktop.mjs path/to/form.pdf # desktop launcher (Linux build of the same code): token/Host protection, CSP,
                                      # open a PDF from the command line, hand a .fillmark file to a running instance, exit after the last window
```

Desktop launcher unit tests: `cd desktop && go test ./...` (run automatically by `npm run build:desktop`).

`e2e/run.mjs` and `e2e/detect.mjs` contain coordinates measured from the DIVA-5 example (pages 2+); with another PDF, use them as a template.

## What was verified with the DIVA-5 example

On the 15-page example (A4, no text layer, no form fields):

- Detection found all 418 printed tick squares and 53 answer boxes, nothing on the covers, and turned the short option rows (*Sexo: H / M*, *Síntoma presente: Sí / No*) into one-choice groups. With OCR, fields get the printed labels (e.g. “Comete errores por olvidos”, “Síntoma presente: Sí”). Detection with OCR took about 65–70 s for 15 pages in headless Chromium (a few seconds without OCR).
- Overlays stayed within about half a screen pixel of the printed frames at 71–175 % zoom, in a tablet-sized window and on a 2× display.
- In exported PDFs every tick sat inside its printed square and every text inside its box (flattened and editable); untouched pages were pixel-identical to the original.

## Limitations

- **Detection** finds boxes drawn as closed outlines, small squares/circles and solid underlines. It does not find dotted/dashed lines, boxes without a visible outline (e.g. a light grey fill only), table cells that already contain printed text, or comb fields (one box per character). Suggestions must be reviewed. Group names come from headings when there is readable text; otherwise lists are numbered.
- **OCR** labels can contain mistakes (e.g. *Sintoma* instead of *Síntoma*, a short word dropped). OCR is only used for labels, never for positions.
- **Encrypted PDFs** (password or permission restrictions) cannot be modified; the app explains how to remove the protection first. **XFA** forms are not supported.
- **Editable export**: signatures and fixed notes are always flattened. Readers that regenerate field appearances may draw the text slightly differently.
- **Fonts**: one regular weight per family (DejaVu Sans, Sans Condensed, Serif, plus the standard Helvetica/Times/Courier); no bold/italic.
- **Rotated text inside a field** (other than following the page rotation) is not supported.
- Very large documents work (pages are rendered lazily and released when far from view), but detection on hundreds of pages takes proportionally longer.
- The UI is in English and Spanish (switch with the EN/ES button).
- **Desktop app**: `Fillmark.exe` is not code-signed, so Windows SmartScreen warns on first run. The Windows-only parts (installer dialogs, shortcuts, registry entries, launching Edge) are built on Linux: they compile and pass static checks and unit tests, but the automated tests cannot run them. Version 0.3.0 had an installer bug that was found on Windows (it stopped before creating the shortcuts and “Open with” entry); 0.3.1 fixes it. Saving back to a file opened from Explorer goes through the local launcher, which only writes to project files that were opened through it. The server, window hand-over and app inside it are tested through a Linux build of the same launcher. The window is an Edge/Chrome app window: Edge itself follows your Windows/Edge settings (updates, diagnostic data); Fillmark never sends document data anywhere.

## Project structure

```
src/core/        pure logic (no DOM): types, coords, fonts/metrics, layout, export, AcroForm import, detection, field building
src/pdf/         pdf.js setup, worker client, detection orchestration, OCR, font loading
src/workers/     background worker: export, form import, image analysis (keeps the UI responsive)
src/state/       undo/redo store, IndexedDB persistence and project files
src/desktop.ts   integration with the Windows launcher (open file passed by Explorer, window heartbeat)
desktop/         Windows launcher (Go): local server, Edge app window, per-user installer
src/ui/          React components (viewer, overlay, panels, dialogs)
tests/           Vitest unit and raster-alignment tests
e2e/             headless-browser end-to-end checks
scripts/         copies runtime assets (pdf.js data, OCR) into public/
```

Stack: React 19, TypeScript, Vite, pdf.js (rendering, text layer), pdf-lib + fontkit (writing PDFs), tesseract.js (optional local OCR), idb-keyval (IndexedDB), lucide-react (icons).

## Licences of bundled assets

DejaVu fonts — Bitstream Vera / DejaVu licence (`src/assets/fonts/LICENSE-DejaVu.txt`); Atkinson Hyperlegible Next — SIL Open Font License; pdf.js and tesseract.js — Apache-2.0; pdf-lib — MIT.
