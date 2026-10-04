// M11 多语言翻译渠道探针：实测 google-gtx 免费端点对多语言对的真实行为。
// 运行：npx tsx tools/m11-probe-translation.ts
// 输出：tools/m11-probe-translation-results.json（原始结果）+ stdout 简表。
//
// 失败分类对齐 lib/regularTranslation.ts：
//   403/429/503 = restricted；空结果 = empty；translated === input = 疑似 partial；
//   其它非 2xx = http；fetch 抛错 = network；JSON 形状异常 = bad-response。
// 注意：lib 的「拉丁字母残留 >= 输入 35% 判 partial」启发式只对「拉丁源→中文目标」成立；
// 本探针对拉丁→拉丁对仅记录 residue 比例作观察值，不据此判 partial。

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const TIMEOUT_MS = 12_000;
const GAP_MS = 300;
const MAX_ATTEMPTS = 2; // 失败重试不超过 1 次
// 与扩展运行时（浏览器 fetch 自带 Chrome UA）对齐；预检发现无 UA/裸 curl 会被 429 拦截。
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** google-gtx 语言码映射：zh-Hans -> zh-CN，zh-Hant -> zh-TW（sl 与 tl 同规则），其余原样。 */
function toGtxCode(lang: string): string {
  if (lang === 'zh-Hans') return 'zh-CN';
  if (lang === 'zh-Hant') return 'zh-TW';
  return lang;
}

type Classification = 'ok' | 'restricted' | 'empty' | 'partial' | 'http' | 'network' | 'bad-response';

interface CaseDef {
  pair: string;
  sl: string; // 逻辑源语言（映射前）
  tl: string; // 逻辑目标语言（映射前）
  input: string;
  expectedDetected?: string; // sl=auto 用：期望端点检出的语种
  note?: string;
}

interface AttemptOutcome {
  classification: Classification;
  httpStatus: number | null;
  output: string | null;
  detectedLang: string | null;
  detail?: string;
  elapsedMs: number;
}

interface CaseResult {
  pair: string;
  sl: string;
  tl: string;
  requestSl: string;
  requestTl: string;
  input: string;
  output: string | null;
  httpStatus: number | null;
  classification: Classification;
  detail?: string;
  attempts: number;
  firstAttempt?: { classification: Classification; httpStatus: number | null; detail?: string };
  elapsedMs: number;
  detectedLang: string | null;
  autoDetectCorrect: boolean | null;
  latinResidueRatio: number | null;
  hanScriptGuess: 'hans' | 'hant' | 'mixed' | 'none' | null;
  note?: string;
}

const CASES: CaseDef[] = [
  { pair: 'ja→zh-Hans', sl: 'ja', tl: 'zh-Hans', input: '私は毎日日本語を勉強しています。' },
  { pair: 'fr→zh-Hans', sl: 'fr', tl: 'zh-Hans', input: 'Le pain frais est délicieux ce matin.' },
  { pair: 'de→en', sl: 'de', tl: 'en', input: 'Die Wissenschaft fängt lange vor der Technik an.' },
  { pair: 'es→en', sl: 'es', tl: 'en', input: 'El café de la mañana siempre sabe mejor en casa.' },
  { pair: 'ru→en', sl: 'ru', tl: 'en', input: 'Я каждый день изучаю новый иностранный язык.' },
  { pair: 'ar→zh-Hans', sl: 'ar', tl: 'zh-Hans', input: 'أحب قراءة الكتب القديمة في المكتبة العامة.' },
  { pair: 'tr→zh-Hans', sl: 'tr', tl: 'zh-Hans', input: 'Bu sabah parkta uzun bir yürüyüş yaptık.' },
  { pair: 'th→zh-Hans', sl: 'th', tl: 'zh-Hans', input: 'อากาศที่เชียงใหม่ในฤดูหนาวเย็นสบายมาก' },
  { pair: 'vi→zh-Hans', sl: 'vi', tl: 'zh-Hans', input: 'Tôi học tiếng Việt mỗi ngày sau khi tan tầm.' },
  { pair: 'fa→zh-Hans', sl: 'fa', tl: 'zh-Hans', input: 'من هر روز صبح چای تازه دم می‌کنم.' },
  { pair: 'ko→zh-Hans', sl: 'ko', tl: 'zh-Hans', input: '나는 매일 아침 공원에서 한 시간씩 산책합니다.' },
  { pair: 'hi→en', sl: 'hi', tl: 'en', input: 'मैं हर रोज़ सुबह ताज़ी सब्ज़ी खरीदने बाज़ार जाता हूँ।' },
  { pair: 'bn→zh-Hans', sl: 'bn', tl: 'zh-Hans', input: 'আমি প্রতিদিন সকালে দুই কাপ চা খাই।' },
  { pair: 'id→zh-Hans', sl: 'id', tl: 'zh-Hans', input: 'Saya pergi ke pasar setiap pagi untuk membeli sayur segar.' },
  { pair: 'pl→de', sl: 'pl', tl: 'de', input: 'Kawa z mlekiem smakuje najlepiej o poranku w weekend.' },
  { pair: 'nl→en', sl: 'nl', tl: 'en', input: 'De treinen vertrekken vanavond later dan gepland.' },
  { pair: 'pt-BR→es', sl: 'pt-BR', tl: 'es', input: 'O time brasileiro ganhou o jogo de ontem à noite.' },
  { pair: 'it→fr', sl: 'it', tl: 'fr', input: 'La pizza napoletana è cotta nel forno a legna.' },
  { pair: 'zh-Hans→ja', sl: 'zh-Hans', tl: 'ja', input: '我每周都去图书馆借几本中文小说。' },
  // sl=auto 自动检测：把 ja/fr/de/ar 的句子翻到 en，验证检出语种
  { pair: 'auto(ja)→en', sl: 'auto', tl: 'en', input: '私は毎日日本語を勉強しています。', expectedDetected: 'ja' },
  { pair: 'auto(fr)→en', sl: 'auto', tl: 'en', input: 'Le pain frais est délicieux ce matin.', expectedDetected: 'fr' },
  { pair: 'auto(de)→en', sl: 'auto', tl: 'en', input: 'Die Wissenschaft fängt lange vor der Technik an.', expectedDetected: 'de' },
  { pair: 'auto(ar)→en', sl: 'auto', tl: 'en', input: 'أحب قراءة الكتب القديمة في المكتبة العامة.', expectedDetected: 'ar' },
  // 专名/同语用例：预期回显原文，观察是否被「partial 失败」判定吞掉
  { pair: 'fr→en (proper noun)', sl: 'fr', tl: 'en', input: 'Paris', note: '专名预期回显原文，观察与 partial 判定的混淆' },
  // 映射验证：tl=zh-TW 应产出繁体（对照 tl=zh-CN 的简体）
  { pair: 'en→zh-Hant (tl=zh-TW)', sl: 'en', tl: 'zh-Hant', input: 'The fresh bread from the bakery tastes wonderful every morning.', note: '验证 zh-Hant -> zh-TW 映射产出繁体' },
];

// ---- 与 lib/regularTranslation.ts 相同的解析与判定 ----

function parseGoogleTranslation(json: unknown): string {
  if (!Array.isArray(json) || !Array.isArray(json[0])) return '';
  return (json[0] as unknown[])
    .map((part) => (Array.isArray(part) && typeof part[0] === 'string' ? part[0] : ''))
    .join('')
    .trim();
}

function detectedLanguageOf(json: unknown): string | null {
  if (Array.isArray(json) && typeof json[2] === 'string') return json[2];
  return null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function requestOnce(sl: string, tl: string, input: string): Promise<AttemptOutcome> {
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({ client: 'gtx', sl, tl, dt: 't', q: input }).toString();
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT },
    });
    if ([403, 429, 503].includes(response.status)) {
      return { classification: 'restricted', httpStatus: response.status, output: null, detectedLang: null, detail: `http ${response.status}`, elapsedMs: elapsed() };
    }
    if (!response.ok) {
      return { classification: 'http', httpStatus: response.status, output: null, detectedLang: null, detail: `http ${response.status}`, elapsedMs: elapsed() };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      return { classification: 'bad-response', httpStatus: response.status, output: null, detectedLang: null, detail: String(error), elapsedMs: elapsed() };
    }
    const translated = parseGoogleTranslation(json);
    const detectedLang = detectedLanguageOf(json);
    if (!translated) {
      return { classification: 'empty', httpStatus: response.status, output: '', detectedLang, detail: 'parsed empty', elapsedMs: elapsed() };
    }
    if (translated === input) {
      return { classification: 'partial', httpStatus: response.status, output: translated, detectedLang, detail: 'translated === input', elapsedMs: elapsed() };
    }
    return { classification: 'ok', httpStatus: response.status, output: translated, detectedLang, elapsedMs: elapsed() };
  } catch (error) {
    return { classification: 'network', httpStatus: null, output: null, detectedLang: null, detail: String(error), elapsedMs: elapsed() };
  }
}

// ---- 观察值辅助 ----

const latinLetters = (value: string) => (value.match(/[A-Za-z]/g) ?? []).length;

const TRAD_ONLY = '們個說學東車門長開關讀寫飯麵館漢圖書館';
const SIMP_ONLY = '们个说学东车门长开关读写饭面馆汉图书馆';
function guessHanScript(text: string | null): 'hans' | 'hant' | 'mixed' | 'none' | null {
  if (!text) return null;
  let trad = 0;
  let simp = 0;
  for (const ch of text) {
    if (TRAD_ONLY.includes(ch)) trad += 1;
    else if (SIMP_ONLY.includes(ch)) simp += 1;
  }
  if (trad > 0 && simp > 0) return 'mixed';
  if (trad > 0) return 'hant';
  if (simp > 0) return 'hans';
  return /[\u4e00-\u9fff]/.test(text) ? 'none' : 'none';
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max).join('')}…`;
}

// ---- 主流程 ----

async function main(): Promise<void> {
  const results: CaseResult[] = [];
  let firstRequest = true;
  for (const def of CASES) {
    const requestSl = toGtxCode(def.sl);
    const requestTl = toGtxCode(def.tl);
    let attempt: AttemptOutcome;
    let attempts = 0;
    let firstAttempt: AttemptOutcome | undefined;
    let totalElapsed = 0;
    do {
      if (!firstRequest) await sleep(GAP_MS);
      firstRequest = false;
      attempts += 1;
      attempt = await requestOnce(requestSl, requestTl, def.input);
      totalElapsed += attempt.elapsedMs;
      if (attempts === 1) firstAttempt = attempt;
      if (attempt.classification !== 'ok' && attempts < MAX_ATTEMPTS) await sleep(GAP_MS);
    } while (attempt.classification !== 'ok' && attempts < MAX_ATTEMPTS);

    const output = attempt.output;
    const latinResidueRatio =
      output !== null && latinLetters(def.input) > 0
        ? Number((latinLetters(output) / latinLetters(def.input)).toFixed(2))
        : null;

    results.push({
      pair: def.pair,
      sl: def.sl,
      tl: def.tl,
      requestSl,
      requestTl,
      input: def.input,
      output,
      httpStatus: attempt.httpStatus,
      classification: attempt.classification,
      detail: attempt.detail,
      attempts,
      firstAttempt:
        attempts > 1 && firstAttempt
          ? { classification: firstAttempt.classification, httpStatus: firstAttempt.httpStatus, detail: firstAttempt.detail }
          : undefined,
      elapsedMs: totalElapsed,
      detectedLang: attempt.detectedLang,
      autoDetectCorrect: def.expectedDetected ? attempt.detectedLang === def.expectedDetected : null,
      latinResidueRatio,
      hanScriptGuess: def.tl === 'zh-Hans' || def.tl === 'zh-Hant' ? guessHanScript(output) : null,
      note: def.note,
    });
    process.stdout.write('.');
  }
  process.stdout.write('\n\n');

  // ---- 汇总 ----
  const count = (c: Classification) => results.filter((r) => r.classification === c).length;
  const autoCases = results.filter((r) => r.autoDetectCorrect !== null);
  const zhCnTl = results.filter((r) => r.requestTl === 'zh-CN');
  const slZhCn = results.filter((r) => r.requestSl === 'zh-CN');
  const zhTwTl = results.filter((r) => r.requestTl === 'zh-TW');

  const mappingVerified = {
    'tl=zh-CN 产出简体': zhCnTl.some((r) => r.classification === 'ok' && r.hanScriptGuess === 'hans'),
    'sl=zh-CN 可作源码': slZhCn.some((r) => r.classification === 'ok'),
    'tl=zh-TW 产出繁体': zhTwTl.some((r) => r.classification === 'ok' && r.hanScriptGuess === 'hant'),
  };

  const report = {
    meta: {
      purpose: 'M11 多语言翻译渠道探针：google-gtx 免费端点对 20 种源语言与可变目标语言的真实行为',
      endpoint: ENDPOINT,
      fixedParams: { client: 'gtx', dt: 't' },
      timeoutMs: TIMEOUT_MS,
      gapMs: GAP_MS,
      retryPolicy: '失败（任何非 ok 分类）重试 1 次；两次尝试之间同样间隔 300ms',
      userAgent: USER_AGENT,
      node: process.version,
      timestamp: new Date().toISOString(),
      classificationRef:
        '对齐 lib/regularTranslation.ts：403/429/503=restricted；空结果=empty；translated===input=疑似 partial；其它非 2xx=http；fetch 抛错=network；JSON 形状异常=bad-response',
      heuristicCaveat:
        'lib 的「拉丁字母数 >= 输入 35% 判 partial」只适用于拉丁源→中文目标（输出应无拉丁字母）。拉丁→拉丁对（de→en 等）输出天然全是拉丁字母，沿用该阈值会全部误判 partial；本探针此类对只记录 latinResidueRatio 作观察，不据此判 partial',
      preflightNote:
        '预检：裸 curl / 无 UA 请求该端点返回 429 Google "Sorry..." 拦截页；Node undici fetch + 浏览器 UA 返回 200。扩展运行时（service worker fetch 自带浏览器 UA）与后者同栈，不受影响',
      codeMapping: {
        rule: 'zh-Hans -> zh-CN（sl 与 tl 同规则）；zh-Hant -> zh-TW；其余语言码原样直传（pt-BR 未归一到 pt）',
        verified: mappingVerified,
        exercisedBy: {
          'tl=zh-CN': `${zhCnTl.length} 例（ja/fr/ar/tr/th/vi/fa/ko/bn/id → zh-Hans）`,
          'sl=zh-CN': 'zh-Hans→ja 1 例',
          'tl=zh-TW': 'en→zh-Hant 1 例',
        },
      },
    },
    cases: results,
    summary: {
      total: results.length,
      ok: count('ok'),
      restricted: count('restricted'),
      empty: count('empty'),
      partial: count('partial'),
      http: count('http'),
      network: count('network'),
      badResponse: count('bad-response'),
      retried: results.filter((r) => r.attempts > 1).length,
      autoDetect: {
        total: autoCases.length,
        correct: autoCases.filter((r) => r.autoDetectCorrect).length,
        detail: autoCases.map((r) => ({ pair: r.pair, detected: r.detectedLang, expected: r.sl === 'auto' ? r.pair.match(/\(([^)]+)\)/)?.[1] : undefined, correct: r.autoDetectCorrect })),
      },
      maxElapsedMs: Math.max(...results.map((r) => r.elapsedMs)),
      medianElapsedMs: [...results.map((r) => r.elapsedMs)].sort((a, b) => a - b)[Math.floor(results.length / 2)],
    },
  };

  const outPath = join(dirname(fileURLToPath(import.meta.url)), 'm11-probe-translation-results.json');
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  // ---- stdout 简表：语言对 | 状态 | 输出截断 40 字 ----
  const pairWidth = Math.max(...results.map((r) => r.pair.length)) + 2;
  console.log(`${'语言对'.padEnd(pairWidth + 2)}| ${'状态'.padEnd(11)}| 输出（截断 40 字）`);
  console.log(`${'-'.repeat(pairWidth + 2)}|${'-'.repeat(12)}|${'-'.repeat(44)}`);
  for (const r of results) {
    const shown =
      r.output !== null && r.output !== ''
        ? truncate(r.output, 40)
        : `[${r.classification}${r.detail ? `: ${truncate(r.detail, 26)}` : ''}]`;
    const autoTag = r.autoDetectCorrect !== null ? (r.autoDetectCorrect ? ` 检出=${r.detectedLang}✓` : ` 检出=${r.detectedLang}✗`) : '';
    console.log(`${r.pair.padEnd(pairWidth + 2)}| ${r.classification.padEnd(11)}| ${shown}${autoTag}`);
  }
  console.log('');
  console.log(`汇总: ${report.summary.ok}/${report.summary.total} ok, restricted=${report.summary.restricted}, empty=${report.summary.empty}, partial=${report.summary.partial}, http=${report.summary.http}, network=${report.summary.network}, bad-response=${report.summary.badResponse}, 重试=${report.summary.retried}`);
  console.log(`auto 检出: ${report.summary.autoDetect.correct}/${report.summary.autoDetect.total} 正确; 耗时中位 ${report.summary.medianElapsedMs}ms / 最大 ${report.summary.maxElapsedMs}ms`);
  console.log(`映射验证: tl=zh-CN→简体=${mappingVerified['tl=zh-CN 产出简体']}, sl=zh-CN=${mappingVerified['sl=zh-CN 可作源码']}, tl=zh-TW→繁体=${mappingVerified['tl=zh-TW 产出繁体']}`);
  console.log(`结果已写入: ${outPath}`);
}

main().catch((error) => {
  console.error('探针脚本自身失败:', error);
  process.exit(1);
});
