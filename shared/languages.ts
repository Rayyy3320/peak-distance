// M11 语言身份合同（C0）：语言标识、规范化与词条稳定 ID 的唯一落点。
// 网页 / 视频 / 学习库 / 词典路由共用；服务专属语言代码转换（如 google-gtx
// 的 zh-CN）由各服务适配层负责，不在这里重复。
//
// 关键决策：
// - 内部身份保留完整 LanguageTag（含地区／文字变体，如 pt-BR、zh-Hant），
//   路由与去重用 primary 子标签；
// - 'und' 表示“待确认”：可保存、可复习，但不参与跨语言标记；
// - 词条稳定键 = `${lang}::${规范化表达}`；无 '::' 的旧键是前 M11 记录，
//   语言由迁移批次按证据赋值（见 docs/specs/m11-multilingual-local-vault.md 第 5 节）；
// - 规范化不剥重音／撇号／连字符；仅按语言做大小写折叠，土耳其语用 tr 局部。

/** 首版目标语言清单（M11 spec 3.1）。primary 子标签形式。 */
export const TARGET_LANGUAGES = [
  'en', 'zh', 'ja', 'ko', 'fr', 'es', 'de', 'pt', 'it', 'ru',
  'ar', 'hi', 'bn', 'id', 'vi', 'th', 'tr', 'pl', 'nl', 'fa',
] as const;

export type TargetLanguage = (typeof TARGET_LANGUAGES)[number];

/** 待确认语言：证据不足以归属时的显式身份，不是英语的别名。 */
export const LANG_UNDETERMINED = 'und';

/** 完整语言标签（BCP-47 风格：primary + 可选变体，原样保留轨道标识）。 */
export type LanguageTag = string;

/** 新安装的默认理解语言（spec 3.2：界面继续中文）。 */
export const DEFAULT_COMPREHENSION_LANG = 'zh-Hans';

const LANG_TAG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

export function isLanguageTag(v: unknown): v is LanguageTag {
  return typeof v === 'string' && v.length <= 35 && LANG_TAG_RE.test(v);
}

/** 规范化标签：primary 小写、保留其余子标签原样；空值归 'und'。 */
export function normalizeLangTag(raw: string): LanguageTag {
  const t = raw.trim();
  if (!t) return LANG_UNDETERMINED;
  const [primary, ...rest] = t.split('-');
  return [primary!.toLowerCase(), ...rest].join('-');
}

/** primary 子标签（路由／去重用）：'zh-Hant' → 'zh'。 */
export function primaryOfLang(tag: LanguageTag): string {
  return normalizeLangTag(tag).split('-')[0]!;
}

export function isTargetLanguage(tag: LanguageTag): boolean {
  return (TARGET_LANGUAGES as readonly string[]).includes(primaryOfLang(tag));
}

/** 生词本／设置页的中文显示名；清单外回退到标签本身。 */
export function langDisplayName(tag: LanguageTag): string {
  const primary = primaryOfLang(tag);
  if (primary === 'zh') {
    if (/^zh-hant/i.test(tag)) return '繁体中文';
    if (/^zh-hans/i.test(tag)) return '简体中文';
    return '中文';
  }
  const names: Record<string, string> = {
    en: '英语', ja: '日语', ko: '韩语', fr: '法语', es: '西班牙语',
    de: '德语', pt: '葡萄牙语', it: '意大利语', ru: '俄语', ar: '阿拉伯语',
    hi: '印地语', bn: '孟加拉语', id: '印尼语', vi: '越南语', th: '泰语',
    tr: '土耳其语', pl: '波兰语', nl: '荷兰语', fa: '波斯语',
  };
  if (primary === LANG_UNDETERMINED) return '待确认';
  return names[primary] ?? tag;
}

/** RTL 文字系统：原文局部排版用，不翻转中文界面。 */
export function isRtlLanguage(tag: LanguageTag): boolean {
  return ['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'ug', 'yi'].includes(primaryOfLang(tag));
}

/**
 * 按语言规范化表达（词条键的规范化部分）：
 * NFC、合并空白、去首尾；保留重音／撇号／连字符与原始书写系统。
 * 大小写折叠仅对有大小写的文字有效（对其余文字是恒等）；
 * 土耳其语用 tr 局部（I→ı 不与 i 合并）。
 */
export function normalizeExpressionInLanguage(raw: string, lang: LanguageTag): string {
  const nfc = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!nfc) return '';
  return primaryOfLang(lang) === 'tr' ? nfc.toLocaleLowerCase('tr') : nfc.toLowerCase();
}

/** 语言作用域的词条稳定键。同一表达在不同语言是不同词条。 */
export function entryKeyOf(lang: LanguageTag, raw: string): string {
  return `${normalizeLangTag(lang)}::${normalizeExpressionInLanguage(raw, lang)}`;
}

export interface ParsedEntryKey {
  lang: LanguageTag;
  expression: string;
}

/** 解析语言作用域键；旧格式（无 '::'）返回 null，按前 M11 记录处理。 */
export function parseEntryKey(key: string): ParsedEntryKey | null {
  const idx = key.indexOf('::');
  if (idx <= 0) return null;
  const lang = key.slice(0, idx);
  const expression = key.slice(idx + 2);
  return isLanguageTag(lang) && expression ? { lang: normalizeLangTag(lang), expression } : null;
}

/**
 * 词条的有效语言：显式 language 字段优先；否则从键推导；
 * 两者都没有（未迁移旧记录）返回 null —— 调用方按“迁移前现状”处理，
 * 不自动当作英语或待确认（迁移批次按证据赋值，spec 第 5 节）。
 */
export function effectiveEntryLanguage(
  entry: { key: string; language?: LanguageTag },
): LanguageTag | null {
  if (entry.language && isLanguageTag(entry.language)) return normalizeLangTag(entry.language);
  const parsed = parseEntryKey(entry.key);
  return parsed?.lang ?? null;
}
