// M11 分词探针：验证 Intl.Segmenter（word granularity）能否为扩展的
// “点击查词 / 悬停词边界 / 词次统计”提供足够的多语言分词能力。
// 覆盖：无空格文字（ja/zh/th）、RTL（ar/fa）、土耳其语大小写、
// 重音与复合词（de）、组合字符（hi/vi 带变音符号）。
// 运行：npx tsx tools/m11-probe-segmenter.ts

interface Case {
  lang: string;
  text: string;
  /** 预期可点击提取的完整词（小写或原文，按语言） */
  expectWords: string[];
  /** 预期不得被拆开的词内断裂（子串不出现在任何词边界结果里） */
  expectNoSplit?: string[];
}

const CASES: Case[] = [
  {
    lang: 'ja',
    text: '私は毎日日本語を勉強しています。',
    expectWords: ['私', '毎日', '日本語', '勉強'],
    expectNoSplit: ['日本', '勉強し'],
  },
  {
    lang: 'zh-Hans',
    text: '我们学习中文，也学习英文。',
    expectWords: ['我们', '学习', '中文'],
  },
  {
    // 泰语无空格：ICU 字典分词把复合词拆成较细单位（ภาษา|ไทย、ทุก|วัน），
    // 属可接受的点击粒度；关键是无词中断裂（expectNoSplit）。
    lang: 'th',
    text: 'ฉันเรียนภาษาไทยทุกวัน',
    expectWords: ['ฉัน', 'เรียน', 'ภาษา', 'ไทย', 'ทุก', 'วัน'],
    expectNoSplit: ['ภาษาไ', 'ทุกว', 'เรียนภ'],
  },
  {
    lang: 'tr',
    text: 'DIŞARI çıkmak istiyorum, İstanbul güzel.',
    expectWords: ['DIŞARI', 'çıkmak', 'istiyorum', 'İstanbul'],
  },
  {
    lang: 'de',
    text: 'Die Wissenschaft fängt lange vor der Technik an.',
    expectWords: ['Wissenschaft', 'fängt', 'Technik'],
  },
  {
    lang: 'de',
    text: 'Donaudampfschifffahrt ist ein langes Wort.',
    expectWords: ['Donaudampfschifffahrt'],
    expectNoSplit: ['Donaudampf', 'schifffahrt'],
  },
  {
    lang: 'fr',
    text: "L'éducation est essentielle, n'est-ce pas ?",
    expectWords: ["l'éducation", 'essentielle'],
  },
  {
    lang: 'es',
    text: 'El examen fue difícil, ¿verdad?',
    expectWords: ['examen', 'difícil', 'verdad'],
  },
  {
    lang: 'ar',
    text: 'أتعلم اللغة العربية كل يوم',
    expectWords: ['أتعلم', 'اللغة', 'العربية'],
    expectNoSplit: ['اللغ', 'العربي'],
  },
  {
    lang: 'fa',
    text: 'من هر روز زبان فارسی یاد می‌گیرم',
    expectWords: ['زبان', 'فارسی'],
  },
  {
    lang: 'hi',
    text: 'मैं हर दिन हिंदी सीखता हूँ',
    expectWords: ['हिंदी', 'सीखता'],
  },
  {
    lang: 'vi',
    text: 'Tôi học tiếng Việt mỗi ngày.',
    expectWords: ['học', 'tiếng', 'Việt'],
  },
  {
    lang: 'ko',
    text: '저는 매일 한국어를 공부합니다.',
    expectWords: ['한국어를', '공부합니다'],
  },
  {
    lang: 'ru',
    text: 'Я учу русский язык каждый день.',
    expectWords: ['учу', 'русский', 'язык'],
  },
  {
    lang: 'en',
    text: 'The constrained design broke the build.',
    expectWords: ['constrained', 'design'],
  },
];

function segments(text: string, lang: string): string[] {
  const seg = new Intl.Segmenter(lang, { granularity: 'word' });
  return Array.from(seg.segment(text))
    .filter((s) => s.isWordLike)
    .map((s) => s.segment);
}

let pass = 0;
let fail = 0;
const failures: string[] = [];

for (const c of CASES) {
  const words = segments(c.text, c.lang);
  const norm = (w: string) => (['tr', 'az'].includes(c.lang.split('-')[0]!) ? w.toLocaleLowerCase(c.lang) : w.toLowerCase());
  const wordSet = new Set(words.map(norm));
  for (const expect of c.expectWords) {
    const ok = wordSet.has(norm(expect));
    if (ok) pass++; else { fail++; failures.push(`${c.lang}: 缺词 "${expect}" → 实际 [${words.join(' | ')}]`); }
  }
  if (c.expectNoSplit) {
    const joined = words.map(norm).join('\u0000');
    for (const frag of c.expectNoSplit) {
      // 词内断裂检查：该子串不得作为独立词段出现
      const split = words.map(norm).includes(norm(frag));
      if (!split) pass++; else { fail++; failures.push(`${c.lang}: "${frag}" 被拆成独立词段`); }
    }
  }
}

console.log(`分词探针：通过 ${pass}，失败 ${fail}`);
for (const f of failures) console.log(`  ✗ ${f}`);

// 附加：浏览器与 Node 的 Segmenter 可用性说明
console.log(`\nNode ${process.version}，Intl.Segmenter ${typeof Intl.Segmenter}`);
if (typeof process !== 'undefined') process.exit(fail ? 1 : 0);
