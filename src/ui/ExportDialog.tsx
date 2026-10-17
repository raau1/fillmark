import { useMemo, useState } from 'react';
import { CircleAlert, Download, LoaderCircle, TriangleAlert, CheckCircle2 } from 'lucide-react';
import type { ExportMode } from '../core/exportPdf';
import { isChecked, valueKey } from '../core/layout';
import type { Field, PageInfo, Values } from '../core/types';
import { exportInWorker } from '../pdf/workerClient';
import { useT } from '../i18n';
import { Modal } from './Modal';
import { isAnswered } from './FillPanel';
import { baseName, downloadBlob, sanitizeFileName, todayIso } from './util';

interface Props {
  pdf: Uint8Array;
  fields: Field[];
  values: Values;
  pages: PageInfo[];
  fileName: string;
  overflowIds: Set<string>;
  smallSizes: Map<string, number>;
  onClose(): void;
  onGoToField(f: Field): void;
}

export function useDefaultExportName(fileName: string) {
  const t = useT();
  return `${baseName(fileName)}_${t('completed')}_${todayIso()}.pdf`;
}

export function missingRequired(fields: Field[], values: Values): Field[] {
  const seen = new Set<string>();
  const out: Field[] = [];
  for (const f of fields) {
    if (!f.required) continue;
    if (f.type === 'radio') {
      const k = valueKey(f);
      if (seen.has(k)) continue;
      seen.add(k);
      if (!fields.some((o) => o.type === 'radio' && valueKey(o) === k && isChecked(o, values))) out.push(f);
    } else if (!isAnswered(f, values)) out.push(f);
  }
  return out;
}

export function ExportDialog(p: Props) {
  const t = useT();
  const [name, setName] = useState(useDefaultExportName(p.fileName));
  const [mode, setMode] = useState<ExportMode>('flatten');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ warnings: string[] } | null>(null);

  const missing = useMemo(() => missingRequired(p.fields, p.values), [p.fields, p.values]);
  const overflow = useMemo(() => p.fields.filter((f) => p.overflowIds.has(f.id)), [p.fields, p.overflowIds]);
  const small = useMemo(() => p.fields.filter((f) => p.smallSizes.has(f.id)), [p.fields, p.smallSizes]);
  const unreviewed = p.fields.filter((f) => f.source === 'detected' && !f.reviewed).length;

  const run = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await exportInWorker(p.pdf, p.fields, p.values, mode, p.pages);
      downloadBlob(new Blob([res.bytes as BlobPart], { type: 'application/pdf' }), sanitizeFileName(name, '.pdf'));
      setDone({ warnings: res.warnings });
    } catch (e) {
      setError(t('Export failed: {msg}', { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('Export completed PDF')} onClose={p.onClose} wide>
      <div className="export-grid">
        <div>
          <label className="field-label" htmlFor="exp-name">
            {t('File name')}
          </label>
          <input id="exp-name" value={name} onChange={(e) => setName(e.target.value)} />

          <fieldset className="choice">
            <legend>{t('Type of PDF')}</legend>
            <label className={mode === 'flatten' ? 'on' : ''}>
              <input type="radio" name="mode" checked={mode === 'flatten'} onChange={() => setMode('flatten')} />
              <span>
                <strong>{t('Final copy (recommended)')}</strong>
                <span className="muted">{t('Answers are printed onto the pages and can no longer be changed. Looks the same in every PDF reader.')}</span>
              </span>
            </label>
            <label className={mode === 'editable' ? 'on' : ''}>
              <input type="radio" name="mode" checked={mode === 'editable'} onChange={() => setMode('editable')} />
              <span>
                <strong>{t('Editable form')}</strong>
                <span className="muted">{t('Answers stay in form fields that can still be changed in Acrobat, Preview, etc. Some readers redraw the text slightly differently.')}</span>
              </span>
            </label>
          </fieldset>
          <p className="note">{t('The PDF is created on this computer. Nothing is uploaded.')}</p>
        </div>

        <div className="checks" aria-live="polite">
          <h3>{t('Before you export')}</h3>
          {missing.length === 0 && overflow.length === 0 && small.length === 0 && unreviewed === 0 && (
            <p className="check-ok">
              <CheckCircle2 size={16} /> {t('No problems found.')}
            </p>
          )}
          {missing.length > 0 && (
            <div className="check-block warn">
              <p>
                <CircleAlert size={16} /> {t('{n} required fields are empty:', { n: missing.length })}
              </p>
              <ul>
                {missing.slice(0, 8).map((f) => (
                  <li key={f.id}>
                    <button className="link" onClick={() => p.onGoToField(f)}>
                      {f.name} <span className="muted">({t('page {n}', { n: f.page + 1 })})</span>
                    </button>
                  </li>
                ))}
                {missing.length > 8 && <li className="muted">{t('and {n} more', { n: missing.length - 8 })}</li>}
              </ul>
            </div>
          )}
          {small.length > 0 && (
            <div className="check-block">
              <p>{t('Very small text in {n} fields (shrunk to fit; nothing is cut off):', { n: small.length })}</p>
              <ul>
                {small.slice(0, 8).map((f) => (
                  <li key={f.id}>
                    <button className="link" onClick={() => p.onGoToField(f)}>
                      {f.name} <span className="muted">({t('page {n}', { n: f.page + 1 })}, {p.smallSizes.get(f.id)!.toLocaleString(undefined, { maximumFractionDigits: 1 })} pt)</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {overflow.length > 0 && (
            <div className="check-block danger">
              <p>
                <TriangleAlert size={16} /> {t('Text will be cut off in {n} fields:', { n: overflow.length })}
              </p>
              <ul>
                {overflow.slice(0, 8).map((f) => (
                  <li key={f.id}>
                    <button className="link" onClick={() => p.onGoToField(f)}>
                      {f.name} <span className="muted">({t('page {n}', { n: f.page + 1 })})</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {unreviewed > 0 && (
            <div className="check-block">
              <p>{t('{n} automatically suggested fields have not been checked. Answers in them are exported where the boxes are.', { n: unreviewed })}</p>
            </div>
          )}
          {error && (
            <div className="check-block danger" role="alert">
              <p>{error}</p>
            </div>
          )}
          {done && (
            <div className="check-block ok" role="status">
              <p>
                <CheckCircle2 size={16} /> {t('Downloaded “{name}”.', { name: sanitizeFileName(name, '.pdf') })}
              </p>
              {done.warnings.length > 0 && (
                <ul>
                  {done.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="modal-actions">
        <span className="spacer" />
        <button className="btn" onClick={p.onClose}>
          {done ? t('Close') : t('Cancel')}
        </button>
        <button className="btn primary" onClick={run} disabled={busy || !name.trim()}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
          {busy ? t('Creating PDF…') : missing.length || overflow.length ? t('Download anyway') : t('Download PDF')}
        </button>
      </div>
    </Modal>
  );
}
