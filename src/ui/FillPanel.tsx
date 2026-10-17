import { useEffect, useMemo, useRef, useState } from 'react';
import { Eraser, PenTool, RotateCcw, Search, Settings2, TriangleAlert } from 'lucide-react';
import { effectiveValue, isChecked, valueKey } from '../core/layout';
import type { Field, Values } from '../core/types';
import { useT } from '../i18n';
import { SignaturePad } from './SignaturePad';
import { cx, readingOrder } from './util';

interface Props {
  fields: Field[];
  values: Values;
  activeId: string | null;
  focusRequest: { id: string; n: number; focus: boolean } | null;
  overflowIds: Set<string>;
  smallSizes: Map<string, number>;
  onFocusField(f: Field): void;
  onValue(f: Field, v: string | boolean, key?: string): void;
  onResetField(f: Field): void;
  onClearAll(): void;
  onEditForm(): void;
}

type Item = { kind: 'field'; field: Field } | { kind: 'radio'; group: string; options: Field[] };

export function isAnswered(f: Field, values: Values): boolean {
  if (f.type === 'label') return false;
  const v = effectiveValue(f, values);
  if (f.type === 'checkbox') return v === true;
  return typeof v === 'string' && v.trim() !== '';
}

export function FillPanel(p: Props) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [signing, setSigning] = useState<Field | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    const fillable = p.fields.filter((f) => f.type !== 'label').sort(readingOrder);
    const q = query.trim().toLowerCase();
    const shown = q ? fillable.filter((f) => `${f.name} ${f.group} ${f.radioValue}`.toLowerCase().includes(q)) : fillable;
    const map = new Map<string, Item[]>();
    const seenRadio = new Set<string>();
    for (const f of shown) {
      const g = f.group || t('Other fields');
      if (!map.has(g)) map.set(g, []);
      if (f.type === 'radio') {
        const key = valueKey(f);
        if (seenRadio.has(key)) continue;
        seenRadio.add(key);
        map.get(g)!.push({ kind: 'radio', group: key, options: shown.filter((x) => x.type === 'radio' && valueKey(x) === key) });
      } else map.get(g)!.push({ kind: 'field', field: f });
    }
    return [...map.entries()];
  }, [p.fields, query, t]);

  const answerable = p.fields.filter((f) => f.type !== 'label' && f.type !== 'radio').length + new Set(p.fields.filter((f) => f.type === 'radio').map(valueKey)).size;
  const answered =
    p.fields.filter((f) => f.type !== 'radio' && isAnswered(f, p.values)).length +
    new Set(p.fields.filter((f) => f.type === 'radio' && isChecked(f, p.values)).map(valueKey)).size;

  // PDF → panel: focus the matching input
  useEffect(() => {
    if (!p.focusRequest) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-input-for="${p.focusRequest.id}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (p.focusRequest.focus) el.focus({ preventScroll: true });
    }
  }, [p.focusRequest]);

  if (!p.fields.length) {
    return (
      <div className="panel-pad empty-panel">
        <Settings2 size={28} className="empty-icon" />
        <h2>{t('This form has no fields yet')}</h2>
        <p>{t('Switch to Edit form to detect the boxes on the page or place fields by hand.')}</p>
        <button className="btn primary block" onClick={p.onEditForm}>
          {t('Set up fields')}
        </button>
      </div>
    );
  }

  return (
    <div className="panel-scroll fill-panel" ref={listRef}>
      <div className="panel-head sticky">
        <div className="progress-line">
          <h2>{t('Fill form')}</h2>
          <span className="muted">{t('{a} of {b} answered', { a: answered, b: answerable })}</span>
        </div>
        <div className="progress" aria-hidden="true">
          <span style={{ width: `${answerable ? (100 * answered) / answerable : 0}%` }} />
        </div>
        <div className="search">
          <Search size={15} />
          <input type="search" placeholder={t('Find a field')} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t('Find a field')} />
        </div>
      </div>

      {groups.map(([g, items]) => (
        <details key={g} className="fill-group" open>
          <summary>
            <span>{g}</span>
            <span className="muted count">{items.length}</span>
          </summary>
          <div className="fill-items">
            {items.map((it) =>
              it.kind === 'radio' ? (
                <RadioItem key={it.group} options={it.options} {...p} />
              ) : (
                <FieldInput key={it.field.id} field={it.field} {...p} onSign={setSigning} />
              ),
            )}
          </div>
        </details>
      ))}

      <div className="panel-actions">
        <button
          className="btn danger-ghost"
          onClick={() => {
            if (confirm(t('Clear every answer in this form? You can undo this.'))) p.onClearAll();
          }}
        >
          <Eraser size={15} /> {t('Clear all answers')}
        </button>
      </div>
      {signing && (
        <SignaturePad
          onCancel={() => setSigning(null)}
          onSave={(url) => {
            p.onValue(signing, url, `sign:${Date.now()}`);
            setSigning(null);
          }}
        />
      )}
    </div>
  );
}

function FieldInput({ field: f, values, activeId, overflowIds, smallSizes, onFocusField, onValue, onResetField, onSign }: Props & { field: Field; onSign: (f: Field) => void }) {
  const t = useT();
  const v = effectiveValue(f, values);
  const active = activeId === f.id;
  const common = {
    'data-input-for': f.id,
    onFocus: () => onFocusField(f),
    'aria-required': f.required || undefined,
  };
  const label = (
    <>
      {f.name}
      {f.required && <span className="req" aria-hidden="true"> *</span>}
    </>
  );

  if (f.type === 'checkbox') {
    return (
      <label className={cx('fill-check', active && 'active')}>
        <input type="checkbox" checked={v === true} onChange={(e) => onValue(f, e.target.checked, `toggle:${Date.now()}`)} {...common} />
        <span>{label}</span>
      </label>
    );
  }

  const str = typeof v === 'string' ? v : '';
  const reset =
    str !== '' ? (
      <button className="icon-btn tiny" onClick={() => onResetField(f)} aria-label={t('Clear this answer')} title={t('Clear this answer')}>
        <RotateCcw size={13} />
      </button>
    ) : null;
  const numberInvalid = f.type === 'number' && str !== '' && !/^[-+]?\d+([.,]\d+)?$/.test(str.trim());

  return (
    <div className={cx('fill-field', active && 'active')}>
      <div className="fill-label">
        <label htmlFor={`in-${f.id}`}>{label}</label>
        {reset}
      </div>
      {f.type === 'multiline' && <textarea id={`in-${f.id}`} rows={3} value={str} onChange={(e) => onValue(f, e.target.value)} {...common} />}
      {(f.type === 'text' || f.type === 'number') && (
        <input
          id={`in-${f.id}`}
          type="text"
          inputMode={f.type === 'number' ? 'decimal' : undefined}
          value={str}
          aria-invalid={numberInvalid || undefined}
          onChange={(e) => onValue(f, e.target.value)}
          {...common}
        />
      )}
      {f.type === 'date' && (
        <div className="inline">
          <input id={`in-${f.id}`} type="date" value={/^\d{4}-\d{2}-\d{2}$/.test(str) ? str : ''} onChange={(e) => onValue(f, e.target.value)} {...common} />
          <span className="muted small">{f.style.dateFormat}</span>
        </div>
      )}
      {f.type === 'dropdown' && (
        <select id={`in-${f.id}`} value={str} onChange={(e) => onValue(f, e.target.value)} {...common}>
          <option value="">{t('— choose —')}</option>
          {f.options.filter(Boolean).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )}
      {f.type === 'signature' && (
        <div className="inline">
          {str.startsWith('data:') && <img src={str} alt={t('Signature')} className="sig-thumb" />}
          <button className="btn small" onClick={() => onSign(f)} {...common}>
            <PenTool size={14} /> {str ? t('Sign again') : t('Sign')}
          </button>
        </div>
      )}
      {numberInvalid && <p className="field-msg error">{t('Enter a number, e.g. 12 or 3,5')}</p>}
      {overflowIds.has(f.id) && (
        <p className="field-msg warn">
          <TriangleAlert size={13} /> {t('Too long for the box: the end will be cut off. Shorten it or enlarge the box in Edit form.')}
        </p>
      )}
      {smallSizes.has(f.id) && (
        <p className="field-msg note">
          {t('Shrunk to {pt} pt to fit the box: it may be hard to read on paper. Shorten it or make the box bigger in Edit form if needed.', {
            pt: smallSizes.get(f.id)!.toLocaleString(undefined, { maximumFractionDigits: 1 }),
          })}
        </p>
      )}
    </div>
  );
}

function RadioItem({ options, values, activeId, onFocusField, onValue, onResetField }: Props & { options: Field[] }) {
  const t = useT();
  const first = options[0];
  const title = first.name.includes(':') ? first.name.split(':')[0] : first.radioGroup;
  const selected = options.find((o) => isChecked(o, values));
  return (
    <fieldset className={cx('fill-radio', options.some((o) => o.id === activeId) && 'active')}>
      <legend>
        {title}
        {first.required && <span className="req"> *</span>}
        {selected && (
          <button className="icon-btn tiny" onClick={() => onResetField(first)} aria-label={t('Clear this answer')} title={t('Clear this answer')}>
            <RotateCcw size={13} />
          </button>
        )}
      </legend>
      {options.map((o) => (
        <label key={o.id} className="fill-check">
          <input
            type="radio"
            name={valueKey(o)}
            checked={selected?.id === o.id}
            data-input-for={o.id}
            onFocus={() => onFocusField(o)}
            onChange={() => onValue(o, o.radioValue, `toggle:${Date.now()}`)}
          />
          <span>{o.radioValue}</span>
        </label>
      ))}
    </fieldset>
  );
}
