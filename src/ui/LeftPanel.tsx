import { useMemo, useState } from 'react';
import { AlignLeft, Calendar, CheckSquare, ChevronDownSquare, CircleDot, Hash, PenTool, StickyNote, TextCursorInput } from 'lucide-react';
import type { Field, FieldType, PageInfo, Values } from '../core/types';
import { isChecked } from '../core/layout';
import { useT } from '../i18n';
import type { ViewMode } from './Editor';
import { isAnswered } from './FillPanel';
import { cx, readingOrder } from './util';

const ICONS: Record<FieldType, typeof AlignLeft> = {
  text: TextCursorInput,
  multiline: AlignLeft,
  checkbox: CheckSquare,
  radio: CircleDot,
  date: Calendar,
  number: Hash,
  dropdown: ChevronDownSquare,
  signature: PenTool,
  label: StickyNote,
};

interface Props {
  pages: PageInfo[];
  thumbs: (string | undefined)[];
  currentPage: number;
  fields: Field[];
  values: Values;
  selection: string[];
  overflowIds: Set<string>;
  mode: ViewMode;
  onPage(i: number): void;
  onField(f: Field): void;
  onAcceptSuggestions(ids: string[]): void;
  onRemoveFields(ids: string[]): void;
}

export function LeftPanel(p: Props) {
  const t = useT();
  const [tab, setTab] = useState<'pages' | 'fields'>('pages');
  const suggested = useMemo(() => p.fields.filter((f) => f.source === 'detected' && !f.reviewed), [p.fields]);
  const byPage = useMemo(() => {
    const m = new Map<number, Field[]>();
    for (const f of [...p.fields].sort(readingOrder)) {
      if (!m.has(f.page)) m.set(f.page, []);
      m.get(f.page)!.push(f);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [p.fields]);
  const counts = useMemo(() => {
    const c = p.pages.map(() => 0);
    p.fields.forEach((f) => c[f.page]++);
    return c;
  }, [p.fields, p.pages]);

  return (
    <aside className="left" aria-label={t('Pages and fields')}>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'pages'} className={cx('tab', tab === 'pages' && 'on')} onClick={() => setTab('pages')}>
          {t('Pages')} <span className="count">{p.pages.length}</span>
        </button>
        <button role="tab" aria-selected={tab === 'fields'} className={cx('tab', tab === 'fields' && 'on')} onClick={() => setTab('fields')}>
          {t('Fields')} <span className="count">{p.fields.length}</span>
        </button>
      </div>

      {tab === 'pages' ? (
        <ol className="thumbs">
          {p.pages.map((pg, i) => (
            <li key={i}>
              <button className={cx('thumb', p.currentPage === i && 'on')} onClick={() => p.onPage(i)} aria-label={t('Page {n}', { n: i + 1 })} aria-current={p.currentPage === i ? 'page' : undefined}>
                <span className="thumb-img" style={{ aspectRatio: `${pg.width} / ${pg.height}` }}>
                  {p.thumbs[i] && <img src={p.thumbs[i]} alt="" />}
                </span>
                <span className="thumb-label">
                  <span>{i + 1}</span>
                  {counts[i] > 0 && <span className="muted small">{t('{n} fields', { n: counts[i] })}</span>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <div className="field-list">
          {suggested.length > 0 && (
            <div className="review-box">
              <p>{t('{n} suggested fields need a check. Suggestions are outlined in orange on the page.', { n: suggested.length })}</p>
              <div className="inline">
                <button className="btn small primary" onClick={() => p.onAcceptSuggestions(suggested.map((f) => f.id))}>
                  {t('Accept all')}
                </button>
                <button
                  className="btn small danger-ghost"
                  onClick={() => {
                    if (confirm(t('Remove all {n} suggested fields that you have not checked?', { n: suggested.length }))) p.onRemoveFields(suggested.map((f) => f.id));
                  }}
                >
                  {t('Remove all')}
                </button>
              </div>
            </div>
          )}
          {!p.fields.length && <p className="muted panel-pad">{t('No fields yet.')}</p>}
          {byPage.map(([page, fs]) => (
            <section key={page}>
              <h3 className="list-page">{t('Page {n}', { n: page + 1 })}</h3>
              <ul>
                {fs.map((f) => {
                  const Icon = ICONS[f.type];
                  const done = f.type === 'radio' ? isChecked(f, p.values) : isAnswered(f, p.values);
                  return (
                    <li key={f.id}>
                      <button
                        className={cx('field-row', p.selection.includes(f.id) && 'on', f.source === 'detected' && !f.reviewed && 'suggested')}
                        onClick={() => p.onField(f)}
                      >
                        <Icon size={14} aria-hidden="true" />
                        <span className="field-row-name">{f.name || t('(no label)')}</span>
                        {p.overflowIds.has(f.id) && <span className="dot warn" title={t('Text does not fit')} />}
                        {p.mode !== 'edit' && done && <span className="dot ok" title={t('Answered')} />}
                        {f.required && !done && <span className="dot req" title={t('Required')} />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </aside>
  );
}
