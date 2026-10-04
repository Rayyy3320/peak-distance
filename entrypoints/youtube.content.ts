import { initFloatingPanel } from '@/shared/floatingPanel';
import { createTranslationPopup } from '@/shared/translationPopup';
import { shadowSelection, rangeOffsetsIn, clampRangeToElement } from '@/shared/selection';
import { brandTokens, brandControls, CHAT_ADD_ICON, CHAT_ADD_BUTTON_STYLE } from '@/shared/brand';
import { classifySelection, detectTextLanguage, effectiveLookupExpression } from '@/shared/tokenize';
import { createSelectionPill } from '@/shared/selectionPill';
import { DEFAULT_SETTINGS } from '@/shared/settings';
import type { Settings } from '@/shared/settings';
// YouTube 隔离世界：字幕、页内学习侧栏、查词与播放控制。
//
// 职责（M0 嗅探链路之上）：
//   1. 与 MAIN world 嗅探脚本互通（config / nudge / tracklist / prefer），
//      优先英文人工轨道、其次英文自动轨道；没有英文轨道时明确提示；
//   2. 用 video.currentTime 定位当前句渲染双语字幕栏（ASR 滚动合并），
//      暂停 / 拖动 / 倍速后按时间重新定位；
//   3. 常规中文优先轨道 / 平台 / Google；显式 AI 按当前窗口小批量请求。
//      字幕 ID 对齐，显示开关保留缓存；换视频 / 换轨 / 隐藏时取消旧任务。
//   4. 悬停 / 点击字幕词就地查释义（拖选短语优先），复用共用弹窗与存储；
//      查词暂停播放，关闭时仅恢复由本次查词暂停且仍是同一视频的播放；
//      页面正文（描述 / 评论 / 标题）选区由共用浮条提供 查词/翻译/添加到
//      对话（shared/selectionPill.ts），字幕栏内选区仍走本脚本操作条；
//   5. 侧栏直达消息：字幕视图状态（blc-sub-get）与播放控制
//      （blc-sub-control，携带 videoId 防串页）；
//   6. 诊断徽标默认隐藏（页面事件 blc-debug-toggle 切换），宿主属性
//      data-blc-* 持续更新供程序化断言。
//
// 沿用 Gythiro yt-dual-subs（MIT）的获取链路思路，见 docs/REFERENCES.md。

import { videoIdFromLocation } from '@/shared/youtube';
import {
  CONTENT_SOURCE,
  INJECT_SOURCE,
  formatCue,
  type Cue,
  type InjectMessage,
} from '@/shared/protocol';
import { cueIndexAt, cueEnd, fmtClock, normalizeAsrCues } from '@/shared/cues';
import { subtitleFontSize } from '@/shared/youtubeWorkspace';
import { createLookupPopup } from '@/shared/lookupPopup';
import {
  sentenceId, type SavedSentence,
  videoContextUrl,
  type VocabIndexItem,
  type VideoSnapshot,
} from '@/shared/vocab';
import { buildMarkBuckets, type MarkBucket } from '@/shared/marker';
import { segmentWords } from '@/shared/tokenize';
import { normalizeExpressionInLanguage, langDisplayName } from '@/shared/languages';
import { comprehensionLangFor } from '@/shared/settings';
import {
  materialFromCandidate,
  sourceKeyOf,
  type MaterialPayload,
  type SelectionCandidate,
  type SourceDescriptor,
} from '@/shared/chat';
import type { ChatSourceInfo, SubControlMessage, SubViewState } from '@/shared/messages';

const SUBS_ID = 'blc-subs';
const SWITCH_ID = 'blc-subs-switch';
const BADGE_ID = 'blc-debug';
const NATIVE_CAPTIONS_HIDE_STYLE_ID = 'blc-hide-native-captions';

interface TrackInfo {
  lang: string; // 基础语言码（en / zh …）
  kind: 'manual' | 'asr';
}

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  runAt: 'document_idle',
  main() {
    const floatingPanel = initFloatingPanel();
    const translationPopup = createTranslationPopup(send);
    document.addEventListener('pd-panel-layout', () => renderBar());
    let currentVideoId = videoIdFromLocation();
    let nonce = 0;
    let navSeq = 0;
    // 展示用字幕（ASR 已滚动合并；人工轨道原样）
    let cues: Cue[] = [];
    let lastTrack = '';
    let lastTrackLang = '';
    let lastTrackId = '';
    let tracklist: TrackInfo[] = [];
    let preferTried = false;
    let notice = '';
    let nocuesReason = '';
    let nocuesRetries = 0;
    let ccDiag = 'init';
    let ccClicks = 0;
    let nativeCaptionsWereOn: boolean | null = null;
    let sawTimedtext = -1;
    // 徽标默认隐藏（保留诊断入口：页面事件 blc-debug-toggle 切换）
    let badgeVisible = false;

    // 双语 / 中文显隐（会话内状态）
    let bilingualOn = true;
    let zhVisible = true;

    // 翻译会话（videoId|trackId 域内复用）
    const translations = new Map<number, string>();
    let translateSession = '';
    let translating = false;
    let settings: Settings = { ...DEFAULT_SETTINGS };
    let settingsReady = false;
    let settingsFailed = false;
    let translationMode: 'regular' | 'ai' = 'regular';
    let modeReady = false;
    let modeBusy = false;
    let autoPause = false;
    let apIndex = -1;
    let apHeld = false;
    let apDisplayIndex = -1;
    let apLastStopped = -1;
    let sentences: SavedSentence[] = [];
    const translationSources = new Map<number, string>();
    let translationEpoch = 0;
    let requestId: string | null = null;
    let platformRequest: string | null = null;
    let platformState: 'idle' | 'waiting' | 'done' = 'idle';
    let platformTimer: ReturnType<typeof setTimeout> | null = null;
    const failedCues = new Set<number>();

    // 当前句
    let currentIdx = -1;
    let renderQueued = false;

    // 词状态（字幕内低强调标记）
    let markBuckets = new Map<string, MarkBucket>();
    // 查词暂停恢复
    let pausedByUsVideo: string | null = null;
    let externalLookupToken='';
    let activeWord: HTMLElement | null = null;
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    let suppressWord: HTMLElement | null = null;


    type LogEvent = { t: number; type: string } & Record<string, unknown>;
    const events: LogEvent[] = [];

    function log(type: string, data: Record<string, unknown> = {}): void {
      const entry: LogEvent = Object.assign({ t: Date.now(), type }, data);
      events.push(entry);
      if (events.length > 40) events.shift();
      console.info('[blc]', type, JSON.stringify(data));
      renderBadge();
    }

    function send<T>(msg: unknown): Promise<T> {
      return new Promise((resolve) => {
        try {
          browser.runtime.sendMessage({...(msg as object),fullscreen:!!document.fullscreenElement}, (r: unknown) => {
            void browser.runtime.lastError;
            resolve(r as T);
          });
        } catch {
          // 扩展禁用/重载瞬间 context invalidated：按失败处理，不产生未捕获报错
          resolve(undefined as T);
        }
      });
    }

    // ---- 徽标（默认隐藏，data-blc-* 属性始终更新） -----------------------------

    function ensureBadge(): HTMLElement {
      let host = document.getElementById(BADGE_ID);
      if (!host) {
        host = document.createElement('div');
        host.id = BADGE_ID;
        document.documentElement.appendChild(host);
        const root = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
          .box {
            position: fixed; top: 8px; right: 8px; z-index: 2147483647;
            max-width: 480px; padding: 6px 10px;
            background: rgba(0, 0, 0, 0.82); color: #fff;
            font: 11px/1.5 Consolas, Menlo, monospace; white-space: pre-wrap;
            border-radius: 4px; pointer-events: none;
          }
          .box[hidden] { display: none; }
        `;
        root.appendChild(style);
        const box = document.createElement('div');
        box.className = 'box';
        if (!badgeVisible) box.setAttribute('hidden', '');
        root.appendChild(box);
      }
      return host;
    }

    function renderBadge(): void {
      const host = ensureBadge();
      const box = host.shadowRoot!.querySelector('.box') as HTMLElement;
      const hasEn = lastTrackLang === 'en';
      const state = cues.length
        ? hasEn
          ? 'cues'
          : 'noenglish'
        : notice
          ? 'notice'
          : nocuesReason
            ? 'nocues'
            : currentVideoId
              ? 'waiting'
              : 'idle';
      const lines = [`BLC ${state} · video=${currentVideoId || '(none)'}`];
      if (cues.length) {
        lines.push(`track=${lastTrackLang || '?'}(${lastTrack}) · cues=${cues.length}`);
        lines.push(`first ${formatCue(cues[0]!)}`);
        lines.push(`last  ${formatCue(cues[cues.length - 1]!)}`);
        if (currentIdx >= 0 && cues[currentIdx]) {
          lines.push(`now   ${formatCue(cues[currentIdx]!)}`);
        }
        lines.push(`zh=${translations.size}/${cues.length} idx=${currentIdx}`);
      } else if (notice) {
        lines.push(`notice: ${notice}`);
      } else if (nocuesReason) {
        lines.push(`nocues: ${nocuesReason}`);
      }
      lines.push(`cc=${ccDiag} clicks=${ccClicks} seen=${sawTimedtext}`);
      box.textContent = lines.join('\n');
      if (badgeVisible) box.removeAttribute('hidden');
      else box.setAttribute('hidden', '');

      // 宿主元素上的属性供自动化断言（Shadow DOM 内文本对页面脚本不可直达）。
      host.setAttribute('data-blc-state', state);
      host.setAttribute('data-blc-video', currentVideoId);
      host.setAttribute('data-blc-track', lastTrack);
      host.setAttribute('data-blc-track-lang', lastTrackLang);
      host.setAttribute('data-blc-track-id', lastTrackId);
      host.setAttribute('data-blc-count', cues.length ? String(cues.length) : '');
      host.setAttribute('data-blc-nav-seq', String(navSeq));
      host.setAttribute('data-blc-cc', ccDiag);
      host.setAttribute('data-blc-seen', String(sawTimedtext));
      host.setAttribute('data-blc-idx', String(currentIdx));
      host.setAttribute('data-blc-zh', String(translations.size));
      host.setAttribute('data-blc-bilingual', bilingualOn ? 'on' : 'off');
      host.setAttribute('data-blc-chinese', zhVisible ? 'shown' : 'hidden');
      host.setAttribute('data-blc-notice', notice);
      host.setAttribute('data-blc-log', JSON.stringify(events));
    }

    window.addEventListener('blc-debug-toggle', () => {
      badgeVisible = !badgeVisible;
      renderBadge();
    });

    // ---- 播放器 / 视频 ---------------------------------------------------------

    function getVideo(): HTMLVideoElement | null {
      return (
        document.querySelector('#movie_player video') ??
        document.querySelector('video')
      );
    }

    let observedPlayer: Element | null = null;
    let observedWatchPage: Element | null = null;
    const playerResize = new ResizeObserver(() => {
      // YouTube 给视频和控制条写入像素尺寸；只改容器宽度不会更新这些值。
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    });
    const watchMode = new MutationObserver(queueRender);

    function observePlayerLayout(): void {
      const player = document.getElementById('movie_player');
      if (player !== observedPlayer) {
        playerResize.disconnect();
        observedPlayer = player;
        if (player) playerResize.observe(player);
      }
      const watchPage = document.querySelector('ytd-watch-flexy');
      if (watchPage !== observedWatchPage) {
        watchMode.disconnect();
        observedWatchPage = watchPage;
        if (watchPage) watchMode.observe(watchPage, { attributes: true, attributeFilter: ['theater'] });
      }
    }

    let playListenerBound = false;
    function bindPlayListener(): void {
      if (playListenerBound) return;
      playListenerBound = true;
      document.addEventListener('seeking', e => {
        if (e.target instanceof HTMLVideoElement) { pausedByUsVideo = null; apHeld = false; apIndex = -1; apLastStopped = -1; }
      }, true);
      document.addEventListener('keydown', e => {
        if (e.key === ' ' || e.key.toLowerCase() === 'k') pausedByUsVideo = null;
      }, true);
      playerRoot().addEventListener('pointerdown', e => {
        if (e.composedPath().some(n => n instanceof Element && (n.matches('video,.ytp-play-button') || n.matches('.html5-video-container')))) pausedByUsVideo = null;
      }, true);
      // YouTube SPA 内复用同一个 <video>；用户主动恢复播放后不再代为恢复
      document.addEventListener(
        'play',
        (e) => {
          const t = e.target;
          if (t instanceof HTMLVideoElement) { pausedByUsVideo = null; apHeld = false; }
        },
        true,
      );
    }

    // ---- 与 MAIN world 嗅探脚本的桥 ---------------------------------------------

    function postToInject(msg: Record<string, unknown>): void {
      try {
        window.postMessage(Object.assign({ source: CONTENT_SOURCE }, msg), '*');
      } catch {
        /* ignore */
      }
    }

    function sendConfig(): void {
      if (!currentVideoId) return; // 非视频页不请求
      nonce++;
      postToInject({ type: 'config', nonce });
    }

    function sendNudge(): void {
      postToInject({ type: 'nudge' });
    }

    function sendPrefer(lang: string, kind: 'manual' | 'asr'): void {
      postToInject({ type: 'prefer', nonce, lang, kind });
    }

    function baseLang(s: string): string {
      return (s || '').split('-')[0]!.toLowerCase();
    }

    /** 轨道优先级（M11 3.2）：沿用当前可用轨道；同语言人工优先于自动；
     *  无当前轨道时任选人工轨道，不强制切英语。 */
    function evaluateTrackPreference(): void {
      if (!tracklist.length || preferTried) return;
      const cur = baseLang(lastTrackLang);
      if (cues.length > 0) {
        // 已有产出：仅当同语言存在人工轨且当前是自动轨时升级
        const sameManual = tracklist.find((t) => t.kind === 'manual' && baseLang(t.lang) === cur);
        if (lastTrack === 'manual' || !sameManual) return;
        preferTried = true;
        sendPrefer(sameManual.lang, 'manual');
        log('prefer', { lang: sameManual.lang, kind: 'manual' });
        return;
      }
      const pick = tracklist.find((t) => t.kind === 'manual') ?? tracklist.find((t) => t.kind === 'asr');
      if (pick) {
        preferTried = true;
        sendPrefer(pick.lang, pick.kind === 'asr' ? 'asr' : 'manual');
        log('prefer', { lang: pick.lang, kind: pick.kind });
      }
    }

    // ---- 打开 YouTube 原生 CC（嗅探需要播放器发出 timedtext 请求） --------------

    function isShortsPage(): boolean {
      return location.pathname.startsWith('/shorts/');
    }

    function ensureCaptionsOn(retries: number): void {
      if (!bilingualOn || isShortsPage()) return;
      const player = document.getElementById('movie_player');
      const cc = player?.querySelector('.ytp-subtitles-button');
      if (!cc || cc.getAttribute('aria-pressed') === null) {
        if (retries > 0) setTimeout(() => ensureCaptionsOn(retries - 1), 600);
        return;
      }
      if (cc.getAttribute('aria-disabled') === 'true') {
        if (retries > 0) setTimeout(() => ensureCaptionsOn(retries - 1), 600);
        return;
      }
      if (nativeCaptionsWereOn === null) nativeCaptionsWereOn = cc.getAttribute('aria-pressed') === 'true';
      if (cc.getAttribute('aria-pressed') !== 'true') {
        (cc as HTMLElement).click();
        ccClicks++;
        log('cc-on', { videoId: currentVideoId, by: 'extension', clicks: ccClicks });
      }
    }

    function readCcDiag(): void {
      const player = document.getElementById('movie_player');
      const cc = player?.querySelector('.ytp-subtitles-button');
      if (!player) ccDiag = 'noplayer';
      else if (!cc) ccDiag = 'absent';
      else if (cc.getAttribute('aria-pressed') === null) ccDiag = 'noattr';
      else if (cc.getAttribute('aria-disabled') === 'true') ccDiag = 'disabled';
      else if (cc.getAttribute('aria-pressed') === 'true') ccDiag = 'on';
      else ccDiag = 'off';
      renderBadge();
    }

    function rearmCaptions(): boolean {
      const player = document.getElementById('movie_player');
      const cc = player?.querySelector('.ytp-subtitles-button');
      if (!cc) return false;
      if (cc.getAttribute('aria-disabled') === 'true') return false;
      if (cc.getAttribute('aria-pressed') !== 'true') return false;
      (cc as HTMLElement).click(); // 关
      setTimeout(() => {
        const p2 = document.getElementById('movie_player');
        const cc2 = p2?.querySelector('.ytp-subtitles-button');
        if (cc2 && cc2.getAttribute('aria-pressed') !== 'true') {
          (cc2 as HTMLElement).click(); // 开
        }
      }, 250);
      return true;
    }

    /** 关闭双语：恢复播放器原字幕显示（去掉我方隐藏样式）。 */
    function restoreNativeCaptions(): void {
      document.getElementById(NATIVE_CAPTIONS_HIDE_STYLE_ID)?.remove();
      const cc = playerRoot().querySelector<HTMLElement>('.ytp-subtitles-button');
      if (nativeCaptionsWereOn === false && cc?.getAttribute('aria-pressed') === 'true') cc.click();
      nativeCaptionsWereOn = null;
    }

    function hideNativeCaptions(): void {
      if (document.getElementById(NATIVE_CAPTIONS_HIDE_STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = NATIVE_CAPTIONS_HIDE_STYLE_ID;
      style.textContent =
        '#movie_player .ytp-caption-window-container { display: none !important; }';
      document.head?.appendChild(style);
    }

    // ---- 字幕栏（Shadow DOM，普通模式在画面下方；全屏在播放器内） -----------------------------

    function playerRoot(): HTMLElement {
      return document.getElementById('movie_player') ?? document.documentElement;
    }

    function ensureSwitchHost(): void {
      if (!currentVideoId) { document.getElementById(SWITCH_ID)?.remove(); return; }
      const parent = playerRoot().querySelector('.ytp-right-controls') ?? playerRoot();
      let host = document.getElementById(SWITCH_ID);
      if (!host) {
        host = document.createElement('div'); host.id = SWITCH_ID;
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>
          :host { position:relative; display:inline-flex; vertical-align:top; height:100%; align-items:center; font:14px/1.5 system-ui; color:#eee; text-shadow:none; letter-spacing:normal; text-transform:none; }
          button,select { font:inherit; color:inherit; background:#292b30; border:1px solid #555; border-radius:5px; padding:5px 9px; cursor:pointer; }
          button:focus-visible,select:focus-visible { outline:2px solid #8ab4f8; }
          #learning { background:transparent; border:0; padding:0 12px; height:100%; }
          ${brandTokens}
          #menu { color:var(--pd-ink);position:absolute; right:0; bottom:calc(100% + 12px); width:280px; background:var(--pd-paper); border:1px solid var(--pd-line); border-radius:8px; padding:12px; box-shadow:0 6px 24px #0008; }
          [hidden] { display:none!important; } label { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:7px 0; } small { color:var(--pd-muted); } #menu button,#menu select { background:var(--pd-surface);border-color:var(--pd-line);color:var(--pd-ink); } #menu input {accent-color:var(--pd-blue)}
          .menu-actions {display:grid;grid-template-columns:1fr auto;gap:8px;padding-bottom:12px;margin-bottom:4px;border-bottom:1px solid var(--pd-line)}
          .menu-actions button {display:flex;align-items:center;justify-content:center;gap:8px;min-height:38px;padding:7px 12px;border-radius:7px;font-size:13px;box-sizing:border-box}
          .menu-actions svg {width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
          #menu #panel {color:var(--pd-blue);background:var(--pd-selected);border-color:transparent}
          #menu .menu-actions button:hover {background:#d6e5f1;border-color:var(--pd-mist);color:var(--pd-blue)}
          #menu .menu-actions button:active {background:#c9dcec}
          #menu .menu-actions button:focus-visible {outline:2px solid var(--pd-blue);outline-offset:2px}
        </style><button id="learning" aria-expanded="false" title="双语字幕与学习面板">双语</button><div id="menu" hidden>
          <div class="menu-actions">
            <button id="panel" aria-label="打开学习面板" title="打开学习面板"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16M7 9h4M7 13h4"/></svg><span>学习面板</span></button>
            <button id="settings" aria-label="打开设置" title="打开设置"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3m4 0h9M4 17h9m4 0h3"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/></svg><span>设置</span></button>
          </div>
          <label>双语字幕<input id="bilingual" type="checkbox"></label><label>显示中文<input id="chinese" type="checkbox"></label>
          <label>本视频翻译<select id="translation-mode" aria-label="本视频翻译方式"><option value="regular">常规</option><option value="ai">AI（LLM）</option></select></label>
          <small>默认方式在设置中修改</small>
          <label>字幕字号<select id="size" aria-label="字幕字号"><option value="small">小</option><option value="standard">标准</option><option value="large">大</option></select></label>
          <label>逐句暂停（AP）<input id="ap" type="checkbox"></label>
        </div>`;
        const menu = root.querySelector<HTMLElement>('#menu')!;
        const close = () => { menu.hidden = true; host!.removeAttribute('data-open'); root.querySelector('#learning')!.setAttribute('aria-expanded', 'false'); };
        root.querySelector('#learning')!.addEventListener('click', () => {
          if(menu.hidden&&floatingPanel.isOpen())floatingPanel.hide();
          menu.hidden = !menu.hidden; host!.toggleAttribute('data-open', !menu.hidden); root.querySelector('#learning')!.setAttribute('aria-expanded', String(!menu.hidden));
        });
        root.querySelector('#panel')!.addEventListener('click', () => { void send({type:'panelOpen',view:'subs'}); close(); });
        root.querySelector('#bilingual')!.addEventListener('change', e => setBilingual((e.target as HTMLInputElement).checked));
        root.querySelector('#chinese')!.addEventListener('change', e => {
          zhVisible = (e.target as HTMLInputElement).checked;
          if (!zhVisible) stopTranslation();
          void send({ type:'setSetting', name:'chineseVisible', value:zhVisible }); renderBar();
        });
        root.querySelector('#translation-mode')!.addEventListener('change', e => void setTranslationMode((e.target as HTMLSelectElement).value as 'regular' | 'ai'));
        root.querySelector('#size')!.addEventListener('change', e => {
          settings.subtitleSize = (e.target as HTMLSelectElement).value as Settings['subtitleSize'];
          void send({ type:'setSetting', name:'subtitleSize', value:settings.subtitleSize }); renderBar();
        });
        root.querySelector('#ap')!.addEventListener('change', e => void updateVideoSession({ autoPause:(e.target as HTMLInputElement).checked }));
        root.querySelector('#settings')!.addEventListener('click', () => { void send({ type:'openSettings' }); close(); });
        host.addEventListener('click', e => e.stopPropagation());
        host.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); close(); root.querySelector<HTMLButtonElement>('#learning')!.focus(); } });
        document.addEventListener('pointerdown', e => { if (!e.composedPath().includes(host!)) close(); }, true);
      }
      if (host.parentElement !== parent) parent.append(host);
      host.style.cssText = parent === playerRoot() ? 'position:absolute;right:100px;bottom:10px;z-index:66;height:32px;' : '';
      const root = host.shadowRoot!;
      if (!modeBusy) (root.querySelector('#translation-mode') as HTMLSelectElement).value = translationMode;
      (root.querySelector('#translation-mode') as HTMLSelectElement).disabled = modeBusy || !modeReady;
      if (!modeBusy) (root.querySelector('#ap') as HTMLInputElement).checked = autoPause;
      (root.querySelector('#ap') as HTMLInputElement).disabled = modeBusy || !cues.length;
      (root.querySelector('#bilingual') as HTMLInputElement).checked = bilingualOn;
      (root.querySelector('#chinese') as HTMLInputElement).checked = zhVisible;
      (root.querySelector('#size') as HTMLSelectElement).value = settings.subtitleSize;
    }

    function ensureSubsHost(): { host: HTMLElement; body: HTMLDivElement } | null {
      if (!document.getElementById('movie_player')) return null;
      let host = document.getElementById(SUBS_ID);
      if (!host) {
        host = document.createElement('div'); host.id = SUBS_ID;
        const root = host.attachShadow({ mode:'open' });
        root.innerHTML = `<style>
          :host { display:block; color:#fff; font:var(--blc-font,28px)/1.45 system-ui,"Microsoft YaHei",sans-serif; }
          .wrap { text-align:center; padding:12px 18px; background:#151719; border-radius:0 0 8px 8px; }
          .en { font-weight:600; overflow-wrap:anywhere; } .zh { font-size:.8em; color:#e1cc91; margin-top:6px; }
          .notice { color:#b7bdc7; font-size:14px; } .w { cursor:pointer; border-radius:3px; } .w:hover { background:#454d58; }
          .w:focus-visible { outline:2px solid #8ab4f8; } .saved { border-bottom:2px solid #8ab4f8; } .learning { border-bottom:2px solid #fdd663; } .known { color:#9aa0a6; }
          button { cursor:pointer; margin:6px; padding:4px 10px; border:1px solid #555; border-radius:5px; background:#292b30; color:#eee; font:14px system-ui; }
          :host([data-fullscreen]) .wrap { background:transparent; padding:4px 8px; text-shadow:0 1px 3px #000,0 0 2px #000; }
          :host([data-fullscreen]) .en,:host([data-fullscreen]) .zh { width:fit-content;max-width:100%;margin-left:auto;margin-right:auto;background:rgba(16,18,20,.25);padding:2px 8px;border-radius:4px; }
        </style><div class="wrap"></div>`;
        bindWordEvents(host);
      }
      const fs = document.fullscreenElement;
      host.toggleAttribute('data-fullscreen', !!fs);
      host.style.setProperty('--blc-font', `${subtitleFontSize(settings.subtitleSize)}px`);
      if (fs) {
        if (host.parentElement !== fs) fs.append(host);
        host.style.cssText += ';position:absolute;left:4%;right:4%;bottom:76px;z-index:60;';
      } else {
        host.style.position = 'relative'; host.style.left = ''; host.style.right = ''; host.style.bottom = ''; host.style.zIndex = '';
        const target = document.querySelector<HTMLElement>('ytd-watch-flexy[theater] #full-bleed-container') ?? document.getElementById('player-container-outer') ?? playerRoot();
        if (target.nextElementSibling !== host) target.after(host);
        // 独立字幕行占播放器一列，侧栏跨两行。
        if (target.parentElement?.id === 'blc-learning-layout') { host.style.gridColumn = '1'; host.style.gridRow = '2'; } else { host.style.gridColumn = ''; host.style.gridRow = ''; }
      }
      return { host, body:host.shadowRoot!.querySelector<HTMLDivElement>('.wrap')! };
    }

    function bindWordEvents(host: HTMLElement): void {
      let lastPhraseAt = 0;
      const wordOf = (e: Event) => (e.composedPath()[0] as Element)?.closest?.('.w') as HTMLElement | null;
      const indexOf = (word: HTMLElement) => Number(word.closest('[data-cue]')?.getAttribute('data-cue') ?? currentIdx);
      host.addEventListener('pointerover', e => {
        const word = wordOf(e);
        if (!word || word === suppressWord || (popup.isOpen() && !popup.isCompact())) return;
        clearTimeout(leaveTimer); clearTimeout(hoverTimer);
        if (word === activeWord && popup.isOpen()) return;
        hoverTimer = setTimeout(() => { if (!window.getSelection()?.toString()) openLookup(word.textContent!, indexOf(word), word, true); }, 180);
      });
      host.addEventListener('pointerout', e => {
        const word = wordOf(e); if (!word || word.contains(e.relatedTarget as Node)) return;
        if (suppressWord === word) suppressWord = null;
        clearTimeout(hoverTimer); scheduleCardClose();
      });
      host.addEventListener('focusin', e => { const word = wordOf(e); if (word) openLookup(word.textContent!, indexOf(word), word, true); });
      host.addEventListener('mouseup', e => {
        const real = e.composedPath()[0] as Element;
        if (!real?.closest('.en')) return;
        const info = subtitleSelectionInBar();
        if (info) {
          // 拖选（单词或短语）后短时间内不触发单词点击查询
          lastPhraseAt = Date.now(); clearTimeout(hoverTimer);
          showSelectionActions(info);
        }
      });
      const clickWord = (e: Event) => {
        if (Date.now() - lastPhraseAt < 500) return;
        const word = wordOf(e); if (!word) return;
        e.preventDefault(); e.stopPropagation(); clearTimeout(hoverTimer); clearTimeout(leaveTimer);
        if (activeWord === word && popup.isOpen()) {
          if (popup.isCompact()) popup.expand(); else { suppressWord = word; popup.close(); }
        } else openLookup(word.textContent!, indexOf(word), word);
      };
      host.addEventListener('click', clickWord);
      host.addEventListener('keydown', e => { if (e.key === 'Enter') clickWord(e); });
    }

    interface SubtitleSelectionInfo {
      raw: string;
      kind: 'word' | 'phrase' | 'sentence';
      hasWord: boolean;
      expression: string | null;
      cueIndex: number;
      rect: DOMRect | null;
    }

    /** 播放器字幕栏选区：收窄到原文行（不含译文/控件文字），本地分类 + 有效表达。 */
    function subtitleSelectionInBar(): SubtitleSelectionInfo | null {
      const root = document.getElementById(SUBS_ID)?.shadowRoot;
      if (!root) return null;
      const selected = shadowSelection(root);
      const en = root.querySelector<HTMLElement>('.en');
      if (!selected || !en) return null;
      const clamped = clampRangeToElement(selected.range, en);
      const raw = clamped.toString().replace(/\s+/g, ' ').trim();
      if (!raw) return null;
      const cueIndex = Number(en.dataset.cue ?? currentIdx);
      const cue = cues[cueIndex];
      if (!cue || !currentVideoId || !lastTrackId) return null;
      const lang = baseLang(lastTrackLang) || 'en';
      const cls = classifySelection(raw, lang);
      let expression: string | null = null;
      if (cls.kind !== 'sentence') {
        const offsets = rangeOffsetsIn(en, clamped);
        if (offsets && offsets.start <= offsets.end && offsets.end <= offsets.text.length) {
          expression = effectiveLookupExpression(offsets.text, offsets.start, offsets.end, lang)?.expression ?? null;
        }
      }
      let rect: DOMRect | null = null;
      try { rect = selected.range.getBoundingClientRect(); } catch { /* ignore */ }
      return { raw, kind: cls.kind, hasWord: cls.hasWord, expression, cueIndex, rect };
    }

    function subtitleCandidate(info: SubtitleSelectionInfo): SelectionCandidate | null {
      const source = buildVideoSource();
      const cue = cues[info.cueIndex];
      if (!source?.video || !cue) return null;
      return {
        at: Date.now(),
        pageUrl: location.href,
        text: info.raw,
        kind: info.kind,
        expression: info.kind === 'sentence' ? null : info.expression,
        lang: lastTrackLang || undefined,
        source,
        cue: { index: info.cueIndex, text: cue.text, startMs: cue.start, endMs: cue.start + cue.dur },
      };
    }

    /** 直接附加到当前聊天并打开面板；不先查词、不自动发送。 */
    async function attachSubtitleSelection(info: SubtitleSelectionInfo): Promise<void> {
      const source = buildVideoSource();
      const candidate = subtitleCandidate(info);
      const built = candidate ? materialFromCandidate(candidate) : null;
      if (!source || !candidate || !built) { playerToast('字幕尚未就绪，稍后再试'); return; }
      const r = await send<{ ok: boolean; panelOpened?: boolean }>({
        type: 'chatEnsure', source, material: built.material, quote: built.quote, openPanel: true,
      });
      if (!r?.ok) { playerToast('附加失败，请重试'); return; }
      if (!r.panelOpened) playerToast('已附加到当前对话：点扩展图标打开侧栏继续');
    }

    function showSelectionActions(info: SubtitleSelectionInfo) {
      document.getElementById('pd-phrase-actions')?.remove();
      const host=document.createElement('div');host.id='pd-phrase-actions';
      host.style.cssText='position:fixed;z-index:2147483646';
      host.style.left=Math.max(12,Math.min(info.rect?.left??24,innerWidth-196))+'px';
      host.style.top=Math.min((info.rect?.bottom??64)+6,innerHeight-60)+'px';
      const root=host.attachShadow({mode:'open'});
      root.innerHTML=`<style>${brandTokens}:host{font:14px system-ui}div{display:flex;gap:4px;padding:4px;border-radius:8px;background:var(--pd-paper)}${brandControls}${CHAT_ADD_BUTTON_STYLE}</style><div><button id="lookup" hidden>查词</button><button id="translate" hidden>翻译</button><button id="chat" class="blc-chat-add" title="添加到对话" aria-label="添加到对话">${CHAT_ADD_ICON}</button></div>`;
      (document.fullscreenElement??document.documentElement).append(host);
      // 分类表：word=查词+对话；phrase=查词+翻译+对话；sentence=翻译+对话
      root.querySelector<HTMLElement>('#lookup')!.hidden = info.kind === 'sentence' || !info.hasWord;
      root.querySelector<HTMLElement>('#translate')!.hidden = info.kind === 'word';
      const rect = info.rect ?? undefined;
      root.querySelector('#lookup')!.addEventListener('click',()=>{host.remove();openLookup(info.expression ?? info.raw, info.cueIndex);});
      root.querySelector('#translate')!.addEventListener('click',()=>{host.remove();popup.close();translationPopup.open({text:info.raw,url:videoContextUrl(currentVideoId,cues[info.cueIndex]?.start??0),title:document.title},rect);});
      root.querySelector('#chat')!.addEventListener('click',()=>{host.remove();popup.close();void attachSubtitleSelection(info);});
      host.addEventListener('mousedown',e=>e.preventDefault());
      // 选区形成即固定候选（面板进入/字幕重绘不清空）
      const candidate = subtitleCandidate(info);
      if (candidate) void send({ type: 'selectionCandidateSet', candidate });
      const remove=(e:Event)=>{if(!e.composedPath().includes(host)){host.remove();document.removeEventListener('pointerdown',remove,true);}};
      document.addEventListener('pointerdown',remove,true);
    }

    function scheduleCardClose(): void {
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => { if (popup.isCompact()) popup.close(); }, 220);
    }

    function removeSubsHost(): void {
      document.getElementById(SUBS_ID)?.remove();
    }

    function queueRender(): void {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        renderBar();
      });
    }

    function renderBar(): void {
      renderBadge();
      observePlayerLayout();
      ensureSwitchHost();
      if (!bilingualOn || !currentVideoId) {
        removeSubsHost();
        return;
      }
      const got = ensureSubsHost();
      if (!got) return;
      const { body } = got;
      const oldEn = body.querySelector<HTMLDivElement>('.en');
      body.textContent = '';

      const bar = document.createElement('div');
      bar.className = 'bar';

      if (!cues.length) {
        const n = document.createElement('div');
        n.className = 'notice';
        n.textContent = notice || '正在获取字幕…';
        bar.appendChild(n);
        body.appendChild(bar);
        return;
      }

      if (notice) {
        const n = document.createElement('div');
        n.className = 'notice';
        n.textContent = notice;
        bar.appendChild(n);
      }

      const cue = currentIdx >= 0 ? cues[currentIdx] : null;
      if (cue) {
        const en = oldEn?.dataset.cue === String(currentIdx) && oldEn.textContent === cue.text ? oldEn : document.createElement('div');
        en.className = 'en'; en.dataset.cue = String(currentIdx);
        if (!en.textContent) appendWords(en, cue.text);
        en.querySelectorAll<HTMLElement>('.w').forEach(w => {
          w.classList.remove('saved', 'learning', 'known');
          const status = wordStatus(w.textContent!); if (status) w.classList.add(status);
        });
        bar.appendChild(en);
        if (zhVisible) {
          const zh = translations.get(currentIdx);
          if (zh) {
            const z = document.createElement('div');
            z.className = 'zh';
            z.textContent = zh;
            bar.appendChild(z);
          } else if (settingsFailed) {
            const error = document.createElement('div'); error.className = 'notice'; error.textContent = '无法连接扩展，请刷新页面'; bar.appendChild(error);
            const reload = document.createElement('button'); reload.textContent = '刷新页面'; reload.addEventListener('click', () => location.reload()); bar.appendChild(reload);
          } else if (failedCues.has(currentIdx)) {
            const error = document.createElement('div'); error.className = 'notice'; error.textContent = '翻译暂不可用'; bar.appendChild(error);
            const ai = document.createElement('button'); ai.textContent = '用 AI 翻译'; ai.addEventListener('click', () => void setTranslationMode('ai')); bar.appendChild(ai);
            const retry = document.createElement('button'); retry.textContent = '重试'; retry.addEventListener('click', () => {
              for (let i = Math.max(0, currentIdx - 1); i <= Math.min(cues.length - 1, currentIdx + 4); i++) failedCues.delete(i);
              scheduleTranslate(); renderBar();
            }); bar.appendChild(retry);
          } else {
            const pending = document.createElement('div'); pending.className = 'notice'; pending.setAttribute('role', 'status');
            pending.textContent = !settingsReady ? '正在读取翻译设置…' : platformState === 'waiting' ? `正在获取${langDisplayName(targetLangOf())}译文…` : '正在翻译…';
            bar.appendChild(pending);
          }
        }
      }
      body.appendChild(bar);
    }

    /** 原文行按轨道语言分词为可点击 span（M11：Segmenter 统一边界），已存词条按状态低强调标出。 */
    function appendWords(en: HTMLDivElement, text: string): void {
      let last = 0;
      for (const s of segmentWords(text, baseLang(lastTrackLang) || 'en')) {
        if (s.start > last) en.appendChild(document.createTextNode(text.slice(last, s.start)));
        const w = document.createElement('span');
        w.className = 'w'; w.tabIndex = 0; w.setAttribute('role', 'button');
        w.textContent = s.text;
        const st = wordStatus(s.text);
        if (st) w.classList.add(st);
        en.appendChild(w);
        last = s.end;
      }
      if (last < text.length) en.appendChild(document.createTextNode(text.slice(last)));
    }

    function setBilingual(on: boolean): void {
      bilingualOn = on;
      void send({ type: 'setSetting', name: 'bilingualEnabled', value: on });
      if (!on) {
        stopTranslation();
        restoreNativeCaptions();
        removeSubsHost();
      } else {
        hideNativeCaptions();
        ensureCaptionsOn(20);
      }
      log('bilingual', { on });
      renderBadge();
      renderBar();
    }

    // ---- 查词（共用弹窗 + 暂停 / 恢复） -------------------------------------------

    document.addEventListener('pointerdown', e => {
      if (e.composedPath().some(n => n instanceof Element && n.matches('[data-playback],video,.ytp-play-button,.ytp-progress-bar'))) pausedByUsVideo = null;
    }, true);
    const popup = createLookupPopup({ send, mountParent: () => document.fullscreenElement as HTMLElement | null });

    // ---- 页面正文选区浮条（描述 / 评论 / 标题等；字幕栏以内不介入） ---------------

    const selectionPill = createSelectionPill({
      send,
      lookup: popup,
      translation: translationPopup,
      buildSource: buildPageArticleSource,
      toast: playerToast,
      onContinueAsk: (ctx) => void continueAskFromPageBody(ctx),
      skipSelection: (sel) => {
        // 字幕栏 / 字幕选区操作条 / 词卡 / 翻译卡都在 Shadow DOM 内：
        // 选区根节点不是 document 就属于插件自身 UI，页面浮条不介入
        const node = sel.anchorNode;
        return !!node && node.getRootNode() !== document;
      },
    });

    function videoRef(index = currentIdx) {
      return { videoId:currentVideoId, trackId:lastTrackId, trackKind:lastTrack === 'asr' ? 'asr' as const : 'manual' as const,
        trackLang:lastTrackLang, startMs:cues[index]?.start ?? 0 };
    }
    async function refreshSaved():Promise<void> {
      const saved=await send<{ok:boolean;sentences:SavedSentence[]}>({type:'listSentences'});
      if(saved?.ok)sentences=saved.sentences;
    }
    async function toggleSentence(index: number): Promise<void> {
      const cue = cues[index]; if (!cue) return;
      const video = videoRef(index), id = sentenceId(video, cue.text);
      const r = await send<{ ok:boolean }>(sentences.some(s => s.id === id) ? { type:'deleteSentence', id } : {
        type:'saveSentence', sentence:{ id, video, text:cue.text, zh:translations.get(index), translationSource:translationSources.get(index),
          ...(lastTrackLang ? { language: lastTrackLang } : {}),
          endMs:cue.start + cue.dur, title:document.title, createdAt:Date.now() },
      });
      if (!r?.ok) playerToast('收藏失败，请重试');
    }
    function seekCue(index: number, play = false): void {
      const v = getVideo(), cue = cues[index]; if (!v || !cue) return;
      pausedByUsVideo = null; apHeld = false; apIndex = -1; apLastStopped = -1;
      v.currentTime = cue.start / 1000;
      if (play) void v.play();
      tick();
    }

    // ---- M5 问答：视频来源与材料 ---------------------------------------------------

    function buildVideoSource(): SourceDescriptor | null {
      if (!currentVideoId) return null;
      const source: SourceDescriptor = {
        sourceType: 'youtube',
        sourceKey: sourceKeyOf({ sourceType: 'youtube', videoId: currentVideoId }),
        title: document.title,
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(currentVideoId)}`,
      };
      if (lastTrackId) {
        source.video = {
          videoId: currentVideoId,
          trackId: lastTrackId,
          trackKind: lastTrack === 'asr' ? 'asr' : 'manual',
          trackLang: lastTrackLang,
        };
      }
      return source;
    }

    /** 页面正文选区（描述 / 评论 / 标题）来源：当前地址的 article 源（与视频源区分）。 */
    function buildPageArticleSource(): SourceDescriptor {
      return {
        sourceType: 'article',
        sourceKey: sourceKeyOf({ sourceType: 'article', url: location.href }),
        title: document.title,
        url: location.href,
      };
    }

    /** 材料仅在打开问答 / 更新材料 / 带入新引用时构建一次（不随播放重建）。 */
    function buildVideoMaterial(): MaterialPayload | null {
      if (!cues.length || !lastTrackId || !currentVideoId) return null;
      return {
        label: '当前轨道完整字幕',
        blocks: cues.map((c, i) => ({
          id: `p${i + 1}`,
          text: c.text,
          startMs: c.start,
          endMs: c.start + c.dur,
        })),
      };
    }

    function buildChatSourceInfo(): ChatSourceInfo {
      const source = buildVideoSource();
      if (!source) {
        return {
          type: 'blc-chat-source-info',
          source: null,
          canMaterial: false,
          hint: '当前不是视频页',
          pageUrl: location.href,
        };
      }
      return {
        type: 'blc-chat-source-info',
        source,
        canMaterial: !!buildVideoMaterial(),
        hint: cues.length ? '' : '字幕尚未就绪，稍后再试',
        pageUrl: location.href,
      };
    }

    // 播放器内轻提示（全屏时侧栏打不开等场景）
    function playerToast(text: string): void {
      const host = document.createElement('div');
      host.style.cssText =
        'position:absolute;left:50%;bottom:110px;transform:translateX(-50%);z-index:70;pointer-events:none;';
      const box = document.createElement('div');
      box.style.cssText =
        'background:rgba(8,8,8,.85);color:#e8eaed;padding:8px 14px;border-radius:8px;font:13px/1.4 system-ui,"Microsoft YaHei",sans-serif;';
      box.textContent = text;
      host.appendChild(box);
      (document.fullscreenElement ?? playerRoot()).appendChild(host);
      setTimeout(() => host.remove(), 3200);
    }

    /** 词卡「继续问」：附加词卡表达与可靠原字幕（可带已有释义），不发新查询。 */
    async function continueAskFromVideo(ctx: {
      snapshot: { expression: string; sentence?: string; video?: { startMs: number } };
      definition: string | null;
    }): Promise<void> {
      const source = buildVideoSource();
      if (!source) {
        playerToast('字幕尚未就绪，等字幕出现后再继续问');
        return;
      }
      const expression = ctx.snapshot.expression.trim();
      if (!expression) return;
      const idx = ctx.snapshot.video ? cues.findIndex(c => c.start === ctx.snapshot.video!.startMs) : currentIdx;
      const cue = cues[idx];
      const candidate: SelectionCandidate = {
        at: Date.now(),
        pageUrl: location.href,
        text: expression,
        kind: 'word',
        expression,
        lang: lastTrackLang || undefined,
        source,
        ...(cue ? { cue: { index: idx, text: cue.text, startMs: cue.start, endMs: cue.start + cue.dur } } : {}),
        ...(ctx.definition ? { definition: ctx.definition } : {}),
      };
      const built = materialFromCandidate(candidate);
      if (!built) { playerToast('字幕尚未就绪，等字幕出现后再继续问'); return; }
      const r = await send<{ ok: boolean; panelOpened?: boolean }>({
        type: 'chatEnsure',
        source,
        material: built.material,
        quote: built.quote,
        openPanel: true,
      });
      popup.close(); // 沿用弹窗关闭后的播放恢复规则
      if (!r?.ok) { playerToast('附加失败，请重试'); return; }
      if (!r.panelOpened) {
        // Chrome 不总允许从内容脚本消息代开侧栏；全屏时同样如此。
        // 引用已保存，退出全屏点扩展图标即可续上。
        playerToast('已带入引用：点浏览器工具栏的扩展图标打开侧栏继续');
      }
    }

    /** 词卡「继续问」（页面正文）：附加表达与可靠原句（可带已有释义），按 article 源入对话。 */
    async function continueAskFromPageBody(ctx: {
      snapshot: { expression: string; sentence?: string };
      definition: string | null;
    }): Promise<void> {
      const source = buildPageArticleSource();
      const expression = ctx.snapshot.expression.trim();
      const sentence = (ctx.snapshot.sentence ?? '').replace(/\s+/g, ' ').trim();
      if (!expression) return;
      // 页面正文词/短语：表达为焦点、可靠原句为背景；没有可靠原句只附加表达
      const candidate: SelectionCandidate = {
        at: Date.now(),
        pageUrl: location.href,
        text: expression,
        kind: 'word',
        expression,
        lang: detectTextLanguage(expression) ?? undefined,
        ...(sentence && sentence !== expression ? { sentence } : {}),
        source,
        ...(ctx.definition ? { definition: ctx.definition } : {}),
      };
      const built = materialFromCandidate(candidate);
      if (!built) { playerToast('无法提取材料：先在正文里选中一段文字'); return; }
      const r = await send<{ ok: boolean; panelOpened?: boolean }>({
        type: 'chatEnsure',
        source,
        material: built.material,
        quote: built.quote,
        openPanel: true,
      });
      popup.close();
      if (!r?.ok) { playerToast('附加失败，请重试'); return; }
      if (!r.panelOpened) {
        playerToast('已带入引用：点浏览器工具栏的扩展图标打开侧栏继续');
      }
    }

    function neighborsText(index = currentIdx): string {
      const parts: string[] = [];
      const prev = cues[index - 1];
      const next = cues[index + 1];
      if (prev) parts.push(prev.text);
      if (next) parts.push(next.text);
      return parts.join(' / ').slice(0, 300);
    }

    function openLookup(expression: string, index = currentIdx, anchor?: HTMLElement, compact = false): void {
      externalLookupToken='';
      const cue = cues[index];
      if (!cue || !currentVideoId || !lastTrackId) return;
      const video = getVideo();
      // 查词时暂停正在播放的视频；只记一次，恢复见 closeResume
      if (video && !video.paused && !pausedByUsVideo) {
        pausedByUsVideo = currentVideoId;
        video.pause();
        log('pause-for-lookup', { videoId: currentVideoId });
      }
      const snapshot: VideoSnapshot = {
        source: 'video',
        expression,
        sentence: cue.text,
        neighbors: neighborsText(index) || undefined,
        title: document.title,
        lang: lastTrackLang || undefined,
        video: {
          videoId: currentVideoId,
          trackId: lastTrackId,
          trackKind: lastTrack === 'asr' ? 'asr' : 'manual',
          trackLang: lastTrackLang,
          startMs: cue.start,
        },
      };
      activeWord = anchor ?? null;
      popup.open({
        snapshot, anchor, compact,
        subLine: `YouTube · ${fmtClock(cue.start)} · ${lastTrackLang}${lastTrack === 'asr' ? '(自动)' : '(人工)'}`,
        onContinueAsk: (ctx) => void continueAskFromVideo(ctx),
        onClose: () => {
          // 只恢复：由本次查词暂停 && 仍是同一视频 && 仍处于暂停
          activeWord = null;
          const v = getVideo();
          const byUs = pausedByUsVideo;
          pausedByUsVideo = null;
          if (byUs && byUs === currentVideoId && v && v.paused && !apHeld) {
            void v.play();
            log('resume-after-lookup', { videoId: currentVideoId });
          }
        },
      });
      const card = popup.host()?.shadowRoot?.querySelector<HTMLElement>('.card');
      card?.addEventListener('pointerenter', () => clearTimeout(leaveTimer));
      card?.addEventListener('pointerleave', scheduleCardClose);
    }

    // ---- 时间循环：currentTime 定位 + 翻译调度 ------------------------------------

    function tick(): void {
      try {
        const v = getVideo();
        if (!v) return;
        bindPlayListener();
        const t = v.currentTime * 1000;
        let idx = cueIndexAt(cues, t);
        if (autoPause && !v.paused && !v.seeking) {
          if (apIndex >= 0 && t >= cueEnd(cues, apIndex)) {
            apDisplayIndex = apIndex; apLastStopped = apIndex; apIndex = -1;
            apHeld = true; pausedByUsVideo = null; v.pause();
          } else if (idx >= 0 && idx !== apLastStopped) apIndex = idx;
        }
        if (apHeld) idx = apDisplayIndex;
        if (idx !== currentIdx) {
          currentIdx = idx;
          queueRender();
          renderBadge();
        }
        if (idx >= 0) scheduleTranslate();
      } catch {
        /* ignore */
      }
    }

    function stopTranslation(): void {
      translationEpoch++;
      if (requestId) void send({ type: 'cancelOnline', requestId });
      requestId = null; translating = false;
      postToInject({ type: 'translation-cancel' });
      platformRequest = null;
      if (platformState === 'waiting') platformState = 'idle';
      if (platformTimer) clearTimeout(platformTimer);
      platformTimer = null;
    }

    async function updateVideoSession(patch: { mode?: 'regular' | 'ai'; autoPause?: boolean } = {}): Promise<void> {
      if (modeBusy || !currentVideoId) return;
      modeBusy = true;
      const videoId = currentVideoId;
      if (patch.mode) stopTranslation();
      ensureSwitchHost();
      const r = await send<{ ok:boolean; mode:'regular' | 'ai'; autoPause:boolean }>({ type:'subtitleMode', videoId, ...patch });
      if (videoId !== currentVideoId) return;
      modeBusy = false;
      if (!r?.ok) { settingsFailed = true; modeReady = false; renderBar(); return; }
      if (translationMode !== r.mode) {
        stopTranslation(); translations.clear(); translationSources.clear(); failedCues.clear(); platformState = 'idle';
      }
      translationMode = r.mode; autoPause = r.autoPause; modeReady = true; settingsFailed = false;
      if (!autoPause) apIndex = -1;
      renderBar(); scheduleTranslate();
    }
    async function setTranslationMode(mode: 'regular' | 'ai'): Promise<void> {
      await updateVideoSession({ mode });
    }

    async function refreshSettings(): Promise<void> {
      const r = await send<{ ok: boolean; settings: Settings }>({ type: 'getSettings' });
      if (!r?.ok) { settingsFailed = true; renderBar(); return; }
      settingsFailed = false;
      settings = { ...DEFAULT_SETTINGS, ...r.settings }; settingsReady = true;
      bilingualOn = settings.bilingualEnabled; zhVisible = settings.chineseVisible;
      if (!modeReady) await updateVideoSession();
      if (!bilingualOn || !zhVisible) stopTranslation();
      if (bilingualOn) { hideNativeCaptions(); ensureCaptionsOn(20); } else restoreNativeCaptions();
      renderBar();
    }

    /** 当前内容的理解语言（M11：按源语言覆盖优先；轨道语言缺省用全局默认）。 */
    function targetLangOf(): string {
      return comprehensionLangFor(settings, lastTrackLang || undefined);
    }

    function captionCacheKey(): string {
      // 缓存随目标语言区分（默认 zh 与旧 'youtube-zh' 键一致，老缓存继续可用）
      const target = baseLang(targetLangOf());
      try {
        const p = new URL(lastTrackId).searchParams;
        return JSON.stringify([currentVideoId, p.get('lang'), p.get('kind'), p.get('name'), p.get('vssId'), `youtube-${target}`]);
      } catch { return `${currentVideoId}|${lastTrackId}|youtube-${target}`; }
    }

    function requestPlatform(): void {
      platformState = 'waiting';
      queueRender();
      const epoch = translationEpoch;
      const key = captionCacheKey();
      void send<{ ok: boolean; cues?: Cue[] }>({ type: 'captionCache', key }).then(r => {
        if (epoch !== translationEpoch) return;
        if (r?.cues?.length) {
          applyPlatformCues(r.cues); platformState = 'done'; scheduleTranslate(); return;
        }
        platformRequest = crypto.randomUUID();
        postToInject({ type: 'translation-request', requestId: platformRequest, videoId: currentVideoId, trackId: lastTrackId, targetLang: targetLangOf() });
        platformTimer = setTimeout(() => {
          if (epoch !== translationEpoch) return;
          postToInject({ type: 'translation-cancel' }); platformRequest = null; platformState = 'done'; scheduleTranslate();
        }, 26000);
      });
    }

    function applyPlatformCues(translated: Cue[]): void {
      const byTime = new Map(translated.filter(c => c.zh).map(c => [`${c.start}|${c.text}`, c.zh!]));
      const sourceLabel = `YouTube ${langDisplayName(targetLangOf())}译文 / 平台翻译`;
      cues.forEach((cue, id) => { const zh = byTime.get(`${cue.start}|${cue.text}`); if (zh) { translations.set(id, zh); translationSources.set(id, sourceLabel); } });
      queueRender();
    }

    function scheduleTranslate(): void {
      if (!settingsReady || !modeReady || modeBusy || !bilingualOn || !zhVisible || translating || currentIdx < 0) return;
      if (!cues.length || !currentVideoId || !lastTrackId) return;
      const session = `${currentVideoId}|${lastTrackId}|${translationMode}`;
      if (session !== translateSession) translateSession = session;
      if (translationMode === 'regular' && platformState !== 'done') {
        if (platformState === 'idle') requestPlatform();
        return;
      }
      const win: number[] = [];
      for (let i = Math.max(0, currentIdx - 1); i <= Math.min(cues.length - 1, currentIdx + 4); i++) {
        if (!translations.has(i) && !failedCues.has(i)) win.push(i);
      }
      if (!win.length) return;
      translating = true;
      queueRender();
      const epoch = translationEpoch;
      requestId = crypto.randomUUID();
      void send<{ ok: boolean; translations?: { id: number; text: string }[] }>({
        type: 'translateCues', mode: translationMode, requestId, videoId: currentVideoId, trackId: lastTrackId,
        sourceLang: lastTrackLang || undefined, targetLang: targetLangOf(),
        items: win.map(id => ({ id, text: cues[id]!.text })),
      }).then(r => {
        if (epoch !== translationEpoch) return;
        requestId = null; translating = false;
        for (const id of win) failedCues.add(id);
        if (r?.ok) for (const t of r.translations ?? []) {
          if (win.includes(t.id) && t.text) { translations.set(t.id, t.text); translationSources.set(t.id, translationMode === 'ai' ? 'AI 翻译' : 'Google 常规翻译'); failedCues.delete(t.id); }
        }
        queueRender();
      });
    }

    setInterval(tick, 50);

    // ---- 全屏：把字幕栏与弹窗宿主放进全屏元素（不靠堆 z-index） -------------------

    document.addEventListener('fullscreenchange', () => {
      pausedByUsVideo = null; popup.close(true); renderBar();
    });
    window.addEventListener('resize', queueRender);

    // ---- 侧栏直达消息（字幕视图 / 播放控制） ---------------------------------------

    browser.runtime.onMessage.addListener(
      (msg: unknown, _sender, sendResponse) => {
        const m = msg as Partial<SubControlMessage> | { type?: string } | undefined;
        if (!m || typeof m.type !== 'string') return undefined;
        if (m.type === 'ai-service-changed') {
          if (translationMode === 'ai') {
            stopTranslation(); translations.clear(); translationSources.clear(); failedCues.clear();
            scheduleTranslate(); queueRender();
          }
          return undefined;
        }
        if (m.type === 'pd-video-action') {
          const a = msg as {videoId:string;action:string;index:number;word?:string;play?:boolean;token?:string};
          if(a.videoId!==currentVideoId || !Number.isInteger(a.index) || !cues[a.index]) {sendResponse({ok:false});return true;}
          if(a.action==='pauseLookup'&&typeof a.token==='string') {
            externalLookupToken=a.token;popup.close();const v=getVideo();
            if(v&&!v.paused){pausedByUsVideo=currentVideoId;v.pause();}
          }
          else if(a.action==='resumeLookup'&&a.token===externalLookupToken){
            externalLookupToken='';const v=getVideo(),byUs=pausedByUsVideo;pausedByUsVideo=null;
            if(v?.paused&&byUs===currentVideoId&&!apHeld)void v.play();
          }
          else if(a.action==='seek')seekCue(a.index,!!a.play);
          else if(a.action==='save')void toggleSentence(a.index);
          else if(a.action==='lookup' && typeof a.word==='string' && a.word.length<=200)openLookup(a.word,a.index);
          sendResponse({ok:true});return true;
        }
        if (m.type === 'blc-sub-get') {
          const v = getVideo();
          const state: SubViewState = {
            type: 'blc-sub-state',
            videoId: currentVideoId,
            title: document.title,
            trackKind: lastTrack === 'asr' ? 'asr' : cues.length ? 'manual' : '',
            trackLang: lastTrackLang,
            translationLang: targetLangOf(),
            trackId: lastTrackId,
            cues: cues.map((c, i) => ({
              id: i,
              startMs: c.start,
              endMs: c.start + c.dur,
              text: c.text,
              zh: translations.get(i) ?? null,
            })),
            chineseVisible: zhVisible,
            currentIndex: currentIdx,
            playing: !!v && !v.paused,
            notice,
          };
          sendResponse(state);
          return true;
        }
        if (m.type === 'blc-sub-control') {
          const c = m as SubControlMessage;          if (!c || c.videoId !== currentVideoId) {
            sendResponse({ ok: false, error: 'video-mismatch' });
            return true;
          }
          const v = getVideo();
          if (!v) {
            sendResponse({ ok: false, error: 'no-video' });
            return true;
          }
          const cueStart = (i: number): number | null =>
            i >= 0 && i < cues.length ? cues[i]!.start : null;
          try {
            if (c.action === 'seek' && typeof c.timeMs === 'number') {
              v.currentTime = c.timeMs / 1000;
            } else if (c.action === 'togglePlay') {
              if (v.paused) void v.play();
              else v.pause();
            } else if (c.action === 'replay') {
              const s = cueStart(currentIdx) ?? cueStart(0);
              if (s !== null) {
                v.currentTime = s / 1000;
                void v.play();
              }
            } else if (c.action === 'next' || c.action === 'prev') {
              const target =
                currentIdx < 0
                  ? 0
                  : Math.min(cues.length - 1, Math.max(0, currentIdx + (c.action === 'next' ? 1 : -1)));
              const s = cueStart(target);
              if (s !== null) v.currentTime = s / 1000;
            }
          } catch {
            /* ignore */
          }
          sendResponse({ ok: true });
          return true;
        }
        // M5 问答：来源描述与按需材料（当前轨道英文字幕，不等待中文翻译）
        if (m.type === 'blc-chat-source') {
          const info = buildChatSourceInfo();
          sendResponse(info);
          return true;
        }
        if (m.type === 'blc-chat-material') {
          sendResponse({ type: 'blc-chat-material-info', material: buildVideoMaterial() });
          return true;
        }
        return undefined;
      },
    );

    // ---- 词状态（字幕词标记）：索引 + 广播同步 -------------------------------------

    async function refreshSurfaceStatus(): Promise<void> {
      const r = await send<{ ok: boolean; items?: VocabIndexItem[] }>({
        type: 'vocabIndex',
      });
      if (r?.ok && Array.isArray(r.items)) {
        // 与页面标记共用语言桶：词条只在同语言轨道文本上标状态
        markBuckets = buildMarkBuckets(r.items);
        queueRender();
      }
    }

    /** 轨道语言下的词状态（按语言规范化；跨语言同形词互不套用）。 */
    function wordStatus(text: string): string | undefined {
      const lang = baseLang(lastTrackLang) || 'en';
      return markBuckets
        .get(lang)
        ?.statusByKey.get(normalizeExpressionInLanguage(text, lang));
    }

    browser.runtime.onMessage.addListener((msg: unknown) => {
      const t = (msg as { type?: string })?.type;
      if (t === 'vocab-changed') { void refreshSurfaceStatus(); }
      if (t === 'sentences-changed') void refreshSaved();
      if (t === 'settings-changed') void refreshSettings();
    });

    // ---- 站内导航：清旧状态、重新发起 -------------------------------------------

    function onNav(): void {
      const from = currentVideoId;
      const to = videoIdFromLocation();
      if (from === to) return; // 同视频页内导航不算换视频
      if (!to) restoreNativeCaptions();
      else nativeCaptionsWereOn = null;
      stopTranslation();
      // 换视频：旧选区候选立即失效（读取侧另有身份校验兜底）
      void send({ type: 'selectionCandidateSet', candidate: null });
      platformState = 'idle'; failedCues.clear();
      translationMode = settings.translationMode;
      currentVideoId = to;
      modeReady = false; modeBusy = false; autoPause = false; apIndex = -1; apHeld = false; apLastStopped = -1;
      floatingPanel.hide(); translationPopup.close(); selectionPill.reset();
      void updateVideoSession();
      navSeq++;
      cues = [];
      lastTrack = '';
      lastTrackLang = '';
      lastTrackId = '';
      tracklist = [];
      preferTried = false;
      notice = '';
      nocuesReason = '';
      nocuesRetries = 0;
      translations.clear(); translationSources.clear();
      translateSession = '';
      currentIdx = -1;
      pausedByUsVideo = null;
      // 换视频：旧弹窗直接移除（不触发恢复播放回调）
      popup.close(true);
      removeSubsHost();
      log('clear', { from, to, navSeq });
      sendConfig();
      if (to) {
        if (bilingualOn) {
          hideNativeCaptions();
          ensureCaptionsOn(20);
        }
      }
      renderBar();
      renderBadge();
    }

    window.addEventListener('yt-navigate-finish', onNav, true);

    // 轮询兜底：yt-navigate-finish 以外的地址变化（如 Shorts 快速滑动）。
    setInterval(() => {
      try {
        const v = videoIdFromLocation();
        if (v && v !== currentVideoId) onNav();
      } catch {
        /* ignore */
      }
    }, 500);

    // 诊断轮询：CC 按钮状态可能被页面或其它扩展随时改变。
    setInterval(readCcDiag, 1500);

    // ---- 接收 MAIN world 的消息 --------------------------------------------------

    window.addEventListener('message', (evt) => {
      try {
        if (evt.source !== window) return;
        const d = evt.data as Partial<InjectMessage> | undefined;
        if (!d || d.source !== INJECT_SOURCE) return;

        // 双重过期闸：消息所属视频 ≠ 当前视频，或请求令牌已过 —— 都丢弃。
        const nowVid = videoIdFromLocation();
        if (d.videoId !== nowVid) {
          log('drop-stale', { msgVideoId: d.videoId, currentVideoId: nowVid });
          return;
        }
        if (typeof d.nonce !== 'number' || d.nonce !== nonce) {
          log('drop-nonce', { msgNonce: d.nonce, currentNonce: nonce });
          return;
        }

        if (d.type === 'translation') {
          if (d.requestId !== platformRequest || d.trackId !== lastTrackId || translationMode !== 'regular') return;
          if (platformTimer) clearTimeout(platformTimer);
          platformRequest = null; platformState = 'done';
          const translated = Array.isArray(d.cues) ? d.cues : [];
          applyPlatformCues(translated);
          if (translated.some(c => c.zh)) void send({ type: 'captionCache', key: captionCacheKey(), cues: translated });
          scheduleTranslate();
          return;
        }

        if (d.type === 'tracklist' && Array.isArray(d.tracks)) {
          tracklist = (d.tracks as { lang?: unknown; kind?: unknown }[])
            .filter((t) => typeof t.lang === 'string')
            .map((t) => ({
              lang: baseLang(String(t.lang)),
              kind: t.kind === 'asr' ? 'asr' : 'manual',
            }));
          log('tracklist', { count: tracklist.length, tracks: tracklist });
          evaluateTrackPreference();
          return;
        }

        if (d.type === 'cues' && Array.isArray(d.cues)) {
          const kind = d.trackKind === 'asr' ? 'asr' : 'manual';
          // 保留轨道完整语言标签（含变体，如 pt-BR）；匹配用 primary。
          const lang = String(d.trackLang || '').toLowerCase();
          const newTrackId = String(d.trackId || '');
          // 同轨道重复产出（如 nocues 重试后的 config）不丢已取得的译文
          if (lastTrackId !== newTrackId) {
            pausedByUsVideo = null; popup.close(true); apIndex = -1; apHeld = false; apLastStopped = -1;
            stopTranslation(); platformState = 'idle'; failedCues.clear();
            translations.clear();
            translateSession = '';
          }
          cues = kind === 'asr' ? normalizeAsrCues(d.cues as Cue[]) : d.cues as Cue[];
          lastTrack = kind;
          lastTrackLang = lang;
          lastTrackId = newTrackId;
          nocuesReason = '';
          nocuesRetries = 0;
          currentIdx = -1;
          if (typeof d.seen === 'number') sawTimedtext = d.seen;
          // M11：非英文原文字幕是合法轨道，按实际语言继续（不强切英语）
          notice = '';
          evaluateTrackPreference();
          log('cues', {
            videoId: d.videoId,
            track: `${lastTrackLang}(${lastTrack})`,
            raw: (d.cues as Cue[]).length, // 合并前（供与 M0 基线核对）
            count: cues.length, // 合并后展示条数
            first: cues.length ? formatCue(cues[0]!) : '',
          });
          renderBar();
          return;
        }
        if (d.type === 'nocues') {
          // 已有当前视频字幕（如英文轨道偏好切换失败回退）：保留现状
          if (cues.length) {
            if (typeof d.seen === 'number') sawTimedtext = d.seen;
            log('nocues-ignored-have-cues', { reason: d.reason });
            return;
          }
          nocuesReason = d.reason || 'unknown';
          if (typeof d.seen === 'number') sawTimedtext = d.seen;
          log('nocues', { videoId: d.videoId, reason: nocuesReason, seen: sawTimedtext });
          if (preferTried && nocuesReason.startsWith('prefer-')) {
            // 英文轨道偏好失败：等原轨道产出（inject 已复位 producedForUrl）
            renderBar();
            return;
          }
          if (nocuesRetries++ < 3) {
            const rearmed = rearmCaptions();
            sendNudge(); // 播放器 API 强制选轨
            setTimeout(() => {
              sendConfig();
              ensureCaptionsOn(20);
            }, 800);
            log('nocues-retry', { attempt: nocuesRetries, rearmed });
          } else {
            notice = '未取得字幕';
            renderBar();
          }
        }
      } catch {
        /* ignore */
      }
    });

    // ---- storage 访问隔离探针（验收用） -------------------------------------------

    window.addEventListener('blc-probe-storage', () => {
      void (async () => {
        const root = document.documentElement;
        try {
          await browser.storage.local.get('blc-probe');
          root.setAttribute('data-blc-storage-probe', 'granted');
        } catch (e) {
          root.setAttribute('data-blc-storage-probe', `denied:${String((e as Error)?.message ?? e).slice(0, 80)}`);
        }
      })();
    });

    // ---- 启动 ---------------------------------------------------------------------

    const layoutStyle = document.createElement('style');
    layoutStyle.textContent = `
      #movie_player:has(#blc-subs-switch[data-open]) .ytp-chrome-bottom { opacity:1!important; pointer-events:auto!important; }
      /* 氛围灯画布是定位层；学习区域也需建立绘制层，不能被它盖住。 */
      #blc-learning-layout { min-width:0; position:relative; z-index:1; }
      #blc-learning-layout > :first-child { min-width:0; width:100%!important; }
      #blc-learning-layout > #blc-learning-panel { grid-column:2; grid-row:1 / span 2; }
      #blc-learning-layout #movie_player { width:100%!important; }
      #blc-learning-layout video { max-width:100%; object-fit:contain; }
    `;
    document.head.append(layoutStyle);

    log('boot', { videoId: currentVideoId, url: location.href.slice(0, 120) });
    if (currentVideoId) {
      if (bilingualOn) hideNativeCaptions();
      sendConfig();
      ensureCaptionsOn(20);
      renderBar();
    }
    void refreshSurfaceStatus();
    void refreshSaved();
    void refreshSettings();
    window.addEventListener('pagehide', stopTranslation);
  },
});
