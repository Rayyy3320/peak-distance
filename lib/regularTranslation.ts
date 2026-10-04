// yt-dual-subs background.js (commit 5657c8a18ca30c84b5d4662bca58e3e9214ffdff):
// 使用同一免 key Google 端点及 json[0][i][0] 结构。
// Copyright (c) 2026 Gythiro. MIT 许可全文见 docs/REFERENCES.md。
//
// M11：支持任意语言对（source 可为 'auto'）；内部语言标签 → google 代码的
// 转换集中在这里。移除按英文字母占比判定失败的旧规则（M11 spec 3.3）：
// 专名或同语输入返回原文不算失败，由调用方按需展示。

export type RegularTranslationResult =
  | { ok: true; source: 'google-gtx'; text: string }
  | { ok: false; source: 'google-gtx'; error: 'empty' | 'restricted' | 'network' | 'http' | 'bad-response' | 'aborted'; detail?: string };

export interface TranslationLangs {
  /** 源语言（内部标签）；'auto' 或缺省交给端点自动检测 */
  source?: string;
  /** 目标语言（内部标签，如 zh-Hans） */
  target: string;
}

/** 内部语言标签 → google-gtx 代码。清单外主标签原样传给端点。 */
export function googleLanguageCode(tag: string): string {
  const primary = tag.trim().toLowerCase().split('-')[0]!;
  if (primary === 'zh') return /^zh-hant/i.test(tag) ? 'zh-TW' : 'zh-CN';
  if (primary === 'iw') return 'iw'; // 端点沿用旧希伯来语代码
  return primary;
}

export function parseGoogleTranslation(json: unknown): string {
  if (!Array.isArray(json) || !Array.isArray(json[0])) return '';
  return json[0]
    .map((part: unknown) => Array.isArray(part) && typeof part[0] === 'string' ? part[0] : '')
    .join('')
    .trim();
}

/** 只翻译一段自由短语或一条字幕；字幕 ID 由调用方保持。 */
export async function translateRegularText(
  text: string,
  signal?: AbortSignal,
  langs?: TranslationLangs,
): Promise<RegularTranslationResult> {
  const input = text.trim();
  if (!input) return { ok: false, source: 'google-gtx', error: 'empty' };
  const sl = !langs?.source || langs.source === 'auto' ? 'auto' : googleLanguageCode(langs.source);
  const tl = googleLanguageCode(langs?.target ?? 'zh-Hans');
  if (sl !== 'auto' && sl === tl) return { ok: true, source: 'google-gtx', text: input };
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.search = new URLSearchParams({ client: 'gtx', sl, tl, dt: 't', q: input }).toString();
  const timeout = AbortSignal.timeout(12000);
  let response: Response;
  try {
    response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (error) {
    return { ok: false, source: 'google-gtx', error: signal?.aborted ? 'aborted' : 'network', detail: String(error) };
  }
  if ([403, 429, 503].includes(response.status)) return { ok: false, source: 'google-gtx', error: 'restricted', detail: `http ${response.status}` };
  if (!response.ok) return { ok: false, source: 'google-gtx', error: 'http', detail: `http ${response.status}` };
  try {
    const translated = parseGoogleTranslation(await response.json());
    if (!translated) return { ok: false, source: 'google-gtx', error: 'empty' };
    // 专名／无变化输入：保持原文，不算失败（不伪造译文也不阻断展示）
    return { ok: true, source: 'google-gtx', text: translated };
  } catch (error) {
    return { ok: false, source: 'google-gtx', error: 'bad-response', detail: String(error) };
  }
}
