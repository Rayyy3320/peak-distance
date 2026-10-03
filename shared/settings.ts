import type { DictionarySource } from '@/lib/onlineDictionary';

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
}

export const DEFAULT_SETTINGS: Settings = {
  markingEnabled: true, primaryDictionary: 'youdao', backupDictionary: 'cambridge',
  regularTranslation: 'google-gtx', translationMode: 'regular',
  bilingualEnabled: true, chineseVisible: true, cacheLimit: 200, subtitleSize: 'standard',
};

export function validSetting(name: string, value: unknown): boolean {
  if (name === 'subtitleSize') return ['small', 'standard', 'large'].includes(String(value));
  if (['markingEnabled', 'bilingualEnabled', 'chineseVisible'].includes(name)) return typeof value === 'boolean';
  if (name === 'primaryDictionary' || name === 'backupDictionary') return value === 'youdao' || value === 'cambridge';
  if (name === 'regularTranslation') return value === 'google-gtx';
  if (name === 'translationMode') return value === 'regular' || value === 'ai';
  return name === 'cacheLimit' && Number.isInteger(value) && Number(value) >= 20 && Number(value) <= 500;
}
