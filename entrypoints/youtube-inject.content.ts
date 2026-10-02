import { alignTranslatedCues, normalizeAsrCues } from '@/shared/cues';
// MAIN world、document_start 的字幕嗅探脚本。
//
// 移植自 yt-dual-subs 的 inject.js（MIT，Gythiro，commit 5657c8a，2026-09-12，
// v3.7.0），见 public/THIRD_PARTY_NOTICES.txt。核心链路：
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
// M2 增补（自研，非上游）：轨道表上报（tracklist）与英文轨道偏好变体拉取
//（prefer —— 在捕获源 URL 上换 lang/kind，pot 与签名原样保留）。
//
// 约束（沿自上游）：绝不能向页面抛出异常 —— 所有钩子体都包在 try/catch 里。

import {
  buildJson3Url,
  isTimedtextUrl,
  normTrackKey,
  trackKindOf,
  trackLangOf,
  videoIdFromUrl,
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
    // 钩子见过的 timedtext 请求总数（诊断用）。
    let seenTimedtext = 0;

    // ---- json3 拉取（页面上下文，同源使 pot/签名保持有效） -------------------

    // 我方自己的 timedtext 请求也会经过嗅探钩子；记录在途的精确 URL，
    // 命中时不当作播放器的新请求。ResourceObserver 在请求体完成后才回报，
    // 比 finally 晚，因此计数保留一段时间再清除。
    const selfUrls = new Map<string, number>();
    const SELF_URL_LINGER_MS = 5000;
    const TT_FETCH_TIMEOUT_MS = 20000;
    const RETRY_DELAYS_MS = [300, 800];

    async function fetchJson3(url: string, signal?: AbortSignal): Promise<any> {
      selfUrls.set(url, (selfUrls.get(url) || 0) + 1);
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(TT_FETCH_TIMEOUT_MS),
        });
      } finally {
        setTimeout(() => {
          const n = (selfUrls.get(url) || 1) - 1;
          if (n > 0) selfUrls.set(url, n);
          else selfUrls.delete(url);
        }, SELF_URL_LINGER_MS);
      }
      if (!res.ok) {
        const err = new Error(`timedtext http ${res.status}`);
        (err as any).status = res.status;
        throw err;
      }
      const txt = await res.text();
      if (!txt) throw new Error('timedtext empty body');
      return JSON.parse(txt);
    }

    // 只重试“偶发”失败（网络错误/空响应/坏 JSON/429/5xx）；
    // 其余 4xx 是明确答复，不值得再花两次请求。
    function isHiccup(err: unknown): boolean {
      const s = (err as any)?.status;
      if (typeof s !== 'number') return true;
      return s === 429 || s >= 500;
    }

    async function fetchJson3Retry(url: string, wantVid: string): Promise<any> {
      for (let i = 0; ; i++) {
        try {
          return await fetchJson3(url);
        } catch (err) {
          if (i >= RETRY_DELAYS_MS.length || !isHiccup(err)) throw err;
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
          // 重试期间已导航离开：结果本就会被丢弃，下一个视频的产出已在路上。
          if (wantVid && wantVid !== tracker.currentVideoId) throw err;
        }
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
      type: 'cues' | 'nocues' | 'tracklist' | 'translation',
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

    // ---- 轨道偏好（content script 的 prefer 消息） ---------------------------

    let pendingPrefer: { lang: string; kind: 'manual' | 'asr' } | null = null;

    /** 在捕获的源 URL（带 pot）上换语言 / 类型；其余参数原样保留。 */
    function buildVariantUrl(
      base: string,
      prefer: { lang: string; kind: 'manual' | 'asr' },
    ): string {
      try {
        const u = new URL(base, location.href);
        u.searchParams.set('lang', prefer.lang);
        if (prefer.kind === 'asr') u.searchParams.set('kind', 'asr');
        else u.searchParams.delete('kind');
        return u.toString();
      } catch {
        return base;
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
        if (tracker.sourceUrl) return; // 捕获与计时器竞争 —— 一切正常
        post('nocues', nonceAtArm, { reason: 'no-timedtext-seen' });
      }, 6000);
    }

    // ---- 产出字幕（同一时刻只允许一个在跑，并发请求排队） ---------------------

    let englishSource: { src: string; videoId: string; trackId: string; cues: Cue[]; kind: string } | null = null;
    let chineseController: AbortController | null = null;
    let producing = false;
    let produceAgain = false;
    let produceAgainForce = false;

    async function produceCues(force: boolean): Promise<void> {
      if (producing) {
        // 排队而不是丢弃：换视频期间上一个产出还在途时，新视频的捕获不能丢。
        produceAgain = true;
        if (force) produceAgainForce = true;
        return;
      }
      producing = true;
      try {
        await produceCuesOnce(force);
      } finally {
        producing = false;
        if (produceAgain) {
          produceAgain = false;
          const again = produceAgainForce;
          produceAgainForce = false;
          void produceCues(again);
        }
      }
    }

    async function produceCuesOnce(force: boolean): Promise<void> {
      // 开始即固定来源与轨道身份：此后所有读取只用固定值（时序 B）。
      const pinned = tracker.pinForProduce();
      if (!cfg || !pinned) return;
      // 轨道偏好：在捕获源上切换语言/类型；偏好一旦消费即固定本次产出
      const prefer = pendingPrefer;
      const src = prefer ? buildVariantUrl(pinned.src, prefer) : pinned.src;
      // 捕获的源 URL 必须属于当前视频。
      if (!force && tracker.producedForUrl === src) return;
      tracker.producedForUrl = src;
      clearNocuesTimer();

      const vid = tracker.currentVideoId;
      // nonce 在产出开始时定格：并发产出的回复必须对准各自的请求。
      const myNonce = reqNonce;
      const kind = prefer
        ? prefer.kind
        : trackKindOf(src, location.href);
      const lang = prefer ? prefer.lang : trackLangOf(src, location.href);
      try {
        const json = await fetchJson3Retry(buildJson3Url(src, location.href), vid);
        // 拉取期间轨道或视频已变 —— 旧结果整体丢弃，不带新元数据发出。
        if (tracker.staleAfterFetch(pinned.trackKey)) return;
        const cues = parseJson3(json);
        if (!cues.length) {
          if (tracker.staleAfterFetch(pinned.trackKey)) return;
          tracker.producedForUrl = ''; // 轨道稍后可能产出内容，允许重试
          if (prefer) {
            pendingPrefer = null; // 偏好轨道不存在：让原轨道自然产出
            post('nocues', myNonce, { reason: 'prefer-empty-track' });
            return;
          }
          post('nocues', myNonce, { reason: 'empty-track' });
          return;
        }
        if (prefer) pendingPrefer = null; // 偏好产出成功，不再作用于后续产出
        chineseController?.abort();
        englishSource = { src, videoId: vid, trackId: normTrackKey(src, location.href), cues, kind };
        post('cues', myNonce, {
          cues,
          trackKind: kind,
          trackLang: lang,
          trackId: normTrackKey(src, location.href),
        });
      } catch {
        if (tracker.staleAfterFetch(pinned.trackKey)) return;
        tracker.producedForUrl = ''; // 允许下次捕获时重试
        if (prefer) {
          pendingPrefer = null;
          post('nocues', myNonce, { reason: 'prefer-fetch-failed' });
          return;
        }
        post('nocues', myNonce, { reason: 'fetch-failed' });
      }
    }

    async function produceChinese(requestId: string, trackId: string, nonce: number): Promise<void> {
      chineseController?.abort();
      const controller = new AbortController();
      chineseController = controller;
      const source = englishSource;
      if (!source || source.videoId !== videoIdFromLocation() || source.trackId !== trackId) return;
      let normalized = source.kind === 'asr' ? normalizeAsrCues(source.cues) : source.cues.map(c => ({ ...c }));
      try {
        const tracks = captionTracksOf(activePlayer()) ?? [];
        const chinese = tracks.filter(t => /^zh(?:-|$)/.test(t.languageCode ?? '')).sort((a, b) => Number(a.kind === 'asr') - Number(b.kind === 'asr'))[0];
        if (chinese) {
          // 上游捕获 URL 的有效 pot 保留；独立轨道自身签名优先。
          const url = new URL(chinese.baseUrl || buildVariantUrl(source.src, { lang: chinese.languageCode, kind: chinese.kind === 'asr' ? 'asr' : 'manual' }));
          const pot = new URL(source.src).searchParams.get('pot');
          if (pot && !url.searchParams.has('pot')) url.searchParams.set('pot', pot);
          url.searchParams.delete('tlang'); url.searchParams.set('fmt', 'json3');
          try { normalized = alignTranslatedCues(normalized, parseJson3(await fetchJson3(url.toString(), controller.signal))); } catch { /* 缺失部分继续平台翻译 */ }
        }
        if (normalized.some(c => !c.zh) && !controller.signal.aborted) {
          // yt-dual-subs inject.js buildUrl：保留签名及 pot，仅设置 fmt/tlang。
          const url = new URL(source.src); url.searchParams.set('fmt', 'json3'); url.searchParams.set('tlang', 'zh-Hans');
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
        if (!controller.signal.aborted && source === englishSource && source.videoId === videoIdFromLocation()) {
          post('translation', nonce, { videoId: source.videoId, trackId, requestId, cues: normalized });
        }
      }
    }

    // ---- 捕获 ---------------------------------------------------------------

    function onSourceCaptured(): void {
      if (!cfg) return; // 等配置就绪再拉取
      void produceCues(false);
    }

    // 记录在途看到的 timedtext URL。
    function noteTimedtext(url: unknown): void {
      try {
        seenTimedtext++;
        if (!isTimedtextUrl(url)) return;
        if (selfUrls.has(url as string)) return; // 这是我方自己的请求
        const result = tracker.noteTimedtext(url as string, location.href);
        if (result === 'new') onSourceCaptured();
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

    function captionTracksOf(p: any): any[] | null {
      try {
        const list = p.getOption('captions', 'tracklist');
        if (Array.isArray(list) && list.length) return list;
      } catch {
        /* ignore */
      }
      try {
        const pr = playerResponseFor(tracker.currentVideoId);
        const r = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
        if (r && Array.isArray(r.captionTracks) && r.captionTracks.length) {
          return r.captionTracks;
        }
      } catch {
        /* ignore */
      }
      return null;
    }

    function nudgeCaptions(): boolean {
      try {
        const p = activePlayer() as any;
        if (!p) return false;
        let acted = false;
        if (typeof p.loadModule === 'function') {
          p.loadModule('captions');
          acted = true;
        }
        const vidAtNudge = tracker.currentVideoId;
        setTimeout(() => {
          try {
            if (tracker.sourceUrl) return; // 模块加载本身已触发请求
            if (vidAtNudge !== tracker.currentVideoId) return;
            const p2 = activePlayer() as any;
            if (!p2 || typeof p2.getOption !== 'function' || typeof p2.setOption !== 'function') {
              return;
            }
            // 已选中轨道时不重复选择 —— 那只会重启下载
            const cur = p2.getOption('captions', 'track');
            if (cur && cur.languageCode) {
              // 已有选择但没有请求：关掉再开同一轨道，促使播放器去取
              const lang = cur.languageCode;
              p2.setOption('captions', 'track', {});
              setTimeout(() => {
                try {
                  if (vidAtNudge !== tracker.currentVideoId || tracker.sourceUrl) return;
                  const p3 = activePlayer() as any;
                  if (p3 && typeof p3.setOption === 'function') {
                    p3.setOption('captions', 'track', { languageCode: lang });
                  }
                } catch {
                  /* never throw */
                }
              }, 300);
              return;
            }
            const list = captionTracksOf(p2);
            if (!list) return; // 两个来源都没有轨道 —— 真无字幕
            p2.setOption('captions', 'track', { languageCode: list[0].languageCode });
          } catch {
            /* never throw */
          }
        }, 400);
        return acted;
      } catch {
        return false;
      }
    }

    // ---- 轨道表上报（config 后尽快；playerResponse 未就绪时短暂重试） ----------

    function postTracklist(nonceAtConfig: number, attempt = 0): void {
      try {
        const p = activePlayer() as any;
        const list = p ? captionTracksOf(p) : null;
        if (!list && attempt < 3) {
          setTimeout(() => postTracklist(nonceAtConfig, attempt + 1), 1000);
          return;
        }
        const tracks = (list ?? []).map((t: any) => ({
          lang: String(t?.languageCode ?? ''),
          kind: t?.kind === 'asr' ? ('asr' as const) : ('manual' as const),
          name: typeof t?.name?.simpleText === 'string' ? t.name.simpleText : undefined,
        }));
        post('tracklist', nonceAtConfig, { tracks });
      } catch {
        /* never throw */
      }
    }

    // ---- 换视频轮询（config 之外的第二通道） -----------------------------------

    setInterval(() => {
      try {
        const v = videoIdFromLocation();
        if (v && tracker.resetForVideo(v)) { chineseController?.abort(); englishSource = null; }
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

        if (d.type === 'translation-cancel') { chineseController?.abort(); return; }
        if (d.type === 'translation-request') {
          if (d.videoId === videoIdFromLocation() && typeof d.requestId === 'string' && typeof d.trackId === 'string') void produceChinese(d.requestId, d.trackId, reqNonce);
          return;
        }
        if (d.type === 'bye') {
          chineseController?.abort();
          // 扩展已重载/移除：不再为一个已经不在的监听者拉取字幕。
          cfg = false;
          return;
        }
        if (d.type === 'nudge') {
          // CC 按钮路径未产生 timedtext：用播放器 API 强制选轨。
          tracker.syncVideo(location.href);
          nudgeCaptions();
          return;
        }
        if (d.type === 'prefer') {
          // 轨道偏好：记录后，捕获一就绪（或已就绪时立即）产出偏好变体。
          if (typeof d.nonce === 'number' && d.nonce !== reqNonce) return;
          if (typeof d.lang !== 'string' || !d.lang) return;
          pendingPrefer = {
            lang: d.lang,
            kind: d.kind === 'asr' ? 'asr' : 'manual',
          };
          if (tracker.hasCurrentSource()) void produceCues(true);
          return;
        }
        if (d.type === 'config') {
          // config 是权威的导航信号：resetForVideo 保留已属于当前视频的来源
          //（时序 A），不靠 nudge 重抓。
          tracker.resetForVideo(videoIdFromLocation());
          cfg = true;
          if (typeof d.nonce === 'number') reqNonce = d.nonce;
          tracker.producedForUrl = ''; // 新配置下重新产出
          postTracklist(reqNonce);
          if (tracker.hasCurrentSource()) {
            void produceCues(true); // 本视频已有捕获（或刚被保留）
          } else {
            armNocuesTimer(); // 等播放器发出 timedtext 请求
          }
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
            noteTimedtext(e.name);
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
