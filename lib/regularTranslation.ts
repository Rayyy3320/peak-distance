// yt-dual-subs background.js (commit 5657c8a18ca30c84b5d4662bca58e3e9214ffdff):
// 使用同一免 key Google 端点及 json[0][i][0] 结构。
// Copyright (c) 2026 Gythiro. MIT 许可全文见 public/THIRD_PARTY_NOTICES.txt。

export type RegularTranslationResult =
  | { ok: true; source: 'google-gtx'; text: string }
  | { ok: false; source: 'google-gtx'; error: 'empty' | 'partial' | 'restricted' | 'network' | 'http' | 'bad-response' | 'aborted'; detail?: string };

export function parseGoogleTranslation(json: unknown): string {
  if (!Array.isArray(json) || !Array.isArray(json[0])) return '';
  return json[0]
    .map((part: unknown) => Array.isArray(part) && typeof part[0] === 'string' ? part[0] : '')
    .join('')
    .trim();
}

/** 只翻译一段自由短语或一条字幕；字幕 ID 由调用方保持。 */
export async function translateRegularText(text: string, signal?: AbortSignal): Promise<RegularTranslationResult> {
  const input = text.trim();
  if (!input) return { ok: false, source: 'google-gtx', error: 'empty' };
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.search = new URLSearchParams({ client: 'gtx', sl: 'en', tl: 'zh-CN', dt: 't', q: input }).toString();
  const timeout = AbortSignal.timeout(12000);
  const fetchOnce = async (): Promise<RegularTranslationResult> => {
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
      const letters = (value: string) => (value.match(/[A-Za-z]/g) ?? []).length;
      if (translated === input || (letters(input) >= 20 && letters(translated) >= letters(input) * 0.35)) {
        return { ok: false, source: 'google-gtx', error: 'partial' };
      }
      return { ok: true, source: 'google-gtx', text: translated };
    } catch (error) {
      return { ok: false, source: 'google-gtx', error: 'bad-response', detail: String(error) };
    }
  };
  const first = await fetchOnce();
  if (first.ok || first.error !== 'partial') return first;
  return fetchOnce();
}
