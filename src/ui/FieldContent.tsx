import { memo } from 'react';
import { FONTS, type Measurer } from '../core/fonts';
import { displayText, effectiveValue, isChecked, isTextType, layoutText, markGeometry, type TextLayout } from '../core/layout';
import type { Field, Values } from '../core/types';

/**
 * Draws what will be printed for a field, in display points, inside an SVG
 * whose viewBox equals the page size. Uses the SAME layout and mark geometry
 * as the PDF exporter. Each line is forced to its measured width with
 * textLength, so on-screen text occupies exactly the space it will in the PDF.
 */
export const FieldContent = memo(function FieldContent({
  field,
  values,
  measurer,
  showPlaceholder,
}: {
  field: Field;
  values: Values;
  measurer: Measurer;
  showPlaceholder: boolean;
}) {
  const { rect, style } = field;
  const deco =
    style.background || style.border ? (
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        fill={style.background ?? 'none'}
        fillOpacity={style.background ? style.backgroundOpacity : undefined}
        stroke={style.border ? style.borderColor : 'none'}
        strokeWidth={style.border ? style.borderWidth : 0}
      />
    ) : null;

  if (isTextType(field.type)) {
    const text = displayText(field, values);
    if (!text) {
      return (
        <g>
          {deco}
          {showPlaceholder && field.type !== 'label' && rect.h >= 7 && (
            <text
              x={rect.x + 2}
              y={rect.y + rect.h / 2}
              dominantBaseline="central"
              className="placeholder-text"
              fontSize={Math.min(9, rect.h * 0.6)}
            >
              {field.name}
            </text>
          )}
        </g>
      );
    }
    const lay = layoutText(field, text, measurer);
    return (
      <g>
        {deco}
        <TextLines field={field} lay={lay} />
      </g>
    );
  }

  if (field.type === 'checkbox' || field.type === 'radio') {
    if (!isChecked(field, values)) return deco;
    const g = markGeometry(style.checkStyle, rect.w, rect.h);
    return (
      <g transform={`translate(${rect.x} ${rect.y})`}>
        {deco && <g transform={`translate(${-rect.x} ${-rect.y})`}>{deco}</g>}
        {g.kind === 'lines' &&
          g.segments.map(([x1, y1, x2, y2], i) => (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={style.color} strokeWidth={g.stroke} strokeLinecap="round" />
          ))}
        {g.kind === 'rect' && <rect x={g.x} y={g.y} width={g.w} height={g.h} fill={style.color} />}
        {g.kind === 'circle' && <circle cx={g.cx} cy={g.cy} r={g.r} fill={style.color} />}
      </g>
    );
  }

  if (field.type === 'signature') {
    const v = effectiveValue(field, values);
    return (
      <g>
        {deco}
        {typeof v === 'string' && v.startsWith('data:image/') && (
          <image href={v} x={rect.x + 1} y={rect.y + 1} width={Math.max(0, rect.w - 2)} height={Math.max(0, rect.h - 2)} preserveAspectRatio="xMidYMid meet" />
        )}
      </g>
    );
  }
  return deco;
});

function TextLines({ field, lay }: { field: Field; lay: TextLayout }) {
  const { rect, style } = field;
  return (
    <svg x={rect.x} y={rect.y} width={rect.w} height={rect.h} overflow="hidden">
      {lay.lines.slice(0, lay.visibleCount).map((ln, i) =>
        ln.text ? (
          <text
            key={i}
            x={ln.x}
            y={ln.baseline}
            fontFamily={FONTS[lay.family].css}
            fontSize={lay.fontSize}
            fill={style.color}
            textLength={ln.width > 0 ? ln.width : undefined}
            lengthAdjust="spacingAndGlyphs"
            className="field-text"
          >
            {ln.text}
          </text>
        ) : null,
      )}
    </svg>
  );
}

export function fieldOverflows(field: Field, values: Values, m: Measurer): boolean {
  if (!isTextType(field.type)) return false;
  const text = displayText(field, values);
  if (!text) return false;
  return layoutText(field, text, m).overflow;
}
