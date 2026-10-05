import { alignTranslatedCues, normalizeAsrCues } from '@/shared/cues';
// MAIN world、document_start 的字幕嗅探脚本。
//
// 移植自 yt-dual-subs 的 inject.js（MIT，Gythiro，commit 5657c8a，2026-09-12，
// v3.7.0），见 docs/REFERENCES.md。核心链路：
//   1. 钩住 fetch / XMLHttpRequest，并以 PerformanceObserver（Resource Timing）
//      兜底，捕获播放器自己发出的 /api/timedtext 请求 URL —— 它携带当前有效
//      的 pot（proof-of-origin）令牌与签名，2025 年后不带 pot 直接请求
//      captionTracks 的 baseUrl 会得到空响应；
//   2. 复用该 URL（保留 pot 与全部参数）加 fmt=json3，在页面上下文
//      （同源、带 cookie）重新拉取并解析为 cue 列表；
//   3. 通过 window.postMessage 把 {videoId, nonce, cues} 发给隔离世界的
//      content script。
//
// 时序状态机（捕获归属、换视频重置、轨道身份固定）在 shared/subtitleTracker.ts，
// 由 tools/regress.ts 离线回归。M6 复用上游的 tlang URL 规则，时间对齐和请求取消在本项目实现。
// TTS、SRT 导出、Shorts 早nudge、自动配音纠正未移植。
// 轨道描述与身份规则集中在 subtitleTracker；播放器选轨与字幕获取只走一条路径。
//
// 约束（沿自上游）：绝不能向页面抛出异常 —— 所有钩子体都包在 try/catch 里。

import {
  buildJson3Url,
  captionTrackOf,
  captionUrlFor,
  isTimedtextUrl,
  trackKindOf,
  trackLangOf,
  trackOfUrl,
  videoIdFromUrl,
  type PlayerCaptionTrack,
  SubtitleSourceTracker,
} from '@/shared/subtitleTracker';
import { CONTENT_SOURCE, INJECT_SOURCE, type Cue } from '@/shared/protocol';

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    // ---- 防重复注入 ---------------------------------------------------------
    if ((window as any).__blcInjected) return;
    (window as any).__blcInjected = true;

    const videoIdFromLocation = (): string => videoIdFromUrl(location.href);
    const tracker = new SubtitleSourceTracker(videoIdFromLocation());

    // content script 是否已就绪（收到过 config）。就绪前不发起字幕拉取。
    let cfg = false;
    let nocuesTimer: ReturnType<typeof setTimeout> | null = null;
    // 请求令牌：与 content script 的 config 消息同步，回复带上它，
    // content script 据此丢弃过期请求的结果。
    let reqNonce = 0;
    let initialSelectionPending = true;
    // 钩子见过的 timedtext 请求总数（诊断用）。
    let seenTimedtext = 0;

    // ---- json3 拉取（页面上下文，同源使 pot/签名保持有效） -------------------

    // 我方自己的 timedtext 请求也会经过嗅探钩子；记录在途的精确 URL，
    // 命中时不当作播放器的新请求。ResourceObserver 在请求体完成后才回报，
    // 比 finally 晚，因此计数保留一段时间再清除。
    const selfUrls = new Map<string, number>();
    const SELF_URL_LINGER_MS = 5000;
    const TT_FETCH_TIMEOUT_MS = 12000;

    async function fetchJson3(url: string, signal?: AbortSignal): Promise<any> {
      selfUrls.set(url, (selfUrls.get(url) || 0) + 1);
      try {
        const res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TT_FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(TT_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`timedtext http ${res.status}`);
        const txt = await res.text();
        if (!txt) throw new Error('timedtext empty body');
        return JSON.parse(txt);
      } finally {
        setTimeout(() => {
          const n = (selfUrls.get(url) || 1) - 1;
          if (n > 0) selfUrls.set(url, n);
          else selfUrls.delete(url);
        }, SELF_URL_LINGER_MS);
      }
    }

    // 解析 json3 为 cue 列表。保持事件顺序（不排序）；对缺失/空 segs 稳健。
    // 自动字幕携带换人标记 “>>”/“>>>”，在产出文本时剥除。
    function parseJson3(json: any): Cue[] {
      const cues: Cue[] = [];
      if (!json || !Array.isArray(json.events)) return cues;
      for (const ev of json.events) {
        if (!ev || !Array.isArray(ev.segs)) continue;
        let text = '';
        let off = 0;
        for (const s of ev.segs) {
          if (s && typeof s.utf8 === 'string') {
            text += s.utf8;
            // 记录最后一个非空白词的偏移；ASR 逐词携带 tOffsetMs，
            // 空白 seg（“\n”）也可能带，会虚增。
            if (s.utf8.trim() && typeof s.tOffsetMs === 'number') off = s.tOffsetMs;
          }
        }
        text = text.replace(/\s+/g, ' ').trim();
        text = text.replace(/(^|\s)>{2,}\s*/g, '$1').trim();
        if (!text) continue; // 跳过样式/窗口/空白事件
        const start = typeof ev.tStartMs === 'number' ? ev.tStartMs : 0;
        const dur = typeof ev.dDurationMs === 'number' ? ev.dDurationMs : 0;
        cues.push({ start, dur, text, lastOff: start + off });
      }
      return cues;
    }

    // ---- 与 content script 的桥 ---------------------------------------------

    function post(
      type: 'cues' | 'nocues' | 'tracklist' | 'track-selected' | 'translation',
      nonce: number,
      extra: Record<string, unknown> = {},
    ): void {
      try {
        window.postMessage(
          Object.assign(
            {
              source: INJECT_SOURCE,
              type,
              videoId: tracker.currentVideoId,
              nonce,
              seen: seenTimedtext,
            },
            extra,
          ),
          '*',
        );
      } catch {
        /* never throw */
      }
    }

    function clearNocuesTimer(): void {
      if (nocuesTimer) {
        clearTimeout(nocuesTimer);
        nocuesTimer = null;
      }
    }

    function armNocuesTimer(): void {
      clearNocuesTimer();
      const vid = tracker.currentVideoId;
      const nonceAtArm = reqNonce;
      nocuesTimer = setTimeout(() => {
        nocuesTimer = null;
        if (vid !== tracker.currentVideoId) return;
        if (nonceAtArm !== reqNonce) return;
        if (tracker.hasCurrentSource()) return;
        post('nocues', nonceAtArm, { reason: 'no-timedtext-seen' });
      }, 6000);
    }

    // ---- 产出字幕（新来源/配置取消旧请求，不让旧视频阻塞当前视频） ------------

    let subtitleSource: { src: string; videoId: string; trackId: string; cues: Cue[]; kind: 'manual' | 'asr' } | null = null;
    let translationController: AbortController | null = null;
    let sourceController: AbortController | null = null;

    async function produceCues(): Promise<void> {
      // 开始即固定来源与轨道身份：此后所有读取只用固定值（时序 B）。
      const pinned = tracker.pinForProduce();
      if (!cfg || !pinned) return;
      const src = pinned.src;
      // 捕获的源 URL 必须属于当前视频。
      if (tracker.producedForUrl === src) return;
      sourceController?.abort();
      const controller = new AbortController();
      sourceController = controller;
      tracker.producedForUrl = src;
      clearNocuesTimer();

      const vid = tracker.currentVideoId;
      // nonce 在产出开始时定格：并发产出的回复必须对准各自的请求。
      const myNonce = reqNonce;
      const stale = () => controller.signal.aborted || myNonce !== reqNonce || vid !== videoIdFromLocation() || tracker.staleAfterFetch(pinned.trackKey);
      const kind = trackKindOf(src, location.href);
      const lang = trackLangOf(src, location.href);
      try {
        const json = await fetchJson3(buildJson3Url(src, location.href), controller.signal);
        // 拉取期间轨道或视频已变 —— 旧结果整体丢弃，不带新元数据发出。
        if (stale()) return;
        const cues = parseJson3(json);
        if (!cues.length) {
          tracker.producedForUrl = ''; // 轨道稍后可能产出内容，允许重试
          post('nocues', myNonce, { reason: 'empty-track' });
          return;
        }
        translationController?.abort();
        subtitleSource = { src, videoId: vid, trackId: pinned.trackKey, cues, kind };
        post('cues', myNonce, {
          cues,
          trackKind: kind,
          trackLang: lang,
          trackId: pinned.trackKey,
        });
      } catch (err) {
        if (stale()) return;
        tracker.producedForUrl = ''; // 允许下次捕获时重试
        post('nocues', myNonce, { reason: (err as Error)?.name === 'TimeoutError' ? 'fetch-timeout' : 'fetch-failed' });
      }
    }

    /** 目标语言 → timedtext tlang 代码（zh 保留简繁区分）。 */
    function tlangCode(tag: string): string {
      const t = (tag || 'zh-Hans').toLowerCase();
      const primary = t.split('-')[0]!;
      if (primary === 'zh') return /^zh-hant/.test(t) ? 'zh-Hant' : 'zh-Hans';
      return primary;
    }

    async function produceTranslation(requestId: string, trackId: string, nonce: number, targetTag = 'zh-Hans'): Promise<void> {
      translationController?.abort();
      const controller = new AbortController();
      translationController = controller;
      const source = subtitleSource;
      if (!source || source.videoId !== videoIdFromLocation() || source.trackId !== trackId) return;
      const currentSourceUrl = captionUrlFor({ id: trackOfUrl(source.trackId)!.id,
        url: tracker.sourceKey === source.trackId ? tracker.sourceUrl : source.src }, tracker.tokenSourceUrl, location.href)!;
      const targetPrimary = tlangCode(targetTag).split('-')[0]!.toLowerCase();
      let normalized = source.kind === 'asr' ? normalizeAsrCues(source.cues) : source.cues.map(c => ({ ...c }));
      try {
        const tracks = captionTracksOf(activePlayer());
        const target = tracks.filter(t => t.lang.split('-')[0] === targetPrimary).sort((a, b) => Number(a.kind === 'asr') - Number(b.kind === 'asr'))[0];
        if (target) {
          // 上游捕获 URL 的有效 pot 保留；独立轨道自身签名优先。
          const url = captionUrlFor(target, tracker.tokenSourceUrl, location.href);
          if (url) try { normalized = alignTranslatedCues(normalized, parseJson3(await fetchJson3(url, controller.signal))); } catch { /* 缺失部分继续平台翻译 */ }
        }
        if (normalized.some(c => !c.zh) && !controller.signal.aborted) {
          // yt-dual-subs inject.js buildUrl：保留签名及 pot，仅设置 fmt/tlang。
          const url = new URL(currentSourceUrl); url.searchParams.set('tlang', tlangCode(targetTag));
          try {
            const translated = parseJson3(await fetchJson3(url.toString(), controller.signal));
            const byStart = new Map(translated.map(c => [c.start, c.text]));
            const paired = source.cues.map(c => ({ ...c, zh: byStart.get(c.start) }));
            const merged = source.kind === 'asr' ? normalizeAsrCues(paired) : paired;
            const byCue = new Map(merged.map(c => [c.start, c.zh]));
            normalized = normalized.map(c => ({ ...c, zh: c.zh ?? byCue.get(c.start) }));
          } catch { /* 通用翻译在隔离世界接手缺失项 */ }
        }
      } finally {
        if (!controller.signal.aborted && source === subtitleSource && source.videoId === videoIdFromLocation()) {
          post('translation', nonce, { videoId: source.videoId, trackId, requestId, cues: normalized });
        }
      }
    }

    // ---- 捕获 ---------------------------------------------------------------

    function acquireCurrentTrack(): void {
      if (!cfg) return;
      if (tracker.hasCurrentSource()) void produceCues();
      else armNocuesTimer();
    }

    function resetVideo(): void {
      if (!tracker.resetForVideo(videoIdFromLocation())) return;
      cancelAcquisition();
      initialSelectionPending = true;
    }

    function stopRequests(): void {
      sourceController?.abort();
      translationController?.abort();
      subtitleSource = null;
    }

    function cancelAcquisition(): void {
      cfg = false;
      stopRequests();
      clearNocuesTimer();
    }

    function beginAcquisition(nonce: number, initialize = false): void {
      resetVideo();
      if (!initialize) initialSelectionPending = false;
      cancelAcquisition();
      cfg = true;
      reqNonce = nonce;
      tracker.producedForUrl = '';
      postTracklist(nonce);
    }

    function currentPlayerTrack(): PlayerCaptionTrack | null {
      try { return captionTrackOf((activePlayer() as any)?.getOption?.('captions', 'track')); }
      catch { return null; } // captions 模块未加载时 API 可能拒绝读取。
    }

    /** 唯一选轨落点：来源匹配目标，捕获 URL 只补请求凭据。 */
    function useTrack(track: PlayerCaptionTrack): void {
      const tokenSource = tracker.tokenSourceUrl;
      if (tracker.selectTrack(track)) {
        stopRequests();
        if (cfg) post('track-selected', reqNonce, { track: tracker.selectedTrack });
      }
      const target = track.url ? track : captionTracksOf(activePlayer()).find(t => t.id === track.id) ?? track;
      const url = captionUrlFor(target, tokenSource, location.href);
      // 无凭据时等播放器自己的请求；不猜签名，也不请求必然为空的轨道表 URL。
      if (!tracker.hasCurrentSource() && url && new URL(url).searchParams.has('pot')) tracker.noteTimedtext(url, location.href);
      acquireCurrentTrack();
    }

    function observePlayerTrack(): void {
      const current = currentPlayerTrack();
      const changed = tracker.observePlayer(current);
      if (cfg && initialSelectionPending && current) {
        const tracks = captionTracksOf(activePlayer());
        if (tracks.length) {
          initialSelectionPending = false;
          const manual = current.kind === 'asr' ? tracks.find(t => t.lang === current.lang && t.kind === 'manual') : null;
          if (manual && typeof (activePlayer() as any)?.setOption === 'function') { chooseTrack(manual); return; }
        }
      }
      if (changed && current) useTrack(current);
    }

    function chooseTrack(track: PlayerCaptionTrack): void {
      initialSelectionPending = false;
      // 记住操作前的确认值，播放器异步反映 setOption 时不会把旧读数当新操作。
      tracker.observePlayer(currentPlayerTrack());
      useTrack(track);
      const p = activePlayer() as any;
      p.setOption('captions', 'track', track.native);
      if (!tracker.hasCurrentSource()) nudgeCaptions();
    }

    // 记录在途看到的 timedtext URL。
    function noteTimedtext(url: unknown, startedAt = performance.now()): void {
      try {
        if (!isTimedtextUrl(url)) return;
        if (selfUrls.has(url as string)) return; // 这是我方自己的请求
        resetVideo();
        observePlayerTrack();
        seenTimedtext++;
        const result = tracker.noteTimedtext(url as string, location.href, startedAt);
        // 同轨道从无 pot 到有效 pot 是来源修复；不能只存 URL 却继续等旧请求。
        if (result === 'new' || (result === 'refresh' && subtitleSource?.trackId !== tracker.sourceKey)) acquireCurrentTrack();
      } catch {
        /* never throw */
      }
    }

    // ---- 播放器 API 强制选轨（移植自上游 nudgeCaptions / captionTracksOf） ------
    // content script 点击 CC 按钮是首选；当按钮路径失效（被其它扩展接管、
    // 状态不同步等）时，通过播放器自己的 API 加载 captions 模块并选择轨道，
    // 促使播放器发出 timedtext 请求 —— 随后的请求照常被嗅探捕获。

    function activePlayer(): HTMLElement | null {
      return document.getElementById('movie_player');
    }

    function playerResponseFor(vid: string): any {
      try {
        const pr = (window as any).ytInitialPlayerResponse;
        if (pr && pr.videoDetails && pr.videoDetails.videoId === vid) return pr;
      } catch {
        /* ignore */
      }
      try {
        const p = activePlayer() as any;
        if (p && typeof p.getPlayerResponse === 'function') {
          const pr = p.getPlayerResponse();
          if (pr && pr.videoDetails && pr.videoDetails.videoId === vid) return pr;
        }
      } catch {
        /* ignore */
      }
      return null;
    }

    function captionTracksOf(p: any): PlayerCaptionTrack[] {
      let tracks: any[] = [];
      try {
        const list = p?.getOption?.('captions', 'tracklist');
        if (Array.isArray(list)) tracks = list;
      } catch {
        /* ignore */
      }
      if (!tracks.length) {
        const pr = playerResponseFor(tracker.currentVideoId);
        const list = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (Array.isArray(list)) tracks = list;
      }
      return tracks.map(captionTrackOf).filter((t): t is PlayerCaptionTrack => t !== null);
    }

    function defaultCaptionTrack(): PlayerCaptionTrack | null {
      const r = playerResponseFor(tracker.currentVideoId)?.captions?.playerCaptionsTracklistRenderer;
      const audio = r?.audioTracks?.[r.defaultAudioTrackIndex ?? 0];
      const target = captionTrackOf(r?.captionTracks?.[audio?.defaultCaptionTrackIndex]);
      if (!target) return null;
      return captionTracksOf(activePlayer()).find(t => t.lang === target.lang && t.kind === 'manual') ?? target;
    }

    function nudgeCaptions(): void {
      const vid = tracker.currentVideoId, nonce = reqNonce, version = tracker.selectionVersion;
      const live = () => cfg && vid === videoIdFromLocation() && nonce === reqNonce && version === tracker.selectionVersion && !subtitleSource;
      const p = activePlayer() as any;
      p?.loadModule?.('captions');
      setTimeout(() => {
        try {
          if (!live()) return;
          const player = activePlayer() as any;
          const current = currentPlayerTrack();
          if (typeof player?.setOption === 'function') {
            if (!current) {
              const target = defaultCaptionTrack();
              if (target) chooseTrack(target);
              return;
            }
            player.setOption('captions', 'track', {});
            setTimeout(() => {
              try {
                if (live() && !currentPlayerTrack()) (activePlayer() as any)?.setOption?.('captions', 'track', current.native);
              } catch { /* 页面播放器调用不能影响播放。 */ }
            }, 300);
          } else {
            // 播放器 API 不可用时，CC 唤醒也在同一代次内执行。
            const cc = player?.querySelector('.ytp-subtitles-button') as HTMLElement | null;
            if (!cc || cc.getAttribute('aria-disabled') === 'true') return;
            if (cc.getAttribute('aria-pressed') === 'true') cc.click();
            setTimeout(() => {
              if (live() && cc.isConnected && cc.getAttribute('aria-pressed') !== 'true') cc.click();
            }, 300);
          }
        } catch { /* 页面播放器调用不能影响播放。 */ }
      }, 400);
    }

    // ---- 轨道表上报（config 后尽快；playerResponse 未就绪时短暂重试） ----------

    function postTracklist(nonceAtConfig: number, attempt = 0): void {
      try {
        if (!cfg || nonceAtConfig !== reqNonce) return;
        const p = activePlayer() as any;
        const list = captionTracksOf(p);
        if (!list.length && attempt < 3) {
          setTimeout(() => postTracklist(nonceAtConfig, attempt + 1), 1000);
          return;
        }
        const tracks = list.map(({ url, native, ...track }) => track);
        post('tracklist', nonceAtConfig, { tracks });
      } catch {
        /* never throw */
      }
    }

    // ---- 换视频轮询（config 之外的第二通道） -----------------------------------

    setInterval(() => {
      try {
        resetVideo();
        observePlayerTrack(); // 原生字幕命中缓存不发网络请求时仍能改轨。
      } catch {
        /* never throw */
      }
    }, 500);

    // ---- 接收 content script 的消息 ------------------------------------------

    window.addEventListener('message', (evt) => {
      try {
        if (evt.source !== window) return;
        const d = evt.data;
        if (!d || d.source !== CONTENT_SOURCE) return;

        if (d.type === 'source-cancel') {
          if (d.nonce !== reqNonce) return;
          cancelAcquisition();
          tracker.clearSource();
          return;
        }

        if (d.type === 'translation-cancel') { translationController?.abort(); return; }
        if (d.type === 'translation-request') {
          if (cfg && d.videoId === videoIdFromLocation() && typeof d.requestId === 'string' && typeof d.trackId === 'string') void produceTranslation(d.requestId, d.trackId, reqNonce, typeof d.targetLang === 'string' ? d.targetLang : 'zh-Hans');
          return;
        }
        if (d.type === 'bye') {
          cancelAcquisition();
          // 扩展已重载/移除：不再为一个已经不在的监听者拉取字幕。
          return;
        }
        if (d.type === 'nudge') {
          // CC 按钮路径未产生 timedtext：用播放器 API 强制选轨。
          resetVideo();
          if (cfg) nudgeCaptions();
          return;
        }
        if (d.type === 'select-track') {
          if (typeof d.nonce !== 'number' || d.nonce < reqNonce || d.videoId !== videoIdFromLocation()) return;
          beginAcquisition(d.nonce);
          const target = captionTracksOf(activePlayer()).find(t => t.id === d.trackId);
          const p = activePlayer() as any;
          if (!target || typeof p?.setOption !== 'function') {
            post('nocues', reqNonce, { reason: 'track-selection-unavailable' });
            return;
          }
          chooseTrack(target);
          return;
        }
        if (d.type === 'config') {
          // config 是权威的导航信号：resetForVideo 保留已属于当前视频的来源
          //（时序 A），不靠 nudge 重抓。
          if (typeof d.nonce !== 'number' || d.nonce < reqNonce) return;
          beginAcquisition(d.nonce, true);
          observePlayerTrack();
          const selected = tracker.selectedTrack;
          const target = selected ? captionTracksOf(activePlayer()).find(t => t.id === selected.id) : null;
          if (target) useTrack(target);
          acquireCurrentTrack();
        }
      } catch {
        /* never throw */
      }
    });

    // ---- 钩住 XMLHttpRequest -------------------------------------------------

    try {
      const XHR = XMLHttpRequest.prototype as any;
      const origOpen = XHR.open;
      const origSend = XHR.send;

      XHR.open = function (this: any, _method: string, url: string) {
        try {
          this.__blcUrl = url;
        } catch {
          /* ignore */
        }
        return origOpen.apply(this, arguments);
      };

      XHR.send = function (this: any) {
        try {
          noteTimedtext(this.__blcUrl);
        } catch {
          /* ignore */
        }
        return origSend.apply(this, arguments);
      };
    } catch {
      /* never throw */
    }

    // ---- 钩住 fetch -----------------------------------------------------------

    try {
      const origFetch = window.fetch;
      if (typeof origFetch === 'function') {
        window.fetch = function (this: Window, input: RequestInfo | URL) {
          try {
            let url = '';
            if (typeof input === 'string') url = input;
            else if (input && typeof (input as Request).url === 'string') {
              url = (input as Request).url;
            }
            noteTimedtext(url);
          } catch {
            /* ignore */
          }
          return origFetch.apply(this, arguments as any);
        };
      }
    } catch {
      /* never throw */
    }

    // ---- 与钩子无关的兜底：Resource Timing ------------------------------------

    // 播放器的 /api/timedtext 请求无论走 XHR 还是 fetch，都会以完整 URL
    //（含 pot）出现在 Resource Timing 里 —— 即使别的扩展锁了
    // XMLHttpRequest.prototype.open 导致我方钩子没装上。
    try {
      const scan = (entries: PerformanceEntry[]) => {
        for (const e of entries) {
          if (e && typeof e.name === 'string' && isTimedtextUrl(e.name)) {
            noteTimedtext(e.name, e.startTime);
          }
        }
      };
      try {
        scan(performance.getEntriesByType('resource'));
      } catch {
        /* ignore */
      }
      if (typeof PerformanceObserver === 'function') {
        const po = new PerformanceObserver((list) => {
          try {
            scan(list.getEntries());
          } catch {
            /* ignore */
          }
        });
        po.observe({ type: 'resource', buffered: true } as PerformanceObserverInit);
      }
    } catch {
      /* never throw */
    }
  },
});
