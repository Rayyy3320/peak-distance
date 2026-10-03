import { cached } from '../lib/onlineCache';
import { lookupDictionarySource } from '../lib/onlineDictionary';
import { translateSentences } from '../lib/aiClient';
import { defaultAiProfile } from '../shared/aiConfig';
import { alignTranslatedCues } from '../shared/cues';
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
  buildSurfaceStatusMap,
  isDuplicateContext,
  isDuplicateVideoContext,
  normalizeExpression,
  parseFormsLine,
  planForms,
  planSave,
  resolveEntryKey,
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
  check('resolveEntryKey：精确优先', resolveEntryKey(items, 'constraint') === 'constraint');
  check('resolveEntryKey：词形落到词条', resolveEntryKey(items, 'Constrained') === 'constrain');
  check('resolveEntryKey：未知词形为空', resolveEntryKey(items, 'gone') === null);

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

  // 表面词形 → 状态（字幕词标记）
  const sm = buildSurfaceStatusMap(items);
  check('constrained 呈现 constrain 状态', sm.get('constrained') === 'saved');
  check('went 呈现 go 状态', sm.get('went') === 'saved');
  check('constraint 用自身状态', sm.get('constraint') === 'learning');
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
console.log(`\n通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exit(1);
