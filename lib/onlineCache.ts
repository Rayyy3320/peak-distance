// 会话缓存使用现有 storage.session；只保存成功结果，消费者独立取消。
const STORE = 'online-cache-v1';
// 2MB 上限与校准节奏：字节账目是近似值（每条 JSON 成员长度之和），
// 全量重算只在 load、每 ~50 次 put、或记录数与账目不符（外部清理）
// 时发生，避免每次 put 都全量 JSON.stringify。
const BYTE_LIMIT = 2_000_000;
const RECALC_EVERY = 50;

let records: Record<string, { value: unknown; at: number }> = {};
let ready: Promise<void> | undefined;
let write = Promise.resolve();
const pending = new Map<string, { controller: AbortController; users: Set<symbol>; result: Promise<any> }>();

// 近似字节数与记录数账目（load / 校准时全量重算，put / 删除时增量调整）。
let bytes = 0;
let trackedCount = 0;
let putsSinceRecalc = 0;

function recalc(): void {
  bytes = JSON.stringify(records).length;
  trackedCount = Object.keys(records).length;
  putsSinceRecalc = 0;
}

/** 单条记录的 JSON 成员近似长度（键 + 冒号 + 值，逗号误差可忽略）。 */
function entryBytes(key: string, rec: { value: unknown; at: number }): number {
  return JSON.stringify(key).length + JSON.stringify(rec).length + 1;
}

async function load(): Promise<void> {
  ready ??= browser.storage.session.get(STORE).then(r => {
    records = (r[STORE] ?? {}) as typeof records;
    recalc();
  });
  await ready;
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  await load();
  return records[key]?.value as T | undefined;
}

export async function cachePut(key: string, value: unknown): Promise<void> {
  await load();
  const prev = records[key];
  if (prev) bytes -= entryBytes(key, prev);
  const rec = { value, at: Date.now() };
  records[key] = rec;
  bytes += entryBytes(key, rec);
  if (!prev) trackedCount++;
  putsSinceRecalc++;
  await trimCache();
}

export async function trimCache(): Promise<void> {
  await load();
  const settings = await browser.storage.local.get('cacheLimit');
  const limit = Math.max(20, Math.min(500, Number(settings.cacheLimit) || 200));
  const evict = (key: string): void => {
    bytes -= entryBytes(key, records[key]!);
    trackedCount--;
    delete records[key];
  };
  for (const [old] of Object.entries(records).sort((a, b) => b[1].at - a[1].at).slice(limit)) evict(old);
  // storage.session 配额内保留最近结果；超大字幕快照也受字节上限约束。
  while (bytes > BYTE_LIMIT) {
    const oldest = Object.keys(records).sort((a, b) => records[a]!.at - records[b]!.at)[0];
    if (!oldest) break;
    evict(oldest);
  }
  if (putsSinceRecalc >= RECALC_EVERY || Object.keys(records).length !== trackedCount) recalc();
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
