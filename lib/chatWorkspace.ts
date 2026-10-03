import { emptyChat, type ChatRecord, type ChatRecordView } from '@/shared/chat';
import { panelStateKey } from '@/shared/panel';

const edits = new Map<number, ChatRecordView>();
export const ownsChatEdit = (windowId: number, edit: ChatRecordView) => edits.get(windowId) === edit;
const operations = new Map<number, symbol>();
export const chatOperation = (windowId: number) => operations.get(windowId);
export function beginChatOperation(windowId: number): symbol {
  const operation = Symbol(); operations.set(windowId, operation); return operation;
}
const keyOf = (windowId: number) => `chat-edit:${windowId}`;

export async function readChatEdit(windowId: number): Promise<ChatRecordView> {
  const cached = edits.get(windowId);
  if (cached) return cached;
  const stored = (await browser.storage.session.get(keyOf(windowId)))[keyOf(windowId)] as ChatRecordView | undefined;
  if (edits.has(windowId)) return edits.get(windowId)!;
  const edit = stored ?? { ...emptyChat(), editId: crypto.randomUUID() };
  edits.set(windowId, edit);
  return edit;
}

export function writeChatEdit(windowId: number, edit: ChatRecordView): Promise<void> {
  edits.set(windowId, edit);
  return browser.storage.session.set({ [keyOf(windowId)]: edit });
}

export function replaceChatEdit(windowId: number, record: ChatRecord | null): Promise<void> {
  return writeChatEdit(windowId, { ...(record ?? emptyChat()), draft: '', pendingQuote: null, editId: crypto.randomUUID() });
}

export function activateChatEdit(windowId: number, record: ChatRecordView | null): Promise<void> {
  const edit = record ?? { ...emptyChat(), editId: crypto.randomUUID() };
  edits.set(windowId, edit);
  return browser.storage.session.set({ [keyOf(windowId)]: edit, [`chat-active:${windowId}`]: edit.id });
}

/** 真实关闭才丢弃；连接断开、隐藏或模式移交不调用。 */
export async function discardChatEdit(windowId: number): Promise<void> {
  beginChatOperation(windowId);
  await replaceChatEdit(windowId, null);
  const key = panelStateKey(windowId);
  const state = (await browser.storage.session.get(key))[key];
  if (state) await browser.storage.session.set({ [key]: { ...state, chat: undefined } });
}
