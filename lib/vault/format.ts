// M11 学习库 Markdown 格式（spec 4.2 / 4.3 / 4.4，docs/specs/m11-multilingual-local-vault.md）：
// 词条 / 句子 / 偏好的序列化、解析、受管写入与三方合并。纯逻辑，无 DOM /
// 无浏览器 API，可在 Node 下离线检查（tools/m11-vault-format-check.ts）。
//
// 格式要点与权衡：
// - frontmatter 为简单 `key: value` 行；值含 `:`、引号、换行、首尾空白或以
//   `#` 开头时写 JSON 字符串形式 `"..."`（与 YAML 双引号串兼容），保证往返
//   无损。因此形如 `ja::学ぶ` 的 id 恒为转义形式（任务规定的转义规则）。
// - 受管内容仅 frontmatter 的 id/language/expression/status 与“原句”块。
//   “我的笔记”、未知 frontmatter 键、未知正文块原样保留（spec 4.3）；解析
//   时未知内容进入 `unknown`，不丢弃。
// - “释义”块是给人看的纯文本（来源行 + 文本），渲染自最新的可用结果；
//   apply 时文件已有该块则保留文件版本（用户可能在 Obsidian 编辑过）。
// - 语境块只承载人类可读行 + 必要关联（视频引用、收藏时间戳）。词典结果的
//   完整 senses/URL、AI 结果的语言对快照按 spec 4.2 不塞进正文，解析按
//   “缩减等价”恢复：translation 全量；dictionary 恢复来源 + 选中释义
//   （重建为单 sense 的最小 entry）；ai-definition 恢复文本与模型，语言对
//   按词条语言 + 默认理解语言；ai-context 恢复来源与文本。完整恢复由 FS
//   层的辅助元数据（.peak-distance/）负责。
// - forms / createdAt / updatedAt 不写入词条正文（spec 格式无此字段），往返
//   不承诺恢复，由本机记录承载。
// - note 与本机笔记同源；文件中的笔记小节用于外部编辑与三方合并。

import { DEFAULT_COMPREHENSION_LANG, isLanguageTag, type LanguageTag } from '@/shared/languages';
import {
  collapseWhitespace,
  sentenceId,
  isVocabStatus,
  type ContextExplanation,
  type LearningResult,
  type VideoRef,
  type VocabStatus,
} from '@/shared/vocab';
import type {
  VaultPreferenceRecord,
  VaultSentenceRecord,
  VaultVocabContext,
  VaultVocabRecord,
} from '@/shared/vault';

// ===== 受管块标题 =====

const NOTE_HEADING = '我的笔记';
const DEFINITION_HEADING = '释义';
const CONTEXTS_HEADING = '原句';
const TRANSLATION_HEADING = '译文';

// ===== frontmatter：简单 key: value 行，必要时 JSON 转义 ==========================

const VOCAB_FM_KEYS = ['id', 'language', 'expression', 'status'] as const;
type VocabFmKey = (typeof VOCAB_FM_KEYS)[number];

function isVocabFmKey(key: string): key is VocabFmKey {
  return (VOCAB_FM_KEYS as readonly string[]).includes(key);
}

/** 序列化值：含 `:` / 引号 / 换行 / 首尾空白 / `#` 开头 / 空串时用 JSON 字符串形式。 */
function escapeFmValue(value: string): string {
  const need =
    value === '' ||
    value !== value.trim() ||
    /["\n\r:]/.test(value) ||
    value.startsWith('#');
  return need ? JSON.stringify(value) : value;
}

/** 解析值：双引号串尝试 JSON.parse（往返无损），失败或非串按原文处理。 */
function unescapeFmValue(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // 非 JSON 双引号串：按原文处理
    }
  }
  return t;
}

interface FmEntry {
  key: string;
  value: string;
  /** 原始行：apply 时未知键与重复键逐字保留 */
  rawLine: string;
  /** 受管键（词条四键之一），未知键为 null */
  vocabKey: VocabFmKey | null;
}

function parseFmLine(line: string): FmEntry | null {
  const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):[ \t]?(.*)$/);
  if (!m) return null;
  const key = m[1]!;
  return { key, value: unescapeFmValue(m[2] ?? ''), rawLine: line, vocabKey: isVocabFmKey(key) ? key : null };
}

/** 拆分 frontmatter：首行 `---` 到下一个 `---`。缺失或未闭合返回 null。 */
function splitDoc(text: string): { fmLines: string[] | null; bodyLines: string[] } {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (close > 0) return { fmLines: lines.slice(1, close), bodyLines: lines.slice(close + 1) };
  }
  return { fmLines: null, bodyLines: lines };
}

/** 渲染词条 frontmatter：已有条目原位更新受管键，缺失的受管键补在末尾。 */
function renderVocabFm(existing: FmEntry[] | null, record: VaultVocabRecord): string[] {
  return renderFm(existing, {
    id: record.id,
    language: record.language,
    expression: record.expression,
    status: record.status,
  });
}

function renderFm(existing: FmEntry[] | null, values: Record<string, string>): string[] {
  const lines: string[] = [];
  const written = new Set<string>();
  for (const e of existing ?? []) {
    if (Object.hasOwn(values, e.key) && !written.has(e.key)) {
      lines.push(`${e.key}: ${escapeFmValue(values[e.key]!)}`);
      written.add(e.key);
    } else {
      lines.push(e.rawLine); // 未知键 / 重复键逐字保留
    }
  }
  for (const key of Object.keys(values)) {
    if (!written.has(key)) lines.push(`${key}: ${escapeFmValue(values[key]!)}`);
  }
  return lines;
}

function fmEntries(lines: string[]): FmEntry[] {
  return lines.map(line => parseFmLine(line) ?? { key: '', value: '', rawLine: line, vocabKey: null });
}

// ===== 正文分节 ===================================================================

interface Section {
  name: string;
  headingLine: string;
  contentLines: string[];
  /** 内容后的空行（与下一节之间的间隔），重建时原样保留 */
  gapLines: string[];
}

function splitSections(bodyLines: string[]): { prefixLines: string[]; sections: Section[] } {
  const prefixLines: string[] = [];
  const sections: Section[] = [];
  for (const line of bodyLines) {
    const m = line.match(/^##[ \t]+(\S.*?)[ \t]*$/);
    if (m) {
      sections.push({ name: m[1]!, headingLine: line, contentLines: [], gapLines: [] });
    } else if (sections.length > 0) {
      sections[sections.length - 1]!.contentLines.push(line);
    } else {
      prefixLines.push(line); // 首个 `## ` 之前（如 `# 学ぶ` 标题）原样保留
    }
  }
  for (const s of sections) {
    while (s.contentLines.length > 0 && s.contentLines[s.contentLines.length - 1]!.trim() === '') {
      s.contentLines.pop();
      s.gapLines.push('');
    }
  }
  return { prefixLines, sections };
}

function buildDoc(fmLines: string[], body: { prefixLines: string[]; sections: Section[] }): string {
  const out: string[] = ['---', ...fmLines, '---'];
  out.push(...body.prefixLines);
  for (const s of body.sections) {
    // 小节之间至少一个空行（已有的更长间隔原样保留）
    if (out.length > 0 && out[out.length - 1]!.trim() !== '') out.push('');
    out.push(s.headingLine);
    out.push(...s.contentLines);
    out.push(...s.gapLines);
  }
  while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
  return out.join('\n') + '\n';
}

function makeSection(name: string, contentLines: string[]): Section {
  return { name, headingLine: `## ${name}`, contentLines, gapLines: [] };
}

// ===== 语境块渲染 / 解析 ==========================================================

type DictionaryResult = Extract<LearningResult, { kind: 'dictionary' }>;

function dictionarySenseText(result: DictionaryResult): string {
  const senses = result.entry.senses;
  const idx = typeof result.selectedSense === 'number' ? result.selectedSense : 0;
  return (senses[idx]?.definition ?? senses.find((s) => s.definition.trim())?.definition ?? '').trim();
}

function resultSourceLabel(result: LearningResult): string {
  switch (result.kind) {
    case 'dictionary':
      return `${result.entry.source} 词典`;
    case 'translation':
      return 'google-gtx 译文';
    case 'ai-definition':
      return `AI 释义（${result.model || result.provider || 'ai'}）`;
  }
}

function videoLine(video: VideoRef): string {
  const flat = {
    videoId: video.videoId,
    trackId: video.trackId,
    trackKind: video.trackKind,
    trackLang: video.trackLang,
    startMs: video.startMs,
  };
  return `  - 视频：${JSON.stringify(flat)}`;
}

function parseVideoLine(value: string): VideoRef | null {
  try {
    const v: unknown = JSON.parse(value);
    if (typeof v !== 'object' || v === null) return null;
    const r = v as Record<string, unknown>;
    if (typeof r.videoId !== 'string' || typeof r.trackId !== 'string') return null;
    if (r.trackKind !== 'manual' && r.trackKind !== 'asr') return null;
    if (typeof r.trackLang !== 'string' || typeof r.startMs !== 'number') return null;
    return {
      videoId: r.videoId,
      trackId: r.trackId,
      trackKind: r.trackKind,
      trackLang: r.trackLang,
      startMs: r.startMs,
    };
  } catch {
    return null;
  }
}

function renderContext(c: VaultVocabContext): string[] {
  const lines: string[] = [`- ${collapseWhitespace(c.sentence)}`];
  lines.push(`  - 出处：${collapseWhitespace(c.title)}`);
  lines.push(`  - 链接：${c.url}`);
  const def = (c.definition ?? '').trim();
  if (def) lines.push(`  - 释义：${collapseWhitespace(def)}`);
  const r = c.result;
  if (r) {
    if (r.kind === 'dictionary') {
      const t = dictionarySenseText(r);
      if (t) {
        lines.push(`  - 词典释义：${collapseWhitespace(t)}`);
        lines.push(`  - 来源：${resultSourceLabel(r)}`);
      }
    } else if (r.kind === 'translation') {
      const t = collapseWhitespace(r.text);
      if (t) {
        lines.push(`  - 译文：${t}`);
        lines.push('  - 来源：google-gtx 译文');
      }
    } else {
      const t = collapseWhitespace(r.text);
      if (t) {
        lines.push(`  - AI 释义：${t}`);
        lines.push(`  - 来源：${resultSourceLabel(r)}`);
      }
    }
  }
  const ex = c.explanation;
  if (ex && ex.text.trim()) {
    lines.push(`  - AI 解释：${collapseWhitespace(ex.text)}`);
    lines.push(`  - 来源：AI 释义（${ex.source}）`);
  }
  lines.push(`  - 时间：${Math.max(0, Math.round(c.createdAt))}`);
  if (c.sourceType === 'video' && c.video) lines.push(videoLine(c.video));
  return lines;
}

function renderContexts(contexts: VaultVocabContext[]): string[] {
  const out: string[] = [];
  contexts.forEach((c, i) => {
    if (i > 0) out.push('');
    out.push(...renderContext(c));
  });
  return out;
}

/** 由“文本行 + 来源行”对重建 result / explanation；来源行不匹配返回 null。 */
function buildResultOrExplanation(
  pending: { label: string; text: string },
  sourceLabel: string,
  lang: string | null,
  expression: string,
  sentence: string,
): { result?: LearningResult; explanation?: ContextExplanation } | null {
  if (pending.label === '词典释义') {
    const m = sourceLabel.match(/^(\S+) 词典$/);
    const src = m?.[1];
    if (src !== 'youdao' && src !== 'cambridge') return null;
    return {
      result: {
        kind: 'dictionary',
        // 缩减等价：只恢复来源与选中释义，完整 senses/URL 由辅助元数据承载
        entry: {
          source: src,
          expression: expression || pending.text,
          headword: expression || pending.text,
          url: '',
          senses: [{ definition: pending.text }],
        },
        selectedSense: 0,
      },
    };
  }
  if (pending.label === '译文') {
    if (sourceLabel !== 'google-gtx 译文') return null;
    return { result: { kind: 'translation', source: 'google-gtx', text: pending.text } };
  }
  if (pending.label === 'AI 释义') {
    const m = sourceLabel.match(/^AI 释义（(.+)）$/);
    if (!m) return null;
    const inner = m[1]!;
    return {
      result: {
        kind: 'ai-definition',
        source: 'ai',
        text: pending.text,
        lang: { source: lang ?? 'und', target: DEFAULT_COMPREHENSION_LANG },
        ...(inner && inner !== 'ai' ? { model: inner } : {}),
      },
    };
  }
  // AI 解释（ai-context）
  const m = sourceLabel.match(/^AI 释义（(deepseek|ai)）$/);
  if (!m) return null;
  return {
    explanation: {
      kind: 'ai-context',
      source: m[1]! as ContextExplanation['source'],
      text: pending.text,
      sentence,
    },
  };
}

function parseContextBlock(
  topText: string,
  subTexts: string[],
  lang: string | null,
  expression: string,
): { ctx: VaultVocabContext; unknownLines: string[] } | null {
  const sentence = collapseWhitespace(topText);
  if (!sentence) return null;
  const unknownLines: string[] = [];
  let title = '';
  let url = '';
  let definition: string | null = null;
  let createdAt = 0;
  let video: VideoRef | null = null;
  let result: LearningResult | null = null;
  let explanation: ContextExplanation | null = null;
  let pending: { label: string; text: string; raw: string } | null = null;

  const dropPending = () => {
    if (pending) {
      unknownLines.push(pending.raw); // 有文本行但没有配对的来源行：保留原文
      pending = null;
    }
  };

  for (const raw of subTexts) {
    const m = raw.match(/^(出处|链接|词典释义|AI 释义|AI 解释|译文|释义|来源|时间|视频)：(.*)$/);
    if (!m) {
      unknownLines.push(`  - ${raw}`);
      continue;
    }
    const label = m[1]!;
    const value = (m[2] ?? '').trim();
    switch (label) {
      case '出处':
        title = collapseWhitespace(value);
        break;
      case '链接':
        url = value;
        break;
      case '释义':
        definition = value || null;
        break;
      case '时间':
        if (/^\d+$/.test(value)) createdAt = Number.parseInt(value, 10);
        else unknownLines.push(`  - ${raw}`);
        break;
      case '视频': {
        const v = parseVideoLine(value);
        if (v) video = v;
        else unknownLines.push(`  - ${raw}`);
        break;
      }
      case '词典释义':
      case '译文':
      case 'AI 释义':
      case 'AI 解释': {
        dropPending();
        const text = collapseWhitespace(value);
        pending = text ? { label, text, raw: `  - ${raw}` } : null;
        if (!text) unknownLines.push(`  - ${raw}`);
        break;
      }
      case '来源': {
        if (!pending) {
          unknownLines.push(`  - ${raw}`);
          break;
        }
        const built = buildResultOrExplanation(pending, value, lang, expression, sentence);
        if (!built) {
          unknownLines.push(`  - ${raw}`);
          break;
        }
        if (built.result) result = built.result;
        if (built.explanation) explanation = built.explanation;
        pending = null;
        break;
      }
    }
  }
  dropPending();

  return {
    ctx: {
      sentence,
      url,
      title,
      sourceType: video ? 'video' : 'web',
      video,
      createdAt,
      definition,
      ...(result ? { result } : {}),
      ...(explanation ? { explanation } : {}),
    },
    unknownLines,
  };
}

function parseContextLines(
  lines: string[],
  unknown: string[],
  lang: string | null,
  expression: string,
): VaultVocabContext[] {
  const contexts: VaultVocabContext[] = [];
  let top: string | null = null;
  let subs: string[] = [];

  const flush = () => {
    if (top === null) return;
    const parsed = parseContextBlock(top, subs, lang, expression);
    if (parsed) {
      contexts.push(parsed.ctx);
      unknown.push(...parsed.unknownLines);
    } else {
      unknown.push(`- ${top}`);
    }
    top = null;
    subs = [];
  };

  for (const line of lines) {
    if (line.trim() === '') continue;
    const indented = /^[ \t]/.test(line);
    if (!indented) {
      const m = line.match(/^-[ \t]+(.*)$/);
      flush();
      if (m) top = m[1] ?? '';
      else unknown.push(line);
    } else {
      const m = line.match(/^[ \t]*-[ \t]+(.*)$/);
      if (m && top !== null) subs.push(m[1] ?? '');
      else unknown.push(line);
    }
  }
  flush();
  return contexts;
}

// ===== 释义块（展示用纯文本）=====================================================

function pickDefinition(contexts: VaultVocabContext[]): { label: string | null; text: string } | null {
  for (let i = contexts.length - 1; i >= 0; i--) {
    const c = contexts[i]!;
    const r = c.result;
    if (r) {
      if (r.kind === 'dictionary') {
        const t = dictionarySenseText(r);
        if (t) return { label: resultSourceLabel(r), text: collapseWhitespace(t) };
      } else if (r.kind === 'translation') {
        const t = collapseWhitespace(r.text);
        if (t) return { label: 'google-gtx 译文', text: t };
      } else {
        const t = collapseWhitespace(r.text);
        if (t) return { label: resultSourceLabel(r), text: t };
      }
    }
    if (c.explanation && c.explanation.text.trim()) {
      return { label: `AI 释义（${c.explanation.source}）`, text: collapseWhitespace(c.explanation.text) };
    }
    const def = (c.definition ?? '').trim();
    if (def) return { label: null, text: collapseWhitespace(def) };
  }
  return null;
}

function renderDefinitionSection(contexts: VaultVocabContext[]): Section | null {
  const d = pickDefinition(contexts);
  if (!d) return null;
  const contentLines = d.label ? [`来源：${d.label}`, '', d.text] : [d.text];
  return makeSection(DEFINITION_HEADING, contentLines);
}

// ===== 词条：序列化 / 解析 / 受管写入 =============================================

export function serializeVocabRecord(record: VaultVocabRecord): string {
  const sections: Section[] = [makeSection(NOTE_HEADING, record.note ? record.note.split('\n') : [])];
  const def = renderDefinitionSection(record.contexts);
  if (def) sections.push(def);
  sections.push(makeSection(CONTEXTS_HEADING, renderContexts(record.contexts)));
  return buildDoc(renderVocabFm(null, record), { prefixLines: ['', `# ${record.expression}`, ''], sections });
}

export interface ParsedVocabDocument {
  id: string | null;
  language: string | null;
  expression: string | null;
  status: VocabStatus | null;
  /** “我的笔记”正文（原样保留；无该块为空串） */
  note: string;
  /** 解析出的受管原句块（按文件顺序） */
  managed: { contexts: VaultVocabContext[] };
  /** 无法识别的 frontmatter 键 / 正文块（保留原文行） */
  unknown: string[];
}

export function parseVocabDocument(text: string): ParsedVocabDocument | { error: 'format' } {
  const { fmLines, bodyLines } = splitDoc(text);
  if (!fmLines) return { error: 'format' };

  const unknown: string[] = [];
  const values: Partial<Record<VocabFmKey, string>> = {};
  for (const line of fmLines) {
    const e = parseFmLine(line);
    if (!e) {
      unknown.push(line);
      continue;
    }
    if (e.vocabKey && !(e.vocabKey in values)) values[e.vocabKey] = e.value;
    else unknown.push(line); // 未知键 / 重复受管键：保留原文
  }
  const language =
    values.language !== undefined && isLanguageTag(values.language) ? values.language : null;

  const { prefixLines, sections } = splitSections(bodyLines);
  let note = '';
  let sawNote = false;
  let sawDef = false;
  const contexts: VaultVocabContext[] = [];
  for (const s of sections) {
    if (s.name === NOTE_HEADING) {
      if (!sawNote) {
        note = s.contentLines.join('\n').trim();
        sawNote = true;
      } else {
        unknown.push([s.headingLine, ...s.contentLines].join('\n')); // 重复笔记块：保留原文
      }
    } else if (s.name === DEFINITION_HEADING) {
      if (sawDef) unknown.push([s.headingLine, ...s.contentLines].join('\n'));
      sawDef = true; // 释义块是展示内容，语境自带数据，无需恢复
    } else if (s.name === CONTEXTS_HEADING) {
      contexts.push(...parseContextLines(s.contentLines, unknown, language, values.expression ?? ''));
    } else {
      unknown.push([s.headingLine, ...s.contentLines].join('\n'));
    }
  }
  void prefixLines; // 首节之前的内容（如 `# 学ぶ`）由 apply 原样保留，解析不消费

  const status = values.status !== undefined && isVocabStatus(values.status) ? values.status : null;
  return {
    id: values.id !== undefined && values.id !== '' ? values.id : null,
    language,
    expression: values.expression !== undefined && values.expression !== '' ? values.expression : null,
    status,
    note,
    managed: { contexts },
    unknown,
  };
}

/**
 * 受管写入：只替换 frontmatter 的 id/language/expression/status 与“原句”块。
 * “我的笔记”、未知键、未知正文块与“释义”块（文件已有时）保持文件版本。
 * 文件没有“释义”块时按记录补写；“原句”块缺失时追加。无 frontmatter 视为
 * 无法定位身份，返回 { error: 'format' }。
 */
export function applyVocabToDocument(
  record: VaultVocabRecord,
  fileText: string,
): string | { error: 'format' } {
  const { fmLines, bodyLines } = splitDoc(fileText);
  if (!fmLines) return { error: 'format' };

  const entries = fmEntries(fmLines);

  const { prefixLines, sections } = splitSections(bodyLines);
  const ctxLines = renderContexts(record.contexts);
  const out: Section[] = sections.map((s) =>
    s.name === CONTEXTS_HEADING ? { ...s, contentLines: ctxLines }
      : s.name === NOTE_HEADING && record.note !== undefined ? { ...s, contentLines: record.note.split('\n') } : { ...s },
  );

  const hasContexts = out.some((s) => s.name === CONTEXTS_HEADING);
  const hasDef = out.some((s) => s.name === DEFINITION_HEADING);

  // 在末尾追加小节前保证与前文隔一个空行
  const ensureGapBeforeAppend = () => {
    if (out.length > 0) {
      const last = out[out.length - 1]!;
      if (last.gapLines.length === 0) last.gapLines = [''];
    } else if (prefixLines.length > 0 && prefixLines[prefixLines.length - 1]!.trim() !== '') {
      prefixLines.push('');
    }
  };

  if (!hasDef) {
    const def = renderDefinitionSection(record.contexts);
    if (def) {
      const at = out.findIndex((s) => s.name === CONTEXTS_HEADING);
      if (at > 0) {
        if (out[at - 1]!.gapLines.length === 0) out[at - 1]!.gapLines = [''];
        def.gapLines = [''];
        out.splice(at, 0, def);
      } else if (at === 0) {
        def.gapLines = [''];
        out.unshift(def);
      } else {
        ensureGapBeforeAppend();
        out.push(def);
      }
    }
  }

  if (!hasContexts) {
    ensureGapBeforeAppend();
    out.push(makeSection(CONTEXTS_HEADING, ctxLines));
  }
  if (record.note !== undefined && !out.some(s => s.name === NOTE_HEADING)) {
    ensureGapBeforeAppend();
    out.push(makeSection(NOTE_HEADING, record.note.split('\n')));
  }

  return buildDoc(renderVocabFm(entries, record), { prefixLines, sections: out });
}

// ===== 句子：frontmatter id/language + 正文原文 + “译文”块 ========================

export function serializeSentenceRecord(record: VaultSentenceRecord): string {
  const fm = [
    `id: ${escapeFmValue(record.id)}`,
    `language: ${escapeFmValue(record.language)}`,
  ];
  const lines: string[] = ['---', ...fm, '---', '', collapseWhitespace(record.text)];
  const translation = collapseWhitespace(record.translation ?? '');
  if (translation) {
    lines.push('', `## ${TRANSLATION_HEADING}`, '', translation);
    if (record.translationSource) lines.push('', `来源：${record.translationSource}`);
  }
  return lines.join('\n') + '\n';
}

/** Update the source/translation while retaining personal notes and custom fields/sections. */
export function applySentenceToDocument(record: VaultSentenceRecord, fileText: string): string | { error: 'format' } {
  const existing = splitDoc(fileText);
  if (!existing.fmLines) return { error: 'format' };
  const next = splitDoc(serializeSentenceRecord(record));
  const managed = splitSections(next.bodyLines);
  const { sections } = splitSections(existing.bodyLines);
  const translation = managed.sections.find(section => section.name === TRANSLATION_HEADING);
  const out = sections.map(section => section.name === TRANSLATION_HEADING
    ? { ...section, contentLines: translation?.contentLines ?? [] } : section);
  if (translation && !out.some(section => section.name === TRANSLATION_HEADING)) out.unshift(translation);
  const fields = renderFm(fmEntries(existing.fmLines), { id: record.id, language: record.language });
  return buildDoc(fields, { prefixLines: managed.prefixLines, sections: out });
}

export interface ParsedSentenceDocument {
  id: string | null;
  language: string | null;
  text: string | null;
  translation: string | null;
  translationSource: string | null;
  unknown: string[];
}

export function parseSentenceDocument(text: string): ParsedSentenceDocument | { error: 'format' } {
  const { fmLines, bodyLines } = splitDoc(text);
  if (!fmLines) return { error: 'format' };

  const unknown: string[] = [];
  let id: string | null = null;
  let language: string | null = null;
  for (const line of fmLines) {
    const e = parseFmLine(line);
    if (!e) {
      unknown.push(line);
      continue;
    }
    if (e.key === 'id' && id === null) id = e.value || null;
    else if (e.key === 'language' && language === null) language = isLanguageTag(e.value) ? e.value : null;
    else unknown.push(line);
  }

  const { prefixLines, sections } = splitSections(bodyLines);
  const textContent = prefixLines.join('\n').trim() || null;
  let translation: string | null = null;
  let translationSource: string | null = null;
  for (const s of sections) {
    if (s.name === TRANSLATION_HEADING) {
      const lines = s.contentLines.filter((l) => l.trim() !== '');
      const srcIdx = lines.findIndex((l) => l.startsWith('来源：'));
      if (srcIdx >= 0) {
        translationSource = lines[srcIdx]!.slice('来源：'.length).trim() || null;
        translation = lines.slice(0, srcIdx).join('\n').trim() || null;
      } else {
        translation = lines.join('\n').trim() || null;
      }
    } else {
      unknown.push([s.headingLine, ...s.contentLines].join('\n'));
    }
  }
  return { id, language, text: textContent, translation, translationSource, unknown };
}

// ===== 偏好：无 frontmatter，正文为默认行 + 覆盖列表 ==============================

export function serializePreferenceRecord(record: VaultPreferenceRecord): string {
  const lines = [`默认理解语言: ${record.defaultComprehensionLang}`];
  for (const src of Object.keys(record.comprehensionOverrides).sort()) {
    lines.push(`${src} -> ${record.comprehensionOverrides[src]}`);
  }
  return lines.join('\n') + '\n';
}

export interface ParsedPreferenceDocument {
  defaultComprehensionLang: string;
  comprehensionOverrides: Record<string, string>;
  unknown: string[];
}

/** 缺失条目用默认值（spec 4.2）：默认理解语言缺省为 zh-Hans，覆盖列表缺省为空。 */
export function parsePreferenceDocument(text: string): ParsedPreferenceDocument {
  const overrides: Record<string, string> = {};
  const unknown: string[] = [];
  let def: string | null = null;
  for (const raw of text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.trim() === '') continue;
    const d = raw.match(/^默认理解语言:[ \t]*(\S.*)$/);
    if (d) {
      def = d[1]!.trim();
      continue;
    }
    const o = raw.match(/^([A-Za-z][A-Za-z0-9_-]*) ->[ \t]*(\S.*)$/);
    if (o) {
      overrides[o[1]!] = o[2]!.trim();
      continue;
    }
    unknown.push(raw);
  }
  return {
    defaultComprehensionLang: def ?? DEFAULT_COMPREHENSION_LANG,
    comprehensionOverrides: overrides,
    unknown,
  };
}

// ===== 三方合并（spec 4.4）=======================================================

export type MergeOutcome<T> =
  | { kind: 'merged'; value: T; tookFile: string[] } // tookFile = 采用了文件侧的字段名
  | { kind: 'conflict'; fields: { field: string; local: unknown; file: unknown }[] };

/**
 * 词条三方合并，笔记缺失按空串处理。
 */
export type VocabRecordWithNote = VaultVocabRecord & { note?: string | null };

/** 语境身份：视频按 videoId+轨道+起始时间+原文，网页按 URL+原文（与保存去重判定一致）。 */
export function contextIdentity(c: VaultVocabContext): string {
  const sentence = collapseWhitespace(c.sentence);
  if (c.sourceType === 'video' && c.video) {
    return `video:${sentenceId(c.video, sentence)}`;
  }
  return JSON.stringify(['web', c.url, sentence]);
}

/** 信息量：带释义/结果/解释的副本优先保留（去重时双方同身份取更完整的一份）。 */
function contextDetail(c: VaultVocabContext): number {
  return ((c.definition ?? '').trim() ? 1 : 0) + (c.result ? 2 : 0) + (c.explanation ? 2 : 0);
}

/** 追加型合并：本地顺序优先，文件新增追加；同身份保留信息更完整的一份。 */
function mergeContexts(local: VaultVocabContext[], file: VaultVocabContext[]): VaultVocabContext[] {
  const merged: VaultVocabContext[] = [];
  const byKey = new Map<string, VaultVocabContext>();
  const add = (c: VaultVocabContext, fileSide: boolean) => {
    const key = contextIdentity(c);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, c);
      merged.push(c);
      return;
    }
    if (fileSide && contextDetail(c) > contextDetail(existing)) {
      byKey.set(key, c);
      merged[merged.indexOf(existing)] = c;
    }
  };
  for (const c of local) add(c, false);
  for (const c of file) add(c, true);
  return merged;
}

function mergeForms(local: string[], file: string[]): string[] {
  const out = [...local];
  for (const f of file) if (!out.includes(f)) out.push(f);
  return out;
}

/**
 * 规则（spec 4.4）：status 双方同改不同值 → 冲突；note 双方都改且不同 → 冲突；
 * 释义/原句追加型差异 → 合并（按语境身份去重，两边都保留）；一方改一方未改 →
 * 取改方；两边改成相同 → 一致。base 为 null（无共同祖先）时标量差异按冲突
 * 处理（不按时间或“已掌握优先”裁决）；删除由调用方（FS 层）处理。
 */
export function mergeVocabRecord(
  base: VocabRecordWithNote | null,
  local: VocabRecordWithNote,
  file: VocabRecordWithNote,
): MergeOutcome<VocabRecordWithNote> {
  const conflicts: { field: string; local: unknown; file: unknown }[] = [];
  const tookFile: string[] = [];
  const noteOf = (r: VocabRecordWithNote | null): string => ((r?.note ?? '') as string).trim();

  // --- status ---
  let status = local.status;
  if (local.status !== file.status) {
    const baseStatus = base?.status;
    if (baseStatus === undefined || (local.status !== baseStatus && file.status !== baseStatus)) {
      conflicts.push({ field: 'status', local: local.status, file: file.status });
    } else if (file.status !== baseStatus) {
      status = file.status;
      tookFile.push('status');
    }
  }

  // --- note（缺失按空串比较：文件新增笔记视为文件侧修改）---
  const localNote = noteOf(local);
  const fileNote = noteOf(file);
  const baseNote = noteOf(base);
  let note = localNote;
  if (localNote !== fileNote) {
    if (localNote !== baseNote && fileNote !== baseNote) {
      conflicts.push({ field: 'note', local: localNote, file: fileNote });
    } else if (fileNote !== baseNote) {
      note = fileNote;
      tookFile.push('note');
    }
  }
  const hasNote =
    local.note !== undefined || file.note !== undefined || base?.note !== undefined;

  // --- 身份（id/language/expression 成组处理：外部改身份应走扩展入口，spec 4.3）---
  type Identity = Pick<VaultVocabRecord, 'id' | 'language' | 'expression'>;
  const sameIdentity = (a: Identity, b: Identity): boolean =>
    a.id === b.id && a.language === b.language && a.expression === b.expression;
  let identity: Identity = { id: local.id, language: local.language, expression: local.expression };
  const fileId: Identity = { id: file.id, language: file.language, expression: file.expression };
  if (!sameIdentity(identity, fileId)) {
    const baseId = base ? { id: base.id, language: base.language, expression: base.expression } : null;
    const keys = ['id', 'language', 'expression'] as const;
    if (baseId === null || (!sameIdentity(identity, baseId) && !sameIdentity(fileId, baseId))) {
      for (const k of keys) {
        if (identity[k] !== fileId[k]) conflicts.push({ field: k, local: identity[k], file: fileId[k] });
      }
    } else if (!sameIdentity(fileId, baseId)) {
      identity = fileId;
      for (const k of keys) if (identity[k] !== fileId[k]) tookFile.push(k);
    }
  }

  if (conflicts.length > 0) return { kind: 'conflict', fields: conflicts };

  const value: VocabRecordWithNote = {
    ...local,
    ...identity,
    status,
    forms: mergeForms(local.forms ?? [], file.forms ?? []),
    contexts: mergeContexts(local.contexts, file.contexts),
    createdAt: base?.createdAt ?? local.createdAt,
    updatedAt: Math.max(local.updatedAt, file.updatedAt),
  };
  if (hasNote) value.note = note;
  return { kind: 'merged', value, tookFile };
}
