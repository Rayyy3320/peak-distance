import { cached } from '../lib/onlineCache';
import { lookupDictionarySource } from '../lib/onlineDictionary';
import { translateSentences } from '../lib/aiClient';
import { defaultAiProfile } from '../shared/aiConfig';
import { alignTranslatedCues } from '../shared/cues';
import { lookupOnline } from '../lib/lookupService';
import { DEFAULT_SETTINGS } from '../shared/settings';
import {
  entryKeyOf,
  parseEntryKey,
  effectiveEntryLanguage,
  normalizeExpressionInLanguage,
} from '../shared/languages';
import { wordAt, detectTextLanguage, classifySelection, effectiveLookupExpression, sentenceContaining } from '../shared/tokenize';
import { planLegacyLanguage } from '../shared/vocab';
import { serializeChatRecord, parseChatDocument, serializeMaterialSnapshot, parseMaterialDocument, materialIdOf } from '../lib/vault/chatFormat';
import type { ChatMessageRecord, MaterialSnapshotRecord } from '../shared/chat';
import { materialFromCandidate, candidateMatchesPage, type SelectionCandidate } from '../shared/chat';
import { scanMarkHits, type MarkBucket } from '../shared/marker';
// 离线回归检查（node 运行，无需浏览器）：
//   1. M0 时序 A/B：捕获归属、换视频重置、跨视频旧响应丢弃。
//   2. M1 词汇逻辑：规范化去重、上下文追加 / 去重、状态保持与显式更新。
//   3. M2 字幕：ASR 滚动合并、currentTime 定位、翻译窗口、视频上下文去重
//      （词条 + videoId + 轨道 + 起始时间 + 原文；同句不同位置分别保存）。
//   4. M3 词形：constrain 系关联、constraint 独立、go/went 显式关联、
//      冲突不合并、占用规则、表面词形 → 状态映射。
//   5. M4 复习队列：排除 known、每词条一条上下文、位置保持与删除同步。
//
// 运行：npm run regress

import {
  SubtitleSourceTracker,
  normTrackKey,
} from '../shared/subtitleTracker';
import {
  buildSegments,
  buildChatMessages,
  feedSSE,
  normalizeArticleUrl,
  parseAnswerCitations,
  parseStreamEvent,
  pickDefaultSegment,
  sourceKeyOf,
  historyForTurn,
  migrateLegacyChat,
  statusIdFromXUrl,
  trimHistory,
  type HistoryPair,
} from '../shared/chat';
import {
  blankExpression,
  buildFormIndex,
  isDuplicateContext,
  isDuplicateVideoContext,
  lookupKeyCandidates,
  normalizeExpression,
  parseFormsLine,
  planForms,
  planSave,
  shouldBackfill,
  videoContextUrl,
  type VocabEntryRecord,
  type VideoRef,
} from '../shared/vocab';
import {
  cueWords, cueEnd,
  buildTranslateWindow,
  cueIndexAt,
  fmtClock,
  normalizeAsrCues,
} from '../shared/cues';
import { parseDefinitionReply, parseChatCompletion } from '../lib/aiClient';
import { buildReviewQueue, refreshQueue } from '../shared/review';
import type { EntryView } from '../shared/messages';

let failed = 0;
let passed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const WATCH = (vid: string) => `https://www.youtube.com/watch?v=${vid}`;
const TT = (vid: string, lang: string, extra = '') =>
  `https://www.youtube.com/api/timedtext?v=${vid}&lang=${lang}&fmt=srv3&pot=T${extra ? '&' + extra : ''}`;

console.log('M0 时序 A：地址变 B → 捕获 B → config B');
{
  const t = new SubtitleSourceTracker('A');
  const r = t.noteTimedtext(TT('B', 'en'), WATCH('B')); // 地址已是 B，内部仍是 A
  check('捕获被接受（身份先同步）', r === 'new', `got ${r}`);
  check('捕获后立即有可用来源', t.hasCurrentSource());
  const pinnedBefore = t.pinForProduce();
  check('产出固定来源属于 B', !!pinnedBefore && pinnedBefore.src.includes('v=B'));
  t.resetForVideo('B'); // config 到达引发的重置
  check('重置保留已属于 B 的来源', t.hasCurrentSource());
  const pinnedAfter = t.pinForProduce();
  check(
    '重置后仍可产出且来源不变（无需 nudge）',
    !!pinnedAfter && pinnedAfter.src === pinnedBefore?.src,
  );
  check('重置后结果不判过期', !t.staleAfterFetch(pinnedAfter!.trackKey));
}

console.log('M0 时序 B：en 在途 → 捕获 fr → en 返回');
{
  const t = new SubtitleSourceTracker('V');
  t.noteTimedtext(TT('V', 'en'), WATCH('V'));
  const enPin = t.pinForProduce()!;
  t.noteTimedtext(TT('V', 'fr'), WATCH('V')); // 请求在途时轨道切换
  check('轨道切换被识别为新来源', t.sourceUrl.includes('lang=fr'));
  check('en 结果判过期（整体丢弃）', t.staleAfterFetch(enPin.trackKey));
  const frPin = t.pinForProduce()!;
  check(
    'fr 新产出元数据一致（trackKey 即 fr）',
    normTrackKey(frPin.src, '') === frPin.trackKey && frPin.src.includes('lang=fr'),
  );
  check('en 的旧 trackKey 与 fr 不一致', enPin.trackKey !== frPin.trackKey);
  check('fr 结果不判过期', !t.staleAfterFetch(frPin.trackKey));
}

console.log('M0 基线：正常取字幕与跨视频旧响应');
{
  const t = new SubtitleSourceTracker('A');
  const r = t.noteTimedtext(TT('A', 'en'), WATCH('A'));
  check('正常捕获', r === 'new');
  const pin = t.pinForProduce();
  check('可产出', !!pin);
  check('同来源不判过期', pin !== null && !t.staleAfterFetch(pin.trackKey));
  check('他人视频的请求被拒', t.noteTimedtext(TT('X', 'en'), WATCH('A')) === 'other-video');
  const pinA = t.pinForProduce()!;
  t.resetForVideo('B');
  check('切视频后旧来源被清掉', !t.hasCurrentSource());
  check('切视频后旧结果判过期', t.staleAfterFetch(pinA.trackKey));
  const r2 = t.noteTimedtext(TT('A', 'en'), WATCH('B')); // 旧视频的迟到请求
  check('旧视频迟到请求不进入来源', r2 === 'other-video' && !t.hasCurrentSource());
  t.noteTimedtext(TT('B', 'en'), WATCH('B'));
  t.syncVideo(WATCH('C'));
  check('地址先变化且新来源未到时清除旧来源', t.sourceUrl === '' && !t.hasCurrentSource());
  t.resetForVideo('');
  check('离开视频页清除视频身份', t.currentVideoId === '' && !t.hasCurrentSource());
}

console.log('M1 词汇：规范化与去重');
{
  check('NFC/空白/大小写归一', normalizeExpression('  The  Flash ') === 'the flash');
  check('不同大小写同键', normalizeExpression('Constrain') === normalizeExpression('CONSTRAIN'));
  check('保留内部标点', normalizeExpression('state-of-the-art') === 'state-of-the-art');
}

console.log('M1 词汇：planSave 决策（网页来源）');
{
  const snap = {
    source: 'web' as const,
    expression: 'Constrain',
    sentence: 'Data constraints limit what we can do.',
    url: 'https://example.com/a',
    title: 'Example',
  };
  const first = planSave(undefined, [], snap, {});
  check('首次保存新建词条', !!first && first.entry.key === 'constrain');
  check('新建默认 saved', first?.entry.status === 'saved');
  check('保留原始大小写', first?.entry.expression === 'Constrain');
  check('追加新上下文', first?.appended === true);

  const entry: VocabEntryRecord = first!.entry;
  const ctxs = [
    { id: 1, entryKey: entry.key, url: snap.url, sentence: snap.sentence, definition: null },
  ];
  const dup = planSave(entry, ctxs, { ...snap, expression: 'CONSTRAIN' }, {});
  check('同上下文重复保存不追加', dup?.appended === false && dup?.context.id === 1);
  check('重复保存保持当前状态', dup?.status === 'saved');
  const dupKnown = planSave(entry, ctxs, { ...snap, expression: 'CONSTRAIN' }, { status: 'known' });
  check('显式“已掌握”更新状态', dupKnown?.status === 'known');
  check('重复上下文不追加（显式状态时）', dupKnown?.appended === false);

  const fresh = planSave(entry, ctxs, { ...snap, url: 'https://example.com/b' }, {});
  check('新 URL 的新语境追加', fresh?.appended === true);
  const def = planSave(undefined, [], snap, { definition: '限制' });
  check('保存可携带释义', def?.context.definition === '限制');
  const backfill2 = planSave(entry, ctxs, snap, { definition: '限制' });
  check('已存在的空释义上下文在重复保存时补上', backfill2?.appended === false && backfill2?.context.definition === '限制');

  check(
    '上下文去重判定（空白差异视为同一片段）',
    isDuplicateContext(ctxs[0]!, entry.key, snap.url, 'Data  constraints limit what we can do.'),
  );
  check('空表达拒绝保存', planSave(undefined, [], { ...snap, expression: '  ' }, {}) === null);
  check('补释义条件：仅空释义时补', shouldBackfill(ctxs[0]) === true && shouldBackfill({ definition: 'x' }) === false);
}

console.log('M2 字幕：ASR 滚动重复消除与合并');
{
  const raw = [
    { start: 0, dur: 2000, text: 'the sounds of', lastOff: 1800 },
    { start: 1400, dur: 2000, text: 'the sounds of silence', lastOff: 3200 },
    { start: 3400, dur: 1000, text: 'the sounds of silence', lastOff: 4200 }, // 同文重复
    { start: 6000, dur: 1500, text: 'one duck', lastOff: 7300 },
    { start: 7000, dur: 1500, text: 'one duck two many', lastOff: 8400 },
  ];
  const merged = normalizeAsrCues(raw);
  check('滚动链合并为一条', merged.length === 2, `got ${merged.length}`);
  check('保留链首起始时间', merged[0]?.start === 0);
  check('文本取最长', merged[0]?.text === 'the sounds of silence');
  check('时长延伸到链尾', merged[0] !== undefined && merged[0].start + merged[0].dur >= 4200);
  check('第二条链起点独立', merged[1]?.start === 6000 && merged[1]?.text === 'one duck two many');
  // 不相连的相似文本不合并
  const far = [
    { start: 0, dur: 1000, text: 'hello', lastOff: 900 },
    { start: 9000, dur: 1000, text: 'hello world', lastOff: 9900 },
  ];
  check('时间不相连不合并', normalizeAsrCues(far).length === 2);
  // 人工字幕原样
  const manual = [
    { start: 0, dur: 1000, text: 'A', lastOff: 1000 },
    { start: 1200, dur: 1000, text: 'B', lastOff: 2200 },
  ];
  check('人工字幕不合并', normalizeAsrCues(manual).length === 2);
}

console.log('M2 字幕：currentTime 定位与翻译窗口');
{
  const cues = [
    { start: 0, dur: 1000, text: 'a', lastOff: 1000 },
    { start: 2000, dur: 1500, text: 'b', lastOff: 3500 },
    { start: 4000, dur: 1000, text: 'c', lastOff: 5000 },
  ];
  check('句中命中', cueIndexAt(cues, 2500) === 1);
  check('句首边界命中', cueIndexAt(cues, 2000) === 1);
  check('句间空隙无句', cueIndexAt(cues, 3800) === -1);
  check('开头之前无句', cueIndexAt(cues, -5) === -1);
  check('末句内命中', cueIndexAt(cues, 4800) === 2);
  check('全片结束无句', cueIndexAt(cues, 9900) === -1);
  check('翻译窗口：前后各 1/4', JSON.stringify(buildTranslateWindow(10, 5, 1, 4)) === '[4,5,6,7,8,9]');
  check('翻译窗口：边界收敛', JSON.stringify(buildTranslateWindow(10, 0, 1, 4)) === '[0,1,2,3,4]');
  check('翻译窗口：无当前句为空', buildTranslateWindow(10, -1, 1, 4).length === 0);
  check('时钟格式', fmtClock(65000) === '1:05' && fmtClock(3723000) === '1:02:03');
}

console.log('M2 词汇：视频上下文去重（词条+videoId+轨道+起始时间+原文）');
{
  const video: VideoRef = {
    videoId: 'vid1',
    trackId: 'https://www.youtube.com/api/timedtext?v=vid1&lang=en',
    trackKind: 'asr',
    trackLang: 'en',
    startMs: 12500,
  };
  const snap = {
    source: 'video' as const,
    expression: 'silence',
    sentence: 'The sounds of silence.',
    title: 'Video Title',
    video,
  };
  const first = planSave(undefined, [], snap, {});
  check('视频首次保存新建', !!first && first.entry.key === 'silence');
  check('视频上下文带 video 字段', first?.appended === true && first?.context.video?.videoId === 'vid1');
  check(
    '视频来源链接带秒参数',
    first?.context.url === 'https://www.youtube.com/watch?v=vid1&t=13s',
    first?.context.url,
  );
  check('毫秒→秒边界转换', videoContextUrl('vid1', 12999) === 'https://www.youtube.com/watch?v=vid1&t=13s');

  const entry = first!.entry;
  const ctxs = [first!.context];
  const dup = planSave(entry, ctxs, snap, {});
  check('同句同位置重复保存不追加', dup?.appended === false);

  const later = planSave(entry, ctxs, { ...snap, video: { ...video, startMs: 45000 } }, {});
  check('同句不同位置分别保存', later?.appended === true);
  check('不同位置的来源链接不同', later?.context.url === 'https://www.youtube.com/watch?v=vid1&t=45s');

  const otherTrack = planSave(
    entry,
    ctxs,
    { ...snap, video: { ...video, trackId: video.trackId + '&kind=asr' } },
    {},
  );
  check('同句不同轨道分别保存', otherTrack?.appended === true);

  const otherVideo = planSave(
    entry,
    ctxs,
    { ...snap, video: { ...video, videoId: 'vid2' } },
    {},
  );
  check('同句不同视频分别保存', otherVideo?.appended === true);

  check(
    '视频去重判定：字段全同才重复',
    isDuplicateVideoContext(ctxs[0] as never, 'silence', video, 'The sounds of silence.') &&
      !isDuplicateVideoContext(ctxs[0] as never, 'silence', { ...video, startMs: 1 }, 'The sounds of silence.'),
  );
  check('网页上下文不与视频判定混淆', !isDuplicateContext(ctxs[0] as never, 'silence', 'https://x.com/', 'The sounds of silence.'));
}

console.log('M3 词形：关联、独立与冲突');
{
  const items = [
    { key: 'constrain', expression: 'constrain', status: 'saved' as const, forms: ['constrains', 'constrained', 'constraining'] },
    { key: 'constraint', expression: 'constraint', status: 'learning' as const, forms: [] },
    { key: 'go', expression: 'go', status: 'saved' as const, forms: ['went'] },
  ];
  const fi = buildFormIndex(items);
  check('constrained 关联 constrain', fi.get('constrained') === 'constrain');
  check('constraining 关联 constrain', fi.get('constraining') === 'constrain');
  check('went 关联 go', fi.get('went') === 'go');
  check('constraint 独立（不映射到 constrain）', !fi.has('constraint') || fi.get('constraint') === 'constraint');

  // 冲突：两个词条声明同一词形 → 不映射（保留独立表达）
  const conflict = [
    ...items,
    { key: 'went', expression: 'went', status: 'saved' as const, forms: [] },
  ];
  const fi2 = buildFormIndex(conflict);
  check('冲突词形不映射（went 已是独立词条）', !fi2.has('went'));
  const twoOwners = [
    { key: 'go', expression: 'go', status: 'saved' as const, forms: ['went'] },
    { key: 'wend', expression: 'wend', status: 'saved' as const, forms: ['went'] },
  ];
  check('双拥有者词形不映射', !buildFormIndex(twoOwners).has('went'));

  // planForms 占用规则
  const occupied = {
    isEntryKey: (k: string) => ['constraint', 'went'].includes(k),
    ownerOf: (f: string) => (f === 'constrains' ? 'other-entry' : undefined),
  };
  const merged = planForms('constrain', ['constrained'], ['constrained', 'constraining', 'constraint', 'went', 'constrains', 'constrain'], occupied);
  check(
    'planForms：并入未占用词形，排除独立词条键/冲突/自身',
    merged.join(',') === 'constrained,constraining',
    merged.join(','),
  );
  check('词形行解析', JSON.stringify(parseFormsLine('constrains, constrained、constraining；went')) === '["constrains","constrained","constraining","went"]');
}

console.log('M3 释义回复：词形行');
{
  const parsed = parseDefinitionReply('释义：限制；约束\n语境：这里指数据层面的限制。\n词形：constrains, constrained, constraining');
  check('三段解析', parsed.definition === '限制；约束' && parsed.note === '这里指数据层面的限制。');
  check('词形行解析', JSON.stringify(parsed.forms) === '["constrains","constrained","constraining"]');
  const noForms = parseDefinitionReply('释义：去\n语境：去某处');
  check('无词形行为空数组', noForms.forms.length === 0);
}

console.log('M3 复习占位：词边界替换');
{
  const r1 = blankExpression('He went home because he Went too early.', 'went');
  check('大小写无关全部替换', r1.count === 2 && !r1.text.includes('ent'));
  const r2 = blankExpression('The wellness center', 'well');
  check('词边界防误匹配（wellness≠well）', r2.count === 0);
  const r3 = blankExpression('give up on it and GIVE UP now', 'give up');
  check('短语完整匹配', r3.count === 2);
}

console.log('M4 复习队列：构建与同步');
{
  const entries: EntryView[] = [
    {
      key: 'constrain',
      expression: 'constrain',
      kind: 'word',
      status: 'saved',
      createdAt: 1,
      updatedAt: 1,
      forms: [],
      contexts: [
        { id: 2, sentence: 'Second ctx.', definition: null, sourceType: 'web', url: 'https://a/2', title: 'A', createdAt: 200 },
        { id: 1, sentence: 'First ctx.', definition: '限制', sourceType: 'web', url: 'https://a/1', title: 'A', createdAt: 100 },
      ],
    },
    {
      key: 'known-word',
      expression: 'known word',
      kind: 'word',
      status: 'known',
      createdAt: 1,
      updatedAt: 1,
      forms: [],
      contexts: [{ id: 3, sentence: 'Known.', definition: null, sourceType: 'web', url: 'https://b', title: 'B', createdAt: 50 }],
    },
    {
      key: 'go',
      expression: 'go',
      kind: 'word',
      status: 'learning',
      createdAt: 1,
      updatedAt: 1,
      forms: ['went'],
      contexts: [
        { id: 4, sentence: 'He went home.', definition: null, sourceType: 'video', url: 'https://www.youtube.com/watch?v=v&t=5s', title: 'V', createdAt: 80, video: { videoId: 'v', trackId: 't1', trackKind: 'asr', trackLang: 'en', startMs: 5000 } },
      ],
    },
    { key: 'no-context', expression: 'no context', kind: 'word', status: 'saved', createdAt: 1, updatedAt: 1, forms: [], contexts: [] },
  ];
  const queue = buildReviewQueue(entries);
  check('排除 known 与无上下文词条', queue.length === 2 && queue[0]?.key === 'constrain' && queue[1]?.key === 'go');
  check('每词条选最新一条上下文', queue[0]?.sentence === 'Second ctx.');
  check('复习不借其它原句的释义', queue[0]?.definition === null);
  check('视频上下文保留 video 字段', queue[1]?.video?.startMs === 5000);

  // 同步：当前词条被删、另一词条改 known，位置保持
  const after: EntryView[] = [
    { ...entries[0]!, status: 'known' }, // constrain 改 known → 移除
    { ...entries[3]!, contexts: [{ id: 5, sentence: 'Now has ctx.', definition: null, sourceType: 'web', url: 'https://c', title: 'C', createdAt: 30 }] }, // no-context 补上上下文 → 追加
    { ...entries[2]! }, // go 仍在
  ];
  const { queue: q2, currentIndex } = refreshQueue(queue, 'go', after);
  check('改 known 的词条移出队列', !q2.some((it) => it.key === 'constrain'));
  check('当前词条位置保持', q2[currentIndex]?.key === 'go');
  check('新增词条追加到队尾', q2[q2.length - 1]?.key === 'no-context');
  const { queue: q3, currentIndex: ci3 } = refreshQueue(queue, 'constrain', after);
  check('当前词条被移除时落到下一位置', q3[ci3]?.key === 'go');
}

console.log('M2 修复：DeepSeek 空回复判定（推理模型预算耗尽）');
{
  const ok = parseChatCompletion({
    choices: [{ message: { content: '释义：限制' }, finish_reason: 'stop' }],
  });
  check('正常回复', ok.content === '释义：限制' && ok.finishReason === 'stop' && !ok.hasReasoning);
  const drained = parseChatCompletion({
    choices: [
      { message: { content: '', reasoning_content: '思考中……' }, finish_reason: 'length' },
    ],
  });
  check(
    '推理耗尽预算：content 空 + finish=length + reasoning 滞留标记',
    drained.content === null && drained.finishReason === 'length' && drained.hasReasoning,
  );
  const blank = parseChatCompletion({
    choices: [{ message: { content: '   ' }, finish_reason: 'stop' }],
  });
  check('纯空白 content 归一为空', blank.content === null);
  const broken = parseChatCompletion(null);
  check('坏结构返回空 parts', broken.content === null && broken.finishReason === null && !broken.hasReasoning);
}

console.log('M5 问答：来源身份与 URL 规范化');
{
  const u1 = normalizeArticleUrl('https://a.com/x?b=1#section-2');
  check('段落锚点被移除、查询参数保留', u1 === 'https://a.com/x?b=1', u1);
  const u2 = normalizeArticleUrl('https://a.com/x#:~:text=hello%20world');
  check('文本定位片段被移除', u2 === 'https://a.com/x', u2);
  const u3 = normalizeArticleUrl('https://a.com/#/detail/42?page=2');
  check('hash 路由保留', u3 === 'https://a.com/#/detail/42?page=2', u3);
  const u4 = normalizeArticleUrl('https://a.com/x?lang=en');
  check('无 hash 原样返回', u4 === 'https://a.com/x?lang=en');
  check(
    'X status ID 解析',
    statusIdFromXUrl('https://x.com/karpathy/status/1841520000000000000?s=20') ===
      '1841520000000000000' && statusIdFromXUrl('https://x.com/home') === null,
  );
  check(
    'sourceKey：视频按 videoId（不同时间 URL 同对话）',
    sourceKeyOf({ sourceType: 'youtube', videoId: 'abc' }) === 'yt:abc',
  );
  check(
    'sourceKey：文章 URL 规范化',
    sourceKeyOf({ sourceType: 'article', url: 'https://a.com/x#sec' }) === 'web:https://a.com/x',
  );
}

console.log('M5 问答：材料分段与默认片段');
{
  const mkBlocks = (n: number, size: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${i + 1}`,
      text: 'a'.repeat(size),
      startMs: i * 1000,
      endMs: i * 1000 + 900,
    }));
  const small = mkBlocks(10, 100);
  const segsSmall = buildSegments(small, 'youtube', 24000);
  check('预算内不分段', segsSmall.length === 1);
  const big = mkBlocks(60, 1000); // 每块约 1KB → 3 段
  const segsBig = buildSegments(big, 'youtube', 24000);
  check('超限按块边界分段', segsBig.length >= 3, `got ${segsBig.length}`);
  check(
    '片段标签带时间范围',
    /^片段 1\/\d+ · 0:00–/.test(segsBig[0]!.label) && segsBig[0]!.label.includes('–'),
    segsBig[0]!.label,
  );
  const allIds = new Set(segsBig.flatMap((s) => s.blocks.map((b) => b.id)));
  check('分段覆盖全部块（不静默丢正文）', allIds.size === 60);
  const articleSegs = buildSegments(
    Array.from({ length: 50 }, (_, i) => ({ id: `p${i + 1}`, text: 'b'.repeat(1000) })),
    'article',
    24000,
  );
  check(
    '文章片段标签带段落范围',
    articleSegs[0]!.label.includes('段落 1–'),
    articleSegs[0]!.label,
  );
  // 单块超长：按句切分、共享原 ID
  const longOne = [
    {
      id: 'p1',
      text: Array.from({ length: 300 }, (_, i) => `Sentence number ${i} here. `).join(''),
      startMs: 0,
      endMs: 1000,
    },
  ];
  const split = buildSegments(longOne, 'youtube', 2000);
  check(
    '超长单块按句切分且保留原 ID',
    split.length >= 2 && split.every((s) => s.blocks.every((b) => b.id === 'p1')),
    `segs=${split.length}`,
  );
  check(
    '默认片段：引用块所在片段',
    pickDefaultSegment(segsBig, 'p45') === segsBig.findIndex((s) => s.blocks.some((b) => b.id === 'p45')),
  );
  check('默认片段：无焦点取第一段', pickDefaultSegment(segsBig, null) === 0);
  check('默认片段：未知焦点回落第一段', pickDefaultSegment(segsBig, 'p999') === 0);
}

console.log('M5 问答：历史裁剪与请求组装');
{
  const mkPair = (i: number, qLen: number, aLen: number): HistoryPair => ({
    question: `q${i} `.repeat(qLen).trim(),
    answer: `a${i} `.repeat(aLen).trim(),
    scopeLabel: `范围${i}`,
  });
  const pairs = [mkPair(1, 10, 10), mkPair(2, 10, 10), mkPair(3, 5000, 5000), mkPair(4, 100, 100), mkPair(5, 100, 100)];
  const trimmed = trimHistory(pairs, 6, 12000);
  check(
    '超限整对移出（最近优先，不拆对）',
    trimmed.length === 4 && trimmed.every((p) => p !== pairs[2]),
    `kept=${trimmed.map((p) => p.question.slice(0, 2)).join(',')}`,
  );
  const trimmed2 = trimHistory(
    Array.from({ length: 8 }, (_, i) => mkPair(i, 10, 10)),
    6,
    12000,
  );
  check('对数上限 6', trimmed2.length === 6);

  const snapshot = {
    source: { sourceType: 'article' as const, sourceKey: 'web:test', title: 'Test', url: 'https://example.com' },
    version: 2,
    createdAt: 1,
    label: '已加载正文',
    blocks: [
      { id: 'p1', text: 'First paragraph.' },
      { id: 'p2', text: 'Second paragraph.' },
    ],
  };
  const msgs = buildChatMessages({
    snapshot,
    segment: { index: 0, label: '已加载正文', blocks: snapshot.blocks },
    question: '这篇文章的观点是什么？',
    quote: { blockIds: ['p2'], expression: 'paragraph', definition: '段落' },
    history: [{ question: '第一段讲了什么？', answer: '讲了开头。', scopeLabel: '已加载正文' }],
  });
  check('消息结构：system + 历史 + 当前', msgs.length === 4 && msgs[0]!.role === 'system');
  check('材料只在 user 侧（不进 system）', !msgs[0]!.content.includes('[p1]'));
  check(
    '当前 user 含材料 / 引用 / 问题 / 范围',
    msgs[3]!.content.includes('[p1] First paragraph.') &&
      msgs[3]!.content.includes('引用｜块 p2｜表达：paragraph｜已有释义：段落') &&
      msgs[3]!.content.includes('问题：\n这篇文章的观点是什么？') &&
      msgs[3]!.content.includes('[材料范围：已加载正文]'),
  );
  check('历史带范围标签', msgs[1]!.content.includes('[历史范围：已加载正文]'));
}

console.log('M5 问答：引用解析与 SSE 流');
{
  const tokens = parseAnswerCitations('开头 [p1] 中间 [p12] 结尾，无效 [q3] 与 [p999]');
  check(
    '引用标记解析（p 前缀才算标记，其余保留原文；有效性由 UI 校验）',
    tokens.filter((t) => t.type === 'cite').map((t) => t.id).join(',') === 'p1,p12,p999' &&
      tokens.some((t) => t.type === 'text' && t.text.includes('[q3]')),
  );

  // 半行 / 多事件合包 / \r\n / [DONE]
  let fed = feedSSE('', 'data: {"choices":[{"delta":{"content":"你"}}]}\r\nda');
  check('完整事件 + 半行余留', fed.events.length === 1 && fed.rest === 'da' && !fed.done);
  fed = feedSSE(fed.rest, 'ta: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n');
  check(
    '半行续上 + 多事件合包 + [DONE]',
    fed.events.length === 1 && fed.done && fed.rest === '',
    JSON.stringify(fed),
  );
  const ev1 = parseStreamEvent('{"choices":[{"delta":{"content":"世界","reasoning_content":"思考"}}]}');
  check(
    'delta 只取 content，reasoning 不当答案',
    ev1.content === '世界' && ev1.reasoning && ev1.finishReason === null,
  );
  const ev2 = parseStreamEvent('{"choices":[{"delta":{},"finish_reason":"stop"}]}');
  check('finish_reason 解析', ev2.finishReason === 'stop' && ev2.content === null);
  check('坏 JSON 安全返回', parseStreamEvent('not json').content === null);
  const empty = feedSSE('', 'event: ping\n: comment\n');
  check('注释行与非 data 行忽略', empty.events.length === 0);
}


// M6 请求材料隔离与幂等迁移（纯逻辑）。
{
  const messages = [0, 1, 2].flatMap(v => [
    { id: `u${v}`, role: 'user' as const, turnId: `t${v}`, text: `question${v}`, at: v, snapshotVersion: v },
    { id: `a${v}`, role: 'assistant' as const, turnId: `t${v}`, text: `answer${v}`, at: v, state: 'done' as const },
  ]);
  check('移除材料后请求仅有普通历史', historyForTurn(messages, 'new', 0).length === 1);
  check('替换材料只带普通与当前快照历史', historyForTurn(messages, 'new', 2).map(p => p.question).join(',') === 'question0,question2');
  const free = buildChatMessages({ snapshot: null, segment: null, question: 'hello', quote: { blockIds: ['p1'], note: 'removed' }, history: [] });
  check('普通问答不夹带材料或引用', free.at(-1)?.content === 'hello');
  const legacy = { sourceKey: 'web:test', source: { sourceType: 'article' as const, sourceKey: 'web:test', title: 'test', url: 'https://example.com' }, snapshots: [], messages, pendingQuote: { blockIds: ['p1'] }, draft: 'draft', updatedAt: 1 };
  const migrated = migrateLegacyChat(legacy);
  check('旧会话迁移身份确定且正文草稿完整', migrated.id === migrateLegacyChat(legacy).id && migrated.messages === messages && migrated.draft === 'draft' && migrated.pendingQuote?.blockIds[0] === 'p1');
}



console.log('M6 对齐、缓存与来源边界');
{
  const english = [{ start: 0, dur: 2000, text: 'first', lastOff: 0 }, { start: 2000, dur: 2000, text: 'second', lastOff: 2000 }];
  const chinese = [{ start: 2200, dur: 1700, text: '第二句', lastOff: 2200 }];
  const aligned = alignTranslatedCues(english, chinese);
  check('独立轨道缺首句不导致后句错配', !aligned[0]?.zh && aligned[1]?.zh === '第二句');
  const paired = normalizeAsrCues([{ start: 0, dur: 1200, text: 'the', zh: '这', lastOff: 700 }, { start: 800, dur: 1600, text: 'the plane', zh: '这架飞机', lastOff: 1800 }]);
  check('ASR 英文合并同时转换平台配对译文', paired.length === 1 && paired[0]?.zh === '这架飞机');
  const memory: Record<string, unknown> = {};
  (globalThis as any).browser = { permissions: {contains:async()=>true}, storage: { session: { get: async () => memory, set: async (r: any) => Object.assign(memory, r) }, local: { get: async () => ({ cacheLimit: 20 }) } } };
  let calls = 0;
  const first = new AbortController();
  const run = async (signal: AbortSignal) => {
    calls++;
    await new Promise(r => setTimeout(r, 30));
    return { ok: !signal.aborted, text: 'result' };
  };
  const one = cached('shared', run, first.signal).catch(() => null);
  const two = cached('shared', run);
  setTimeout(() => first.abort(), 5);
  const [, result] = await Promise.all([one, two]);
  check('一个消费者关闭不取消其它消费者的共享任务', result.ok && calls === 1);
  await cached('shared', run);
  check('成功结果被缓存', calls === 1);
  await cached('other-source', run);
  check('不同来源缓存隔离', calls === 2);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('<html><title>Verify you are human</title></html>', { status: 200 });
    const restricted = await lookupDictionarySource('run', 'cambridge');
    check('HTTP 200 验证页不当释义', !restricted.ok && restricted.error === 'restricted');
    globalThis.fetch = async () => new Response('<div class="entry-body"><div class="entry-body__el"><span class="headword">take</span><div class="def-block"><span class="trans dtrans">拿</span></div></div></div>', { status: 200 });
    const partial = await lookupDictionarySource('take off', 'cambridge');
    check('take 普通词条不能冒充 take off', !partial.ok && partial.error === 'not-found');
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '["一", "", "三"]' }, finish_reason: 'stop' }] });
    const ai = await translateSentences({...defaultAiProfile('deepseek'),provider:'deepseek',apiKey:'test-only-key'}, ['one', 'two', 'three']);
    check('AI 译文空项不移动后续字幕 ID', ai.ok && ai.translations.length === 2 && ai.translations[1]?.id === 2);
  } finally { globalThis.fetch = originalFetch; }
}
const m7Cues = [
  { start:0, dur:3000, lastOff:0, text:'Run, run home.' },
  { start:2000, dur:1000, lastOff:0, text:'Home now.' },
];
const m7Words = cueWords(m7Cues);
check('词次按实际出现计数，字幕位置去重', m7Words[0]?.count === 2 && m7Words[0]?.positions.length === 1 && m7Words[1]?.count === 2);
check('AP 使用显示结束边界，重叠在下一句开始结束', cueEnd(m7Cues, 0) === 2000 && cueEnd(m7Cues, 1) === 3000);

// M11 语言身份与词条稳定键（纯逻辑）。
console.log('M11 语言身份与词条键');
{
  check('土耳其语 I 折叠为 ı（不与 i 合并）', normalizeExpressionInLanguage('DIŞARI', 'tr') === 'dışarı');
  check('英语折叠保持点化 i', normalizeExpressionInLanguage('DIŞARI', 'en') === 'dişari');
  check('日语键保留原形', entryKeyOf('ja', '学ぶ') === 'ja::学ぶ');
  check('键往返', parseEntryKey('zh-Hant::繁體')?.lang === 'zh-Hant' && parseEntryKey('zh-Hant::繁體')?.expression === '繁體');
  check('旧格式键无语言', parseEntryKey('pain') === null);
  check('有效语言字段优先', effectiveEntryLanguage({ key: 'pain', language: 'fr' }) === 'fr');
  check('无语言旧记录不猜语言', effectiveEntryLanguage({ key: 'pain' }) === null);
  check('重音保留', normalizeExpressionInLanguage('École', 'fr') === 'école');
  check('同形词不同语言是不同词条', entryKeyOf('en', 'pain') !== entryKeyOf('fr', 'pain'));
}

console.log('M11 planSave 语言身份');
{
  const jaSnap = {
    source: 'web' as const, expression: '学ぶ', sentence: '私は日本語を学ぶ。',
    url: 'https://example.com/ja', title: 'Example', lang: 'ja',
  };
  const saved = planSave(undefined, [], jaSnap, {});
  check('语言作用域键', saved?.entry.key === 'ja::学ぶ');
  check('词条携带语言', saved?.entry.language === 'ja');
  const undSaved = planSave(undefined, [], { ...jaSnap, expression: 'pain', lang: 'und' }, {});
  check('待确认语言仍可收藏', undSaved?.entry.key === 'und::pain' && undSaved?.entry.language === 'und');
  const noLang = planSave(undefined, [], { source: 'web' as const, expression: 'pain', sentence: 's', url: 'https://a.com', title: 't' }, {});
  check('无语言快照沿用旧键（迁移前兼容）', noLang?.entry.key === 'pain');
  check('查询候选：无语言只有裸键', JSON.stringify(lookupKeyCandidates('Late')) === '["late"]');
  check('查询候选：裸键优先于作用域键', JSON.stringify(lookupKeyCandidates('Late', 'en')) === '["late","en::late"]');
  check('查询候选：作用域键按语言规范化', lookupKeyCandidates('DIŞARI', 'tr')[1] === 'tr::dışarı');
}

console.log('M11 查询路由：语言对、词典门控与 AI 兜底');
{
  const originalFetch = globalThis.fetch;
  const aiConfig = { ...defaultAiProfile('deepseek'), provider: 'deepseek' as const, apiKey: 'test-only-key' };
  const seenUrls: string[] = [];
  const stubFetch = (urls: string[]) => {
    globalThis.fetch = (async (input: any) => {
      const url = String(input instanceof URL ? input : input?.url ?? input);
      seenUrls.push(url);
      if (url.includes('dict.youdao.com/jsonapi')) return Response.json({});
      if (url.includes('dictionary.cambridge.org')) return new Response('<html><body></body></html>', { status: 200 });
      if (url.includes('translate.googleapis.com')) return Response.json([[['译文']]]);
      if (url.includes('/chat/completions')) return Response.json({ choices: [{ message: { content: '释义：学习\n语境：表示学习的动作' }, finish_reason: 'stop' }] });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    urls.length = 0;
  };
  try {
    // 非英语源：词典完全不适用 → 免费译文，已知源传实际代码，目标 zh-CN
    stubFetch(seenUrls);
    const ja = await lookupOnline('学ぶ', DEFAULT_SETTINGS, undefined, undefined, {
      lang: { source: 'ja', target: 'zh-Hans' }, sentence: '私は日本語を学ぶ。',
    });
    check('日语走免费译文', ja.ok && ja.result.kind === 'translation');
    check('已知源传实际语言代码', seenUrls.some(u => u.includes('sl=ja') && u.includes('tl=zh-CN')));

    // 待确认源（und）：交给端点自动检测，不猜英语
    stubFetch(seenUrls);
    const und = await lookupOnline('pain', DEFAULT_SETTINGS, undefined, undefined, {
      lang: { source: 'und', target: 'zh-Hans' }, sentence: 'Le pain est bon.',
    });
    check('待确认源交给自动检测', und.ok && seenUrls.some(u => u.includes('sl=auto')) && !seenUrls.some(u => u.includes('sl=en')));

    // 英语源 + 词典明确未命中 + 开关关 → 免费译文（不是失败）
    stubFetch(seenUrls);
    const missWord = await lookupOnline('flumberration', DEFAULT_SETTINGS, undefined, undefined, {
      lang: { source: 'en', target: 'zh-Hans' }, sentence: 'A flumberration of options.',
    });
    check('词典未命中回退免费译文', missWord.ok && missWord.result.kind === 'translation');
    check('词典请求按 en 源发出', seenUrls.some(u => u.includes('youdao.com/jsonapi')));

    // 悬停意图：开关开 + 已配置也绝不触发 LLM
    stubFetch(seenUrls);
    const hover = await lookupOnline('flumberration2', DEFAULT_SETTINGS, undefined, undefined, {
      lang: { source: 'en', target: 'zh-Hans' }, intent: 'hover',
      aiFallback: { enabled: true, config: aiConfig },
    });
    check('悬停零 LLM 调用', !seenUrls.some(u => u.includes('/chat/completions')));
    check('悬停仍得免费译文', hover.ok && hover.result.kind === 'translation');

    // 主动查词 + 开关开 + 已配置 + 词典未命中 → AI 释义
    stubFetch(seenUrls);
    const ai = await lookupOnline('flumberration3', DEFAULT_SETTINGS, undefined, undefined, {
      lang: { source: 'en', target: 'zh-Hans' },
      aiFallback: { enabled: true, config: aiConfig }, sentence: 'A flumberration of options.',
    });
    check('主动兜底命中 AI 释义', ai.ok && ai.result.kind === 'ai-definition');
    if (ai.ok && ai.result.kind === 'ai-definition') {
      check('AI 结果区分于词典与译文', ai.result.lang.source === 'en' && ai.result.text.includes('学习'));
    }

    // 主动 + 开关开但未配置 → 免费路径 + ai-unconfigured 提示
    stubFetch(seenUrls);
    const uncfg = await lookupOnline('flumberration4', DEFAULT_SETTINGS, undefined, undefined, {
      lang: { source: 'en', target: 'zh-Hans' }, aiFallback: { enabled: true, config: null }, sentence: 's',
    });
    check('未配置 AI 继续免费路径并提示', uncfg.ok && uncfg.result.kind === 'translation' && uncfg.degraded === 'ai-unconfigured');

    // 词典限流（restricted）：不算未命中 → 不触发 AI，标明故障并尝试免费译文
    globalThis.fetch = (async (input: any) => {
      const url = String(input instanceof URL ? input : input?.url ?? input);
      seenUrls.push(url);
      if (url.includes('translate.googleapis.com')) return Response.json([[['译文']]]);
      if (url.includes('/chat/completions')) return Response.json({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] });
      return new Response('{}', { status: 429 });
    }) as typeof fetch;
    seenUrls.length = 0;
    const restricted = await lookupOnline('flumberration5', DEFAULT_SETTINGS, undefined, undefined, {
      lang: { source: 'en', target: 'zh-Hans' }, aiFallback: { enabled: true, config: aiConfig }, sentence: 's',
    });
    check('词典故障不触发 AI', !seenUrls.some(u => u.includes('/chat/completions')));
    check('词典故障标明降级仍给译文', restricted.ok && restricted.result.kind === 'translation' && restricted.degraded === 'dictionary-failure');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('M11 分词与标记命中');
{
  const jaRaw = '私は毎日日本語を学ぶ。';
  const manabu = jaRaw.indexOf('学ぶ');
  check('点击定位日语词', wordAt(jaRaw, manabu, 'ja')?.text === '学ぶ');
  check('点击定位土耳其语词', wordAt('DIŞARI çıkmak', 0, 'tr')?.text === 'DIŞARI');
  check('点击落在词间取紧邻词', !!wordAt('hello world', 5, 'en'));
  check('纯数字不判语言', detectTextLanguage('123 456') === null);
  check('假名判日语', detectTextLanguage('これはペンです') === 'ja');
  check('无假名汉字判中文', detectTextLanguage('我们学习中文') === 'zh');
  check('波斯语特有字符判 fa', detectTextLanguage('زبان فارسی') === 'fa');
  check('阿拉伯语判 ar', detectTextLanguage('اللغة العربية') === 'ar');
  check('拉丁保守判英语桶', detectTextLanguage('Le pain est bon') === 'en');

  const mkBucket = (tokens: Record<string, string>, phrases: Record<string, string> = {}): MarkBucket => ({
    statusByKey: new Map(Object.entries(tokens)),
    phrases: new Map(Object.entries(phrases)),
  });
  const buckets = new Map<string, MarkBucket>([
    ['ja', mkBucket({ 学ぶ: 'learning' })],
    ['zh', mkBucket({ 中文: 'known' })],
    ['en', mkBucket({ constrained: 'saved' }, { 'take off': 'learning' })],
    ['fr', mkBucket({ pain: 'saved' })],
  ]);
  const jaHits = scanMarkHits(jaRaw, buckets);
  check('日语词条命中且范围正确', jaHits.length === 1 && jaRaw.slice(jaHits[0]!.start, jaHits[0]!.end) === '学ぶ');
  check('法语词条不套用到拉丁默认桶', scanMarkHits('Le pain est bon', buckets).length === 0);
  check('英语桶命中词条', scanMarkHits('The constrained design', buckets).length === 1);
  const phHits = scanMarkHits('Take off now', buckets);
  check('英语短语窗口命中', phHits.length === 1 && phHits[0]!.end - phHits[0]!.start === 'Take off'.length);
  check('中文词条命中', scanMarkHits('我们学习中文。', buckets).length === 1);
  check('无语言文本零标记', scanMarkHits('123', buckets).length === 0);
}

console.log('M11 旧数据语言迁移决策');
{
  const videoEn = { sourceType: 'video' as const, trackLang: 'en' };
  const videoJa = { sourceType: 'video' as const, trackLang: 'ja' };
  const webDict = { sourceType: 'web' as const, hasDictionaryResult: true };
  const webPlain = { sourceType: 'web' as const };
  const assign = planLegacyLanguage([videoEn, webPlain]);
  check('轨道语言证据归属（无证据语境随词条）', assign.kind === 'assign' && assign.language === 'en');
  const viaDict = planLegacyLanguage([webDict]);
  check('词典命中是英语证据', viaDict.kind === 'assign' && viaDict.language === 'en');
  const none = planLegacyLanguage([webPlain, { sourceType: 'web' as const }]);
  check('无证据归待确认', none.kind === 'none');
  const split = planLegacyLanguage([videoEn, videoJa, webPlain, videoJa]);
  check('跨语言语境拆分成两组', split.kind === 'split' && split.groups.length === 2);
  if (split.kind === 'split') {
    const ja = split.groups.find(g => g.language === 'ja')!;
    check('无证据语境随最大组', ja.contextIndexes.length === 3 && ja.contextIndexes.includes(2));
  }
  check('旧请求固定语言不是证据', planLegacyLanguage([{ sourceType: 'web' as const }]).kind === 'none');
}

console.log('M11 聊天/材料序列化往返');
{
  const record: {
    id: string; title: string;
    source: { sourceType: 'article'; sourceKey: string; title: string; url: string } | null;
    sourceKey: string; snapshots: MaterialSnapshotRecord[]; activeSnapshotVersion: number;
    messages: ChatMessageRecord[]; updatedAt: number;
  } = {
    id: 'chat-1', title: 'Language and the world',
    source: { sourceType: 'article', sourceKey: 'web:x', title: 'Language', url: 'https://example.com/a' },
    sourceKey: 'web:x', snapshots: [], activeSnapshotVersion: 0,
    messages: [
      { id: 'u1', role: 'user', turnId: 't1', text: 'What does constrained mean here?', at: 1700000000000, snapshotVersion: 1, segmentIndex: 0, scopeLabel: '已加载正文', quote: { blockIds: ['p1', 'p2'], expression: 'constrained' } },
      { id: 'a1', role: 'assistant', turnId: 't1', text: '受控回答：受限制的。', at: 1700000001000, state: 'stopped' },
    ],
    updatedAt: 1700000002000,
  };
  const md = serializeChatRecord(record);
  const parsed = parseChatDocument(md);
  check('会话往返：身份与来源', !('error' in parsed) && parsed.id === 'chat-1' && parsed.sourceType === 'article');
  if (!('error' in parsed)) {
    check('会话往返：全部消息保序', parsed.messages.length === 2 && parsed.messages[0]!.text.includes('constrained'));
    check('会话往返：终态与材料引用', parsed.messages[1]!.state === 'stopped' && parsed.messages[0]!.snapshotVersion === 1 && parsed.messages[0]!.segmentIndex === 0);
    check('会话往返：引用块与表达', (parsed.messages[0]!.quote?.blockIds ?? []).join(',') === 'p1,p2');
  }
  const snapshot: MaterialSnapshotRecord = {
    source: { sourceType: 'article', sourceKey: '', title: 'T', url: '' },
    version: 2, createdAt: 1700000000000, label: '当前轨道完整字幕',
    blocks: [
      { id: 'p1', text: '第一句', startMs: 0, endMs: 2000 },
      { id: 'p2', text: '第二句' },
    ],
  };
  const mat = parseMaterialDocument(serializeMaterialSnapshot('chat-1', snapshot));
  check('材料往返：版本与块', !('error' in mat) && mat.version === 2 && mat.snapshot.blocks.length === 2 && mat.snapshot.blocks[0]!.startMs === 0);
  check('材料 ID 稳定', materialIdOf('chat-1', 2) === 'chat-1::v2');
  check('坏会话输入报格式错误', 'error' in parseChatDocument('not a doc'));
}

// ---- 选区查词与添加到对话（selection-chat-actions spec） ----------------------------

{
  const cls = (raw: string, lang = 'en', opts: { crossesBlock?: boolean } = {}) => classifySelection(raw, lang, opts);
  check('选区分类：单词', cls('learning').kind === 'word');
  check('选区分类：词内撇号/连字符各算一个词', cls("don't").kind === 'word' && cls('well-known').kind === 'word');
  check('选区分类：2–5 词短语', cls('take off').kind === 'phrase' && cls('in terms of').kind === 'phrase');
  check('选区分类：超过 5 词隐藏查词', cls('one two three four five six').kind === 'sentence');
  check('选区分类：跨正文块落入句段', cls('take off', 'en', { crossesBlock: true }).kind === 'sentence');
  check('选区分类：内部句界落入句段', cls('Go home. Take rest').kind === 'sentence');
  check('选区分类：中日文按分词器计（无空格≠单词）', cls('这是测试', 'zh').kind === 'phrase' && cls('学习', 'zh').kind === 'word');
  check('选区分类：长中日句段无查词', cls('今天的会议讨论了三个重要问题并且形成最终结论', 'zh').kind === 'sentence');

  const block = 'They are learning English together. Take off your shoes!';
  check('有效表达：learnin 补齐 learning', effectiveLookupExpression(block, 10, 16, 'en')?.expression === 'learning');
  check('有效表达：外围引号/逗号剥离', effectiveLookupExpression('“learning, fast', 1, 10, 'en')?.expression === 'learning');
  check('有效表达：词尾撇号补齐', effectiveLookupExpression("they are goin' now", 10, 13, 'en')?.expression === "goin'");
  check('有效表达：撇号后无字母不吞词', effectiveLookupExpression("they are goin' now", 10, 13, 'en')?.expression !== "goin' now");
  check('有效表达：所有格 s 保留', effectiveLookupExpression("Paris's streets", 0, 7, 'en')?.expression === "Paris's");
  check('有效表达：短语残缺补齐', effectiveLookupExpression('take off your shoes', 0, 7, 'en')?.expression === 'take off');
  check('有效表达：配对引号整体剥离', effectiveLookupExpression('“learning” done', 0, 11, 'en')?.expression === 'learning');
  check('有效表达：无法定位不猜', effectiveLookupExpression('!! ,,', 0, 5, 'en') === null);
  check('原句提取：选区所在句', sentenceContaining(block, 10, 17) === 'They are learning English together.');
  check('原句提取：跨句不兜底', sentenceContaining(block, 10, 45) === null);

  const webSource = { sourceType: 'article' as const, sourceKey: 'web:https://a.example/x', title: 'A', url: 'https://a.example/x' };
  const ytSource = {
    sourceType: 'youtube' as const, sourceKey: 'yt:v1', title: 'V', url: 'https://www.youtube.com/watch?v=v1',
    video: { videoId: 'v1', trackId: 't1', trackKind: 'manual' as const, trackLang: 'en' },
  };
  const base = { at: 1, pageUrl: 'https://a.example/x' };
  const wordCand: SelectionCandidate = { ...base, text: 'learning', kind: 'word', expression: 'learning', sentence: 'They are learning English together.', source: webSource };
  const wordBuilt = materialFromCandidate(wordCand);
  check('材料构建：网页词=焦点+原句背景', !!wordBuilt && wordBuilt.material.blocks.length === 2 && wordBuilt.material.blocks[0]!.text === 'learning' && wordBuilt.quote.blockIds.join() === 'p1' && wordBuilt.quote.expression === 'learning');
  const sentCand: SelectionCandidate = { ...base, text: 'They are learning English together.', kind: 'sentence', expression: null, source: webSource };
  check('材料构建：句段只附加选区', materialFromCandidate(sentCand)?.material.blocks.length === 1);
  const cueCand: SelectionCandidate = { ...base, pageUrl: ytSource.url, text: 'take off', kind: 'phrase', expression: 'take off', source: ytSource, cue: { index: 3, text: 'Take off your shoes!', startMs: 15000, endMs: 18000 } };
  const cueBuilt = materialFromCandidate(cueCand);
  check('材料构建：字幕词=焦点+字幕项背景带时间', !!cueBuilt && cueBuilt.material.blocks.length === 2 && cueBuilt.material.blocks[1]!.text === 'Take off your shoes!' && cueBuilt.material.blocks[1]!.startMs === 15000);
  const crossCand: SelectionCandidate = { ...base, pageUrl: ytSource.url, text: 'end of one cue start of next', kind: 'cross-cue', expression: null, source: ytSource, crossFromMs: 32000, crossCount: 2 };
  const crossBuilt = materialFromCandidate(crossCand);
  check('材料构建：跨字幕项带起始位置', !!crossBuilt && crossBuilt.material.blocks.length === 1 && crossBuilt.material.blocks[0]!.startMs === 32000 && !!crossBuilt.quote.note?.includes('2'));
  const defCand: SelectionCandidate = { ...base, text: 'learning', kind: 'word', expression: 'learning', source: webSource, definition: '学习' };
  check('材料构建：已有释义随焦点', materialFromCandidate(defCand)?.quote.definition === '学习');
  check('材料构建：空文本拒绝', materialFromCandidate({ ...base, text: '  ', kind: 'word', expression: null, source: webSource }) === null);

  check('候选身份：同页有效', candidateMatchesPage({ ...wordCand }, 'https://a.example/x#section') === true);
  check('候选身份：换页失效', candidateMatchesPage({ ...wordCand }, 'https://a.example/y') === false);
}

console.log(`\n通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exit(1);
