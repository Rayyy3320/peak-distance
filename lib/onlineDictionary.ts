// 仅由 background 调用。返回纯文本字段，远端 HTML 不进入页面 UI。
import { parseHTML } from 'linkedom';

export type DictionarySource = 'youdao' | 'cambridge';

export interface DictionarySense {
  partOfSpeech?: string;
  definition: string;
  example?: string;
  exampleTranslation?: string;
}

export interface DictionaryEntry {
  source: DictionarySource;
  expression: string;
  headword: string;
  url: string;
  phonetic?: string;
  audioUrl?: string;
  senses: DictionarySense[];
  /** 来源明确给出的候选；调用方不得自动归并词条。 */
  lemmaCandidates?: string[];
  forms?: string[];
}

export type DictionaryResult =
  | { ok: true; entry: DictionaryEntry }
  | { ok: false; source: DictionarySource; error: 'not-found' | 'restricted' | 'network' | 'http' | 'bad-response' | 'aborted'; detail?: string };

const clean = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const same = (a: string, b: string): boolean => clean(a).toLocaleLowerCase() === clean(b).toLocaleLowerCase();
const text = (node: Element | null): string => clean(node?.textContent);

export function dictionaryOriginalUrl(expression: string, source: DictionarySource): string {
  const query = clean(expression);
  return source === 'youdao'
    ? `https://dict.youdao.com/w/${encodeURIComponent(query)}/`
    : `https://dictionary.cambridge.org/dictionary/english-chinese-simplified/${encodeURIComponent(query.toLowerCase().replace(/\s+/g, '-'))}`;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(12000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function parseYoudao(json: any, expression: string, url: string): DictionaryResult {
  const source = 'youdao';
  const word = json?.ec?.word?.[0];
  const headword = clean(word?.['return-phrase']?.l?.i);
  if (!same(headword, expression)) return { ok: false, source, error: 'not-found' };
  const pairs = json?.blng_sents_part?.['sentence-pair'];
  const example = Array.isArray(pairs) ? pairs.find((p) => clean(p?.sentence) && clean(p?.['sentence-translation'])) : undefined;
  const senses: DictionarySense[] = [];
  for (const group of word?.trs ?? []) {
    for (const item of group?.tr ?? []) {
      for (const raw of item?.l?.i ?? []) {
        const value = clean(raw);
        if (!value || !/[\u3400-\u9fff]/u.test(value)) continue;
        const match = value.match(/^((?:n|v|adj|adv|prep|pron|conj|interj|phr)\.)\s*(.+)$/i);
        const sentence = item?.l?.sentence?.find?.((s: any) => clean(s?.en) && clean(s?.zh));
        for (const meaning of (match?.[2] ?? value).split('；').map(clean).filter(Boolean)) {
          senses.push({
            partOfSpeech: match?.[1],
            definition: meaning,
            example: clean(sentence?.en ?? example?.sentence) || undefined,
            exampleTranslation: clean(sentence?.zh ?? example?.['sentence-translation']) || undefined,
          });
          if (senses.length >= 8) break;
        }
        if (senses.length >= 8) break;
      }
      if (senses.length >= 8) break;
    }
    if (senses.length >= 8) break;
  }
  if (!senses.length) return { ok: false, source, error: 'not-found' };
  const forms: string[] = (word?.wfs ?? []).map((w: any) => clean(w?.wf?.value)).filter(Boolean);
  const prototype = clean(word?.prototype);
  return {
    ok: true,
    entry: {
      source, expression, headword, url,
      phonetic: clean(word?.usphone ?? word?.ukphone) || undefined,
      senses,
      forms: forms.length ? [...new Set(forms)] : undefined,
      lemmaCandidates: prototype && !same(prototype, headword) ? [prototype] : undefined,
    },
  };
}

function cambridgeHeadMatches(head: string, query: string): boolean {
  if (same(head, query)) return true;
  return same(head.replace(/\b(?:someone|somebody|something|yourself|oneself)\b/gi, ''), query);
}

function parseCambridge(html: string, expression: string, url: string): DictionaryResult {
  const source = 'cambridge';
  const { document } = parseHTML(html);
  if (/captcha|verify you are human|access denied|cloudflare/i.test(text(document.querySelector('title')))) {
    return { ok: false, source, error: 'restricted' };
  }
  if (!document.querySelector('.entry-body') && /cf-chl|captcha|verify you are human|unusual traffic/i.test(html)) {
    return { ok: false, source, error: 'restricted' };
  }
  const roots = [...document.querySelectorAll('.entry-body__el, .phrase-block')]
    .filter((root) => cambridgeHeadMatches(text(root.querySelector('.headword, .phrase-title')), expression))
    .sort((a, b) => Number(same(text(b.querySelector('.headword, .phrase-title')), expression))
      - Number(same(text(a.querySelector('.headword, .phrase-title')), expression)));
  const senses: DictionarySense[] = [];
  let headword = '';
  let phonetic = '';
  let audioUrl = '';
  const lemmas: string[] = [];
  for (const root of roots) {
    headword ||= text(root.querySelector('.headword, .phrase-title'));
    if (!expression.includes(' ')) phonetic ||= text(root.querySelector('.ipa'));
    const audio = expression.includes(' ') ? null : root.querySelector('audio source[type="audio/mpeg"]')?.getAttribute('src');
    if (!audioUrl && audio) audioUrl = new URL(audio, 'https://dictionary.cambridge.org').toString();
    for (const inf of root.querySelectorAll('.inf')) {
      const form = text(inf);
      if (form && !lemmas.includes(form)) lemmas.push(form);
    }
    for (const block of root.querySelectorAll('.def-block')) {
      // 普通词条页面还会嵌入其它短语，不能借其义项冒充当前表达。
      if (root.classList.contains('entry-body__el') && block.closest('.phrase-block')) continue;
      const definition = text(block.querySelector('.trans.dtrans'));
      if (!definition) continue;
      const example = text(block.querySelector('.eg .deg')) || text(block.querySelector('.eg'));
      const exampleTranslation = text(block.querySelector('.eg .trans.dtrans'));
      senses.push({
        partOfSpeech: text(root.querySelector('.pos')) || undefined,
        definition,
        example: example || undefined,
        exampleTranslation: exampleTranslation || undefined,
      });
      if (senses.length >= 8) break;
    }
    if (senses.length >= 8) break;
  }
  if (!senses.length) return { ok: false, source, error: 'not-found' };
  return {
    ok: true,
    entry: {
      source, expression, headword, url,
      phonetic: phonetic || undefined,
      audioUrl: audioUrl || undefined,
      senses,
      forms: lemmas.length ? lemmas : undefined,
    },
  };
}

/** 指定一个来源查询；不缓存、不触发 AI。 */
export async function lookupDictionarySource(
  expression: string,
  source: DictionarySource,
  signal?: AbortSignal,
): Promise<DictionaryResult> {
  const query = clean(expression);
  if (!query) return { ok: false, source, error: 'not-found' };
  const url = source === 'youdao'
    ? `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(query)}`
    : dictionaryOriginalUrl(query, source);
  let response: Response;
  try {
    response = await fetch(url, { signal: requestSignal(signal) });
  } catch (error) {
    return { ok: false, source, error: signal?.aborted ? 'aborted' : 'network', detail: String(error) };
  }
  if (response.status === 403 || response.status === 429) return { ok: false, source, error: 'restricted', detail: `http ${response.status}` };
  if (!response.ok) return { ok: false, source, error: 'http', detail: `http ${response.status}` };
  try {
    return source === 'youdao'
      ? parseYoudao(await response.json(), query, dictionaryOriginalUrl(query, source))
      : parseCambridge(await response.text(), query, response.url);
  } catch (error) {
    return { ok: false, source, error: 'bad-response', detail: String(error) };
  }
}
