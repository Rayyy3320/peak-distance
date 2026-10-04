// M11 学习库格式离线检查（纯逻辑，node 直接运行）：
//   1. 词条往返：id/language/expression/status + 全部语境（web/video、definition、
//      dictionary/translation/ai-definition 三种结果与 AI 语境解释）
//   2. applyVocabToDocument：Obsidian 改“我的笔记”+ 自定义键 + 自定义正文块后，
//      受管字段更新、用户内容与未知键保留
//   3. 三方合并：不同字段各改各的自动合并；status 双改冲突；两边追加语境合并；
//      同字段同值一致；笔记双改冲突
//   4. 坏输入：缺 frontmatter / 未闭合 / status 非法 / language 非法 → error 或字段 null，不抛异常
//   5. 句子 / 偏好往返
//   6. 转义：值含冒号（id/expression/definition/note）往返无损
// 运行：npx tsx tools/m11-vault-format-check.ts

import {
  applyVocabToDocument,
  mergeVocabRecord,
  parsePreferenceDocument,
  parseSentenceDocument,
  parseVocabDocument,
  serializePreferenceRecord,
  serializeSentenceRecord,
  serializeVocabRecord,
  type ParsedVocabDocument,
  type VocabRecordWithNote,
} from '../lib/vault/format';
import type {
  VaultPreferenceRecord,
  VaultSentenceRecord,
  VaultVocabContext,
} from '../shared/vault';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) pass++;
  else {
    fail++;
    failures.push(detail ? `${name}：${detail}` : name);
  }
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isFormatError<T>(r: T | { error: 'format' }): r is { error: 'format' } {
  return typeof r === 'object' && r !== null && 'error' in r && (r as { error: string }).error === 'format';
}

/** 深取值（检查脚本专用，绕开 noUncheckedIndexedAccess 的窄化负担） */
function get(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

const okDoc = (r: ParsedVocabDocument | { error: 'format' }): r is ParsedVocabDocument => !isFormatError(r);

// ---- 测试数据 -------------------------------------------------------------------

function ctx(partial: Partial<VaultVocabContext> & { sentence: string }): VaultVocabContext {
  return {
    url: '',
    title: '',
    sourceType: 'web',
    video: null,
    createdAt: 1,
    definition: null,
    ...partial,
  };
}

function record(partial: Partial<VocabRecordWithNote> & { id: string }): VocabRecordWithNote {
  return {
    language: 'ja',
    expression: '学ぶ',
    status: 'saved',
    forms: [],
    createdAt: 100,
    updatedAt: 200,
    contexts: [],
    ...partial,
  };
}

const webDictContext = ctx({
  sentence: '私は毎日日本語を学ぶ。',
  url: 'https://example.com/post/1',
  title: '日本語学習ブログ',
  sourceType: 'web',
  createdAt: 1728000000000,
  definition: '学ぶ＝学习',
  result: {
    kind: 'dictionary',
    entry: {
      source: 'youdao',
      expression: '学ぶ',
      headword: '学ぶ',
      url: 'https://dict.youdao.com/w/%E5%AD%A6%E3%81%B6/',
      senses: [
        { partOfSpeech: 'v.', definition: '学习，掌握' },
        { definition: '学会' },
      ],
    },
    selectedSense: 1,
  },
});

const videoTranslateContext = ctx({
  sentence: '今日も勉強する。',
  url: 'https://www.youtube.com/watch?v=abc123&t=123s',
  title: '勉強動画',
  sourceType: 'video',
  video: {
    videoId: 'abc123',
    trackId: 'yt:abc123:ja:manual',
    trackKind: 'manual',
    trackLang: 'ja',
    startMs: 123456,
  },
  createdAt: 1728000001000,
  result: { kind: 'translation', source: 'google-gtx', text: 'I study every day, too.' },
});

const webAiContext = ctx({
  sentence: '新しいことを学ぶのが好きだ。',
  url: 'https://example.com/post/2',
  title: '趣味の話',
  sourceType: 'web',
  createdAt: 1728000002000,
  result: {
    kind: 'ai-definition',
    source: 'ai',
    text: '学习（他动词）',
    lang: { source: 'ja', target: 'zh-Hans' },
    model: 'deepseek-chat',
  },
  explanation: {
    kind: 'ai-context',
    source: 'deepseek',
    text: '在这个句子里表示“学习新东西”。',
    sentence: '新しいことを学ぶのが好きだ。',
  },
});

const definitionOnlyContext = ctx({
  sentence: '子供は遊びから学ぶ。',
  url: 'https://example.com/post/3',
  title: '育児メモ',
  sourceType: 'web',
  createdAt: 1728000003000,
  definition: '读音：まなぶ',
});

const fullRecord = record({
  id: 'ja::学ぶ',
  language: 'ja',
  expression: '学ぶ',
  status: 'learning',
  forms: ['学びます'],
  contexts: [webDictContext, videoTranslateContext, webAiContext, definitionOnlyContext],
});

// ---- 1. 词条往返 -----------------------------------------------------------------

{
  const text = serializeVocabRecord(fullRecord);
  const parsed = parseVocabDocument(text);
  check('1 往返可解析', okDoc(parsed));
  if (!okDoc(parsed)) throw new Error('词条往返基础用例失败');
  check('1 id 恢复', parsed.id === fullRecord.id, `实际 ${parsed.id}`);
  check('1 language 恢复', parsed.language === 'ja', `实际 ${parsed.language}`);
  check('1 expression 恢复', parsed.expression === '学ぶ', `实际 ${parsed.expression}`);
  check('1 status 恢复', parsed.status === 'learning', `实际 ${parsed.status}`);
  check('1 语境数量', parsed.managed.contexts.length === 4, `实际 ${parsed.managed.contexts.length}`);
  check('1 无未知内容', parsed.unknown.length === 0, `unknown=${JSON.stringify(parsed.unknown)}`);

  const [c1, c2, c3, c4] = parsed.managed.contexts;
  // web + dictionary
  check(
    '1 web 语境 sentence/url/title/createdAt',
    c1?.sentence === webDictContext.sentence && c1.url === webDictContext.url && c1.title === webDictContext.title && c1.createdAt === 1728000000000,
  );
  check('1 web 语境 sourceType/web video 为空', c1?.sourceType === 'web' && c1?.video === null);
  check('1 definition 恢复', c1?.definition === '学ぶ＝学习', `实际 ${c1?.definition}`);
  check('1 dictionary 结果 kind/source 恢复', get(c1, 'result', 'kind') === 'dictionary' && get(c1, 'result', 'entry', 'source') === 'youdao');
  check('1 dictionary 选中释义恢复（selectedSense=1）', get(c1, 'result', 'entry', 'senses', '0', 'definition') === '学会', `实际 ${JSON.stringify(get(c1, 'result', 'entry', 'senses'))}`);
  // video + translation
  check('1 video 语境 sourceType/video 恢复', c2?.sourceType === 'video' && eq(c2?.video, videoTranslateContext.video));
  check('1 translation 结果全量恢复', eq(get(c2, 'result'), { kind: 'translation', source: 'google-gtx', text: 'I study every day, too.' }));
  // web + ai-definition + explanation
  check('1 ai-definition kind/text/model 恢复', get(c3, 'result', 'kind') === 'ai-definition' && get(c3, 'result', 'text') === '学习（他动词）' && get(c3, 'result', 'model') === 'deepseek-chat');
  check('1 ai-definition lang.source 按词条语言恢复', get(c3, 'result', 'lang', 'source') === 'ja');
  check('1 explanation kind/source/text/sentence 恢复', get(c3, 'explanation', 'kind') === 'ai-context' && get(c3, 'explanation', 'source') === 'deepseek' && get(c3, 'explanation', 'text') === '在这个句子里表示“学习新东西”。' && get(c3, 'explanation', 'sentence') === webAiContext.sentence);
  // definition-only
  check('1 仅 definition 语境恢复（无 result/explanation）', c4?.definition === '读音：まなぶ' && get(c4, 'result') === undefined && get(c4, 'explanation') === undefined);
  check('1 空笔记为空串', parsed.note === '', `实际 ${JSON.stringify(parsed.note)}`);
  check('1 释义块带来源行', text.includes('## 释义') && text.includes('来源：youdao 词典'), text);
  check('1 时间与视频行写入', text.includes('  - 时间：1728000001000') && text.includes('  - 视频：{"videoId":"abc123"'));
}

// ---- 2. applyVocabToDocument：保留用户内容，更新受管字段 -------------------------

{
  const base = record({ id: 'ja::学ぶ', status: 'saved', contexts: [webDictContext] });
  let fileText = serializeVocabRecord(base);
  // Obsidian 用户：改“我的笔记”、加自定义 frontmatter 键、改“释义”块、加自定义正文块
  fileText = fileText.replace('## 我的笔记\n', '## 我的笔记\n我的个人理解：用: 冒号也没问题\n');
  fileText = fileText.replace('status: saved\n', 'status: saved\ntags: 日语学习\n');
  fileText = fileText.replace('## 释义\n来源：youdao 词典\n\n学会\n', '## 释义\n用户改过的释义内容\n');
  fileText += '\n## 关联词\n- 派生：学びます\n';

  const updated = record({ id: 'ja::学ぶ', status: 'learning', contexts: [webDictContext, videoTranslateContext] });
  const applied = applyVocabToDocument(updated, fileText);
  check('2 apply 返回文本', typeof applied === 'string');
  if (typeof applied !== 'string') throw new Error('apply 基础用例失败');
  const parsed = parseVocabDocument(applied);
  check('2 apply 后可解析', okDoc(parsed));
  if (!okDoc(parsed)) throw new Error('apply 解析失败');
  check('2 受管 status 更新', parsed.status === 'learning', `实际 ${parsed.status}`);
  check('2 用户笔记保留（含冒号）', parsed.note === '我的个人理解：用: 冒号也没问题', `实际 ${JSON.stringify(parsed.note)}`);
  check('2 未知 frontmatter 键保留', parsed.unknown.some((l) => l.includes('tags: 日语学习')), JSON.stringify(parsed.unknown));
  check('2 未知正文块保留', parsed.unknown.some((l) => l.includes('## 关联词') && l.includes('派生：学びます')), JSON.stringify(parsed.unknown));
  check('2 “释义”块保留文件版本', applied.includes('用户改过的释义内容'), applied);
  check('2 “原句”块更新为新语境', parsed.managed.contexts.length === 2 && parsed.managed.contexts.some((c) => c.sentence === '今日も勉強する。'));
  check('2 受管 id/language/expression 保持', parsed.id === 'ja::学ぶ' && parsed.language === 'ja' && parsed.expression === '学ぶ');

  // 文件缺“原句”/“释义”块时补齐；无正文文件也保留未知键
  const bare = '---\nid: "ja::学ぶ"\nlanguage: ja\nexpression: 学ぶ\nstatus: saved\ntags: keep\n---\n\n# 学ぶ\n';
  const appliedBare = applyVocabToDocument(updated, bare);
  check('2 无正文文件 apply 成文本', typeof appliedBare === 'string');
  if (typeof appliedBare === 'string') {
    const p2 = parseVocabDocument(appliedBare);
    check('2 补写原句块与释义块', okDoc(p2) && p2.managed.contexts.length === 2 && appliedBare.includes('## 释义') && appliedBare.includes('## 原句'), appliedBare);
    check('2 无正文文件保留未知键', okDoc(p2) && p2.unknown.some((l) => l.includes('tags: keep')));
  }
}

// ---- 3. 三方合并 -----------------------------------------------------------------

{
  const c1 = webDictContext;
  const cA = ctx({ sentence: '追加语境 A（本地）', url: 'https://example.com/a', createdAt: 10 });
  const cB = ctx({ sentence: '追加语境 B（文件）', url: 'https://example.com/b', createdAt: 11 });

  // 3.1 笔记文件改 + 状态本地改 → merged 且互不覆盖
  const base = record({ id: 'ja::学ぶ', status: 'saved', note: '旧笔记', contexts: [c1] });
  const local = record({ id: 'ja::学ぶ', status: 'known', note: '旧笔记', contexts: [c1] });
  const file = record({ id: 'ja::学ぶ', status: 'saved', note: '在 Obsidian 里改的笔记', contexts: [c1] });
  const m1 = mergeVocabRecord(base, local, file);
  check('3.1 不同字段各改各的 → merged', m1.kind === 'merged');
  if (m1.kind === 'merged') {
    check('3.1 状态取本地', m1.value.status === 'known', `实际 ${m1.value.status}`);
    check('3.1 笔记取文件', m1.value.note === '在 Obsidian 里改的笔记', `实际 ${m1.value.note}`);
    check('3.1 tookFile 含 note 不含 status', m1.tookFile.includes('note') && !m1.tookFile.includes('status'), JSON.stringify(m1.tookFile));
  }

  // 3.2 status 双改不同 → conflict
  const local2 = record({ id: 'ja::学ぶ', status: 'known', note: '旧笔记', contexts: [c1] });
  const file2 = record({ id: 'ja::学ぶ', status: 'learning', note: '旧笔记', contexts: [c1] });
  const m2 = mergeVocabRecord(base, local2, file2);
  check('3.2 status 双改不同 → conflict', m2.kind === 'conflict');
  if (m2.kind === 'conflict') {
    const st = m2.fields.find((f) => f.field === 'status');
    check('3.2 冲突字段与双方值', !!st && st.local === 'known' && st.file === 'learning', JSON.stringify(m2.fields));
  }

  // 3.3 两边追加不同语境 → 合并保留双方
  const local3 = record({ id: 'ja::学ぶ', status: 'saved', note: '旧笔记', contexts: [c1, cA] });
  const file3 = record({ id: 'ja::学ぶ', status: 'saved', note: '旧笔记', contexts: [c1, cB] });
  const m3 = mergeVocabRecord(base, local3, file3);
  check('3.3 追加语境 → merged', m3.kind === 'merged');
  if (m3.kind === 'merged') {
    const sentences = m3.value.contexts.map((c) => c.sentence);
    check('3.3 双方语境都保留且去重', m3.value.contexts.length === 3 && sentences.includes('追加语境 A（本地）') && sentences.includes('追加语境 B（文件）'), JSON.stringify(sentences));
  }

  // 3.4 同字段同值 → merged
  const local4 = record({ id: 'ja::学ぶ', status: 'known', note: '旧笔记', contexts: [c1] });
  const file4 = record({ id: 'ja::学ぶ', status: 'known', note: '旧笔记', contexts: [c1] });
  const m4 = mergeVocabRecord(base, local4, file4);
  check('3.4 同字段同值 → merged', m4.kind === 'merged' && m4.value.status === 'known');
  if (m4.kind === 'merged') {
    check('3.4 一致不记 tookFile', !m4.tookFile.includes('status'), JSON.stringify(m4.tookFile));
  }

  // 3.5 笔记双改且不同 → conflict
  const local5 = record({ id: 'ja::学ぶ', status: 'saved', note: '本地改的笔记', contexts: [c1] });
  const file5 = record({ id: 'ja::学ぶ', status: 'saved', note: '文件改的笔记', contexts: [c1] });
  const m5 = mergeVocabRecord(base, local5, file5);
  check('3.5 笔记双改不同 → conflict', m5.kind === 'conflict' && m5.fields.some((f) => f.field === 'note'), JSON.stringify(m5.kind === 'conflict' ? m5.fields : m5));
}

// ---- 4. 坏输入 -------------------------------------------------------------------

{
  let r1: ReturnType<typeof parseVocabDocument> = { error: 'format' };
  try {
    r1 = parseVocabDocument('# 没有属性的笔记\n\n正文');
  } catch {
    check('4 缺 frontmatter 不抛异常', false);
  }
  check('4 缺 frontmatter → error:format', isFormatError(r1));

  let r2: ReturnType<typeof parseVocabDocument> = { error: 'format' };
  try {
    r2 = parseVocabDocument('---\nid: "x::y"\nlanguage: en\nexpression: y\nstatus: learning\n');
  } catch {
    check('4 未闭合 frontmatter 不抛异常', false);
  }
  check('4 未闭合 frontmatter → error:format', isFormatError(r2));

  const badStatus = '---\nid: "ja::学ぶ"\nlanguage: ja\nexpression: 学ぶ\nstatus: mastered\n---\n\n# 学ぶ\n';
  let r3: ReturnType<typeof parseVocabDocument> = { error: 'format' };
  try {
    r3 = parseVocabDocument(badStatus);
  } catch {
    check('4 非法 status 不抛异常', false);
  }
  check('4 非法 status → 字段 null', okDoc(r3) && r3.status === null && r3.id === 'ja::学ぶ', JSON.stringify(r3));

  const badLang = '---\nid: "ja::学ぶ"\nlanguage: 日本語\nexpression: 学ぶ\nstatus: saved\n---\n';
  const r4 = parseVocabDocument(badLang);
  check('4 非法 language → 字段 null', okDoc(r4) && r4.language === null);

  let r5: string | { error: 'format' } = { error: 'format' };
  try {
    r5 = applyVocabToDocument(fullRecord, '完全不是词条的文本');
  } catch {
    check('4 apply 坏输入不抛异常', false);
  }
  check('4 apply 缺 frontmatter → error:format', isFormatError(r5));

  const garbageCtx = '---\nid: "ja::学ぶ"\nlanguage: ja\nexpression: 学ぶ\nstatus: saved\n---\n\n## 原句\n一些散乱的文字\n- \n  - 不认识的标签：值\n';
  const r6 = parseVocabDocument(garbageCtx);
  check('4 语境块坏行进 unknown 不丢弃', okDoc(r6) && r6.managed.contexts.length === 0 && r6.unknown.length >= 2, JSON.stringify(okDoc(r6) ? r6.unknown : r6));
}

// ---- 5. 句子 / 偏好往返 ----------------------------------------------------------

{
  const sentence: VaultSentenceRecord = {
    id: JSON.stringify(['abc123', 'yt:abc123:ja:manual', 123456, '今日も勉強する。']),
    language: 'ja',
    text: '今日も勉強する。',
    translation: '今天也要学习。',
    translationSource: 'google-gtx',
    video: { videoId: 'abc123', trackId: 'yt:abc123:ja:manual', trackKind: 'manual', trackLang: 'ja', startMs: 123456 },
    endMs: 130000,
    title: '勉強動画',
    createdAt: 1728000000000,
  };
  const st = serializeSentenceRecord(sentence);
  const sp = parseSentenceDocument(st);
  check('5 句子可解析', !isFormatError(sp));
  if (isFormatError(sp)) throw new Error('句子往返基础用例失败');
  check('5 句子 id/language/text 往返', sp.id === sentence.id && sp.language === 'ja' && sp.text === '今日も勉強する。', JSON.stringify(sp));
  check('5 句子译文与来源往返', sp.translation === '今天也要学习。' && sp.translationSource === 'google-gtx', JSON.stringify(sp));

  const sentenceNoTrans: VaultSentenceRecord = { ...sentence, translation: undefined, translationSource: undefined };
  const sp2 = parseSentenceDocument(serializeSentenceRecord(sentenceNoTrans));
  check('5 无译文句子往返为 null', !isFormatError(sp2) && sp2.translation === null && sp2.translationSource === null);

  const pref: VaultPreferenceRecord = {
    defaultComprehensionLang: 'zh-Hans',
    comprehensionOverrides: { ja: 'en', fr: 'zh-Hant' },
  };
  const pt = serializePreferenceRecord(pref);
  const pp = parsePreferenceDocument(pt);
  check('5 偏好默认语言往返', pp.defaultComprehensionLang === 'zh-Hans', pt);
  // 序列化按键排序输出，比较需与键顺序无关
  const normOverrides = (o: Record<string, string>): string =>
    JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  check('5 偏好覆盖列表往返', normOverrides(pp.comprehensionOverrides) === normOverrides({ ja: 'en', fr: 'zh-Hant' }), pt);
  check('5 偏好格式行', pt.includes('默认理解语言: zh-Hans') && pt.includes('ja -> en') && pt.includes('fr -> zh-Hant'), pt);
  const empty = parsePreferenceDocument('');
  check('5 偏好缺失条目用默认值', empty.defaultComprehensionLang === 'zh-Hans' && eq(empty.comprehensionOverrides, {}));
  const dirty = parsePreferenceDocument('默认理解语言: zh-Hans\nja -> en\n无关行\n');
  check('5 偏好未知行进 unknown', dirty.comprehensionOverrides['ja'] === 'en' && dirty.unknown.length === 1);
}

// ---- 6. 转义：值含冒号往返无损 ---------------------------------------------------

{
  const colonRecord = record({
    id: 'und::en::pain',
    language: 'und',
    expression: 'en::pain',
    status: 'saved',
    contexts: [ctx({ sentence: 'I feel en::pain here.', url: 'https://example.com/pain', definition: '带:半角冒号 的释义：测试', createdAt: 5 })],
  });
  const text = serializeVocabRecord(colonRecord);
  check('6 含冒号值写为 JSON 转义形式', text.includes('id: "und::en::pain"') && text.includes('expression: "en::pain"'), text.split('\n').slice(0, 5).join(' / '));
  const parsed = parseVocabDocument(text);
  check('6 含冒号 id/expression 往返无损', okDoc(parsed) && parsed.id === 'und::en::pain' && parsed.expression === 'en::pain', JSON.stringify(parsed));
  check('6 含冒号 definition 往返无损', okDoc(parsed) && parsed.managed.contexts[0]?.definition === '带:半角冒号 的释义：测试', JSON.stringify(parsed));

  // 笔记里的冒号（正文块，非 frontmatter）：经 apply 保留
  const fileText = '---\nid: "und::en::pain"\nlanguage: und\nexpression: "en::pain"\nstatus: saved\n---\n\n# en::pain\n\n## 我的笔记\nnote: 用: 冒号\n\n## 原句\n- I feel en::pain here.\n  - 出处：t\n  - 链接：https://example.com/pain\n  - 时间：5\n';
  const applied = applyVocabToDocument(colonRecord, fileText);
  check('6 apply 含冒号文件成功', typeof applied === 'string');
  if (typeof applied === 'string') {
    const p = parseVocabDocument(applied);
    check('6 笔记冒号原样保留', okDoc(p) && p.note === 'note: 用: 冒号', JSON.stringify(p));
    check('6 apply 后冒号值仍往返无损', okDoc(p) && p.expression === 'en::pain' && p.managed.contexts[0]?.definition === '带:半角冒号 的释义：测试');
  }

  // 句子 id 本身含引号/逗号/冒号（JSON 串）：转义往返
  const sid = JSON.stringify(['a:b', 't:"q"', 1, 'x']);
  const s: VaultSentenceRecord = {
    id: sid,
    language: 'ja',
    text: 'テスト',
    video: { videoId: 'a:b', trackId: 't:"q"', trackKind: 'asr', trackLang: 'ja', startMs: 1 },
    endMs: 2,
    title: 't',
    createdAt: 3,
  };
  const sp = parseSentenceDocument(serializeSentenceRecord(s));
  check('6 句子 id（含引号冒号）往返无损', !isFormatError(sp) && sp.id === sid, JSON.stringify(sp));
}

// ---- 汇总 -----------------------------------------------------------------------

console.log(`M11 学习库格式检查：通过 ${pass}，失败 ${fail}`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(fail > 0 ? 1 : 0);
