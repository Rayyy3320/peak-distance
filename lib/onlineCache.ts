// 会话缓存使用现有 storage.session；只保存成功结果，消费者独立取消。
const STORE = 'online-cache-v1';
let records: Record<string, { value: unknown; at: number }> = {};
let ready: Promise<void> | undefined;
let write = Promise.resolve();
const pending = new Map<string, { controller: AbortController; users: Set<symbol>; result: Promise<any> }>();

async function load(): Promise<void> {
  ready ??= browser.storage.session.get(STORE).then(r => { records = (r[STORE] ?? {}) as typeof records; });
  await ready;
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  await load();
  return records[key]?.value as T | undefined;
}

export async function cachePut(key: string, value: unknown): Promise<void> {
  await load();
  records[key] = { value, at: Date.now() };
  await trimCache();
}

export async function trimCache(): Promise<void> {
  await load();
  const settings = await browser.storage.local.get('cacheLimit');
  const limit = Math.max(20, Math.min(500, Number(settings.cacheLimit) || 200));
  for (const [old] of Object.entries(records).sort((a, b) => b[1].at - a[1].at).slice(limit)) delete records[old];
  // storage.session 配额内保留最近结果；超大字幕快照也受字节上限约束。
  while (JSON.stringify(records).length > 2_000_000) {
    const oldest = Object.keys(records).sort((a, b) => records[a]!.at - records[b]!.at)[0];
    if (!oldest) break;
    delete records[oldest];
  }
  write = write.catch(() => {}).then(() => browser.storage.session.set({ [STORE]: records }));
  await write;
}

export async function cached<T extends { ok: boolean }>(key: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const hit = await cacheGet<T>(key);
  signal?.throwIfAborted();
  if (hit) return hit;
  let task = pending.get(key);
  if (!task) {
    const controller = new AbortController();
    task = { controller, users: new Set(), result: Promise.resolve() };
    const current = task;
    task.result = run(controller.signal).then(async result => {
      if (result.ok && !controller.signal.aborted) await cachePut(key, result);
      return result;
    }).finally(() => { if (pending.get(key) === current) pending.delete(key); });
    pending.set(key, task);
  }
  const user = Symbol();
  task.users.add(user);
  const current = task;
  return new Promise<T>((resolve, reject) => {
    const release = () => {
      signal?.removeEventListener('abort', abort);
      current.users.delete(user);
      if (!current.users.size && pending.get(key) === current) {
        pending.delete(key);
        current.controller.abort();
      }
    };
    const abort = () => { release(); reject(new DOMException('Cancelled', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    current.result.then(resolve, reject).finally(release);
  });
}
