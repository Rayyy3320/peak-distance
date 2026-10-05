// timedtext 捕获状态机（纯逻辑，无 DOM 依赖）。
// MAIN world 注入脚本与 tools/regress.ts 共用，使两处时序约束可离线回归：
//
//  A. 地址变为 B 后捕获到 B 的 timedtext：先同步视频身份再判定，捕获立即
//     有效；随后 B 的 config 触发的重置不得清掉已属于 B 的来源（不靠 nudge
//     重抓才能继续）。
//  B. 一次产出在开始时固定来源与轨道身份；拉取期间轨道或视频变化，旧结果
//     整体丢弃（正文与元数据不得错配），新轨道由自己的捕获触发新产出。
//
// URL 侧工具函数同样是纯的，从原注入脚本迁出。

/** 从页面地址解析视频 ID：?v= 以及 /shorts|embed|live/<id>（排除伪 id）。 */
export function videoIdFromUrl(href: string): string {
  try {
    const u = new URL(href);
    const m = u.pathname.match(
      /^\/(?:shorts|embed|live)\/(?!videoseries\b|live_stream\b)([A-Za-z0-9_-]{6,})/,
    );
    if (m) return m[1] ?? '';
    return u.searchParams.get('v') || '';
  } catch {
    return '';
  }
}

export function isTimedtextUrl(url: unknown): boolean {
  return typeof url === 'string' && url.includes('/api/timedtext');
}

function paramsOf(url: string, href: string): URLSearchParams {
  try {
    return new URL(url, href).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

export function hasTlangParam(url: string, href: string): boolean {
  return paramsOf(url, href).has('tlang');
}

/** 轨道稳定标识：剥离会轮换（pot）或可变（fmt/tlang）的参数。 */
export function normTrackKey(url: string, href: string): string {
  try {
    const u = new URL(url, href);
    u.searchParams.delete('fmt');
    u.searchParams.delete('tlang');
    u.searchParams.delete('pot');
    return u.toString();
  } catch {
    return url;
  }
}

export function stripTlang(url: string, href: string): string {
  try {
    const u = new URL(url, href);
    u.searchParams.delete('tlang');
    return u.toString();
  } catch {
    return url;
  }
}

/** 轨道类型：kind=asr 为平台自动生成，人工轨道无 kind。 */
export function trackKindOf(url: string, href: string): 'manual' | 'asr' {
  return paramsOf(url, href).get('kind') === 'asr' ? 'asr' : 'manual';
}

export function trackLangOf(url: string, href: string): string {
  return paramsOf(url, href).get('lang') || '';
}

export function vidOfTimedtext(url: string, href: string): string {
  return paramsOf(url, href).get('v') || videoIdFromUrl(href);
}

/** 拉取 URL：保留全部参数（含 pot 与签名），强制 fmt=json3，去掉 tlang。 */
export function buildJson3Url(base: string, href: string): string {
  const u = new URL(base, href);
  u.searchParams.delete('tlang');
  u.searchParams.set('fmt', 'json3');
  return u.toString();
}

export type CaptureResult = 'new' | 'refresh' | 'other-video' | 'ignored';

export interface PinnedSource {
  src: string;
  trackKey: string;
}

export class SubtitleSourceTracker {
  currentVideoId: string;
  sourceUrl = '';
  sourceVid = '';
  sourceKey = '';
  producedForUrl = '';

  constructor(initialVideoId: string) {
    this.currentVideoId = initialVideoId;
  }

  /** 地址已变而轮询未跑时先对齐身份，返回对齐后的视频 ID。 */
  syncVideo(locationHref: string): string {
    const v = videoIdFromUrl(locationHref);
    this.resetForVideo(v);
    return this.currentVideoId;
  }

  /**
   * 视频切换重置（config 与轮询共用）。已属于新视频的来源保留 —— 这是时序 A
   * 的关键：捕获先于 config 到达时，重置不能把刚抓到的来源清掉。
   */
  resetForVideo(newVideoId: string): boolean {
    if (newVideoId === this.currentVideoId) return false;
    this.currentVideoId = newVideoId;
    if (this.sourceVid !== newVideoId) {
      this.sourceUrl = '';
      this.sourceVid = '';
      this.sourceKey = '';
    }
    this.producedForUrl = '';
    return true;
  }

  /** 记录在途 timedtext URL。调用方已排除自身请求（selfUrls）。 */
  noteTimedtext(url: string, locationHref: string): CaptureResult {
    if (!isTimedtextUrl(url)) return 'ignored';
    // 时序 A 第一步：先同步视频身份，再判定归属 —— 否则新视频的捕获会被
    // 尚未轮询到的旧身份（sourceVid !== currentVideoId）拦下。
    this.syncVideo(locationHref);
    const vidHere = this.currentVideoId;
    const urlVid = vidOfTimedtext(url, locationHref);
    if (vidHere && urlVid !== vidHere) return 'other-video';
    const effective = hasTlangParam(url, locationHref)
      ? stripTlang(url, locationHref)
      : url;
    const key = normTrackKey(url, locationHref);
    const wasKey = this.sourceKey;
    this.sourceUrl = effective;
    this.sourceVid = urlVid;
    if (key !== wasKey) {
      this.sourceKey = key;
      return 'new';
    }
    return 'refresh'; // 同轨道 pot 轮换：保存最新 URL，不重新触发产出
  }

  /** 当前是否存在可用的（属于当前视频的）来源。 */
  hasCurrentSource(): boolean {
    return !!this.sourceUrl && this.sourceVid === this.currentVideoId;
  }

  /**
   * 产出开始时固定来源与轨道身份（时序 B）：此后一切读取都用固定值，
   * 不再触碰 live 状态。
   */
  pinForProduce(): PinnedSource | null {
    if (!this.sourceUrl || this.sourceVid !== this.currentVideoId) return null;
    return { src: this.sourceUrl, trackKey: normTrackKey(this.sourceUrl, '') };
  }

  /**
   * 拉取结束后判定本结果是否已过期（时序 B）：轨道变化（含视频变化导致的
   * 来源清空）都算过期，旧结果整体丢弃，不得带新轨道的元数据发出。
   */
  staleAfterFetch(pinnedTrackKey: string): boolean {
    if (!this.sourceUrl) return true;
    return normTrackKey(this.sourceUrl, '') !== pinnedTrackKey;
  }
}
