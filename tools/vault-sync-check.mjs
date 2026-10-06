// Real Chrome/Edge IndexedDB and production sync code share a disposable disk directory.
// Only the native directory handle boundary is adapted; native handles/UI are covered by m11-vault-e2e.mjs.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "pd-vault-sync-"));
const directory = join(workspace, "shared");
mkdirSync(directory);
const contexts = [];
let editLegacyDuringBackup = false;
const bundle = await build({
  absWorkingDir: root,
  stdin: { contents: "export * from './lib/vault/sync'; export * from './lib/vault/records'; export * as db from './lib/db'; export * as format from './lib/vault/format';", resolveDir: root },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  globalName: "Vault",
  plugins: [{ name: "directory-handle-boundary", setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/db$/ }, (args) => /[/\\]vault[/\\](sync|fs)\.ts$/.test(args.importer) ? { path: args.path, namespace: "handle" } : void 0);
    builder.onLoad({ filter: /.*/, namespace: "handle" }, () => ({
      contents: `export * from ${JSON.stringify(join(root, "lib/db.ts").replace(/\\/g, "/"))}; export const getVaultHandle = async () => globalThis.__vaultDirectory;`,
      loader: "ts",
      resolveDir: root
    }));
  } }]
});
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>Vault sync check</title>");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
async function open(kind) {
  const executablePath = kind === "chrome" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const context = await chromium.launchPersistentContext(join(workspace, kind), { executablePath, headless: true });
  contexts.push(context);
  const page = await context.newPage();
  await page.exposeBinding("__vaultDisk", (_source, operation, parts, value) => {
    const target = resolve(directory, ...parts);
    assert.ok(target === directory || target.startsWith(directory + sep));
    if (!existsSync(target)) {
      if (operation === "directory" && value) mkdirSync(target, { recursive: true });
      else if (operation === "file" && value) writeFileSync(target, "");
      else return { missing: true };
    }
    if (operation === "directory") {
      assert.ok(statSync(target).isDirectory());
      return true;
    }
    if (operation === "file") {
      assert.ok(statSync(target).isFile());
      return true;
    }
    if (operation === "read") return readFileSync(target, "utf8");
    if (operation === "write") {
      writeFileSync(target, String(value));
      if (editLegacyDuringBackup && parts.join('/') === '.peak-distance/legacy/词汇/en/race.md') {
        editLegacyDuringBackup = false;
        const legacyPath = join(directory, '词汇/en/race.md');
        writeFileSync(legacyPath, readFileSync(legacyPath, 'utf8') + '\nLATEST USER NOTE\n');
      }
      return true;
    }
    if (operation === "remove") {
      rmSync(target);
      return true;
    }
    if (operation === "list") return readdirSync(target, { withFileTypes: true }).map((item) => [item.name, item.isDirectory() ? "directory" : "file"]);
    throw Error(`Unknown disk operation ${operation}`);
  });
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.evaluate(() => {
    const globals = window;
    globals.__permission = "granted";
    const local = {};
    globals.browser = { storage: { local: {
      get: async (keys) => Object.fromEntries(keys.filter((key) => key in local).map((key) => [key, local[key]])),
      set: async (items) => Object.assign(local, items)
    } } };
    async function disk(operation, parts, value) {
      const result = await globals.__vaultDisk(operation, parts, value);
      if (result?.missing) throw new DOMException("Missing file", "NotFoundError");
      return result;
    }
    function handle(parts = []) {
      return {
        kind: "directory",
        name: "shared",
        queryPermission: async () => globals.__permission,
        getDirectoryHandle: async (name, options) => {
          const path = [...parts, name];
          await disk("directory", path, !!options?.create);
          return handle(path);
        },
        getFileHandle: async (name, options) => {
          const path = [...parts, name];
          await disk("file", path, !!options?.create);
          return { kind: "file", getFile: async () => ({ text: () => disk("read", path) }), createWritable: async () => {
            let text = "";
            return { write: async (value) => {
              text = value;
            }, close: () => disk("write", path, text), abort: async () => {
            } };
          } };
        },
        removeEntry: (name) => disk("remove", [...parts, name]),
        async *[Symbol.asyncIterator]() {
          for (const [name, kind2] of await disk("list", parts)) yield [name, kind2 === "directory" ? handle([...parts, name]) : { kind: kind2 }];
        }
      };
    }
    globals.__vaultDirectory = handle();
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => window.Vault.db.setVaultHandle("shared-test-directory"));
  return page;
}
try {
  const chrome = await open("chrome");
  const edge = await open("edge");
  await chrome.evaluate(async () => {
    const { db } = window.Vault;
    await db.saveSnapshot({ source: "web", expression: "engineer", sentence: "A senior engineer.", url: "https://example.com/one", title: "One", lang: "en" }, {
      result: { kind: "dictionary", selectedSense: 1, entry: { source: "youdao", expression: "engineer", headword: "engineer", url: "https://dict.youdao.com/engineer", senses: [{ definition: "工程师" }, { definition: "设计师", example: "A senior engineer." }] } }
    });
    await db.saveSentence({
      id: "shared-sentence",
      language: "en",
      text: "A senior engineer.",
      zh: "一位资深工程师。",
      translationSource: "google-gtx",
      title: "Video",
      createdAt: 123,
      video: { videoId: "abcdefghijk", trackId: "en-track", trackKind: "manual", trackLang: "en", startMs: 1e3 },
      endMs: 3500
    });
  });
  await edge.evaluate(() => window.Vault.db.saveSnapshot({ source: "web", expression: "speculation", sentence: "Pure speculation.", url: "https://example.com/two", title: "Two", lang: "en" }, {}));
  assert.ok((await chrome.evaluate(() => window.Vault.adoptVault())).ok);
  assert.ok((await edge.evaluate(() => window.Vault.adoptVault())).ok);
  assert.equal((await chrome.evaluate(() => window.Vault.synchronizeVault())).error, void 0);
  for (const page of [chrome, edge]) {
    assert.equal((await page.evaluate(() => window.Vault.db.listEntries())).length, 2);
    const sentence = (await page.evaluate(() => window.Vault.db.listSentences()))[0];
    assert.equal(sentence.video.startMs, 1e3);
    assert.equal(sentence.endMs, 3500);
    assert.equal(sentence.zh, "一位资深工程师。");
    const entry = await page.evaluate(() => window.Vault.db.getEntry("en::engineer"));
    assert.equal(entry.contexts[0].result.entry.senses.length, 2);
    assert.equal(entry.contexts[0].result.selectedSense, 1);
    assert.ok(entry.createdAt > 0);
  }
  assert.equal((await chrome.evaluate(() => window.Vault.synchronizeVault())).committed, 0);
  console.log("PASS Chrome/Edge exchange vocabulary, complete dictionary data and video sentences; unchanged sync is idempotent");
  await chrome.evaluate(() => window.Vault.db.setEntryNote("en::engineer", "在原句里理解。"));
  await edge.evaluate(() => window.Vault.db.setStatus("en::engineer", "learning"));
  await edge.evaluate(() => window.Vault.synchronizeVault());
  await chrome.evaluate(() => window.Vault.synchronizeVault());
  await edge.evaluate(() => window.Vault.synchronizeVault());
  const merged = await edge.evaluate(() => window.Vault.db.getEntry("en::engineer"));
  assert.equal(merged.status, "learning");
  assert.equal(merged.note, "在原句里理解。");
  console.log("PASS different-field changes merge across browsers without losing notes or state");

  const sentenceBook = join(directory, '句子.md');
  writeFileSync(sentenceBook, readFileSync(sentenceBook, 'utf8') + '\n### 我的笔记\nKEEP THIS PERSONAL NOTE\n');
  await chrome.evaluate(async () => {
    const api = window.Vault;
    const sentence = (await api.db.listSentences())[0];
    const captured = api.sentenceToVaultRecord(sentence);
    await api.db.saveSentence({ ...sentence, zh: '保留笔记的新译文。' });
    await api.db.enqueueRecoveredVaultWrite({ id: 'sentence:shared-sentence', kind: 'sentence', recordId: 'shared-sentence', payload: captured, queuedAt: Date.now() });
  });
  assert.equal((await chrome.evaluate(() => window.Vault.db.listVaultQueue())).length, 0);
  await chrome.evaluate(() => window.Vault.synchronizeVault());
  assert.ok(readFileSync(sentenceBook, 'utf8').includes('KEEP THIS PERSONAL NOTE'));
  assert.ok(readFileSync(sentenceBook, 'utf8').includes('保留笔记的新译文。'));
  console.log('PASS stale sentence recovery is rejected; translation update preserves external personal notes');

  const revisionGuard = await chrome.evaluate(async () => {
    const api = window.Vault;
    const original = api.entryViewToVaultRecord(await api.db.getEntry('en::engineer'));
    const write = { id: 'vocab:en::engineer', kind: 'vocab', recordId: 'en::engineer', payload: original, queuedAt: Date.now() };
    await api.db.enqueueVaultWrite(write);
    const old = (await api.db.listVaultQueue()).find(item => item.id === write.id);
    await api.db.setEntryNote('en::engineer', 'NEWER LOCAL NOTE');
    const newer = api.entryViewToVaultRecord(await api.db.getEntry('en::engineer'));
    await api.db.enqueueVaultWrite({ ...write, payload: newer });
    await api.db.enqueueRecoveredVaultWrite(write);
    await api.db.removeVaultWrite(old);
    await api.db.markVaultWriteAttempt(old, 'old failure');
    return (await api.db.listVaultQueue()).find(item => item.id === write.id);
  });
  assert.equal(revisionGuard.payload.note, 'NEWER LOCAL NOTE');
  assert.equal(revisionGuard.attempts, undefined);
  await chrome.evaluate(() => window.Vault.synchronizeVault());
  console.log('PASS stale recovery and old completion cannot replace or remove a newer pending edit');
  const rejectedSentenceImport = await chrome.evaluate(async () => {
    const api = window.Vault;
    const captured = (await api.db.listSentences())[0];
    await api.db.deleteSentence("shared-sentence");
    return api.db.upsertVaultSentence(captured, null);
  });
  assert.equal(rejectedSentenceImport, false);
  await chrome.evaluate(() => window.Vault.syncFromVault());
  assert.equal((await chrome.evaluate(() => window.Vault.db.listSentences())).length, 0);
  await chrome.evaluate(() => window.Vault.synchronizeVault());
  await edge.evaluate(() => window.Vault.synchronizeVault());
  assert.equal((await edge.evaluate(() => window.Vault.db.listSentences())).length, 0);
  console.log("PASS collection deletion propagates and does not resurrect the saved sentence");

  const deleted = await chrome.evaluate(async () => {
    const api = window.Vault;
    const captured = api.entryViewToVaultRecord(await api.db.getEntry('en::engineer'));
    await api.db.deleteEntry('en::engineer');
    await api.db.enqueueRecoveredVaultWrite({ id: 'vocab:en::engineer', kind: 'vocab', recordId: captured.id, payload: captured, queuedAt: Date.now() });
    await api.syncFromVault();
    const mapped = api.vaultRecordToEntry(captured, captured.note ?? '');
    const imported = await api.db.importVaultEntry(mapped.entry, mapped.contexts, null);
    return { imported, entry: await api.db.getEntry('en::engineer'), pending: (await api.db.listVaultQueue()).find(item => item.recordId === captured.id) };
  });
  assert.equal(deleted.imported, false); assert.equal(deleted.entry, null); assert.equal(deleted.pending.payload, null);
  await chrome.evaluate(() => window.Vault.synchronizeVault());
  await edge.evaluate(() => window.Vault.syncFromVault());
  assert.equal(await edge.evaluate(() => window.Vault.db.getEntry('en::engineer')), null);
  console.log('PASS vocabulary deletion and tombstone commit atomically; readback/old recovery do not resurrect it');

  const preservedNote = await edge.evaluate(async () => {
    const api = window.Vault;
    const captured = api.entryViewToVaultRecord(await api.db.getEntry('en::speculation'));
    await api.db.setEntryNote(captured.id, 'SAVED DURING READBACK');
    const removed = await api.db.deleteEntry(captured.id, false, captured);
    return { removed, entry: await api.db.getEntry(captured.id) };
  });
  assert.equal(preservedNote.removed, false); assert.equal(preservedNote.entry.note, 'SAVED DURING READBACK');
  await edge.evaluate(() => window.Vault.synchronizeVault());
  console.log('PASS remote deletion cannot erase a local note saved after the readback snapshot');

  const bookPath = join(directory, '生词本.md');
  const intact = readFileSync(bookPath, 'utf8');
  const before = (await edge.evaluate(() => window.Vault.db.listEntries())).length;
  writeFileSync(bookPath, intact.replaceAll('<!-- peak-distance:vocab -->', ''));
  const broken = await edge.evaluate(() => window.Vault.syncFromVault());
  assert.equal(broken.error, 'format'); assert.equal(broken.deleted, 0);
  assert.equal((await edge.evaluate(() => window.Vault.db.listEntries())).length, before);
  writeFileSync(bookPath, intact);
  console.log('PASS broken collection separators report format failure and preserve the running vocabulary');
  await chrome.evaluate(() => {
    window.__permission = "prompt";
  });
  const refused = await chrome.evaluate(() => window.Vault.synchronizeVault());
  assert.equal(refused.error, "no-permission");
  await chrome.evaluate(() => {
    window.__permission = "granted";
  });
  console.log("PASS unavailable permission is reported as a failed sync");
  const legacy = await chrome.evaluate(() => window.Vault.format.serializeVocabRecord({ id: "en::legacy", language: "en", expression: "legacy", status: "saved", forms: [], note: "保留旧笔记", createdAt: 1, updatedAt: 1, contexts: [] }));
  mkdirSync(join(directory, "词汇/en"), { recursive: true });
  writeFileSync(join(directory, "词汇/en/legacy.md"), legacy);
  await edge.evaluate(() => window.Vault.synchronizeVault());
  assert.equal((await edge.evaluate(() => window.Vault.db.getEntry("en::legacy"))).note, "保留旧笔记");
  assert.ok(existsSync(join(directory, ".peak-distance/legacy/词汇/en/legacy.md")));
  assert.ok(!existsSync(join(directory, "词汇/en/legacy.md")));
  assert.equal(readdirSync(directory).filter((name) => name.endsWith(".md")).length, 2);
  console.log("PASS legacy records consolidate into two Markdown collections with verified backups");
  const raced = legacy.replaceAll('en::legacy', 'en::race').replaceAll('expression: legacy', 'expression: race');
  writeFileSync(join(directory, '词汇/en/race.md'), raced);
  editLegacyDuringBackup = true;
  await assert.rejects(edge.evaluate(() => window.Vault.syncFromVault()), /conflict: legacy file changed/);
  assert.ok(readFileSync(join(directory, '词汇/en/race.md'), 'utf8').includes('LATEST USER NOTE'));
  console.log('PASS legacy changes during backup are retained and migration stops with a conflict');
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await new Promise((done) => server.close(() => done()));
  assert.ok(resolve(workspace).startsWith(resolve(tmpdir()) + sep) && workspace.includes("pd-vault-sync-"));
  rmSync(workspace, { recursive: true, force: true });
}
