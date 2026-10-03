// 实时来源冒烟检查：npm exec tsx tools/check-online-sources.ts
import { lookupDictionarySource, lookupOnlineDictionary } from '../lib/onlineDictionary';
import { translateRegularText } from '../lib/regularTranslation';

for (const expression of ['run', 'bank', 'went', 'take off', 'in spite of']) {
  const result = await lookupOnlineDictionary(expression);
  if (!result.ok || !result.entry.senses.some((sense) => /[\u3400-\u9fff]/u.test(sense.definition))) {
    throw new Error(`${expression}: no Chinese dictionary entry: ${JSON.stringify(result)}`);
  }
  console.log(`${expression}: ${result.entry.source} / ${result.entry.headword} / ${result.entry.senses[0]?.definition}`);
}
for (const expression of ['a surprisingly good result', 'zzzxxyynotaword']) {
  const result = await lookupDictionarySource(expression, 'youdao');
  if (result.ok || result.error !== 'not-found') throw new Error(`${expression}: expected not-found`);
  console.log(`${expression}: not-found`);
}
for (const expression of ['take off', 'in spite of']) {
  const result = await lookupDictionarySource(expression, 'cambridge');
  if (!result.ok || !result.entry.senses.some((sense) => /[\u3400-\u9fff]/u.test(sense.definition))) {
    throw new Error(`Cambridge ${expression}: no full phrase entry: ${JSON.stringify(result)}`);
  }
  console.log(`Cambridge ${expression}: ${result.entry.headword} / ${result.entry.senses[0]?.definition}`);
}
for (const expression of ['a surprisingly good result', 'zzzxxyynotaword']) {
  const result = await lookupDictionarySource(expression, 'cambridge');
  if (result.ok || result.error !== 'not-found') throw new Error(`Cambridge ${expression}: expected not-found`);
  console.log(`Cambridge ${expression}: not-found`);
}
const translated = await translateRegularText('The plane took off.');
if (!translated.ok || !/[\u3400-\u9fff]/u.test(translated.text)) throw new Error(`Google translation: ${JSON.stringify(translated)}`);
console.log(`Google: ${translated.text}`);
const phrase = await translateRegularText('a surprisingly good result');
if (!phrase.ok || !/[\u3400-\u9fff]/u.test(phrase.text)) throw new Error(`Google free phrase: ${JSON.stringify(phrase)}`);
console.log(`Google free phrase: ${phrase.text}`);
