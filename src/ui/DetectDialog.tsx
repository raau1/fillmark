import { useMemo, useRef, useState } from 'react';
import { LoaderCircle, ScanSearch, TriangleAlert } from 'lucide-react';
import type { Field, PageInfo, Rect, Values } from '../core/types';
import type { PDFDocumentProxy } from '../pdf/pdfjs';
import { importFormInWorker } from '../pdf/workerClient';
import { runDetection, type DetectionResult } from '../pdf/detection';
import type { Naming } from '../core/detectFields';
import { useT } from '../i18n';
import { Modal } from './Modal';

interface Props {
  pdf: Uint8Array;
  doc: PDFDocumentProxy;
  pages: PageInfo[];
  existing: Field[];
  formFieldCount: number;
  currentPage: number;
  hideFormWidgets: boolean;
  onClose(): void;
  onSnapRects(snap: Record<number, Rect[]>): void;
  onAdd(fields: Field[], values: Values, opts: { hideOriginals?: boolean }): void;
}

type Phase = { kind: 'setup' } | { kind: 'running'; page: number; done: number; total: number; step: string } | { kind: 'done'; result: DetectionResult };

export function DetectDialog(p: Props) {
  const t = useT();
  const [scope, setScope] = useState<'all' | 'current'>('all');
  const [checkboxes, setCheckboxes] = useState(true);
  const [boxes, setBoxes] = useState(true);
  const [lines, setLines] = useState(true);
  const [choiceGroups, setChoiceGroups] = useState(true);
  const [ocr, setOcr] = useState(true);
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const cancel = useRef({ cancelled: false });
  const alreadyImported = p.existing.some((f) => f.source === 'imported');

  const naming: Naming = useMemo(
    () => ({
      page: (n) => t('Page {n}', { n }),
      list: (page, n) => t('Page {page}, list {n}', { page, n }),
      checkbox: (n) => t('Checkbox {n}', { n }),
      textBox: (n) => t('Text {n}', { n }),
      longText: (n) => t('Long text {n}', { n }),
      choice: (n) => t('Choice {n}', { n }),
      option: (n) => t('Option {n}', { n }),
    }),
    [t],
  );

  const importForm = async () => {
    setImporting(true);
    setError(null);
    try {
      const r = await importFormInWorker(p.pdf);
      p.onAdd(r.fields, r.values, { hideOriginals: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const start = async () => {
    setError(null);
    cancel.current = { cancelled: false };
    const pages = scope === 'all' ? p.pages.map((_, i) => i) : [p.currentPage];
    const steps = { render: t('Rendering'), analyse: t('Looking for boxes'), read: t('Reading labels (OCR)') };
    try {
      setPhase({ kind: 'running', page: pages[0], done: 0, total: pages.length, step: steps.render });
      const result = await runDetection(p.doc, p.pages, {
        pages,
        checkboxes,
        boxes,
        lines,
        choiceGroups,
        ocr: ocr ? 'auto' : 'off',
        existing: p.existing,
        naming,
        hideFormWidgets: p.hideFormWidgets || alreadyImported,
        signal: cancel.current,
        onProgress: (page, done, total, step) => setPhase({ kind: 'running', page, done, total, step: steps[step] }),
      });
      p.onSnapRects(result.snap);
      if (cancel.current.cancelled) {
        setPhase({ kind: 'setup' });
        return;
      }
      setPhase({ kind: 'done', result });
    } catch (e) {
      setError(t('Detection failed: {msg}', { msg: (e as Error).message }));
      setPhase({ kind: 'setup' });
    }
  };

  const close = () => {
    cancel.current.cancelled = true;
    p.onClose();
  };

  return (
    <Modal title={t('Detect fields')} onClose={close}>
      {p.formFieldCount > 0 && phase.kind === 'setup' && (
        <section className="detect-section">
          <h3>{t('Interactive fields in this PDF')}</h3>
          <p className="muted">
            {alreadyImported
              ? t('The {n} interactive fields of this PDF have been imported.', { n: p.formFieldCount })
              : t('This PDF already contains {n} interactive fields. Importing them is the most reliable option.', { n: p.formFieldCount })}
          </p>
          <button className="btn primary" disabled={importing || alreadyImported} onClick={importForm}>
            {importing && <LoaderCircle size={16} className="spin" />} {t('Import interactive fields')}
          </button>
        </section>
      )}

      {phase.kind === 'setup' && (
        <section className="detect-section">
          <h3>{t('Find printed boxes on the page')}</h3>
          <p className="muted">{t('Looks at the page image for empty boxes, squares to tick and blank lines. Results are suggestions for you to check.')}</p>
          <div className="detect-options">
            <fieldset>
              <legend>{t('Pages')}</legend>
              <label className="check">
                <input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} />
                {t('All {n} pages', { n: p.pages.length })}
              </label>
              <label className="check">
                <input type="radio" name="scope" checked={scope === 'current'} onChange={() => setScope('current')} />
                {t('Only page {n}', { n: p.currentPage + 1 })}
              </label>
            </fieldset>
            <fieldset>
              <legend>{t('Look for')}</legend>
              <label className="check">
                <input type="checkbox" checked={checkboxes} onChange={(e) => setCheckboxes(e.target.checked)} />
                {t('Squares and circles to tick')}
              </label>
              <label className="check">
                <input type="checkbox" checked={boxes} onChange={(e) => setBoxes(e.target.checked)} />
                {t('Empty text boxes')}
              </label>
              <label className="check">
                <input type="checkbox" checked={lines} onChange={(e) => setLines(e.target.checked)} />
                {t('Blank lines after a label')}
              </label>
            </fieldset>
            <fieldset>
              <legend>{t('Options')}</legend>
              <label className="check">
                <input type="checkbox" checked={choiceGroups} onChange={(e) => setChoiceGroups(e.target.checked)} />
                {t('Treat small rows like “Sí / No” as one choice')}
              </label>
              <label className="check">
                <input type="checkbox" checked={ocr} onChange={(e) => setOcr(e.target.checked)} />
                {t('Read labels from the image when the PDF has no text (OCR on this computer, slower)')}
              </label>
            </fieldset>
          </div>
          {error && (
            <p className="field-msg error" role="alert">
              <TriangleAlert size={14} /> {error}
            </p>
          )}
          <div className="modal-actions">
            <span className="spacer" />
            <button className="btn" onClick={close}>
              {t('Cancel')}
            </button>
            <button className="btn primary" disabled={!checkboxes && !boxes && !lines} onClick={start}>
              <ScanSearch size={16} /> {t('Find fields')}
            </button>
          </div>
        </section>
      )}

      {phase.kind === 'running' && (
        <section className="detect-section" aria-live="polite">
          <p>
            <LoaderCircle size={16} className="spin" /> {t('{step}: page {page} ({done} of {total} done)', { step: phase.step, page: phase.page + 1, done: phase.done, total: phase.total })}
          </p>
          <div className="progress">
            <span style={{ width: `${(100 * phase.done) / phase.total}%` }} />
          </div>
          <div className="modal-actions">
            <span className="spacer" />
            <button className="btn" onClick={() => (cancel.current.cancelled = true)}>
              {t('Stop')}
            </button>
          </div>
        </section>
      )}

      {phase.kind === 'done' && (
        <section className="detect-section">
          {phase.result.fields.length ? (
            <>
              <p>
                <strong>{t('{n} fields found', { n: phase.result.fields.length })}</strong>
              </p>
              <ul className="detect-summary">
                {phase.result.counts.checkbox > 0 && <li>{t('{n} squares to tick', { n: phase.result.counts.checkbox })}</li>}
                {phase.result.counts.radio > 0 && <li>{t('{n} circles', { n: phase.result.counts.radio })}</li>}
                {phase.result.counts.box + phase.result.counts.multibox > 0 && <li>{t('{n} text boxes', { n: phase.result.counts.box + phase.result.counts.multibox })}</li>}
                {phase.result.counts.line > 0 && <li>{t('{n} blank lines', { n: phase.result.counts.line })}</li>}
                {phase.result.skippedExisting > 0 && <li className="muted">{t('{n} skipped because a field is already there', { n: phase.result.skippedExisting })}</li>}
              </ul>
              {phase.result.labelSource.none > 0 && (
                <p className="note">{t('Some pages have no readable text, so their fields get numbered names. You can rename them in Edit form.')}</p>
              )}
              {phase.result.labelSource.ocr > 0 && <p className="note">{t('Labels on pages without text were read with OCR and may contain mistakes.')}</p>}
              <p className="note">{t('The new fields are outlined in orange until you check them. Remove anything that is not a real answer box.')}</p>
            </>
          ) : (
            <p>{t('No new fields were found. You can still place fields by hand with the tools above the page.')}</p>
          )}
          <div className="modal-actions">
            <span className="spacer" />
            <button className="btn" onClick={close}>
              {t('Cancel')}
            </button>
            {phase.result.fields.length > 0 && (
              <button className="btn primary" onClick={() => p.onAdd(phase.result.fields, {}, {})}>
                {t('Add {n} suggested fields', { n: phase.result.fields.length })}
              </button>
            )}
          </div>
        </section>
      )}
    </Modal>
  );
}
