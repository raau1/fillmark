import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckSquare,
  Eye,
  FileDown,
  FolderDown,
  Home,
  Maximize,
  MoveHorizontal,
  PenLine,
  Redo2,
  Undo2,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import type { Measurer } from '../core/fonts';
import { createField, uid } from '../core/fieldFactory';
import { isChecked, valueKey } from '../core/layout';
import { clampRectToPage } from '../core/coords';
import type { Field, FieldType, PageInfo, ProjectData, Rect, Values } from '../core/types';
import type { PDFDocumentProxy } from '../pdf/pdfjs';
import { saveProject, projectFileBlob, PROJECT_FILE_EXT } from '../state/persistence';
import { patchField, useDocStore } from '../state/store';
import { useT, useLang } from '../i18n';
import { Viewer, useThumbnails, type ViewerHandle } from './Viewer';
import { FieldLayer, type EditorMode, type Tool } from './FieldLayer';
import { fieldOverflows, fieldSmallSize } from './FieldContent';
import { Toolbox } from './Toolbox';
import { PropertiesPanel } from './PropertiesPanel';
import { FillPanel } from './FillPanel';
import { LeftPanel } from './LeftPanel';
import { ExportDialog } from './ExportDialog';
import { PreviewPane } from './PreviewPane';
import { DetectDialog } from './DetectDialog';
import { baseName, cx, downloadBlob, isTypingTarget } from './util';

export type ViewMode = EditorMode | 'preview';
type ZoomMode = 'fit-width' | 'fit-page' | 'custom';
type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error';

interface Props {
  initial: ProjectData;
  pdf: Uint8Array;
  doc: PDFDocumentProxy;
  measurer: Measurer;
  formFieldCount: number;
  onClose(): void;
}

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export function Editor({ initial, pdf, doc, measurer, formFieldCount, onClose }: Props) {
  const t = useT();
  const { lang, setLang } = useLang();
  const [meta, setMeta] = useState(initial.meta);
  const [settings, setSettings] = useState(initial.settings);
  const pages: PageInfo[] = initial.pages;
  const [state, api] = useDocStore({ fields: initial.fields, values: initial.values });
  const { fields, values, selection } = state;

  const [mode, setMode] = useState<ViewMode>(initial.fields.length ? 'fill' : 'edit');
  const [tool, setTool] = useState<Tool>('select');
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit-width');
  const [scale, setScale] = useState(1);
  const [viewport, setViewport] = useState({ width: 900, height: 700 });
  const [currentPage, setCurrentPage] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ id: string; n: number; focus: boolean } | null>(null);
  const [highlightFields, setHighlightFields] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [exportOpen, setExportOpen] = useState(false);
  const [detectOpen, setDetectOpen] = useState(false);
  const [snapRects, setSnapRects] = useState<Record<number, Rect[]>>({});
  const [toast, setToast] = useState<string | null>(null);
  const viewerRef = useRef<ViewerHandle>(null);
  const clipboard = useRef<Field[]>([]);

  const thumbs = useThumbnails(doc, pages, 132, settings.hideOriginalWidgets);

  // ---------------------------------------------------------------- zoom
  const maxW = useMemo(() => Math.max(...pages.map((p) => p.width)), [pages]);
  const fitWidth = useCallback(() => Math.max(0.2, (viewport.width - 48 - 4) / maxW), [viewport.width, maxW]);
  const fitPage = useCallback(() => {
    const p = pages[currentPage] ?? pages[0];
    return Math.max(0.2, Math.min((viewport.width - 48) / p.width, (viewport.height - 48) / p.height));
  }, [pages, currentPage, viewport]);

  useEffect(() => {
    if (zoomMode === 'fit-width') setScale(Math.min(3, fitWidth()));
    else if (zoomMode === 'fit-page') setScale(fitPage());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomMode, viewport.width, viewport.height]);

  const zoomBy = useCallback((dir: 1 | -1) => {
    setZoomMode('custom');
    setScale((s) => {
      if (dir > 0) return ZOOM_STEPS.find((z) => z > s + 0.01) ?? s;
      return [...ZOOM_STEPS].reverse().find((z) => z < s - 0.01) ?? s;
    });
  }, []);

  // ctrl + wheel zoom on the viewer
  useEffect(() => {
    const el = viewerRef.current?.getElement();
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoomMode('custom');
      setScale((s) => Math.min(5, Math.max(0.25, s * Math.exp(-e.deltaY * 0.0025))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [mode]);

  // ---------------------------------------------------------------- autosave (this browser only)
  const dataRef = useRef<ProjectData | null>(null);
  dataRef.current = { meta, pages, fields, values, settings };
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    setSaveStatus('unsaved');
    const timer = setTimeout(async () => {
      setSaveStatus('saving');
      try {
        const d = dataRef.current!;
        const updated = { ...d, meta: { ...d.meta, updatedAt: Date.now() } };
        await saveProject(updated);
        setSaveStatus('saved');
      } catch {
        setSaveStatus('error');
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [state.revision, settings, meta.name]);

  // warn before closing the tab with unsaved changes
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (saveStatus === 'unsaved' || saveStatus === 'saving') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [saveStatus]);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((m) => (m === msg ? null : m)), 3200);
  }, []);

  // ---------------------------------------------------------------- derived
  const byPage = useMemo(() => {
    const m: Field[][] = pages.map(() => []);
    for (const f of fields) if (m[f.page]) m[f.page].push(f);
    return m;
  }, [fields, pages]);

  const overflowIds = useMemo(() => {
    const s = new Set<string>();
    for (const f of fields) if (fieldOverflows(f, values, measurer)) s.add(f.id);
    return s;
  }, [fields, values, measurer]);

  /** fields whose text was shrunk below a comfortable reading size to fit (complete, but tiny) */
  const smallSizes = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of fields) {
      const size = fieldSmallSize(f, values, measurer);
      if (size !== null) m.set(f.id, size);
    }
    return m;
  }, [fields, values, measurer]);

  const selectedFields = useMemo(() => fields.filter((f) => selection.includes(f.id)), [fields, selection]);

  // ---------------------------------------------------------------- field operations
  const onCreate = useCallback(
    (type: FieldType, page: number, rect: Rect) => {
      const f = createField(type, page, rect, { group: t('Page {n}', { n: page + 1 }) });
      if (type === 'radio') {
        // continue the radio group of the currently selected radio, if any
        const sel = fields.find((x) => x.id === selection[0] && x.type === 'radio');
        if (sel) {
          f.radioGroup = sel.radioGroup;
          f.group = sel.group;
          const n = fields.filter((x) => x.radioGroup === sel.radioGroup).length + 1;
          f.radioValue = t('Option {n}', { n });
          f.name = `${sel.name.split(':')[0]}: ${f.radioValue}`;
        } else {
          f.radioValue = t('Option {n}', { n: 1 });
        }
      }
      if (type === 'label') f.defaultValue = t('Note');
      f.name = type === 'radio' ? f.name : `${t(typeName(type))} ${fields.filter((x) => x.type === type).length + 1}`;
      api.updateFields((fs) => [...fs, f]);
      api.select([f.id]);
    },
    [api, fields, selection, t],
  );

  const onTransform = useCallback(
    (changes: { id: string; rect: Rect }[], key: string) => {
      const m = new Map(changes.map((c) => [c.id, c.rect]));
      api.updateFields((fs) => fs.map((f) => (m.has(f.id) ? { ...f, rect: m.get(f.id)!, reviewed: true } : f)), key);
    },
    [api],
  );

  const onSelect = useCallback(
    (ids: string[], how: 'replace' | 'toggle' | 'add') => {
      if (how === 'replace') api.select(ids);
      else if (how === 'add') api.select(Array.from(new Set([...selection, ...ids])));
      else api.select(selection.includes(ids[0]) ? selection.filter((x) => x !== ids[0]) : [...selection, ids[0]]);
    },
    [api, selection],
  );

  const setValue = useCallback(
    (f: Field, v: string | boolean, key?: string) => {
      api.updateValues((vals) => ({ ...vals, [valueKey(f)]: v }), key ?? `value:${valueKey(f)}`);
    },
    [api],
  );

  const onToggle = useCallback(
    (f: Field) => {
      setActiveId(f.id);
      if (f.type === 'checkbox') setValue(f, !isChecked(f, values), `toggle:${Date.now()}`);
      else setValue(f, isChecked(f, values) ? '' : f.radioValue, `toggle:${Date.now()}`);
    },
    [setValue, values],
  );

  const deleteSelected = useCallback(() => {
    if (!selection.length) return;
    const ids = new Set(selection);
    api.updateBoth(({ fields: fs, values: vs }) => {
      const remaining = fs.filter((f) => !ids.has(f.id));
      const keep = new Set(remaining.map(valueKey));
      const nv: Values = {};
      for (const [k, v] of Object.entries(vs)) if (keep.has(k)) nv[k] = v;
      return { fields: remaining, values: nv };
    });
    api.select([]);
  }, [api, selection]);

  const duplicate = useCallback(
    (src: Field[], dx: number, dy: number, page?: number) => {
      const copies = src.map((f) => {
        const p = page ?? f.page;
        const info = pages[p];
        return {
          ...f,
          id: uid(),
          page: p,
          source: 'manual' as const,
          reviewed: true,
          sourceName: undefined,
          rect: clampRectToPage({ ...f.rect, x: f.rect.x + dx, y: f.rect.y + dy }, info, 2),
        };
      });
      api.updateFields((fs) => [...fs, ...copies]);
      api.select(copies.map((c) => c.id));
    },
    [api, pages],
  );

  const nudge = useCallback(
    (dx: number, dy: number) => {
      const ids = new Set(selection);
      api.updateFields(
        (fs) => fs.map((f) => (ids.has(f.id) ? { ...f, rect: clampRectToPage({ ...f.rect, x: f.rect.x + dx, y: f.rect.y + dy }, pages[f.page], 1) } : f)),
        'nudge',
      );
    },
    [api, selection, pages],
  );

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const typing = isTypingTarget(e.target);
      if (mod && !typing && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) api.redo();
        else api.undo();
        return;
      }
      if (mod && !typing && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        api.redo();
        return;
      }
      if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoomBy(1);
        return;
      }
      if (mod && e.key === '-') {
        e.preventDefault();
        zoomBy(-1);
        return;
      }
      if (mod && e.key === '0') {
        e.preventDefault();
        setZoomMode('fit-width');
        return;
      }
      if (typing || mode !== 'edit') return;
      if (e.key === 'Escape') {
        setTool('select');
        api.select([]);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selection.length) {
        e.preventDefault();
        deleteSelected();
      } else if (e.key.startsWith('Arrow') && selection.length) {
        e.preventDefault();
        const st = e.shiftKey ? 10 : e.altKey ? 0.25 : 1;
        nudge(e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0, e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0);
      } else if (mod && e.key.toLowerCase() === 'd' && selectedFields.length) {
        e.preventDefault();
        duplicate(selectedFields, 0, Math.max(...selectedFields.map((f) => f.rect.h)) + 4);
      } else if (mod && e.key.toLowerCase() === 'c' && selectedFields.length) {
        clipboard.current = selectedFields;
      } else if (mod && e.key.toLowerCase() === 'v' && clipboard.current.length) {
        e.preventDefault();
        const samePage = clipboard.current[0].page === currentPage;
        duplicate(clipboard.current, samePage ? 8 : 0, samePage ? 8 : 0, currentPage);
      } else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        api.select(byPage[currentPage].map((f) => f.id));
      } else if (!mod && !e.altKey) {
        const k = e.key.toLowerCase();
        const map: Record<string, Tool> = { v: 'select', t: 'text', m: 'multiline', c: 'checkbox', r: 'radio', d: 'date', n: 'number' };
        if (map[k]) setTool(map[k]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [api, mode, selection, selectedFields, deleteSelected, nudge, duplicate, zoomBy, currentPage, byPage]);

  // ---------------------------------------------------------------- navigation between PDF and side panels
  const revealField = useCallback(
    (f: Field) => {
      viewerRef.current?.revealRect(f.page, f.rect);
      setActiveId(f.id);
    },
    [],
  );

  const onReveal = useCallback((f: Field) => {
    setActiveId(f.id);
    setFocusRequest((r) => ({ id: f.id, n: (r?.n ?? 0) + 1, focus: false }));
  }, []);

  const onActivate = useCallback((f: Field) => {
    setActiveId(f.id);
    setFocusRequest((r) => ({ id: f.id, n: (r?.n ?? 0) + 1, focus: true }));
  }, []);

  const goToField = useCallback(
    (f: Field) => {
      revealField(f);
      if (mode === 'edit') api.select([f.id]);
    },
    [revealField, mode, api],
  );

  // ---------------------------------------------------------------- project file
  const downloadProjectFile = useCallback(() => {
    const d = dataRef.current!;
    downloadBlob(projectFileBlob(d, pdf), `${baseName(meta.fileName)}${PROJECT_FILE_EXT}`);
    flash(t('Project file downloaded. Keep it somewhere safe: it contains the PDF and every answer.'));
  }, [pdf, meta.fileName, flash, t]);

  const addFields = useCallback(
    (newFields: Field[], newValues: Values = {}, opts: { hideOriginals?: boolean } = {}) => {
      api.updateBoth(({ fields: fs, values: vs }) => ({ fields: [...fs, ...newFields], values: { ...vs, ...newValues } }));
      if (opts.hideOriginals) setSettings((s) => ({ ...s, hideOriginalWidgets: true }));
    },
    [api],
  );

  // ---------------------------------------------------------------- render
  const pageCount = pages.length;
  const statusText: Record<SaveStatus, string> = {
    saved: t('Saved in this browser'),
    saving: t('Saving…'),
    unsaved: t('Unsaved changes'),
    error: t('Could not save in this browser — download the project file'),
  };

  const renderOverlay = (i: number) => (
    <FieldLayer
      page={i}
      info={pages[i]}
      scale={scale}
      fields={byPage[i]}
      values={values}
      measurer={measurer}
      mode={mode === 'edit' ? 'edit' : 'fill'}
      selection={selection}
      activeId={activeId}
      tool={tool}
      highlightFields={highlightFields}
      overflowIds={overflowIds}
      snapRects={snapRects[i]}
      onSelect={onSelect}
      onCreate={onCreate}
      onTransform={onTransform}
      onActivate={onActivate}
      onReveal={onReveal}
      onHighlight={(f) => setActiveId(f.id)}
      onToggle={onToggle}
      onTextValue={(f, v) => setValue(f, v)}
    />
  );

  return (
    <div className={cx('app', `mode-${mode}`)}>
      <header className="topbar">
        <button className="icon-btn" onClick={onClose} title={t('All projects')} aria-label={t('All projects')}>
          <Home size={18} />
        </button>
        <div className="doc-title">
          <input
            className="doc-name"
            value={meta.name}
            aria-label={t('Project name')}
            onChange={(e) => setMeta((m) => ({ ...m, name: e.target.value }))}
          />
          <span className={cx('save-status', saveStatus)} role="status" aria-live="polite">
            {statusText[saveStatus]}
          </span>
        </div>

        <nav className="mode-switch" aria-label={t('Mode')}>
          {(
            [
              ['edit', t('Edit form'), <PenLine size={16} key="i" />],
              ['fill', t('Fill form'), <CheckSquare size={16} key="i" />],
              ['preview', t('Preview PDF'), <Eye size={16} key="i" />],
            ] as const
          ).map(([m, label, icon]) => (
            <button key={m} className={cx('mode-btn', mode === m && 'on')} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {icon}
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="topbar-actions">
          <button className="icon-btn" onClick={api.undo} disabled={!state.past.length} title={t('Undo (Ctrl+Z)')} aria-label={t('Undo')}>
            <Undo2 size={18} />
          </button>
          <button className="icon-btn" onClick={api.redo} disabled={!state.future.length} title={t('Redo (Ctrl+Shift+Z)')} aria-label={t('Redo')}>
            <Redo2 size={18} />
          </button>
          <button className="btn ghost" onClick={downloadProjectFile} title={t('Download a project file you can reopen later on any computer')}>
            <FolderDown size={16} />
            <span className="hide-sm">{t('Save project file')}</span>
          </button>
          <button className="btn primary" onClick={() => setExportOpen(true)}>
            <FileDown size={16} />
            <span>{t('Export PDF')}</span>
          </button>
          <button className="lang-btn" onClick={() => setLang(lang === 'es' ? 'en' : 'es')} title={lang === 'es' ? 'English' : 'Español'}>
            {lang === 'es' ? 'EN' : 'ES'}
          </button>
        </div>
      </header>

      <div className="workspace">
        <LeftPanel
          pages={pages}
          thumbs={thumbs}
          currentPage={currentPage}
          fields={fields}
          values={values}
          selection={selection}
          overflowIds={overflowIds}
          mode={mode}
          onPage={(i) => viewerRef.current?.scrollToPage(i)}
          onField={goToField}
          onAcceptSuggestions={(ids) => api.updateFields((fs) => fs.map((f) => (ids.includes(f.id) ? { ...f, reviewed: true } : f)))}
          onRemoveFields={(ids) => {
            api.select(ids);
            const set = new Set(ids);
            api.updateFields((fs) => fs.filter((f) => !set.has(f.id)));
          }}
        />

        <main className="center">
          {mode === 'edit' && (
            <Toolbox
              tool={tool}
              setTool={setTool}
              onDetect={() => setDetectOpen(true)}
              selectionCount={selection.length}
              onAlign={(kind) => api.updateFields((fs) => alignFields(fs, selection, kind))}
            />
          )}
          {mode === 'fill' && (
            <div className="fill-hint">
              <span>{t('Click a box on the page to type in it or tick it, or use the form on the right.')}</span>
              <label className="switch">
                <input type="checkbox" checked={highlightFields} onChange={(e) => setHighlightFields(e.target.checked)} />
                <span>{t('Highlight fields')}</span>
              </label>
            </div>
          )}
          {mode === 'preview' ? (
            <PreviewPane
              pdf={pdf}
              fields={fields}
              values={values}
              pages={pages}
              fileName={meta.fileName}
              onExport={() => setExportOpen(true)}
              viewerRef={viewerRef}
              onCurrentPage={setCurrentPage}
            />
          ) : (
            <Viewer
              ref={viewerRef}
              doc={doc}
              pages={pages}
              scale={scale}
              hideFormWidgets={settings.hideOriginalWidgets}
              renderOverlay={renderOverlay}
              onCurrentPage={setCurrentPage}
              onViewportResize={setViewport}
              placeholders={thumbs}
              label={t('PDF pages')}
            />
          )}
          {mode !== 'preview' && (
            <div className="zoombar" role="toolbar" aria-label={t('Page and zoom')}>
              <button className="icon-btn" aria-label={t('Previous page')} disabled={currentPage === 0} onClick={() => viewerRef.current?.scrollToPage(currentPage - 1)}>
                <ChevronLeft size={16} />
              </button>
              <span className="page-counter" aria-live="polite">
                {t('Page {a} of {b}', { a: currentPage + 1, b: pageCount })}
              </span>
              <button className="icon-btn" aria-label={t('Next page')} disabled={currentPage >= pageCount - 1} onClick={() => viewerRef.current?.scrollToPage(currentPage + 1)}>
                <ChevronRight size={16} />
              </button>
              <span className="sep" />
              <button className="icon-btn" aria-label={t('Zoom out')} onClick={() => zoomBy(-1)}>
                <ZoomOut size={16} />
              </button>
              <span className="zoom-value">{Math.round(scale * 100)}%</span>
              <button className="icon-btn" aria-label={t('Zoom in')} onClick={() => zoomBy(1)}>
                <ZoomIn size={16} />
              </button>
              <button className={cx('btn small', zoomMode === 'fit-width' && 'on')} onClick={() => setZoomMode('fit-width')} title={t('Fit to width')}>
                <MoveHorizontal size={14} />
                <span className="hide-sm">{t('Width')}</span>
              </button>
              <button className={cx('btn small', zoomMode === 'fit-page' && 'on')} onClick={() => setZoomMode('fit-page')} title={t('Fit page')}>
                <Maximize size={14} />
                <span className="hide-sm">{t('Page')}</span>
              </button>
            </div>
          )}
        </main>

        <aside className="right" aria-label={mode === 'edit' ? t('Field properties') : t('Form')}>
          {mode === 'edit' && (
            <PropertiesPanel
              fields={selectedFields}
              allFields={fields}
              values={values}
              pages={pages}
              formFieldCount={formFieldCount}
              onImportDetect={() => setDetectOpen(true)}
              onChange={(ids, patch, key) => {
                const set = new Set(ids);
                api.updateFields(
                  (fs) =>
                    fs.map((f) => {
                      if (!set.has(f.id)) return f;
                      const next = applyPatch(f, patch);
                      // geometry typed in the panel is kept on the page
                      return patch.rect ? { ...next, rect: clampRectToPage(next.rect, pages[f.page], 2) } : next;
                    }),
                  key,
                );
              }}
              onRename={(id, name) => api.updateFields((fs) => patchField(fs, id, { name }), `name:${id}`)}
              onDelete={deleteSelected}
              onDuplicate={() => duplicate(selectedFields, 0, Math.max(...selectedFields.map((f) => f.rect.h)) + 4)}
            />
          )}
          {mode === 'fill' && (
            <FillPanel
              fields={fields}
              values={values}
              activeId={activeId}
              focusRequest={focusRequest}
              overflowIds={overflowIds}
              smallSizes={smallSizes}
              onFocusField={revealField}
              onValue={setValue}
              onResetField={(f) =>
                api.updateValues((vs) => {
                  const n = { ...vs };
                  delete n[valueKey(f)];
                  return n;
                }, `reset:${Date.now()}`)
              }
              onClearAll={() => api.updateValues(() => ({}), `clear:${Date.now()}`)}
              onEditForm={() => setMode('edit')}
            />
          )}
          {mode === 'preview' && <div className="panel-pad muted">{t('This preview shows the exact PDF that will be downloaded. Nothing here is uploaded anywhere.')}</div>}
        </aside>
      </div>

      {exportOpen && (
        <ExportDialog
          pdf={pdf}
          fields={fields}
          values={values}
          pages={pages}
          fileName={meta.fileName}
          overflowIds={overflowIds}
          smallSizes={smallSizes}
          onClose={() => setExportOpen(false)}
          onGoToField={(f) => {
            setExportOpen(false);
            setMode('fill');
            setTimeout(() => {
              revealField(f);
              onActivate(f);
            }, 50);
          }}
        />
      )}
      {detectOpen && (
        <DetectDialog
          pdf={pdf}
          doc={doc}
          pages={pages}
          existing={fields}
          formFieldCount={formFieldCount}
          currentPage={currentPage}
          hideFormWidgets={settings.hideOriginalWidgets}
          onClose={() => setDetectOpen(false)}
          onSnapRects={(snap) => setSnapRects((s) => ({ ...s, ...snap }))}
          onAdd={(nf, nv, opts) => {
            addFields(nf, nv, opts);
            setDetectOpen(false);
            flash(
              nf.some((f) => f.source === 'detected')
                ? t('{n} fields added. Suggested fields have an orange outline until you check them.', { n: nf.length })
                : t('{n} fields imported.', { n: nf.length }),
            );
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function typeName(t: FieldType) {
  const m: Record<FieldType, string> = {
    text: 'Text',
    multiline: 'Long text',
    checkbox: 'Checkbox',
    radio: 'Option',
    date: 'Date',
    number: 'Number',
    dropdown: 'Dropdown',
    signature: 'Signature',
    label: 'Note',
  };
  return m[t];
}

export type FieldPatch = Partial<Omit<Field, 'style'>> & { style?: Partial<Field['style']> };

function applyPatch(f: Field, patch: FieldPatch): Field {
  const { style, ...rest } = patch;
  return { ...f, ...rest, style: style ? { ...f.style, ...style } : f.style, reviewed: true };
}

export type AlignKind = 'left' | 'right' | 'top' | 'bottom' | 'same-size' | 'distribute-v' | 'distribute-h';

function alignFields(fs: Field[], ids: string[], kind: AlignKind): Field[] {
  const sel = fs.filter((f) => ids.includes(f.id));
  if (sel.length < 2) return fs;
  const first = sel[0];
  const minX = Math.min(...sel.map((f) => f.rect.x));
  const maxR = Math.max(...sel.map((f) => f.rect.x + f.rect.w));
  const minY = Math.min(...sel.map((f) => f.rect.y));
  const maxB = Math.max(...sel.map((f) => f.rect.y + f.rect.h));
  const upd = new Map<string, Rect>();
  if (kind === 'distribute-v' || kind === 'distribute-h') {
    const v = kind === 'distribute-v';
    const sorted = [...sel].sort((a, b) => (v ? a.rect.y - b.rect.y : a.rect.x - b.rect.x));
    const start = v ? sorted[0].rect.y : sorted[0].rect.x;
    const end = v ? sorted[sorted.length - 1].rect.y : sorted[sorted.length - 1].rect.x;
    const step = (end - start) / (sorted.length - 1);
    sorted.forEach((f, i) => upd.set(f.id, v ? { ...f.rect, y: start + i * step } : { ...f.rect, x: start + i * step }));
  } else {
    for (const f of sel) {
      const r = { ...f.rect };
      if (kind === 'left') r.x = minX;
      if (kind === 'right') r.x = maxR - r.w;
      if (kind === 'top') r.y = minY;
      if (kind === 'bottom') r.y = maxB - r.h;
      if (kind === 'same-size') {
        r.w = first.rect.w;
        r.h = first.rect.h;
      }
      upd.set(f.id, r);
    }
  }
  return fs.map((f) => (upd.has(f.id) ? { ...f, rect: upd.get(f.id)! } : f));
}
