import { brandTokens, brandControls } from './brand';
import type { Cue } from './protocol';
import type { Settings } from './settings';
import type { EntryView } from './messages';
import { cueWords, fmtClock } from './cues';
import { sentenceId, type SavedSentence, type VideoRef } from './vocab';
import { normalizeExpressionInLanguage } from './languages';

export interface WorkspaceState {
  videoId: string;
  videoRef: VideoRef;
  cues: Cue[];
  current: number;
  translations: Map<number, string>;
  statuses: Map<string, string>;
  sentences: SavedSentence[];
  entries: EntryView[];
  notice: string;
  chinese: boolean;
  /** 当前轨道语言（词次分词与查词边界用；缺省按英文兼容） */
  trackLang?: string;
}

const css = `
  ${brandTokens}:host { display:block;height:100%;min-height:0;color-scheme:light; font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:var(--pd-ink); } ${brandControls}
  * { box-sizing:border-box; } [hidden] { display:none!important; }
  button,select { font:inherit; color:inherit; border:1px solid var(--pd-line); background:var(--pd-surface); border-radius:5px; padding:5px 9px; cursor:pointer; }
  button:hover { background:var(--pd-selected); } button:focus-visible,select:focus-visible,.w:focus-visible { outline:2px solid var(--pd-blue); outline-offset:2px; }
  .panel { background:var(--pd-surface); border:1px solid var(--pd-line); border-radius:8px; height:100%; display:flex; flex-direction:column; overflow:hidden; }
  .head,.controls { display:flex; gap:6px; padding:8px; align-items:center; flex-wrap:wrap; border-bottom:1px solid var(--pd-line); }
  .head button { background:transparent; border-color:transparent; } .head button.active { border-bottom-color:var(--pd-blue); color:var(--pd-blue); }
  .head .close { margin-left:auto; } .body { overflow:auto; min-height:0; flex:1; overscroll-behavior:contain; }
  .row { padding:12px; border-bottom:1px solid var(--pd-line); } .row.current { background:var(--pd-selected); box-shadow:inset 3px 0 var(--pd-blue); }
  .en { font-size:16px; overflow-wrap:anywhere; } .zh { color:var(--pd-muted); margin-top:5px; }
  .meta { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-top:8px; color:var(--pd-muted); font-size:12px; }
  .meta button { font-size:12px; padding:2px 7px; } .muted { color:var(--pd-muted); padding:12px; }
  .w { cursor:pointer; border-radius:3px; } .w:hover { background:var(--pd-selected); }
  .saved { border-bottom:2px solid var(--pd-blue); } .learning { border-bottom:2px solid var(--pd-gold); } .known { color:var(--pd-muted); }
  .word { font-size:16px; } details { margin-top:8px; } summary { cursor:pointer; color:var(--pd-blue); }
`;

export function createYoutubeWorkspace(actions: {
  bindWords: (host: HTMLElement) => void;
  words: (parent: HTMLDivElement, text: string) => void;
  seek: (index: number, play?: boolean) => void;
  lookup: (word: string, index: number, anchor: HTMLElement) => void;
  save: (index: number) => void;
  remove: (id: string) => void;
  ask: (index: number) => void;
  open: (view: 'list' | 'sentences' | 'review') => void;
  status: (key:string, status:string) => void;
}, mount: HTMLElement) {
  const host = document.createElement('aside'); host.id = 'blc-learning-panel';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${css}</style><section class="panel" aria-label="视频学习侧栏"><div class="head"></div><div class="controls"></div><div class="body"></div></section>`;
  const head = root.querySelector<HTMLDivElement>('.head')!;
  const controls = root.querySelector<HTMLDivElement>('.controls')!;
  const body = root.querySelector<HTMLDivElement>('.body')!;
  let state: WorkspaceState;
  let follow = true;
  const scrollPositions = new Map<string, number>();
  let tab = 'subs', renderedTab = '', lastCues: Cue[] | null = null;
  let lastSentences: SavedSentence[] | null = null, lastEntries: EntryView[] | null = null;
  let lastStatuses: Map<string, string> | null = null;
  let lastCurrent = -1;
  const button = (parent: HTMLElement, label: string, action: () => void) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', action); parent.append(b); return b;
  };
  for (const [id, label] of [['subs', '字幕'], ['words', '词语'], ['saved', '已保存']]) {
    const b = button(head, label!, () => { scrollPositions.set(tab, body.scrollTop); tab = id!; render(); }); b.dataset.tab = id;
  }

  button(controls, '上一句', () => actions.seek(Math.max(0, state.current - 1)));
  button(controls, '重播', () => actions.seek(Math.max(0, state.current), true));
  button(controls, '下一句', () => actions.seek(Math.min(state.cues.length - 1, state.current + 1)));
  controls.querySelectorAll('button').forEach(b => b.dataset.playback = '');
  const back = button(controls, '回到当前句', () => { follow = true; highlight(true); });
  back.hidden = true;
  for (const event of ['wheel', 'touchmove', 'pointerdown']) body.addEventListener(event, () => { follow = false; back.hidden = false; }, { passive: true });
  host.addEventListener('keydown', e => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(e.key)) { follow = false; back.hidden = false; }
  });
  actions.bindWords(host);

  mount.append(host);
  function line(index: number) {
    const cue = state.cues[index]!;
    const row = document.createElement('div'); row.className = 'row'; row.dataset.cue = String(index);
    const en = document.createElement('div'); en.className = 'en'; actions.words(en, cue.text); row.append(en);
    const zh = document.createElement('div'); zh.className = 'zh'; row.append(zh);
    return row;
  }
  function meta(row: HTMLElement) { const el = document.createElement('div'); el.className = 'meta'; row.append(el); return el; }
  function empty(text: string) { const el = document.createElement('p'); el.className = 'muted'; el.textContent = text; body.append(el); }
  function render() {
    if (!state) return;
    head.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    controls.hidden = tab !== 'subs';
    const rebuild = renderedTab !== tab || lastCues !== state.cues ||
      (tab !== 'words' && lastSentences !== state.sentences) || (tab === 'saved' && lastEntries !== state.entries);
    if (rebuild) {
      const top = renderedTab === tab ? body.scrollTop : scrollPositions.get(tab) ?? 0;
      body.replaceChildren();
      if (tab === 'subs') {
        if (!state.cues.length) empty(state.notice || '正在读取字幕…');
        state.cues.forEach((cue, i) => {
          const row = line(i), tools = meta(row);
          button(tools, fmtClock(cue.start), () => actions.seek(i)).dataset.playback = '';
          const saved = state.sentences.some(s => s.id === sentenceId({ ...state.videoRef, startMs: cue.start }, cue.text));
          button(tools, saved ? '已收藏' : '收藏整句', () => actions.save(i));
          button(tools, '问 AI', () => actions.ask(i)); body.append(row);
        });
      } else if (tab === 'words') {
        if (!state.cues.length) empty(state.notice || '字幕尚未就绪');
        for (const item of cueWords(state.cues, state.trackLang || undefined)) {
          const row = document.createElement('div'); row.className = 'row';
          const word = button(row, `${item.word} · ${item.count} 次`, () => { details.open = true; actions.lookup(item.word, item.positions[0]!, word); });
          word.className = 'word'; word.dataset.word = item.word;
          const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = '字幕位置'; details.append(summary);
          for (const i of item.positions) {
            const cue = state.cues[i]!, place = meta(details);
            button(place, fmtClock(cue.start), () => actions.seek(i)).dataset.playback = '';
            const lookup = button(place, cue.text, () => actions.lookup(item.word, i, lookup)); lookup.dataset.word = item.word;
          }
          row.append(details); body.append(row);
        }
      } else {
        const nav = document.createElement('div'); nav.className = 'controls'; body.append(nav);
        button(nav, '全部词语', () => actions.open('list')); button(nav, '全部句子', () => actions.open('sentences')); button(nav, '复习', () => actions.open('review'));
        let count = 0;
        for (const entry of state.entries) for (const c of entry.contexts.filter(c => c.video?.videoId === state.videoId)) {
          count++;
          const row = document.createElement('div'); row.className = 'row';
          const expr = button(row, entry.expression, () => { const i = state.cues.findIndex(cue => cue.start === c.video?.startMs && cue.text === c.sentence); if (i >= 0) actions.lookup(entry.expression, i, expr); else actions.open('list'); }); expr.dataset.word = entry.expression;
          const status = document.createElement('select'); status.setAttribute('aria-label', `${entry.expression} 学习状态`);
          for (const [value, label] of [['saved','已收藏'],['learning','在学'],['known','已掌握']]) { const option = document.createElement('option'); option.value = value!; option.textContent = label!; status.append(option); }
          status.value = entry.status; status.addEventListener('change', () => actions.status(entry.key, status.value)); row.append(status);
          const sentence = document.createElement('div'); sentence.textContent = c.sentence; row.append(sentence);
          const link = document.createElement('a'); link.href = c.url; link.textContent = fmtClock(c.video!.startMs); link.style.color = 'var(--pd-blue)';
          link.dataset.playback = ''; link.addEventListener('click', e => { const i = state.cues.findIndex(cue => cue.start === c.video!.startMs); if (i >= 0) { e.preventDefault(); actions.seek(i); } });
          row.append(link); body.append(row);
        }
        for (const saved of state.sentences.filter(s => s.video.videoId === state.videoId)) {
          count++;
          const row = document.createElement('div'); row.className = 'row';
          const text = document.createElement('div'); text.textContent = saved.text; row.append(text);
          if (saved.zh) { const zh = document.createElement('div'); zh.className = 'zh'; zh.textContent = saved.zh; row.append(zh); }
          const tools = meta(row);
          const link = document.createElement('a'); link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(saved.video.videoId)}&t=${saved.video.startMs / 1000}s`; link.textContent = `整句 · ${fmtClock(saved.video.startMs)}`; link.style.color = 'var(--pd-blue)';
          link.dataset.playback = ''; link.addEventListener('click', e => { const i = state.cues.findIndex(cue => cue.start === saved.video.startMs); if (i >= 0) { e.preventDefault(); actions.seek(i); } });
          tools.append(link);
          button(tools, '取消收藏', () => actions.remove(saved.id)); body.append(row);
        }
        if (!count) empty('本视频还没有收藏。可在词卡保存词语，或在字幕行收藏整句。');
      }
      body.scrollTop = top;
      renderedTab = tab; lastCues = state.cues; lastSentences = state.sentences; lastEntries = state.entries;
    }
    if (rebuild || lastStatuses !== state.statuses) {
      const lang = (state.trackLang || 'en').split('-')[0]!;
      body.querySelectorAll<HTMLElement>('.w,[data-word]').forEach(el => {
        el.classList.remove('saved', 'learning', 'known');
        const word = el.dataset.word ?? el.textContent ?? '';
        const status = state.statuses.get(normalizeExpressionInLanguage(word, lang));
        if (status) el.classList.add(status);
      });
      lastStatuses = state.statuses;
    }
    if (tab === 'subs') body.querySelectorAll<HTMLElement>('[data-cue]').forEach(row => {
      const zh = row.querySelector<HTMLElement>('.zh')!; const value = state.translations.get(Number(row.dataset.cue)) ?? '';
      if (zh.textContent !== value) zh.textContent = value; zh.hidden = !state.chinese || !value;
    });
    highlight(rebuild);
  }
  function highlight(force = false) {
    back.hidden = follow;
    if (tab !== 'subs' || (!force && lastCurrent === state.current)) return;
    body.querySelector('.current')?.classList.remove('current');
    const row = body.querySelector<HTMLElement>(`[data-cue="${state.current}"]`); row?.classList.add('current');
    if (row && follow) body.scrollTop += row.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 3;
    lastCurrent = state.current;
  }
  return {
    snapshot: () => ({ tab, follow, top:body.scrollTop }),
    restore(value: {tab?:string;follow?:boolean;top?:number}) { if(value.tab && ['subs','words','saved'].includes(value.tab))tab=value.tab;follow=value.follow!==false;render();body.scrollTop=value.top??0; },
    update(next: WorkspaceState) { state = next; render(); },
  };
}

export const subtitleFontSize = (size: Settings['subtitleSize']) => size === 'small' ? 23 : size === 'large' ? 34 : 28;
