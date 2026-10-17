import { useEffect, useState } from 'react';
import { Download, LoaderCircle, TriangleAlert, Settings2 } from 'lucide-react';
import type { Field, PageInfo, Values } from '../core/types';
import { exportInWorker } from '../pdf/workerClient';
import { closePdf, openPdf, readPageInfos, type PDFDocumentProxy } from '../pdf/pdfjs';
import { useT } from '../i18n';
import { Viewer, type ViewerHandle } from './Viewer';
import { useDefaultExportName } from './ExportDialog';
import { downloadBlob } from './util';
import { choosePdfDestination, writePdf } from '../state/fileSave';

/** Shows the real flattened output (generated locally), so what you see is what you download. */
export function PreviewPane({
  pdf,
  fields,
  values,
  pages,
  fileName,
  onExport,
  viewerRef,
  onCurrentPage,
}: {
  pdf: Uint8Array;
  fields: Field[];
  values: Values;
  pages: PageInfo[];
  fileName: string;
  onExport: () => void;
  viewerRef?: React.Ref<ViewerHandle>;
  onCurrentPage?: (p: number) => void;
}) {
  const t = useT();
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; msg: string } | { kind: 'ready'; doc: PDFDocumentProxy; pages: PageInfo[]; bytes: Uint8Array; warnings: string[] }
  >({ kind: 'loading' });
  const [scale, setScale] = useState(1);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const defaultName = useDefaultExportName(fileName);

  useEffect(() => {
    let cancelled = false;
    let doc: PDFDocumentProxy | null = null;
    (async () => {
      try {
        const res = await exportInWorker(pdf, fields, values, 'flatten', pages);
        const d = await openPdf(res.bytes);
        doc = d;
        const infos = await readPageInfos(d);
        if (cancelled) return closePdf(d);
        setState({ kind: 'ready', doc: d, pages: infos, bytes: res.bytes, warnings: res.warnings });
      } catch (e) {
        if (!cancelled) setState({ kind: 'error', msg: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
      closePdf(doc);
    };
    // generated once per visit to Preview
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.kind === 'loading')
    return (
      <div className="preview-status">
        <LoaderCircle className="spin" size={22} /> {t('Creating the PDF on this computer…')}
      </div>
    );
  if (state.kind === 'error')
    return (
      <div className="preview-status error" role="alert">
        <TriangleAlert size={20} /> {t('The preview could not be created: {msg}', { msg: state.msg })}
      </div>
    );

  return (
    <>
      <div className="preview-bar">
        {state.warnings.length > 0 ? (
          <details className="preview-warn">
            <summary>
              <TriangleAlert size={15} /> {t('{n} things to check', { n: state.warnings.length })}
            </summary>
            <ul>
              {state.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        ) : (
          <span className="muted">{t('This is the final PDF exactly as it will be saved.')}</span>
        )}
        <span className="spacer" />
        {savedMsg && (
          <span className="muted preview-saved" role="status">
            {savedMsg}
          </span>
        )}
        <button className="btn" onClick={onExport}>
          <Settings2 size={15} /> {t('Export options…')}
        </button>
        <button
          className="btn primary"
          onClick={async () => {
            try {
              const dest = await choosePdfDestination(defaultName);
              if (!dest) return;
              const saved = await writePdf(dest, new Blob([state.bytes as BlobPart], { type: 'application/pdf' }), defaultName, downloadBlob);
              setSavedMsg(saved.downloaded ? t('Downloaded “{name}”.', { name: saved.name }) : t('Saved “{name}”.', { name: saved.name }));
            } catch (e) {
              setSavedMsg(t('Export failed: {msg}', { msg: (e as Error).message }));
            }
          }}
        >
          <Download size={15} /> {t('Save this PDF…')}
        </button>
      </div>
      <Viewer
        ref={viewerRef}
        onCurrentPage={onCurrentPage}
        doc={state.doc}
        pages={state.pages}
        scale={scale}
        hideFormWidgets={false}
        label={t('Preview of the completed PDF')}
        onViewportResize={(s) => setScale(Math.min(2, (s.width - 52) / Math.max(...state.pages.map((p) => p.width))))}
      />
    </>
  );
}
