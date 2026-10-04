import type { AiConfig } from '@/shared/aiConfig';
import { parseAiResponse, parseAiStreamEvent, requestAi } from './aiTransport';
import { parseFormsLine } from '@/shared/vocab';
import { langDisplayName, LANG_UNDETERMINED } from '@/shared/languages';
import {
  feedSSE,
  type ChatCompletionMessage,
} from '@/shared/chat';
import type { LookupResult, TranslateSentencesResult } from '@/shared/messages';

const TIMEOUT_MS = 30000;
// deepseek-flash 是推理模型：max_tokens 需覆盖推理链 + 最终回答
//（2026-10-02 验收实证：预算过小时回答全落在 reasoning_content，content 为空）。
const MAX_TOKENS = 4000;
const MAX_TOKENS_TRANSLATE = 6000;
const RETRY_TOKENS_CAP = 12000;
// 问答流式：回答较长，预算单独给足
const MAX_TOKENS_CHAT = 8000;

/** M11：提示按实际源／理解语言组织；语言待确认时按原文处理。 */
function sourceNameOf(lang: string): string {
  return lang === LANG_UNDETERMINED || !lang ? '原文（语言待确认）' : `${langDisplayName(lang)}（${lang}）`;
}

function definitionSystemPrompt(source: string, target: string): string {
  return [
    `你是语言学习助手。用户正在阅读${sourceNameOf(source)}内容并查询其中的一个词或短语。`,
    `请用${langDisplayName(target)}回答，输出纯文本，不要使用 Markdown、HTML 或代码块。`,
    `第一行以“释义：”开头，给出该表达的核心${langDisplayName(target)}释义（简洁，通常一行）；`,
    `第二行以“语境：”开头，说明它在这句话里的具体含义或用法（一到两句）；`,
  ].join('');
}

function translateSystemPrompt(source: string, target: string): string {
  return [
    `你是视频字幕翻译引擎。把用户给出的每行${sourceNameOf(source)}字幕翻译成自然的${langDisplayName(target)}。`,
    '只输出一个 JSON 数组，长度与输入行数相同，每项是对应行译文的字符串，',
    '不要输出任何其它内容、解释或代码块标记。',
  ].join('');
}

/** 兼容缺省：未提供语言对时沿用英语学习／简体中文行为（迁移前调用方）。 */
const SYSTEM_PROMPT = definitionSystemPrompt('en', 'zh-Hans');
const SYSTEM_PROMPT_TRANSLATE = translateSystemPrompt('en', 'zh-Hans');

interface ChatError {
  ok: false;
  error: string;
  detail?: string;
}

/** chat/completions 响应的可判定部分（纯函数，regress 覆盖）。 */
export interface ChatCompletionParts {
  /** 最终回答；空串 / 纯空白 / 非字符串都归一为 null。 */
  content: string | null;
  finishReason: string | null;
  /** 回答是否滞留在 reasoning_content（推理模型预算耗尽的信号）。 */
  hasReasoning: boolean;
}

export function parseChatCompletion(json: unknown): ChatCompletionParts {
  return parseAiResponse('openai', json);
}

async function chatOnce(
  config: AiConfig,
  system: string,
  user: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<{ parts: ChatCompletionParts } | { error: ChatError }> {
  let res: Response;
  try {
    res = await requestAi(config, [{ role: 'system', content: system }, { role: 'user', content: user }], false, maxTokens, signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS));
  } catch (err) {
    return { error: { ok: false, error: requestError(err) } };
  }
  if (res.status === 401 || res.status === 403) {
    return { error: { ok: false, error: 'auth', detail: `http ${res.status}` } };
  }
  if (res.status === 429) {
    return { error: { ok: false, error: 'rate-limit' } };
  }
  if (!res.ok) {
    return { error: { ok: false, error: 'http', detail: `http ${res.status}` } };
  }
  let json: any;
  try {
    json = await res.json();
  } catch {
    return { error: { ok: false, error: 'bad-response' } };
  }
  return { parts: parseAiResponse(config.protocol, json) };
}

async function chat(
  config: AiConfig,
  system: string,
  user: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<{ content: string } | { error: ChatError }> {
  let r = await chatOnce(config, system, user, maxTokens, signal);
  if ('error' in r) return r;
  if (!r.parts.content) {
    // 失败留痕便于定位（不含 key 与用户内容）
    console.warn('[blc] AI 无有效 content', {
      model: config.model,
      finish: r.parts.finishReason,
      reasoningOnly: r.parts.hasReasoning,
    });
    return {
      error: {
        ok: false,
        error: 'bad-response',
        detail: `finish=${r.parts.finishReason ?? '?'}${r.parts.hasReasoning ? ' reasoning-only' : ''}`,
      },
    };
  }
  return { content: r.parts.content };
}

/** 从纯文本回复中提取释义、语境与词形；模型未按格式作答时整体作为释义。 */
export function parseDefinitionReply(content: string): {
  definition: string;
  note: string;
  forms: string[];
} {
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  let definition = '';
  let note = '';
  let formsRaw = '';
  for (const line of lines) {
    const m = line.match(/^(?:释义|定義|定义)\s*[：:]\s*(.+)$/);
    if (m && !definition) {
      definition = m[1]!;
      continue;
    }
    const n = line.match(/^(?:语境|語境)\s*[：:]\s*(.+)$/);
    if (n && !note) {
      note = n[1]!;
      continue;
    }
    const f = line.match(/^(?:词形|詞形)\s*[：:]\s*(.+)$/);
    if (f && !formsRaw) {
      formsRaw = f[1]!;
      continue;
    }
  }
  if (!definition && !note && !formsRaw) {
    return { definition: content.trim(), note: '', forms: [] };
  }
  return { definition, note, forms: formsRaw ? parseFormsLine(formsRaw) : [] };
}

export async function lookupExpression(
  config: AiConfig,
  input: { expression: string; sentence: string; neighbors?: string; langs?: { source: string; target: string } },
  signal?: AbortSignal,
): Promise<LookupResult> {
  if (!config.apiKey) return { ok: false, error: 'no-key' };
  const user = [
    `表达：${input.expression}`,
    `原句：${input.sentence}`,
    input.neighbors ? `相邻字幕：${input.neighbors}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const system = input.langs
    ? definitionSystemPrompt(input.langs.source, input.langs.target)
    : SYSTEM_PROMPT;
  const r = await chat(config, system, user, MAX_TOKENS, signal);
  if ('error' in r) return r.error as LookupResult;
  const { definition, note } = parseDefinitionReply(r.content);
  return { ok: true, definition, note, provider: config.provider, model: config.model };
}

/** 从模型输出中抢救一个 JSON 数组（容忍被包裹或前后杂文）。 */
function parseJsonArray(content: string): string[] | null {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(trimmed.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    return arr.map((x) => (typeof x === 'string' ? x.trim() : ''));
  } catch {
    return null;
  }
}

/**
 * 字幕批量翻译：lines 与输入等长对齐；只返回成功解析出的行。
 * 整体失败（网络 / 无 key / 响应不可解析）返回错误，由调用方决定不再自动重试。
 */
export async function translateSentences(
  config: AiConfig,
  lines: string[],
  signal?: AbortSignal,
  langs?: { source: string; target: string },
): Promise<TranslateSentencesResult> {
  if (!config.apiKey) return { ok: false, error: 'no-key' };
  if (!lines.length) return { ok: true, translations: [] };
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  const system = langs ? translateSystemPrompt(langs.source, langs.target) : SYSTEM_PROMPT_TRANSLATE;
  let content: string | null = null;
  const r1 = await chat(config, system, numbered, MAX_TOKENS_TRANSLATE, signal);
  if ('error' in r1) return r1.error as TranslateSentencesResult;
  content = r1.content;
  let arr = parseJsonArray(content);
  if (!arr || !arr.length) {
    // JSON 被截断（推理 + 长回答超出预算）时加倍预算重试一次
    const r2 = await chat(
      config,
      system,
      numbered,
      Math.min(MAX_TOKENS_TRANSLATE * 2, RETRY_TOKENS_CAP),
      signal,
    );
    if ('error' in r2) return r2.error as TranslateSentencesResult;
    arr = parseJsonArray(r2.content);
  }
  if (!arr || !arr.length) return { ok: false, error: 'bad-response' };
  const translations = arr
    .map((text, i) => ({ id: i, text }))
    .filter((t) => t.text);
  return { ok: true, translations };
}

// ---- M5 问答流式调用（多轮、SSE） ----------------------------------------------

export type ChatStreamErrorKind =
  | 'invalid-config'
  | 'permission'
  | 'no-key'
  | 'auth'
  | 'rate-limit'
  | 'network'
  | 'http'
  | 'bad-response'
  | 'aborted';

export type ChatStreamResult =
  | { ok: true; text: string; finishReason: string | null }
  | { ok: false; error: ChatStreamErrorKind; detail?: string };

/**
 * 问答专用流式补全：stream=true，逐块解析 SSE（半行 / 多事件合包 / [DONE]），
 * 只把 delta.content 当回答；reasoning_content 不当答案也不入库。
 * onText 在回答正文增长时回调；onEvent 在每个有效 SSE 事件（含 reasoning
 * 增量）回调——调用方据此重置空闲计时，长推理阶段不误判 60s 超时。
 * 停止由调用方的 AbortSignal 触发（返回 aborted）。
 */
export async function chatCompletionStream(
  config: AiConfig,
  messages: ChatCompletionMessage[],
  opts: {
    signal: AbortSignal;
    onText?: (fullText: string) => void;
    onEvent?: () => void;
  },
): Promise<ChatStreamResult> {
  if (!config.apiKey) return { ok: false, error: 'no-key' };
  let res: Response;
  try {
    res = await requestAi(config, messages, true, MAX_TOKENS_CHAT, opts.signal);
  } catch (err) {
    if (opts.signal.aborted) return { ok: false, error: 'aborted' };
    return {
      ok: false,
      error: requestError(err),
    };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'auth', detail: `http ${res.status}` };
  }
  if (res.status === 429) {
    return { ok: false, error: 'rate-limit' };
  }
  if (!res.ok) {
    return { ok: false, error: 'http', detail: `http ${res.status}` };
  }
  const reader = res.body?.getReader();
  if (!reader) return { ok: false, error: 'bad-response', detail: 'no body' };
  const decoder = new TextDecoder();
  let rest = '';
  let text = '';
  let finishReason: string | null = null;
  const consume = (chunk: string): boolean => {
    const fed = feedSSE(rest, chunk);
    rest = fed.rest;
    if (fed.events.length || fed.done) opts.onEvent?.();
    for (const ev of fed.events) {
      const parsed = parseAiStreamEvent(config.protocol, ev);
      if (parsed.error) throw Error('stream-error');
      if (parsed.done) return true;
      if (parsed.content) {
        text += parsed.content;
        opts.onText?.(text);
      }
      if (parsed.finishReason) finishReason = parsed.finishReason;
    }
    return fed.done;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break; // 流自然结束（无 [DONE] 也视为截断收尾）
      if (consume(decoder.decode(value, { stream: true }))) break;
    }
  } catch (err) {
    if (opts.signal.aborted) return { ok: false, error: 'aborted' };
    return { ok: false, error: (err as Error)?.message === 'stream-error' ? 'bad-response' : 'network' };
  } finally {
    try {
      await reader.cancel();
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  if (!text.trim()) {
    return {
      ok: false,
      error: 'bad-response',
      detail: `empty stream finish=${finishReason ?? '?'}`,
    };
  }
  return { ok: true, text, finishReason };
}

function requestError(error: unknown): 'network' | 'invalid-config' | 'permission' {
  const message = (error as Error)?.message;
  return message === 'invalid-config' || message === 'permission' ? message : 'network';
}
