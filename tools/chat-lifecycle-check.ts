// Offline lifecycle checks: real handlers/workspace, controlled DB/config boundaries.
// Run: npx tsx tools/chat-lifecycle-check.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import type { ChatRecordView } from '../shared/chat';
import type { ChatPortEvent, ChatPortMessage } from '../shared/messages';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const session: Record<string, unknown> = {};
let connect!: (port: unknown) => void;
const config = { provider: 'custom', protocol: 'openai', baseUrl: 'https://example.com/v1', model: 'controlled-model', apiKey: 'disposable-key' };
const boundaries = {
  getChat: async (_id: string): Promise<ChatRecordView | null> => null,
  appendChatTurn: async (_input: unknown): Promise<unknown> => { throw Error('Unexpected submission'); },
  getAiConfig: async () => config,
};
const bundle = await build({
  absWorkingDir: resolve(import.meta.dirname, '..'),
  stdin: { contents: "export * from './lib/chatService'; export * from './lib/chatWorkspace'; export { emptyChat } from './shared/chat';", resolveDir: resolve(import.meta.dirname, '..') },
  bundle: true, write: false, platform: 'node', format: 'iife', globalName: 'Lifecycle',
  plugins: [{ name: 'controlled-boundaries', setup(builder) {
    builder.onResolve({ filter: /^\.\/(db|aiClient|aiTransport|panelService|vault\/sync)$/ }, args =>
      args.importer.endsWith('chatService.ts') ? { path: args.path, namespace: 'boundary' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => {
      const stubs: Record<string, string> = {
        getVaultIdentity: 'Promise.resolve(null)',
        flushVaultWrites: 'Promise.resolve({ committed: 0, failed: 0, skipped: 0 })',
        enqueueChatWrite: 'Promise.resolve()',
      };
      const names = args.path === './db'
        ? ['appendChatTurn', 'clearChat', 'getChat', 'getVaultIdentity', 'listChats', 'resetChatTurn', 'saveAssistantProgress', 'setChatRetained']
        : args.path === './vault/sync' ? ['enqueueChatWrite', 'flushVaultWrites']
        : args.path === './aiTransport' ? ['getAiConfig'] : args.path === './aiClient' ? ['chatCompletionStream'] : ['openPanel'];
      return {
        contents: names
          .map((n) => `export const ${n} = ${stubs[n] ?? `((...args) => globalThis.boundaries.${n}(...args))`};`)
          .join('\n'),
      };
    });
  } }],
});
const context = vm.createContext({
  boundaries, crypto: { randomUUID }, structuredClone, AbortController, URL, console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  browser: {
    storage: { session: {
      get: async (key: string) => ({ [key]: structuredClone(session[key]) }),
      set: async (values: Record<string, unknown>) => { Object.assign(session, structuredClone(values)); },
    } },
    runtime: { id: 'controlled-extension', onConnect: { addListener: (listener: typeof connect) => { connect = listener; } } },
  },
});
vm.runInContext(bundle.outputFiles[0]!.text, context);
const api = context.Lifecycle as typeof import('../lib/chatService') & typeof import('../lib/chatWorkspace') & typeof import('../shared/chat');
const request = (windowId: number, message: Record<string, unknown>) => api.handleChatRequest({ ...message, windowId }, {}) as Promise<{ ok: boolean; chat?: ChatRecordView }>;

// A late selection must not navigate away from an already completed New action.
const selection = deferred<ChatRecordView>();
boundaries.getChat = () => selection.promise;
const staleSelection = request(1, { type: 'chatSelect', chatId: 'slow' });
await request(1, { type: 'chatNew' });
selection.resolve({ ...api.emptyChat(), id: 'slow' });
assert.equal((await staleSelection).ok, false);
assert.equal((await api.readChatEdit(1)).id, '');
assert.equal(session['chat-active:1'], '');

api.initChatService();
for (const [index, phase] of (['unchanged', 'commit', 'config'] as const).entries()) {
  const changed = phase !== 'unchanged';
  const windowId = index + 2;
  await request(windowId, { type: 'chatNew' });
  const initial = await api.readChatEdit(windowId);
  const source = { sourceType: 'article', sourceKey: 'web:original', title: 'Original', url: 'https://example.com/original' };
  await request(windowId, { type: 'chatEnsure', chatId: '', editId: initial.editId, source,
    material: { label: 'Original', blocks: [{ id: 'p1', text: 'Original material.' }] }, quote: { blockIds: ['p1'], note: 'Original quote' } });
  await request(windowId, { type: 'chatSetDraft', chatId: '', editId: initial.editId, draft: 'Submitted question' });
  const submitted = deferred<{ chatId: string; context: ChatRecordView }>();
  const commit = deferred<unknown>();
  boundaries.appendChatTurn = async input => { submitted.resolve(input as { chatId: string; context: ChatRecordView }); return commit.promise; };
  const ack = deferred<Extract<ChatPortEvent, { type: 'chat-ack' }>>();
  let receive!: (message: ChatPortMessage) => void;
  connect({ name: 'blc-chat', sender: { id: 'controlled-extension', tab: { windowId } },
    onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
    onDisconnect: { addListener: () => {} },
    postMessage: (event: ChatPortEvent) => { if (event.type === 'chat-ack') ack.resolve(event); },
  });
  const configStarted = deferred<void>();
  const configReady = deferred<typeof config>();
  boundaries.getAiConfig = phase === 'config' ? async () => { configStarted.resolve(); return configReady.promise; } : async () => config;
  receive({ type: 'chat-send', chatId: '', editId: initial.editId, question: 'Submitted question', snapshotVersion: 1, segmentIndex: 0, quote: initial.pendingQuote });
  if (phase === 'config') {
    await configStarted.promise;
    await request(windowId, { type: 'chatSetDraft', chatId: '', editId: initial.editId, draft: 'Next unsent question' });
    configReady.resolve(config);
  }
  const accepted = await Promise.race([submitted.promise, ack.promise.then(event => { throw Error(`Submission rejected: ${event.error}`); })]);
  // A canned DB result represents only the already accepted submission.
  boundaries.getChat = async id => ({ ...structuredClone(accepted.context), id, draft: '', pendingQuote: null, messages: [], title: 'Submitted question' });
  if (changed) {
    if (phase === 'commit') await request(windowId, { type: 'chatSetDraft', chatId: '', editId: initial.editId, draft: 'Next unsent question' });
    await request(windowId, { type: 'chatEnsure', chatId: '', editId: initial.editId,
      source: { ...source, sourceKey: 'web:next', title: 'Next' },
      material: { label: 'Next', blocks: [{ id: 'p1', text: 'Next unsent material.' }] }, quote: { blockIds: ['p1'], note: 'Next unsent quote' } });
  }
  commit.resolve({});
  const timeout = setTimeout(() => ack.resolve({ type: 'chat-ack', chatId: '', ok: false, error: 'ack-timeout' }), 1000);
  assert.equal((await ack.promise).ok, true);
  clearTimeout(timeout);
  const final = await api.readChatEdit(windowId);
  assert.equal(final.id, accepted.chatId);
  assert.equal(session[`chat-active:${windowId}`], accepted.chatId);
  assert.equal(final.draft, changed ? 'Next unsent question' : '', `${phase}: preserve input added after Send`);
  assert.equal(final.pendingQuote?.note ?? null, changed ? 'Next unsent quote' : null);
  assert.equal(final.source?.title, changed ? 'Next' : 'Original');
  assert.equal((session[`chat-edit:${windowId}`] as ChatRecordView).draft, final.draft);
  assert.equal((session[`chat-edit:${windowId}`] as ChatRecordView).pendingQuote?.note ?? null, final.pendingQuote?.note ?? null);
  assert.equal(accepted.context.source?.title, 'Original');
}
console.log('PASS: stale navigation rejected; normal submission clears sent edits; edits during config/commit remain in workspace and session.');
