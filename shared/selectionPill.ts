// 选区浮条（选区查词 spec 的单层入口）：普通网页 / X 与 YouTube 页面正文共用。
// 分类表驱动按钮：word=查词+添加到对话；phrase=查词+翻译+添加到对话；
// sentence=翻译+添加到对话。查词用有效表达（补残缺词边界、去词外标点），
// 翻译与附加用原始选区（不改写）；选区形成即固定候选（文本、来源、位置与
// 局部上下文）。来源、轻提示与「继续问」由调用方注入，跳过条件可扩展
// （YouTube 用它排除字幕栏等自身 UI 内的选区）。
import { brandTokens, brandControls, CHAT_ADD_ICON, CHAT_ADD_BUTTON_STYLE } from './brand';
import { classifySelection, detectTextLanguage, effectiveLookupExpression, sentenceContaining } from './tokenize';
import { rangeOffsetsIn, inlineRunContainer } from './selection';
import { materialFromCandidate, type SelectionCandidate, type SourceDescriptor } from './chat';
import type { LookupPopup } from './lookupPopup';
import type { SelectionSnapshot } from './panel';

export const PILL_ID = 'blc-lookup-pill';

export interface PillSelectionInfo {
  /** 原始选区（翻译/附加用；不改写）。 */
  raw: string;
  kind: 'word' | 'phrase' | 'sentence';
  hasWord: boolean;
  /** 有效查词表达（补齐残缺词、去词外标点）；无法定位为 null。 */
  expression: string | null;
  /** 所在正文块的包含原句；无可靠原句为 null。 */
  sentence: string | null;
  blockText: string;
  source: SourceDescriptor | null;
  rect: DOMRect | null;
}

export interface SelectionPillDeps {
  send: <T>(msg: unknown) => Promise<T>;
  lookup: LookupPopup;
  translation: { open(snapshot: SelectionSnapshot, rect?: DOMRect | null): void; close(restoreFocus?: boolean): void };
  /** 选区来源（X 绑定被选帖子；YouTube 页面正文按当前地址的 article 源）。 */
  buildSource: () => SourceDescriptor | null;
  /** 页面内轻提示（网页与播放器样式不同，由调用方提供）。 */
  toast: (text: string) => void;
  /** 词卡「继续问」：附加词卡表达与可靠原句（可带已有释义），不发新查询。 */
  onContinueAsk?: (ctx: { snapshot: { expression: string; sentence?: string }; definition: string | null }) => void;
  /** 额外跳过条件：自身其它 UI（如字幕栏、选区操作条、词卡）内的选区不产生入口。 */
  skipSelection?: (sel: Selection) => boolean;
}

function editableTarget(sel: Selection): boolean {
  const node = sel.anchorNode;
  const el =
    node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
  if (!el) return true;
  return !!el.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]',
  );
}

export function createSelectionPill(deps: SelectionPillDeps) {
  const { send, lookup, translation } = deps;

  let dismissedRange: Range | null = null;
  let dismissedText = '';
  let selectionTimer: ReturnType<typeof setTimeout> | null = null;
  let currentInfo: PillSelectionInfo | null = null;
  let pushedCandidateKey = '';

  const sameDismissedSelection = () => {
    const s = document.getSelection();
    if (!s?.rangeCount || !dismissedRange) return false;
    const r = s.getRangeAt(0);
    return s.toString() === dismissedText && r.startContainer === dismissedRange.startContainer &&
      r.endContainer === dismissedRange.endContainer && r.startOffset === dismissedRange.startOffset && r.endOffset === dismissedRange.endOffset;
  };
  const dismissSelection = () => {
    const s = document.getSelection();
    dismissedRange = s?.rangeCount ? s.getRangeAt(0).cloneRange() : null;
    dismissedText = s?.toString() ?? '';
    if (selectionTimer) clearTimeout(selectionTimer);
    remove();
  };

  function blockElementOf(node: Node | null): Element | null {
    // 通用文本块检测（见 shared/selection.ts）：不依赖语义标签清单，
    // X / YouTube 页面正文等 div 结构同样得到正确的块
    return inlineRunContainer(node);
  }

  function evaluate(): PillSelectionInfo | null {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    if (editableTarget(sel)) return null;
    if (sel.anchorNode?.parentElement?.closest('#pd-floating-panel,#pd-translation')) return null;
    if (deps.skipSelection?.(sel)) return null;
    // 原始选区不改写（保留换行与大小写）；分类与展示在各自层面处理空白
    const raw = sel.toString().trim();
    if (!raw || raw.length > 20000) return null;
    let rect: DOMRect | null = null;
    try {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch {
      /* ignore */
    }
    const range = sel.getRangeAt(0);
    const startBlock = blockElementOf(range.startContainer);
    const endBlock = blockElementOf(range.endContainer);
    const blockText = (startBlock?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const lang = detectTextLanguage(raw) ?? detectTextLanguage(blockText) ?? 'en';
    // 未跨正文块时才有词/短语分类；跨块（或选区落在无块元素文本上）按句段处理
    const crossesBlock = !startBlock || startBlock !== endBlock;
    const cls = classifySelection(raw, lang, { crossesBlock });
    let expression: string | null = null;
    let sentence: string | null = null;
    if (!crossesBlock && startBlock) {
      const offsets = rangeOffsetsIn(startBlock, range);
      if (offsets && offsets.start <= offsets.end && offsets.end <= offsets.text.length) {
        // 偏移基于块内原始文本（未做空白归一），补词与原句都用这份定位。
        // 有效表达对所有分类计算：词/短语整体为查词表达，句段用作翻译卡的
        // 首尾清洗（补齐首尾残缺词、去词外标点；内部保持原文）。
        expression = effectiveLookupExpression(offsets.text, offsets.start, offsets.end, lang)?.expression ?? null;
        sentence = sentenceContaining(offsets.text, offsets.start, offsets.end);
      }
    }
    return {
      raw,
      kind: cls.kind,
      hasWord: cls.hasWord,
      expression,
      sentence,
      blockText: blockText.slice(0, 600),
      source: deps.buildSource(),
      rect,
    };
  }

  // ---- 查词入口（pill：分类驱动按钮 + 添加到对话） -----------------------------

  function ensureHost(): HTMLElement {
    let host = document.getElementById(PILL_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = PILL_ID;
      // 挂在文档最前：置于页面 AX 树开头，避免被大页面的元素截断隐藏
      document.documentElement.prepend(host);
      const root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
        ${brandTokens}:host { font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif; display:flex; gap:4px; padding:4px; background:var(--pd-paper); border:1px solid var(--pd-line);border-radius:8px;box-shadow:var(--pd-shadow) }
        ${brandControls}${CHAT_ADD_BUTTON_STYLE}
        button { min-height:32px;border:0;background:transparent; } button:hover {background:var(--pd-selected)} [hidden] { display:none!important; }
      `;
      root.appendChild(style);
      const btn = document.createElement('button');
      btn.textContent = '查词';
      btn.id = 'lookup';
      root.appendChild(btn);
      const translate = document.createElement('button');
      translate.id = 'translate'; translate.textContent = '翻译'; root.append(translate);
      translate.addEventListener('click', () => {
        const info = evaluate() ?? currentInfo;
        if (!info) return;
        dismissSelection();
        lookup.close();
        // 卡片展示与翻译请求同一文本：词/短语/句段首尾均用补全/清洗后的
        // 有效表达（残缺词补齐、去词外标点；句段内部保持原文）
        translation.open({ text: info.expression ?? info.raw, url: location.href, title: document.title }, info.rect);
        remove();
      });
      const chat = document.createElement('button');
      chat.id = 'chat';
      chat.className = 'blc-chat-add';
      chat.title = '添加到对话';
      chat.setAttribute('aria-label', '添加到对话');
      chat.innerHTML = CHAT_ADD_ICON;
      root.append(chat);
      chat.addEventListener('click', () => {
        const info = evaluate() ?? currentInfo;
        if (info) void attach(info);
      });
      // mousedown 阻止默认，避免点击入口时选区被清除
      host.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        const info = evaluate() ?? currentInfo;
        if (info) openLookup(info);
      });
    }
    return host;
  }

  function show(info: PillSelectionInfo): void {
    currentInfo = info;
    const host = ensureHost();
    // 分类表：word=查词+对话；phrase=查词+翻译+对话；sentence/无有效表达=翻译+对话
    host.shadowRoot!.querySelector<HTMLElement>('#lookup')!.hidden = info.kind === 'sentence' || !info.hasWord;
    host.shadowRoot!.querySelector<HTMLElement>('#translate')!.hidden = info.kind === 'word';
    const r = info.rect;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = r && r.width >= 0 ? r.left + r.width / 2 : vw / 2;
    let y = r ? r.bottom + 6 : vh / 2;
    x = Math.min(Math.max(x, 8), vw - 60);
    y = Math.min(Math.max(y, 8), vh - 36);
    host.style.position = 'fixed';
    host.style.left = `${Math.round(x - 24)}px`;
    host.style.top = `${Math.round(y)}px`;
    host.style.zIndex = '2147483646';
    pushCandidate(info);
  }

  /** 有效阅读选区形成时固定候选（文本、来源、位置与局部上下文）。 */
  function pushCandidate(info: PillSelectionInfo): void {
    if (!info.source) return;
    const key = `${info.source.sourceKey}|${info.raw}`;
    if (key === pushedCandidateKey) return;
    pushedCandidateKey = key;
    void send({ type: 'selectionCandidateSet', candidate: candidateOf(info) });
  }

  function candidateOf(info: PillSelectionInfo, definition?: string): SelectionCandidate | null {
    if (!info.source) return null;
    return {
      at: Date.now(),
      pageUrl: location.href,
      text: info.raw,
      kind: info.kind,
      expression: info.kind === 'sentence' ? null : info.expression,
      lang: detectTextLanguage(info.raw) ?? detectTextLanguage(info.blockText) ?? undefined,
      ...(info.sentence ? { sentence: info.sentence } : {}),
      source: info.source,
      ...(definition ? { definition } : {}),
    };
  }

  /** 点击「添加到对话」：直接附加并进入当前聊天；不先查词、不自动发送。 */
  async function attach(info: PillSelectionInfo): Promise<void> {
    const candidate = candidateOf(info);
    if (!candidate || !info.source) {
      deps.toast('当前选区无法附加，请重新选择');
      return;
    }
    const built = materialFromCandidate(candidate);
    if (!built) { deps.toast('当前选区无法附加，请重新选择'); return; }
    const r = await send<{ ok: boolean; panelOpened?: boolean }>({
      type: 'chatEnsure',
      source: info.source,
      material: built.material,
      quote: built.quote,
      openPanel: true,
    });
    remove();
    // 材料附加成功与面板打开成功分别判断；写入失败不提示已附加
    if (!r?.ok) { deps.toast('附加失败，请重试'); return; }
    if (!r.panelOpened) deps.toast('已附加到当前对话：点扩展图标打开侧栏继续');
  }

  function remove(): void {
    currentInfo = null;
    document.getElementById(PILL_ID)?.remove();
  }

  function openLookup(info: PillSelectionInfo): void {
    dismissSelection();
    translation.close();
    const expression = info.expression ?? info.raw;
    void send({ type: 'selectionSnapshot', snapshot: { text: expression, url: location.href, title: document.title } });
    lookup.open({
      snapshot: {
        source: 'web',
        expression,
        sentence: info.sentence ?? info.blockText,
        url: location.href,
        title: document.title,
        // 局部语言初判（选区优先，其次所在原句）；无法判定则缺省（待确认由词卡纠正）
        lang: detectTextLanguage(expression) ?? detectTextLanguage(info.sentence ?? info.blockText) ?? undefined,
      },
      onContinueAsk: deps.onContinueAsk,
    });
    remove();
  }

  function refresh(): void {
    const info = evaluate();
    if (document.getSelection()?.isCollapsed) dismissedRange = null;
    if (sameDismissedSelection()) { remove(); return; }
    if (!info) {
      remove();
      return;
    }
    show(info);
  }

  function onMaybeSelection(): void {
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(refresh, 250);
  }

  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.shiftKey) onMaybeSelection();
  };

  document.addEventListener('selectionchange', onMaybeSelection, true);
  document.addEventListener('mouseup', onMaybeSelection, true);
  document.addEventListener('keyup', onKeyUp, true);

  return {
    /** 当前选区信息（供外部即时读取）。 */
    evaluate,
    remove,
    /** 站内导航（SPA）后清理旧浮条与候选去重键。 */
    reset() {
      remove();
      pushedCandidateKey = '';
    },
    dispose() {
      if (selectionTimer) clearTimeout(selectionTimer);
      remove();
      document.removeEventListener('selectionchange', onMaybeSelection, true);
      document.removeEventListener('mouseup', onMaybeSelection, true);
      document.removeEventListener('keyup', onKeyUp, true);
    },
  };
}
