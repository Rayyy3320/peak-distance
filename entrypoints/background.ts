import { lookupOnline, type LookupRequestContext } from '@/lib/lookupService';
import { handlePanelMessage, openPanel, startNativePanel, initPanelLifecycle } from '@/lib/panelService';
import { handleSelectionCandidateMessage, initSelectionCandidateStore } from '@/lib/selectionCandidates';
import { selectionError } from '@/shared/panel';
import { translateRegularText } from '@/lib/regularTranslation';
import { cached, cacheGet, cachePut, trimCache } from '@/lib/onlineCache';
import { comprehensionLangFor, DEFAULT_SETTINGS, validSetting } from '@/shared/settings';
import type { LearningResult, ContextExplanation } from '@/shared/vocab';
// background：词汇 / 翻译消息路由、IndexedDB 存取、AI 请求、广播。
// 凭据仅在本上下文读取；content script 只传查词材料与词汇操作，
// 不传任意请求地址或凭据。消息按来源（本扩展）与载荷形状校验。
// storage.local 显式收紧为 TRUSTED_CONTEXTS：content script 不可读
//（设置项由本文件代读，key 永不下发）。

import {
  saveSentence, listSentences, deleteSentence,
  backfillDefinition,
  backfillResult,
  deleteEntry,
  getEntry,
  listEntries,
  listIndex,
  removeForm,
  resolveEntry,
  saveSnapshot,
  setEntryNote,
  setStatus,
} from '@/lib/db';
import { lookupExpression, translateSentences } from '@/lib/aiClient';
import { getAiConfig } from '@/lib/aiTransport';
import { aiCacheScope, isAiProvider, validateAiProfile } from '@/shared/aiConfig';
import { handleChatRequest, initChatService } from '@/lib/chatService';
import { getVaultIdentity, getVaultStatus, migrateLegacyLanguages } from '@/lib/db';
import {
  adoptVault,
  disconnectVault,
  enqueuePreferenceWrite,
  enqueueSentenceWrite,
  enqueueVocabWrite,
  entryViewToVaultRecord,
  flushVaultWrites,
  sentenceToVaultRecord,
  syncFromVault,
} from '@/lib/vault/sync';
import { isLanguageTag, normalizeLangTag } from '@/shared/languages';
import {
  sentenceId,
  isVocabStatus,
  normalizeExpression,
  type LookupSnapshot,
  type VideoRef,
  type WebSnapshot,
} from '@/shared/vocab';
import type {
  BgcError,
  BgcRequest,
  BackfillResult,
  BroadcastEvent,
  GetEntryResult,
  GetSettingsResult,
  RemoveFormResult,
  SaveResult,
  SettingsView,
  VocabIndexResult,
} from '@/shared/messages';

const MAX_EXPRESSION = 300;
const MAX_SENTENCE = 2000;
const MAX_TITLE = 300;
const MAX_TRANSLATE_BATCH = 8;
const MAX_CUE_TEXT = 500;

function bad(error: string, detail?: string): BgcError {
  return { ok: false, error, detail };
}

/** M11 可选语言字段：undefined = 未提供（迁移前兼容）；null = 非法。 */
function parseLangField(v: unknown): string | undefined | null {
  if (v === undefined) return undefined;
  return isLanguageTag(v) ? normalizeLangTag(v) : null;
}

/** 本机保存成功后（已连接库时）排队写入学库并尝试提交；结果经 vault-changed 广播。 */
function queueVaultWriteAfterSave(task: () => Promise<void>): void {
  void (async () => {
    try {
      if (!(await getVaultIdentity())) return;
      await task();
      await flushVaultWrites();
      broadcast({ type: 'vault-changed' });
    } catch {
      /* 写库失败保留待办（队列持久化），下次活动补写 */
    }
  })();
}

function parseVideoRef(v: unknown): VideoRef | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (typeof s.videoId !== 'string' || !s.videoId.trim()) return null;
  if (typeof s.trackId !== 'string' || !s.trackId.trim()) return null;
  if (s.trackKind !== 'manual' && s.trackKind !== 'asr') return null;
  if (typeof s.trackLang !== 'string') return null;
  if (typeof s.startMs !== 'number' || !Number.isFinite(s.startMs) || s.startMs < 0) {
    return null;
  }
  return {
    videoId: s.videoId.slice(0, 32),
    trackId: s.trackId.slice(0, 2000),
    trackKind: s.trackKind,
    trackLang: s.trackLang.slice(0, 32),
    startMs: Math.round(s.startMs),
  };
}

/** 快照载荷校验：网页 / 视频两种来源；缺 source 按 web（M1 兼容）。 */
function parseSnapshot(v: unknown): LookupSnapshot | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (typeof s.expression !== 'string' || !s.expression.trim()) return null;
  if (typeof s.sentence !== 'string') return null;
  // M11：快照可带源语言（'und' = 待确认）；缺省 = 迁移前调用方。
  let lang: string | undefined;
  if (s.lang !== undefined) {
    if (!isLanguageTag(s.lang)) return null;
    lang = normalizeLangTag(s.lang);
  }
  const base = {
    expression: s.expression.slice(0, MAX_EXPRESSION),
    sentence: s.sentence.slice(0, MAX_SENTENCE),
    ...(lang ? { lang } : {}),
  };
  if (s.source === 'video') {
    if (typeof s.title !== 'string') return null;
    const video = parseVideoRef(s.video);
    if (!video) return null;
    return {
      ...base,
      source: 'video' as const,
      title: s.title.slice(0, MAX_TITLE),
      video,
      neighbors:
        typeof s.neighbors === 'string' ? s.neighbors.slice(0, 1000) : undefined,
    };
  }
  if (s.source !== undefined && s.source !== 'web') return null;
  if (typeof s.url !== 'string' || !/^https?:\/\//.test(s.url)) return null;
  if (typeof s.title !== 'string') return null;
  return {
    ...base,
    source: 'web',
    url: s.url,
    title: s.title.slice(0, MAX_TITLE),
  };
}

/** 广播到扩展页面（runtime）与各标签页 content script（tabs）。 */
function broadcast(evt: BroadcastEvent): void {
  void browser.runtime.sendMessage(evt).catch(() => {});
  void browser.tabs
    .query({})
    .then((tabs) => {
      for (const t of tabs) {
        if (typeof t.id === 'number') {
          void browser.tabs.sendMessage(t.id, evt).catch(() => {});
        }
      }
    })
    .catch(() => {});
}

async function getSettings(): Promise<SettingsView> {
  const got = await browser.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key, value]) => [key, validSetting(key, got[key]) ? got[key] : value])) as unknown as SettingsView;
}

const onlineRequests = new Map<string, AbortController>();

function parseResult(v: unknown): LearningResult | undefined {
  if (!v || typeof v !== 'object' || JSON.stringify(v).length > 24000) return undefined;
  const r = v as LearningResult;
  if (r.kind === 'translation' && r.source === 'google-gtx' && typeof r.text === 'string') return r;
  if (r.kind === 'dictionary' && ['youdao', 'cambridge'].includes(r.entry?.source) && /^https:\/\//.test(r.entry.url) &&
      Array.isArray(r.entry.senses) && r.entry.senses.length && r.entry.senses.every(s => typeof s.definition === 'string')) return r;
  // M11：AI 查词兜底结果（主动查词、词典明确未命中时；与语境解释区分）
  if (r.kind === 'ai-definition' && r.source === 'ai' && typeof r.text === 'string' && r.text.length <= 6000 &&
      isLanguageTag(r.lang?.source) && isLanguageTag(r.lang?.target)) return r;
  return undefined;
}
function parseExplanation(v: unknown): ContextExplanation | undefined {
  const x = v as ContextExplanation | undefined;
  return x?.kind === 'ai-context' && ['deepseek','ai'].includes(x.source) && (!x.provider || isAiProvider(x.provider)) && (!x.model || typeof x.model === 'string' && x.model.length <= 200) && typeof x.text === 'string' && x.text.length <= 6000 && typeof x.sentence === 'string' ? x : undefined;
}

async function handle(
  msg: unknown,
  sender: Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[1],
  nativeOpen?: Promise<boolean>,
): Promise<unknown> {
  // 来源校验：只接受本扩展的上下文（content script / 扩展页面）。
  if (sender.id !== browser.runtime.id) return bad('forbidden-sender');

  const panelResult = await handlePanelMessage(msg, sender,nativeOpen);
  if (panelResult !== undefined) return panelResult;

  const candidateResult = await handleSelectionCandidateMessage(msg, sender);
  if (candidateResult !== undefined) return candidateResult;

  const m = msg as Partial<BgcRequest>;
  // M5 问答：CRUD / 打开面板统一走 chatService（含载荷校验）
  if (typeof m.type === 'string' && m.type.startsWith('chat')) {
    const r = await handleChatRequest(msg, { tab: sender.tab,nativeOpen });
    if (r !== undefined) return r;
  }
  switch (m.type) {
    case 'translateSelection': {
      const error = selectionError(m.text);
      if (error || typeof m.requestId !== 'string') return bad('bad-payload', error ?? 'requestId');
      const sourceLang = parseLangField(m.sourceLang);
      const targetLang = parseLangField(m.targetLang);
      if (sourceLang === null || targetLang === null) return bad('bad-payload', 'lang');
      const text = m.text!;
      const controller = new AbortController();
      const key = `${sender.tab?.id ?? sender.url}|${m.requestId}`;
      onlineRequests.set(key, controller);
      // 缓存身份随语言对区分；未提供时沿用旧 'en-zh' 作用域（迁移前缓存兼容）。
      const scope = sourceLang && targetLang ? `${sourceLang}|${targetLang}` : 'en-zh';
      const selLangs = { source: sourceLang ?? 'en', target: targetLang ?? 'zh-Hans' };
      try { return await cached(JSON.stringify(['translation','google-gtx',scope,text]), signal => translateRegularText(text,signal,selLangs),controller.signal); }
      finally { if(onlineRequests.get(key)===controller) onlineRequests.delete(key); }
    }
    case 'cancelOnline': {
      onlineRequests.get(`${sender.tab?.id ?? sender.url}|${m.requestId}`)?.abort();
      return { ok: true };
    }
    case 'subtitleMode': {
      if (typeof sender.tab?.id !== 'number' || typeof m.videoId !== 'string') return bad('bad-payload');
      if (m.mode !== undefined && !['regular', 'ai'].includes(m.mode)) return bad('bad-payload');
      if (m.autoPause !== undefined && typeof m.autoPause !== 'boolean') return bad('bad-payload');
      const key = `video-session:${sender.tab.id}`;
      const stored = (await browser.storage.session.get(key))[key] as { videoId:string; mode:'regular' | 'ai'; autoPause:boolean } | undefined;
      const state = stored?.videoId === m.videoId ? stored : { videoId: m.videoId, mode: (await getSettings()).translationMode, autoPause: false };
      if (m.mode !== undefined) state.mode = m.mode;
      if (m.autoPause !== undefined) state.autoPause = m.autoPause;
      await browser.storage.session.set({ [key]: state });
      return { ok: true, ...state };
    }
    case 'listSentences': return { ok: true, sentences: await listSentences() };
    case 'saveSentence': {
      const s = m.sentence;
      const video = parseVideoRef(s?.video);
      const language = parseLangField(s?.language);
      if (!s || !video || typeof s.text !== 'string' || !s.text.trim() || s.text.length > MAX_SENTENCE ||
          typeof s.title !== 'string' || !Number.isFinite(s.endMs) || s.endMs < video.startMs || language === null) return bad('bad-payload');
      const savedSentence = { id: sentenceId(video, s.text), video, text: s.text, endMs: s.endMs, title: s.title.slice(0, MAX_TITLE),
        zh: typeof s.zh === 'string' ? s.zh.slice(0, MAX_SENTENCE) : undefined,
        translationSource: typeof s.translationSource === 'string' ? s.translationSource.slice(0, 80) : undefined,
        ...(language ? { language } : {}),
        createdAt: Date.now() };
      await saveSentence(savedSentence);
      broadcast({ type: 'sentences-changed' });
      if (language) {
        queueVaultWriteAfterSave(async () => {
          await enqueueSentenceWrite({
            id: savedSentence.id,
            language: savedSentence.language ?? video.trackLang ?? 'und',
            text: savedSentence.text,
            ...(savedSentence.zh ? { translation: savedSentence.zh } : {}),
            ...(savedSentence.translationSource ? { translationSource: savedSentence.translationSource } : {}),
            video,
            endMs: savedSentence.endMs,
            title: savedSentence.title,
            createdAt: savedSentence.createdAt,
          });
        });
      }
      return { ok: true };
    }
    case 'deleteSentence': {
      if (typeof m.id !== 'string') return bad('bad-payload');
      await deleteSentence(m.id);
      broadcast({ type: 'sentences-changed' });
      return { ok: true };
    }
    case 'openLearning': {
      if (!['list', 'sentences', 'review'].includes(m.view!)) return bad('bad-payload');
      return handlePanelMessage({type:'panelOpen',view:m.view},sender,nativeOpen);
    }
    case 'captionCache': {
      if (typeof m.key !== 'string' || m.key.length > 3000) return bad('bad-payload');
      const key = `captions:${m.key}`;
      if (m.cues) {
        if (!Array.isArray(m.cues) || m.cues.length > 10000 || JSON.stringify(m.cues).length > 800000) return bad('bad-payload');
        await cachePut(key, m.cues);
      }
      return { ok: true, cues: await cacheGet(key) };
    }
    case 'explainContext':
    case 'lookup': {
      const snapshot = parseSnapshot(m.snapshot);
      if (!snapshot) return bad('bad-payload', 'snapshot');
      // M11：理解语言与查询意图（路由表见 M11 spec 3.3；实际路由随 L 线程接入）。
      if (m.targetLang !== undefined && !isLanguageTag(m.targetLang)) return bad('bad-payload', 'targetLang');
      const intent = m.type === 'lookup' ? m.intent : undefined;
      if (intent !== undefined && !['active', 'hover', 'preview', 'prefetch'].includes(intent)) {
        return bad('bad-payload', 'intent');
      }
      const controller = new AbortController();
      const requestKey = `${sender.tab?.id ?? sender.url}|${m.requestId}`;
      onlineRequests.set(requestKey, controller);
      try {
        if (m.type === 'lookup') {
          if (m.source && m.source !== 'youdao' && m.source !== 'cambridge') return bad('bad-payload');
          const settings = await getSettings();
          // 快照语言缺省按 en（迁移前调用方）；目标 = 调用方指定或按设置解析。
          const sourceLang = snapshot.lang ?? 'en';
          const targetLang = m.targetLang ?? comprehensionLangFor(settings, sourceLang);
          // AI 兜底授权仅主动查词携带；配置快照固定在本次请求（spec 3.3）。
          let aiFallback: LookupRequestContext['aiFallback'];
          if (settings.aiLookupFallback && (intent ?? 'active') === 'active') {
            const config = await getAiConfig();
            aiFallback = { enabled: true, config: config.apiKey ? config : null };
          }
          return await lookupOnline(snapshot.expression, settings, m.source, controller.signal, {
            lang: { source: sourceLang, target: targetLang },
            intent,
            aiFallback,
            sentence: snapshot.sentence,
            neighbors: snapshot.source === 'video' ? snapshot.neighbors : undefined,
          });
        }
        const neighbors = snapshot.source === 'video' ? snapshot.neighbors : undefined;
        const config = await getAiConfig();
        if (!config.apiKey) return bad('no-key');
        if (validateAiProfile(config)) return bad('invalid-config');
        const settings = await getSettings();
        const sourceLang = snapshot.lang ?? 'en';
        const targetLang = m.targetLang ?? comprehensionLangFor(settings, sourceLang);
        return await cached(JSON.stringify(['ai-context', aiCacheScope(config), `${sourceLang}|${targetLang}`, snapshot.expression, snapshot.sentence, neighbors]),
          signal => lookupExpression(config, { expression: snapshot.expression, sentence: snapshot.sentence, neighbors, langs: { source: sourceLang, target: targetLang } }, signal), controller.signal);
      } finally { if (onlineRequests.get(requestKey) === controller) onlineRequests.delete(requestKey); }
    }
    case 'getEntry': {
      if (typeof m.key !== 'string' || !m.key.trim()) return bad('bad-payload', 'key');
      const r: GetEntryResult = {
        ok: true,
        entry: await getEntry(normalizeExpression(m.key)),
      };
      return r;
    }
    case 'save': {
      const snapshot = parseSnapshot(m.snapshot);
      if (!snapshot) return bad('bad-payload', 'snapshot');
      if (m.status !== undefined && !isVocabStatus(m.status)) {
        return bad('bad-payload', 'status');
      }
      if (m.definition !== undefined && typeof m.definition !== 'string') {
        return bad('bad-payload', 'definition');
      }
      const r = await saveSnapshot(snapshot, {
        status: m.status,
        definition: m.definition?.slice(0, 2000),
        result: parseResult(m.result),
        explanation: parseExplanation(m.explanation),
      });
      if (!r) return bad('bad-payload', 'empty-expression');
      const out: SaveResult = r;
      broadcast({ type: 'vocab-changed' });
      if (snapshot.lang || r.key.includes('::')) {
        // M11 语言作用域词条：连接学习库时排队写入（旧键词条待语言迁移批次）
        queueVaultWriteAfterSave(async () => {
          const entry = await getEntry(r.key);
          if (entry) await enqueueVocabWrite(entryViewToVaultRecord(entry));
        });
      }
      return out;
    }
    case 'backfillResult': {
      if (typeof m.contextId !== 'number') return bad('bad-payload');
      const filled = await backfillResult(m.contextId, parseResult(m.result), parseExplanation(m.explanation));
      if (filled) broadcast({ type: 'vocab-changed' });
      return { ok: true, filled };
    }
    case 'backfillDefinition': {
      if (
        typeof m.contextId !== 'number' ||
        typeof m.definition !== 'string' ||
        !m.definition.trim()
      ) {
        return bad('bad-payload');
      }
      const filled = await backfillDefinition(
        m.contextId,
        m.definition.slice(0, 2000),
      );
      const r: BackfillResult = { ok: true, filled };
      if (filled) broadcast({ type: 'vocab-changed' });
      return r;
    }
    case 'setStatus': {
      const key = typeof m.key === 'string' ? normalizeExpression(m.key) : '';
      if (!key || !isVocabStatus(m.status)) return bad('bad-payload');
      // 词形关联：把 'went' 的状态修改落到词条 'go'
      const target = (await resolveEntry(key))?.key ?? key;
      const ok = await setStatus(target, m.status);
      if (!ok) return bad('not-found');
      broadcast({ type: 'vocab-changed' });
      // 状态是学习库受管字段：连接时排队写回
      queueVaultWriteAfterSave(async () => {
        const entry = await getEntry(target);
        if (entry) await enqueueVocabWrite(entryViewToVaultRecord(entry));
      });
      return { ok: true };
    }
    case 'setNote': {
      const key = typeof m.key === 'string' ? normalizeExpression(m.key) : '';
      if (!key || typeof m.note !== 'string' || m.note.length > 4000) return bad('bad-payload');
      const target = (await resolveEntry(key))?.key ?? key;
      const ok = await setEntryNote(target, m.note);
      if (!ok) return bad('not-found');
      broadcast({ type: 'vocab-changed' });
      queueVaultWriteAfterSave(async () => {
        const entry = await getEntry(target);
        if (entry) await enqueueVocabWrite(entryViewToVaultRecord(entry));
      });
      return { ok: true };
    }
    case 'deleteEntry': {
      if (typeof m.key !== 'string' || !m.key) return bad('bad-payload', 'key');
      const target = (await resolveEntry(normalizeExpression(m.key)))?.key ?? normalizeExpression(m.key);
      const ok = await deleteEntry(target);
      if (!ok) return bad('not-found');
      broadcast({ type: 'vocab-changed' });
      return { ok: true };
    }
    case 'removeForm': {
      if (typeof m.key !== 'string' || !m.key) return bad('bad-payload', 'key');
      if (typeof m.form !== 'string' || !m.form.trim()) return bad('bad-payload', 'form');
      const target = (await resolveEntry(normalizeExpression(m.key)))?.key ?? normalizeExpression(m.key);
      const removed = await removeForm(target, normalizeExpression(m.form));
      const r: RemoveFormResult = { ok: true, removed };
      if (removed) broadcast({ type: 'vocab-changed' });
      return r;
    }
    case 'listEntries': {
      if (m.query !== undefined && typeof m.query !== 'string') {
        return bad('bad-payload', 'query');
      }
      // 语言筛选：'all'／缺省 = 全部；'und' = 待确认集合；其余为语言标签。
      if (m.language !== undefined && m.language !== 'all' && !isLanguageTag(m.language)) {
        return bad('bad-payload', 'language');
      }
      return { ok: true, entries: await listEntries(m.query, m.language) };
    }
    case 'vocabIndex': {
      const r: VocabIndexResult = { ok: true, items: await listIndex() };
      return r;
    }
    case 'getSettings': {
      const r: GetSettingsResult = { ok: true, settings: await getSettings() };
      return r;
    }
    case 'setSetting': {
      if (typeof m.name !== 'string' || !validSetting(m.name, m.value)) {
        return bad('bad-payload', 'setting');
      }
      await browser.storage.local.set({ [m.name]: m.value });
      // 语言偏好双向生效：连接学习库时排队写回 偏好.md
      if (m.name === 'defaultComprehensionLang' || m.name === 'comprehensionOverrides') {
        queueVaultWriteAfterSave(() => enqueuePreferenceWrite());
      }
      return { ok: true };
    }
    case 'translateCues': {
      if (typeof m.videoId !== 'string' || !m.videoId) return bad('bad-payload', 'videoId');
      if (typeof m.trackId !== 'string' || !m.trackId) return bad('bad-payload', 'trackId');
      if (
        !Array.isArray(m.items) ||
        !m.items.length ||
        m.items.length > MAX_TRANSLATE_BATCH
      ) {
        return bad('bad-payload', 'items');
      }
      const items: { id: number; text: string }[] = [];
      for (const it of m.items) {
        const x = it as { id?: unknown; text?: unknown };
        if (typeof x.id !== 'number' || !Number.isInteger(x.id) || x.id < 0) {
          return bad('bad-payload', 'id');
        }
        if (typeof x.text !== 'string' || !x.text.trim()) {
          return bad('bad-payload', 'text');
        }
        items.push({ id: x.id, text: x.text.slice(0, MAX_CUE_TEXT) });
      }
      const sourceLang = parseLangField(m.sourceLang);
      const targetLang = parseLangField(m.targetLang);
      if (sourceLang === null || targetLang === null) return bad('bad-payload', 'lang');
      const langScope = sourceLang && targetLang ? `${sourceLang}|${targetLang}` : 'en-zh';
      const controller = new AbortController();
      const requestKey = `${sender.tab?.id ?? sender.url}|${m.requestId}`;
      onlineRequests.set(requestKey, controller);
      try {
        const mode = m.mode;
        if (mode !== 'regular' && mode !== 'ai') return bad('bad-payload', 'mode');
        if (mode === 'ai') {
          const config = await getAiConfig();
          if (!config.apiKey) return bad('no-key');
          if (validateAiProfile(config)) return bad('invalid-config');
          const scope = aiCacheScope(config);
          const textKey = (text: string) => JSON.stringify(['translation', scope, langScope, text]);
          const translations: { id: number; text: string }[] = [];
          const missing: typeof items = [];
          for (const item of items) {
            const hit = await cacheGet<string>(textKey(item.text));
            if (hit) translations.push({ id: item.id, text: hit }); else missing.push(item);
          }
          if (missing.length) {
            const key = JSON.stringify(['translation-batch', scope, langScope, missing.map(i => i.text)]);
            const r = await cached(key, signal => translateSentences(config, missing.map(i => i.text), signal, { source: sourceLang ?? 'en', target: targetLang ?? 'zh-Hans' }), controller.signal);
            if (!r.ok && !translations.length) return r;
            if (r.ok) for (const t of r.translations) {
              const item = missing[t.id];
              if (item && t.text) { translations.push({ id: item.id, text: t.text }); await cachePut(textKey(item.text), t.text); }
            }
          }
          return { ok: true, translations };
        }
        const translations: { id: number; text: string }[] = [];
        const cueLangs = { source: sourceLang ?? 'en', target: targetLang ?? 'zh-Hans' };
        for (const item of items) {
          const r = await cached(JSON.stringify(['translation', 'google-gtx', langScope, item.text]), signal => translateRegularText(item.text, signal, cueLangs), controller.signal);
          if (r.ok) translations.push({ id: item.id, text: r.text });
        }
        return { ok: true, translations };
      } finally { if (onlineRequests.get(requestKey) === controller) onlineRequests.delete(requestKey); }
    }
    // ---- M11 学习库 -------------------------------------------------------------
    case 'vaultStatus': {
      return { ok: true, status: await getVaultStatus() };
    }
    case 'vaultConnect': {
      // 页面侧已完成选目录/授权（pickVaultDirectoryInPage 把句柄写入 IDB），
      // 重新授权 = 页面再次选同一目录后重发本消息。
      const r = await adoptVault();
      if (!r.ok) return bad(r.error);
      broadcast({ type: 'vault-changed' });
      broadcast({ type: 'vocab-changed' });
      return { ok: true, vault: (await getVaultIdentity()) ?? null, imported: r.imported };
    }
    case 'vaultDisconnect': {
      await disconnectVault();
      broadcast({ type: 'vault-changed' });
      return { ok: true };
    }
    case 'vaultFlush': {
      const r = await flushVaultWrites();
      await syncFromVault();
      broadcast({ type: 'vault-changed' });
      broadcast({ type: 'vocab-changed' });
      return { ok: true, ...r };
    }
    case 'vaultSync': {
      const r = await syncFromVault();
      if (r.error) return bad(r.error);
      broadcast({ type: 'vault-changed' });
      if (r.updated || r.deleted) broadcast({ type: 'vocab-changed' });
      return { ok: true, ...r };
    }
    case 'openSettings': {
      return handlePanelMessage({type:'panelOpen',view:'settings'},sender,nativeOpen);
    }
    default:
      return bad('unknown-type');
  }
}

export default defineBackground(() => {
  // storage.local 收紧为受信任上下文（扩展页面 / SW），content script 不可读。
  void browser.storage.local
    .setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    .catch(() => {});

  // M11 语言迁移（幂等）：旧词条按证据赋语言；有变化时补写学习库。
  void (async () => {
    try {
      const report = await migrateLegacyLanguages();
      if (report.entriesScanned || report.sentencesBackfilled) {
        broadcast({ type: 'vocab-changed' });
        broadcast({ type: 'sentences-changed' });
        if (await getVaultIdentity()) {
          for (const e of await listEntries()) await enqueueVocabWrite(entryViewToVaultRecord(e));
          for (const s of await listSentences()) await enqueueSentenceWrite(sentenceToVaultRecord(s));
          await flushVaultWrites();
          broadcast({ type: 'vault-changed' });
        }
      }
    } catch (e) {
      console.warn('[blc] language migration failed', e);
    }
  })();

  // M5 问答：侧栏长连接（发送 / 停止 / 重试 / 流事件广播）
  initChatService();
  initPanelLifecycle();
  initSelectionCandidateStore();

  // 设置页直接写 storage 时经 onChanged 广播给页面与各标签页。
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('cacheLimit' in changes) void trimCache();
    if (Object.keys(changes).some(k => k in DEFAULT_SETTINGS)) broadcast({ type: 'settings-changed' });
    // 语言偏好双向生效：设置变化即排队写回 偏好.md（幂等键，重复无害）
    if ('defaultComprehensionLang' in changes || 'comprehensionOverrides' in changes) {
      queueVaultWriteAfterSave(() => enqueuePreferenceWrite());
    }
    const activeProfile = (raw: unknown) => {const value=raw as {active?:string;profiles?:Record<string,unknown>}|undefined;return [value?.active,value?.profiles?.[value?.active??'']];};
    if (changes.deepseekApiKey || changes.aiServices && JSON.stringify(activeProfile(changes.aiServices.oldValue)) !== JSON.stringify(activeProfile(changes.aiServices.newValue))) broadcast({type:'ai-service-changed'});
  });

  browser.tabs.onRemoved.addListener(tabId => {
    void browser.storage.session.remove(`video-session:${tabId}`);
    for (const [key, controller] of onlineRequests) if (key.startsWith(`${tabId}|`)) controller.abort();
  });

  // 扩展按钮直接打开侧栏（生词本）。
  void browser.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  browser.action.onClicked.addListener(tab => {
    if(typeof tab.id === 'number' && typeof tab.windowId === 'number') {
      const opened=browser.sidePanel.open({windowId:tab.windowId}).then(()=>true,()=>false);
      void openPanel(tab.id,tab.windowId,undefined,undefined,opened);
    }
  });
  browser.tabs.onActivated.addListener(({tabId})=>{
    void browser.storage.local.get('panelMode').then(stored=>{
      if(stored.panelMode!=='floating')void browser.tabs.sendMessage(tabId,{type:'pd-panel-hide'},{frameId:0}).catch(()=>{});
    });
  });
  console.info('[blc] background ready');

  browser.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    const nativeOpen=sender.id===browser.runtime.id?startNativePanel(msg,sender):undefined;
    handle(msg, sender,nativeOpen)
      .then(sendResponse)
      .catch((e) => sendResponse(bad('internal', String((e as Error)?.message ?? e))));
    return true; // 异步响应
  });
});
