import type { DictionarySource } from '@/lib/onlineDictionary';
import {
  DEFAULT_COMPREHENSION_LANG,
  isLanguageTag,
  isTargetLanguage,
  primaryOfLang,
} from './languages';

export interface Settings {
  markingEnabled: boolean;
  primaryDictionary: DictionarySource;
  backupDictionary: DictionarySource;
  regularTranslation: 'google-gtx';
  translationMode: 'regular' | 'ai';
  bilingualEnabled: boolean;
  chineseVisible: boolean;
  cacheLimit: number;
  subtitleSize: 'small' | 'standard' | 'large';
  /** M11：默认理解语言（词语解释／句段／字幕译文共用目标） */
  defaultComprehensionLang: string;
  /** M11：按源语言 primary 覆盖理解语言，如 { ja: 'en' } */
  comprehensionOverrides: Record<string, string>;
  /** M11：无词典结果时主动查词自动使用 AI（默认关；仅本浏览器生效，不写入学习库） */
  aiLookupFallback: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  markingEnabled: true, primaryDictionary: 'youdao', backupDictionary: 'cambridge',
  regularTranslation: 'google-gtx', translationMode: 'regular',
  bilingualEnabled: true, chineseVisible: true, cacheLimit: 200, subtitleSize: 'standard',
  defaultComprehensionLang: DEFAULT_COMPREHENSION_LANG,
  comprehensionOverrides: {},
  aiLookupFallback: false,
};

/** 源语言 → 实际理解语言：覆盖优先，其次默认值。 */
export function comprehensionLangFor(
  settings: Pick<Settings, 'defaultComprehensionLang' | 'comprehensionOverrides'>,
  sourceLang: string | undefined,
): string {
  if (sourceLang) {
    const override = settings.comprehensionOverrides?.[primaryOfLang(sourceLang)];
    if (isLanguageTag(override)) return override;
  }
  return isLanguageTag(settings.defaultComprehensionLang)
    ? settings.defaultComprehensionLang
    : DEFAULT_COMPREHENSION_LANG;
}

function validOverrides(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const [k, t] of Object.entries(v as Record<string, unknown>)) {
    if (!isLanguageTag(k) || !primaryOfLang(k)) return false;
    if (!isLanguageTag(t)) return false;
    if (primaryOfLang(k) === primaryOfLang(t)) return false; // 同语闭环无意义，拒绝保存
  }
  return true;
}

export function validSetting(name: string, value: unknown): boolean {
  if (name === 'subtitleSize') return ['small', 'standard', 'large'].includes(String(value));
  if (['markingEnabled', 'bilingualEnabled', 'chineseVisible', 'aiLookupFallback'].includes(name)) return typeof value === 'boolean';
  if (name === 'primaryDictionary' || name === 'backupDictionary') return value === 'youdao' || value === 'cambridge';
  if (name === 'regularTranslation') return value === 'google-gtx';
  if (name === 'translationMode') return value === 'regular' || value === 'ai';
  if (name === 'defaultComprehensionLang') return isLanguageTag(value) && isTargetLanguage(String(value));
  if (name === 'comprehensionOverrides') return validOverrides(value);
  return name === 'cacheLimit' && Number.isInteger(value) && Number(value) >= 20 && Number(value) <= 500;
}
