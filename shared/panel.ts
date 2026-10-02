export const PANEL_VIEWS = ['subs', 'list', 'sentences', 'review', 'chat', 'settings'] as const;
export type PanelView = typeof PANEL_VIEWS[number];
export type PanelMode = 'fixed' | 'floating';
export const isPanelView = (value: unknown): value is PanelView => PANEL_VIEWS.includes(value as PanelView);
export const panelStateKey = (windowId: number) => `panel-state:${windowId}`;

export interface SelectionSnapshot {
  text: string;
  url: string;
  title: string;
}

export const MAX_SELECTION_CHARS = 5000;
export function selectionError(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim()) return '请选择要翻译的英文';
  if (text.length > MAX_SELECTION_CHARS) return `最多翻译 ${MAX_SELECTION_CHARS} 字符，请缩小选区`;
  return null;
}
