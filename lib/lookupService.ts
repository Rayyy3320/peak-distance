// M11 查询路由（spec 3.3 路由表的唯一实现点）：
// - 词典按源／目标语言对匹配（现有 youdao / cambridge 仅 en→zh-Hans），
//   语言对不适用或词典明确未命中 → 免费译文；
// - 词典网络／限流等故障 ≠ 明确未命中：标明故障（degraded），仍可尝试免费译文，
//   但不触发 AI 兜底；
// - AI 释义兜底仅在「开关开启 + 已配置 + 主动查词（active）」时走，
//   失败回退免费译文；悬停／预览／预取永不触发 LLM；
// - 缓存键随语言对、原文与 AI 配置区分，词典缓存不混入其它语言同形词。
import { lookupDictionarySource, type DictionarySource } from './onlineDictionary';
import { translateRegularText } from './regularTranslation';
import { cached, cacheGet } from './onlineCache';
import { lookupExpression } from './aiClient';
import type { DictionaryResult } from './onlineDictionary';
import type { RegularTranslationResult } from './regularTranslation';
import type { Settings } from '@/shared/settings';
import type { OnlineLookupResult } from '@/shared/messages';
import type { AiConfig } from '@/shared/aiConfig';
import { aiCacheScope } from '@/shared/aiConfig';
import {
  LANG_UNDETERMINED,
  normalizeExpressionInLanguage,
  primaryOfLang,
} from '@/shared/languages';

export interface LookupRequestContext {
  /** 源语言（'und' = 待确认，交给免费译文自动检测）；目标 = 理解语言 */
  lang: { source: string; target: string };
  /** 缺省按 active（迁移前调用方）；hover/preview/prefetch 不触发 AI */
  intent?: 'active' | 'hover' | 'preview' | 'prefetch';
  /** AI 兜底授权：开关（本浏览器）+ 当前配置快照；未配置时 config 为 null */
  aiFallback?: { enabled: boolean; config: AiConfig | null };
  /** 语境（AI 释义与缓存身份用） */
  sentence?: string;
  neighbors?: string;
}

/** 现有词典渠道的语言能力：仅英语源 + 中文理解目标。 */
function dictionaryApplicable(source: string, target: string): boolean {
  return primaryOfLang(source) === 'en' && primaryOfLang(target) === 'zh';
}

function pairOf(source: string, target: string): string {
  return `${source}|${target}`;
}

async function freeTranslation(
  expression: string,
  ctx: LookupRequestContext,
  signal?: AbortSignal,
): Promise<OnlineLookupResult> {
  const hit = await cacheGet<RegularTranslationResult>(
    JSON.stringify(['translation', 'google-gtx', pairOf(ctx.lang.source, ctx.lang.target), expression]),
  );
  if (hit?.ok) return { ok: true, result: { kind: 'translation', source: hit.source, text: hit.text } };
  const r = await cached(
    JSON.stringify(['translation', 'google-gtx', pairOf(ctx.lang.source, ctx.lang.target), expression]),
    (s) =>
      translateRegularText(expression, s, {
        source: ctx.lang.source === LANG_UNDETERMINED ? 'auto' : ctx.lang.source,
        target: ctx.lang.target,
      }),
    signal,
  );
  if (r.ok) return { ok: true, result: { kind: 'translation', source: r.source, text: r.text } };
  return { ok: false, error: r.error, detail: r.detail };
}

/** AI 释义兜底（已由调用条件保证开关开启、已配置、主动意图）。失败返回 null。 */
async function aiDefinitionFallback(
  expression: string,
  ctx: LookupRequestContext,
  config: AiConfig,
  signal?: AbortSignal,
): Promise<OnlineLookupResult | null> {
  const cacheKey = JSON.stringify([
    'ai-definition',
    aiCacheScope(config),
    pairOf(ctx.lang.source, ctx.lang.target),
    expression,
    ctx.sentence ?? '',
  ]);
  const hit = await cacheGet<OnlineLookupResult>(cacheKey);
  if (hit?.ok) return hit;
  const r = await cached(cacheKey, (s) =>
    lookupExpression(
      config,
      {
        expression,
        sentence: ctx.sentence ?? expression,
        neighbors: ctx.neighbors,
        langs: ctx.lang,
      },
      s,
    ),
    signal,
  );
  if (!r.ok) return null;
  const text = [r.definition, r.note].filter(Boolean).join('\n');
  if (!text) return null;
  return {
    ok: true,
    result: {
      kind: 'ai-definition',
      source: 'ai',
      text,
      lang: { source: ctx.lang.source, target: ctx.lang.target },
      ...(r.provider ? { provider: r.provider } : {}),
      ...(r.model ? { model: r.model } : {}),
    },
  };
}

/**
 * 主动查词的唯一入口。无 ctx 时按 en→zh-Hans 旧行为（词典优先）。
 * 悬停预览等非主动入口由调用方携带 intent，本函数保证零 LLM 调用。
 */
export async function lookupOnline(
  expression: string,
  settings: Settings,
  source?: DictionarySource,
  signal?: AbortSignal,
  ctx?: LookupRequestContext,
): Promise<OnlineLookupResult> {
  const lang = ctx?.lang ?? { source: 'en', target: 'zh-Hans' };
  const query = normalizeExpressionInLanguage(expression, lang.source);
  if (!query) return { ok: false, error: 'bad-payload', detail: 'empty-expression' };

  // 免费译文兜底链：明确未命中（或词典不适用）时——AI 优先（开关开启且已配置
  // 且主动查词），AI 失败回退免费译文；开关关闭直接免费译文。
  const missFallback = async (): Promise<OnlineLookupResult> => {
    const activeIntent = (ctx?.intent ?? 'active') === 'active';
    const allowAi = !!ctx?.aiFallback?.enabled && !!ctx.aiFallback.config?.apiKey && activeIntent;
    if (allowAi && ctx) {
      const ai = await aiDefinitionFallback(query, { ...ctx, lang }, ctx.aiFallback!.config!, signal);
      if (ai) return ai;
      const degradedAi: OnlineLookupResult = await freeTranslation(query, { ...ctx, lang }, signal);
      return degradedAi.ok ? { ...degradedAi, degraded: 'ai-failed' } : degradedAi;
    }
    const base = await freeTranslation(query, { ...ctx, lang }, signal);
    // 开关开启但未配置：继续免费路径，同时提示需要配置（spec 3.3）。
    if (
      base.ok && ctx?.aiFallback?.enabled && !ctx.aiFallback.config?.apiKey && activeIntent
    ) {
      return { ...base, degraded: 'ai-unconfigured' };
    }
    return base;
  };

  // 词典语言对不适用：非英语源（含待确认）或非中文目标 → 直接免费译文链。
  if (!dictionaryApplicable(lang.source, lang.target)) {
    return missFallback();
  }

  const sources = source
    ? [source]
    : [...new Set([settings.primaryDictionary, settings.backupDictionary])];
  const dictScope = pairOf('en', lang.target);

  for (const dictionary of sources) {
    const hit = await cacheGet<DictionaryResult>(JSON.stringify(['dictionary', dictionary, dictScope, query]));
    if (hit?.ok) return { ok: true, result: { kind: 'dictionary', entry: hit.entry } };
  }
  if (!source) {
    const hit = await cacheGet<RegularTranslationResult>(
      JSON.stringify(['translation', 'google-gtx', pairOf(lang.source, lang.target), query]),
    );
    if (hit?.ok) return { ok: true, result: { kind: 'translation', source: hit.source, text: hit.text } };
  }

  let failure = 'not-found';
  let allMissing = true;
  for (const dictionary of sources) {
    const result = await cached(
      JSON.stringify(['dictionary', dictionary, dictScope, query]),
      (s) => lookupDictionarySource(query, dictionary, s),
      signal,
    );
    if (result.ok) return { ok: true, result: { kind: 'dictionary', entry: result.entry } };
    failure = result.error;
    if (result.error !== 'not-found') allMissing = false;
    if (result.error === 'aborted' || result.error === 'restricted') break;
  }

  if (allMissing) return missFallback();

  // 词典故障（网络／限流／解析）：标明故障，可尝试免费译文，但不当作未命中触发 AI。
  const degraded = await freeTranslation(query, { lang, intent: ctx?.intent, sentence: ctx?.sentence, neighbors: ctx?.neighbors }, signal);
  return degraded.ok ? { ...degraded, degraded: 'dictionary-failure' } : { ok: false, error: failure };
}
