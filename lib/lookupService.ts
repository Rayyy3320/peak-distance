import { lookupDictionarySource, type DictionarySource } from './onlineDictionary';
import { translateRegularText } from './regularTranslation';
import { cached, cacheGet } from './onlineCache';
import type { DictionaryResult } from './onlineDictionary';
import type { RegularTranslationResult } from './regularTranslation';
import type { Settings } from '@/shared/settings';
import type { OnlineLookupResult } from '@/shared/messages';

export async function lookupOnline(expression: string, settings: Settings, source?: DictionarySource, signal?: AbortSignal): Promise<OnlineLookupResult> {
  const query = expression.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  const sources = source ? [source] : [...new Set([settings.primaryDictionary, settings.backupDictionary])];
  for (const dictionary of sources) {
    const hit = await cacheGet<DictionaryResult>(JSON.stringify(['dictionary', dictionary, 'en-zh', query]));
    if (hit?.ok) return { ok: true, result: { kind: 'dictionary', entry: hit.entry } };
  }
  if (!source) {
    const hit = await cacheGet<RegularTranslationResult>(JSON.stringify(['translation', 'google-gtx', 'en-zh', query]));
    if (hit?.ok) return { ok: true, result: { kind: 'translation', source: hit.source, text: hit.text } };
  }
  let failure = 'not-found';
  let allMissing = true;
  for (const dictionary of sources) {
    const result = await cached(JSON.stringify(['dictionary', dictionary, 'en-zh', query]), s => lookupDictionarySource(query, dictionary, s), signal);
    if (result.ok) return { ok: true, result: { kind: 'dictionary', entry: result.entry } };
    failure = result.error;
    if (result.error !== 'not-found') allMissing = false;
    if (result.error === 'aborted' || result.error === 'restricted') break;
  }
  if (allMissing && /\s/.test(query)) {
    const translated = await cached(JSON.stringify(['translation', 'google-gtx', 'en-zh', query]), s => translateRegularText(query, s), signal);
    if (translated.ok) return { ok: true, result: { kind: 'translation', source: translated.source, text: translated.text } };
    failure = translated.error;
  }
  return { ok: false, error: failure };
}
