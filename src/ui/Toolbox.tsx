import {
  AlignHorizontalJustifyStart,
  AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyEnd,
  AlignVerticalSpaceAround,
  AlignHorizontalSpaceAround,
  Calendar,
  CircleDot,
  Hash,
  MousePointer2,
  PenTool,
  ScanSearch,
  Square,
  SquareCheck,
  StickyNote,
  TextCursorInput,
  AlignLeft,
  ChevronDownSquare,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { Tool } from './FieldLayer';
import type { AlignKind } from './Editor';
import { useT } from '../i18n';
import { cx } from './util';

const TOOLS: { tool: Tool; label: string; key?: string; icon: ReactNode }[] = [
  { tool: 'select', label: 'Select and move', key: 'V', icon: <MousePointer2 size={17} /> },
  { tool: 'text', label: 'Text', key: 'T', icon: <TextCursorInput size={17} /> },
  { tool: 'multiline', label: 'Long text', key: 'M', icon: <AlignLeft size={17} /> },
  { tool: 'checkbox', label: 'Checkbox', key: 'C', icon: <SquareCheck size={17} /> },
  { tool: 'radio', label: 'Option (one of several)', key: 'R', icon: <CircleDot size={17} /> },
  { tool: 'date', label: 'Date', key: 'D', icon: <Calendar size={17} /> },
  { tool: 'number', label: 'Number', key: 'N', icon: <Hash size={17} /> },
  { tool: 'dropdown', label: 'Dropdown', icon: <ChevronDownSquare size={17} /> },
  { tool: 'signature', label: 'Signature', icon: <PenTool size={17} /> },
  { tool: 'label', label: 'Note (fixed text)', icon: <StickyNote size={17} /> },
];

export function Toolbox({
  tool,
  setTool,
  onDetect,
  selectionCount,
  onAlign,
}: {
  tool: Tool;
  setTool: (t: Tool) => void;
  onDetect: () => void;
  selectionCount: number;
  onAlign: (k: AlignKind) => void;
}) {
  const t = useT();
  return (
    <div className="toolbox" role="toolbar" aria-label={t('Field tools')}>
      <div className="tool-group">
        {TOOLS.map((x) => (
          <button
            key={x.tool}
            className={cx('tool-btn', tool === x.tool && 'on')}
            aria-pressed={tool === x.tool}
            title={`${t(x.label)}${x.key ? ` (${x.key})` : ''}`}
            aria-label={t(x.label)}
            onClick={() => setTool(x.tool)}
          >
            {x.icon}
          </button>
        ))}
      </div>
      {tool !== 'select' ? (
        <span className="tool-hint">
          <Square size={12} /> {t('Click on the page to place it (or drag to draw its size). Clicking inside a printed box snaps to it after detection. Esc to finish.')}
        </span>
      ) : selectionCount > 1 ? (
        <div className="tool-group" aria-label={t('Align')}>
          <button className="tool-btn" title={t('Align left edges')} aria-label={t('Align left edges')} onClick={() => onAlign('left')}>
            <AlignHorizontalJustifyStart size={16} />
          </button>
          <button className="tool-btn" title={t('Align right edges')} aria-label={t('Align right edges')} onClick={() => onAlign('right')}>
            <AlignHorizontalJustifyEnd size={16} />
          </button>
          <button className="tool-btn" title={t('Align top edges')} aria-label={t('Align top edges')} onClick={() => onAlign('top')}>
            <AlignVerticalJustifyStart size={16} />
          </button>
          <button className="tool-btn" title={t('Align bottom edges')} aria-label={t('Align bottom edges')} onClick={() => onAlign('bottom')}>
            <AlignVerticalJustifyEnd size={16} />
          </button>
          <button className="tool-btn" title={t('Distribute vertically')} aria-label={t('Distribute vertically')} onClick={() => onAlign('distribute-v')}>
            <AlignVerticalSpaceAround size={16} />
          </button>
          <button className="tool-btn" title={t('Distribute horizontally')} aria-label={t('Distribute horizontally')} onClick={() => onAlign('distribute-h')}>
            <AlignHorizontalSpaceAround size={16} />
          </button>
          <button className="btn small" onClick={() => onAlign('same-size')}>
            {t('Same size')}
          </button>
        </div>
      ) : (
        <span className="tool-hint">{t('Select a field to move it, drag its corners to resize. Shift-click or drag a frame to select several.')}</span>
      )}
      <button className="btn detect-btn" onClick={onDetect}>
        <ScanSearch size={16} />
        <span>{t('Detect fields')}</span>
      </button>
    </div>
  );
}
