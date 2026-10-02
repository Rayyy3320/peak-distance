import { brandTokens } from './brand';
import type { DictionarySource } from '@/lib/onlineDictionary';
// 共用查词弹窗（网页与 YouTube 字幕共用，M1 行为原样提取）：
//   Shadow DOM 卡片、宿主 fixed+inset:0+满 z-index（不被页面悬浮层盖住）、
//   标题行拖动、Esc 关闭、快照在打开时固定（保存/释义都用这一份）、
//   旧请求按 nonce 丢弃、保存结果以数据库响应为准（非乐观）。
// 来源差异（网页 URL / 视频轨道+时间）只体现在 snapshot 类型与 subLine 附加行。

import type {
  BgcError,
  EntryView,
  LookupResult,
  OnlineLookupResult,
  SaveResult,
} from '@/shared/messages';
import {
  normalizeExpression,
  type LookupSnapshot,
  type LearningResult,
  type ContextExplanation,
  type VocabStatus,
} from '@/shared/vocab';

export const POPUP_ID = 'blc-lookup-popup';

export interface PopupOpenArgs {
  snapshot: LookupSnapshot;
  anchor?: HTMLElement;
  compact?: boolean;
  /** 上下文下的附加行（视频：时间 + 相邻字幕）。 */
  subLine?: string;
  /** 弹窗关闭后回调（视频：恢复播放判定在此实现）。 */
  onClose?: () => void;
  /** M5「继续问」：转入侧栏问答并带入引用（提供时才显示该按钮）。 */
  onContinueAsk?: (ctx: {
    snapshot: LookupSnapshot;
    definition: string | null;
    subLine?: string;
  }) => void;
}

export interface LookupPopup {
  open(args: PopupOpenArgs): void;
  /** silent：不触发 onClose（页面卸载 / 主动清理）。 */
  close(silent?: boolean): void;
  isOpen(): boolean;
  expand(): void;
  isCompact(): boolean;
  host(): HTMLElement | null;
}

interface PinnedState {
  anchor?: HTMLElement;
  compact?: boolean;
  snapshot: LookupSnapshot;
  subLine: string | undefined;
  nonce: number;
  onClose: (() => void) | undefined;
  onContinueAsk: PopupOpenArgs['onContinueAsk'];
  savedContextId: number | null;
  definition: string | null;
  result?: LearningResult;
  explanation?: ContextExplanation;
  source?: DictionarySource;
  lookupRequest?: string;
  aiRequest?: string;
  aiError?: string;
  note: string | undefined;
  lookupError: string | undefined;
  status: VocabStatus | null;
  entryExists: boolean;
}

const STATUS_LABEL: Record<VocabStatus, string> = {
  saved: '已收藏',
  learning: '在学',
  known: '已掌握',
};

const ERROR_LABEL: Record<string, string> = {
  'invalid-config': 'AI 配置无效，请在设置中检查接口与模型',
  permission: '请在设置中重新保存 AI 配置并允许访问服务地址',
  'no-key': '尚未配置 API key，可先保存原文',
  auth: 'API key 无效或无权限',
  'rate-limit': '请求过于频繁，稍后再试',
  network: '网络错误',
  http: '服务返回异常',
  'bad-response': '服务响应无法解析',
};

export function createLookupPopup(opts: {
  send: <T>(msg: unknown) => Promise<T>;
  /** 宿主挂载点（默认 documentElement；全屏时由调用方移动节点）。 */
  mountParent?: () => HTMLElement | null;
}): LookupPopup {
  const send = opts.send;
  let pinned: PinnedState | null = null;
  let nonce = 0;
  let requestCounter = 0;
  // 拖动后的卡片位置（null = 仍锚定右上角），跨渲染保留
  let anchorRect: DOMRect | null = null;
  let dragPos: { x: number; y: number } | null = null;

  function applyDragPos(card: HTMLDivElement): void {
    if (pinned?.anchor) {
      if (pinned.anchor.isConnected) anchorRect = pinned.anchor.getBoundingClientRect();
      const r = anchorRect; if (!r) return;
      const panel = document.fullscreenElement?.querySelector<HTMLElement>('#blc-learning-panel');
      const inSubtitles = (pinned.anchor.getRootNode() as ShadowRoot).host?.id === 'blc-subs';
      const right = panel && inSubtitles ? panel.getBoundingClientRect().left - 8 : innerWidth;
      card.style.maxWidth = `${Math.max(160, right - 16)}px`;
      const width = card.offsetWidth, height = card.offsetHeight;
      card.style.right = 'auto';
      card.style.left = `${Math.max(8, Math.min(r.left, right - width - 8))}px`;
      card.style.top = `${Math.max(8, Math.min(r.top >= height + 8 ? r.top - height - 6 : r.bottom + 6, innerHeight - height - 8))}px`;
      return;
    }
    if (dragPos) {
      card.style.left = `${dragPos.x}px`;
      card.style.top = `${dragPos.y}px`;
      card.style.right = 'auto';
    }
  }

  function ensurePopupHost(): HTMLDivElement {
    let host = document.getElementById(POPUP_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = POPUP_ID;
      // 宿主必须是定位元素且给满 z-index，否则 prepend 到 DOM 最前意味着
      // 绘制顺序垫底，会被页面的悬浮层盖住。
      const parent = opts.mountParent?.() ?? document.documentElement;
      parent.prepend(host);
      host.style.position = 'fixed';
      host.style.inset = '0';
      host.style.zIndex = '2147483647';
      host.style.pointerEvents = 'none';
      const root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
        ${brandTokens}:host { font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif; text-shadow:none; letter-spacing:normal; text-transform:none; color:var(--pd-ink); }
        * { box-sizing:border-box; }
        ::selection { background:var(--pd-selected); color:var(--pd-ink); }
        .card {
          position: fixed; top: 64px; right: 16px; width: min(420px, calc(100vw - 32px));
          max-height: min(70vh, 560px); overflow: auto;
          background: linear-gradient(#f7f4ecd9,#f7f4ecd9),url('${browser.runtime.getURL('/brand/paper-tile.png')}') center/620px; color: var(--pd-ink); border-radius: 12px;
          box-shadow: var(--pd-shadow);
          font: 14px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
          padding: 20px; box-sizing: border-box;
          pointer-events: auto; scrollbar-width:thin; scrollbar-color:var(--pd-line) transparent;
        }
        button,input,select { font:inherit; color:inherit; }
        button:focus-visible, select:focus-visible, a:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--pd-blue); outline-offset: 2px; }
        .card.compact { width: min(290px, calc(100vw - 16px)); }
        .compact .ctx, .compact .sub { display: none; }
        .compact .feedback:empty { display: none; }
        .card.dragging { user-select: none; }
        .expr { font:600 26px/1.35 Georgia,'Times New Roman',serif; margin: 0 0 10px; word-break: break-word;
                cursor: grab; touch-action: none; }
        .chip { display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 999px;
                font:12px/1.6 system-ui; vertical-align: 3px; }
        .chip.saved { background: var(--pd-selected); color: var(--pd-blue); }
        .chip.learning { background: #fef7e0; color: #b06000; }
        .chip.known { background: #e6f4ea; color: #137333; }
        .ctx { color: var(--pd-muted); font-size: 13px; margin: 4px 0 8px;
               display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .sub { color: var(--pd-muted); font-size: 12px; margin: 0 0 16px; }
        .def-box { border-top: 1px solid var(--pd-line); padding-top: 12px; margin-top: 12px; }
        .def-state { color: var(--pd-muted); }
        .def-label { font-size: 12px; color: var(--pd-muted); margin: 0 0 8px; }
        .def-text { margin: 0; white-space: pre-wrap; word-break: break-word; }
        .sense {margin:10px 0 14px;overflow-wrap:anywhere}
        .sense label {display:flex;align-items:baseline;gap:8px;cursor:pointer;font-size:15px;line-height:1.7}
        .sense input {accent-color:var(--pd-blue);margin:0;flex:none}
        .example {font:17px/1.65 Georgia,serif;margin:12px 0 6px}
        details {margin-top:8px} summary {cursor:pointer;color:var(--pd-muted);font-size:13px;padding:6px 0}
        audio {width:100%;margin-top:8px}
        .link-btn {cursor:pointer;color:var(--pd-blue);font:13px/1.5 system-ui;border:0;background:transparent;border-radius:6px;padding:6px 8px;min-height:32px}
        .link-btn:hover {background:var(--pd-selected)}
        .row { margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .sources {padding-top:12px;border-top:1px solid var(--pd-line);gap:4px;margin-bottom:8px}
        .sources a {display:inline-flex;align-items:center;gap:4px;min-height:34px;padding:4px 7px;border-radius:6px;color:var(--pd-muted);font:13px/1.5 system-ui;text-decoration:none}
        .sources a:hover {background:var(--pd-selected);color:var(--pd-blue)}
        .sources a svg {width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
        button.act {box-sizing:border-box;cursor:pointer;padding:7px 8px;border:1px solid transparent;min-height:36px;border-radius:7px;font:13px/1.5 system-ui}
        button:disabled {opacity:.6;cursor:default}
        button.save { background: var(--pd-blue); color: var(--pd-surface); }
        button.save:hover { background: #1765cc; }
        button.ghost { background: transparent; color: var(--pd-ink); border-color:var(--pd-line); }
        button.ghost:hover { background: var(--pd-selected); }
        select {appearance:none;cursor:pointer;max-width:100%;min-height:34px;padding:6px 30px 6px 10px;border:1px solid #b9b4a8;border-radius:7px;font:13px/1.5 system-ui;background:var(--pd-surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%2359636b' stroke-width='1.5'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E") right 8px center/16px no-repeat}
        select:hover {border-color:var(--pd-muted)}
        option {background:var(--pd-surface);color:var(--pd-ink)}
        @media(max-width:359px) {.sources select {width:100%;margin-bottom:4px}}
        .feedback { font-size: 12px; margin-top: 8px; }
        .feedback:empty {display:none}
        .feedback.ok { color: #137333; }
        .feedback.err { color: #d93025; }
        .err-kind { font-size: 11px; color: var(--pd-muted); margin-top: 2px; }
      `;
      root.appendChild(style);
      const body = document.createElement('div');
      body.className = 'card';
      root.appendChild(body);
      // 页面内点击弹窗本身不冒泡成“新选区”
      host.addEventListener('mousedown', (e) => e.stopPropagation());
      // 按住标题行（表达 + 状态 chip）拖动整卡。
      // 监听器在 shadow 边界外，e.target 已被 retarget 成 host，须用 composedPath 取真实目标。
      host.addEventListener('pointerdown', (e) => {
        const real = e.composedPath()[0] as Element | null;
        const header = real?.closest?.('.expr');
        const card = root.querySelector('.card') as HTMLDivElement | null;
        if (!header || !card || pinned?.anchor) return;
        e.preventDefault();
        card.classList.add('dragging');
        const startX = e.clientX;
        const startY = e.clientY;
        const rect = card.getBoundingClientRect();
        const originX = rect.left;
        const originY = rect.top;
        const onMove = (ev: PointerEvent) => {
          dragPos = {
            x: Math.min(Math.max(originX + ev.clientX - startX, 0), window.innerWidth - 80),
            y: Math.min(Math.max(originY + ev.clientY - startY, 0), window.innerHeight - 48),
          };
          applyDragPos(card);
        };
        const onUp = () => {
          card.classList.remove('dragging');
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
    }
    const host2 = document.getElementById(POPUP_ID)!;
    const card2 = host2.shadowRoot!.querySelector('.card') as HTMLDivElement;
    applyDragPos(card2);
    return card2;
  }

  function setFeedback(ok: boolean, text: string): void {
    const el = document
      .getElementById(POPUP_ID)
      ?.shadowRoot?.querySelector('#blc-feedback') as HTMLDivElement | undefined;
    if (el) {
      el.className = `feedback ${ok ? 'ok' : 'err'}`;
      el.textContent = text;
    }
  }

  function renderPopup(): void {
    if (!pinned) return;
    const body = ensurePopupHost();
    const p = pinned;
    body.classList.toggle('compact', !!p.compact);
    body.textContent = '';

    // 表达 + 状态
    const head = document.createElement('p');
    head.className = 'expr';
    head.textContent = p.snapshot.expression;
    if (p.status) {
      const chip = document.createElement('span');
      chip.className = `chip ${p.status}`;
      chip.textContent = STATUS_LABEL[p.status];
      head.appendChild(chip);
    }
    body.appendChild(head);

    // 原文上下文（视频 = 当前字幕；网页 = 所在正文片段）
    const ctx = document.createElement('div');
    ctx.className = 'ctx';
    ctx.textContent = p.snapshot.sentence || '（无上下文）';
    body.appendChild(ctx);

    if (p.subLine) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = p.subLine;
      body.appendChild(sub);
    }

    // 释义区
    const defBox = document.createElement('div');
    defBox.className = 'def-box';
    renderDefinition(defBox);
    body.appendChild(defBox);

    // 操作区
    const row = document.createElement('div');
    row.className = 'row';

    const save = document.createElement('button');
    save.className = 'act save';
    save.textContent = '保存';
    save.addEventListener('click', () => void doSave());
    row.appendChild(save);

    const master = document.createElement('button');
    master.className = 'act ghost';
    master.textContent = '已掌握';
    master.addEventListener('click', () => void doSave('known'));
    row.appendChild(master);

    if (!p.compact && typeof p.onContinueAsk === 'function') {
      const ask = document.createElement('button');
      ask.className = 'act ghost';
      ask.textContent = '继续问';
      ask.title = '带着这句原文转入侧栏问答';
      ask.addEventListener('click', () => {
        if (!pinned) return;
        p.onContinueAsk!({
          snapshot: p.snapshot,
          definition: p.explanation?.text ?? p.definition,
          subLine: p.subLine,
        });
      });
      row.appendChild(ask);
    }

    if (p.entryExists && !p.compact) {
      const sel = document.createElement('select');
      sel.className = 'status';
      sel.setAttribute('aria-label', '学习状态');
      for (const s of ['saved', 'learning', 'known'] as const) {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = STATUS_LABEL[s];
        if (p.status === s) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => void doStatus(sel.value as VocabStatus));
      row.appendChild(sel);
    }

    const close = document.createElement('button');
    close.className = 'act ghost';
    close.textContent = '关闭';
    close.addEventListener('click', () => closePopup());
    row.appendChild(close);
    body.appendChild(row);

    // 数据库结果的反馈（非乐观）
    const fb = document.createElement('div');
    fb.className = 'feedback';
    fb.id = 'blc-feedback';
    body.appendChild(fb);
    applyDragPos(body);
  }

  function renderDefinition(box: HTMLDivElement): void {
    if (!pinned) return;
    const p = pinned;
    const text = (value: string, cls = 'def-text') => {
      const n = document.createElement('p'); n.className = cls; n.textContent = value; box.appendChild(n); return n;
    };
    const button = (label: string, action: () => void) => {
      const b = document.createElement('button'); b.className = 'link-btn'; b.textContent = label; b.addEventListener('click', action); box.appendChild(b); return b;
    };
    if (p.compact) {
      if (p.result?.kind === 'dictionary') {
        const sense = p.result.entry.senses[0];
        text(`${sense?.partOfSpeech ?? ''} ${sense?.definition ?? ''}`);
        text(p.result.entry.source === 'youdao' ? '有道' : '剑桥英汉', 'def-label');
      } else if (p.result?.kind === 'translation') { text(p.result.text); text('翻译 · Google', 'def-label'); }
      else text(p.lookupError ? (p.lookupError === 'not-found' ? '未查到该表达' : '暂时无法查询') : '正在查询…', 'def-state');
      button('展开详情', () => { p.compact = false; renderPopup(); });
      return;
    }
    if (p.result?.kind === 'dictionary') {
      const entry = p.result.entry;
      text(`${entry.source === 'youdao' ? '有道' : '剑桥英汉'} · ${entry.headword}${entry.phonetic ? ` /${entry.phonetic}/` : ''}`, 'def-label');
      const renderSense = (index: number, parent: HTMLElement) => {
        const sense = entry.senses[index]!;
        const line = document.createElement('div'); line.className = 'sense';
        const select = document.createElement('input'); select.type = 'radio'; select.name = 'sense';
        select.checked = (p.result?.kind === 'dictionary' ? p.result.selectedSense ?? 0 : 0) === index;
        select.addEventListener('change', () => { if (p.result?.kind === 'dictionary') { p.result.selectedSense = index; p.definition = sense.definition; } });
        const label = document.createElement('label'); label.append(select, document.createTextNode(`${sense.partOfSpeech ?? ''} ${sense.definition}`)); line.appendChild(label);
        if (sense.example) { const ex = document.createElement('p'); ex.className = 'example'; ex.textContent = sense.example; line.appendChild(ex); }
        if (sense.exampleTranslation) { const ex = document.createElement('p'); ex.className = 'def-label'; ex.textContent = sense.exampleTranslation; line.appendChild(ex); }
        parent.appendChild(line);
      };
      renderSense(0, box);
      if (entry.senses.length > 1) {
        const more = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = '其它义项'; more.appendChild(summary);
        for (let i = 1; i < entry.senses.length; i++) renderSense(i, more);
        box.appendChild(more);
      }
      if (entry.forms?.length) text(`来源词形：${entry.forms.join('、')}`, 'def-label');
      if (entry.lemmaCandidates?.length) text(`原形候选：${entry.lemmaCandidates.join('、')}`, 'def-label');
      if (entry.audioUrl && /^https:\/\//.test(entry.audioUrl)) { const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none'; audio.src = entry.audioUrl; box.appendChild(audio); }
    } else if (p.result?.kind === 'translation') {
      text('翻译 · Google', 'def-label'); text(p.result.text);
    } else if (p.lookupError) {
      text(p.lookupError === 'not-found' ? '未查到该表达' : '暂时无法查询', 'def-state');
      button('重试', () => void requestLookup(p.source));
    } else text('正在查询释义…（此时也可保存）', 'def-state');
    const row = document.createElement('div'); row.className = 'row sources';
    const choose = document.createElement('select'); choose.setAttribute('aria-label', '词典');
    for (const [value, label] of [['', '首选词典'], ['youdao', '有道'], ['cambridge', '剑桥英汉']]) { const opt = document.createElement('option'); opt.value = value!; opt.textContent = label!; choose.appendChild(opt); }
    choose.value = p.source ?? ''; choose.addEventListener('change', () => void requestLookup(choose.value as DictionarySource || undefined)); row.appendChild(choose);
    const source = p.result?.kind === 'dictionary' ? p.result.entry.source : p.source ?? 'youdao';
    const link = document.createElement('a'); link.textContent = '查看原文'; link.target = '_blank'; link.rel = 'noopener';
    link.href = p.result?.kind === 'dictionary' ? p.result.entry.url : source === 'youdao' ? `https://dict.youdao.com/w/${encodeURIComponent(p.snapshot.expression)}/` : `https://dictionary.cambridge.org/dictionary/english-chinese-simplified/${encodeURIComponent(p.snapshot.expression.replace(/\s+/g, '-'))}`;
    row.appendChild(link);
    const oxford = document.createElement('a'); oxford.textContent = '牛津原站'; oxford.href = `https://www.oxfordlearnersdictionaries.com/definition/english/${encodeURIComponent(p.snapshot.expression.replace(/\s+/g, '-'))}`; oxford.target = '_blank'; oxford.rel = 'noopener'; row.appendChild(oxford);
    for (const sourceLink of [link, oxford]) {
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 16 16'); icon.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M6 3H3v10h10v-3M9 3h4v4M7 9l6-6');
      icon.appendChild(path); sourceLink.appendChild(icon);
    }
    box.appendChild(row);
    const ai = button(p.aiRequest ? '正在解释语境…' : '解释语境', () => void explainContext()); ai.disabled = !!p.aiRequest;
    if (p.explanation) { text('AI 语境解释 · 当前原句', 'def-label'); text(p.explanation.text); }
    if (p.aiError) { text(ERROR_LABEL[p.aiError] ?? '解释失败，请重试', 'def-state'); if (p.aiError === 'no-key') button('打开设置填写 API key', () => void send({ type: 'openSettings' })); }
  }

  // ---- 与 background 的交互 ---------------------------------------------------

  async function queryStatus(): Promise<void> {
    if (!pinned) return;
    const my = pinned.nonce;
    const key = normalizeExpression(pinned.snapshot.expression);
    const r = await send<{ ok: boolean; entry?: EntryView | null }>({
      type: 'getEntry',
      key,
    });
    if (!pinned || pinned.nonce !== my) return; // 弹窗已被替换
    if (r?.ok && r.entry) {
      pinned.status = r.entry.status;
      pinned.entryExists = true;
      const snap = pinned.snapshot;
      const saved = r.entry.contexts.find(c => c.sentence.replace(/\s+/g, ' ').trim() === snap.sentence.replace(/\s+/g, ' ').trim() &&
        (snap.source === 'video' ? c.video?.videoId === snap.video.videoId && c.video.trackId === snap.video.trackId && c.video.startMs === snap.video.startMs : c.url === snap.url));
      if (saved) { pinned.savedContextId = saved.id; pinned.explanation = saved.explanation; void backfill(pinned); }
      renderPopup();
    }
  }

  async function backfill(p: PinnedState): Promise<void> {
    if (p.savedContextId !== null) await send({ type: 'backfillResult', contextId: p.savedContextId, result: p.result, explanation: p.explanation });
  }

  async function requestLookup(source?: DictionarySource): Promise<void> {
    if (!pinned) return;
    const p = pinned;
    if (p.lookupRequest) void send({ type: 'cancelOnline', requestId: p.lookupRequest });
    const requestId = `lookup-${Date.now()}-${++requestCounter}`;
    p.lookupRequest = requestId; p.source = source; p.lookupError = undefined; p.result = undefined; p.definition = null;
    renderPopup();
    const r = await send<OnlineLookupResult>({ type: 'lookup', snapshot: p.snapshot, source, requestId });
    if (p.lookupRequest !== requestId) return;
    p.lookupRequest = undefined;
    if (r?.ok) {
      p.result = r.result;
      p.definition = r.result.kind === 'dictionary' ? r.result.entry.senses[0]?.definition ?? null : r.result.text;
      await backfill(p);
    } else p.lookupError = r && !r.ok ? r.error : 'network';
    if (pinned === p) renderPopup();
  }

  async function explainContext(): Promise<void> {
    if (!pinned || pinned.aiRequest) return;
    const p = pinned;
    p.aiRequest = `lookup-${Date.now()}-${++requestCounter}`; p.aiError = undefined;
    renderPopup();
    const r = await send<LookupResult>({ type: 'explainContext', snapshot: p.snapshot, requestId: p.aiRequest });
    p.aiRequest = undefined;
    if (r?.ok) {
      p.explanation = { kind: 'ai-context', source: r.provider === 'deepseek' ? 'deepseek' : 'ai', provider: r.provider, model: r.model, text: [r.definition, r.note].filter(Boolean).join('\n'), sentence: p.snapshot.sentence, neighbors: p.snapshot.source === 'video' ? p.snapshot.neighbors : undefined };
      await backfill(p);
    } else p.aiError = r && !r.ok ? r.error : 'network';
    if (pinned === p) renderPopup();
  }

  async function doSave(status?: VocabStatus): Promise<void> {
    if (!pinned) return;
    const p = pinned;
    setFeedback(false, '保存中…');
    const r = await send<SaveResult | BgcError>({
      type: 'save',
      snapshot: p.snapshot,
      status,
      result: p.result,
      explanation: p.explanation,
    });
    if (r && r.ok) {
      p.savedContextId = r.contextId;
      await backfill(p);
      if (pinned !== p) return;
      p.status = r.status;
      p.entryExists = true;
      // 先重建卡片再写反馈：renderPopup 会清空卡片内容
      renderPopup();
      setFeedback(true, r.appended ? '已保存 ✓' : '该上下文已存在，未重复追加');
    } else {
      setFeedback(false, '保存失败，请重试');
    }
  }

  async function doStatus(status: VocabStatus): Promise<void> {
    if (!pinned) return;
    const p = pinned;
    const key = normalizeExpression(p.snapshot.expression);
    const r = await send<{ ok: boolean }>({ type: 'setStatus', key, status });
    if (pinned !== p) return;
    if (r?.ok) {
      pinned.status = status;
      renderPopup();
      setFeedback(true, '状态已更新');
    } else {
      setFeedback(false, '状态更新失败');
    }
  }

  // ---- 开 / 关 -----------------------------------------------------------------

  function closePopup(silent = false): void {
    document.getElementById(POPUP_ID)?.remove();
    for (const requestId of [pinned?.lookupRequest, pinned?.aiRequest]) if (requestId) void send({ type: 'cancelOnline', requestId });
    const cb = pinned?.onClose;
    pinned = null;
    if (!silent) cb?.();
  }

  document.addEventListener('pointerdown', e => {
    if (!pinned?.anchor) return;
    const path = e.composedPath();
    const switchingWord = path.some(n => n instanceof Element && n.matches('.w,[data-word]'));
    if (!switchingWord && !path.includes(pinned.anchor) && !path.includes(document.getElementById(POPUP_ID)!)) closePopup();
  }, true);
  window.addEventListener('resize', () => { const card = document.getElementById(POPUP_ID)?.shadowRoot?.querySelector<HTMLDivElement>('.card'); if (card) applyDragPos(card); });
  document.addEventListener('scroll', () => {
    if (!pinned?.anchor) return;
    const card = document.getElementById(POPUP_ID)?.shadowRoot?.querySelector<HTMLDivElement>('.card');
    if (card) applyDragPos(card);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById(POPUP_ID)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closePopup();
    }
  }, true);

  return {
    open(args: PopupOpenArgs): void {
      if (pinned) closePopup(true);
      nonce++; anchorRect = null;
      pinned = {
        snapshot: args.snapshot,
        anchor: args.anchor, compact: args.compact,
        subLine: args.subLine,
        nonce,
        onClose: args.onClose,
        onContinueAsk: args.onContinueAsk,
        savedContextId: null,
        definition: null,
        note: undefined,
        lookupError: undefined,
        status: null,
        entryExists: false,
      };
      renderPopup();
      void queryStatus();
      void requestLookup();
    },
    isCompact() { return !!pinned?.compact; },
    expand() { if (pinned) { pinned.compact = false; renderPopup(); } },
    close(silent) {
      closePopup(silent);
    },
    isOpen() {
      return pinned !== null;
    },
    host() {
      return document.getElementById(POPUP_ID);
    },
  };
}
