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
    return new URL(url, href || undefined).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

export function hasTlangParam(url: string, href: string): boolean {
  return paramsOf(url, href).has('tlang');
}

export interface SubtitleTrack {
  id: string;
  lang: string;
  kind: 'manual' | 'asr';
  name: string;
  label?: string;
  xtags: string;
  vssId?: string;
}

function trackInfo(lang: string, kind: 'manual' | 'asr', name = '', xtags = '', vssId = ''): SubtitleTrack {
  lang = lang.toLowerCase();
  const defaultVss = `${kind === 'asr' ? 'a.' : '.'}${lang}${name ? `.${name}` : ''}`;
  const variant = vssId && vssId.toLowerCase() !== defaultVss.toLowerCase() ? vssId : '';
  const identity = [lang, kind, name, xtags];
  if (variant) identity.push(variant);
  return { id: JSON.stringify(identity), lang, kind, name, xtags, ...(variant ? { vssId: variant } : {}) };
}

export function trackOfUrl(url: string, href = ''): SubtitleTrack | null {
  const p = paramsOf(url, href);
  const lang = p.get('lang');
  return lang ? trackInfo(lang, p.get('kind') === 'asr' ? 'asr' : 'manual', p.get('name') || '', p.get('xtags') || '', p.get('vssId') || p.get('vss_id') || '') : null;
}

export interface PlayerCaptionTrack extends SubtitleTrack {
  url: string;
  native: { languageCode: string; kind: string; name: string; xtags: string; vss_id?: string };
}

/** 播放器 API 与 playerResponse 两种描述在这个边界统一。 */
export function captionTrackOf(raw: any): PlayerCaptionTrack | null {
  if (typeof raw?.languageCode !== 'string' || !raw.languageCode) return null;
  const url = typeof raw.baseUrl === 'string' ? raw.baseUrl : typeof raw.url === 'string' ? raw.url : '';
  const fromUrl = trackOfUrl(url);
  const name = fromUrl?.name ?? (typeof raw.name === 'string' ? raw.name : '');
  const track = trackInfo(raw.languageCode, raw.kind === 'asr' ? 'asr' : 'manual', name, fromUrl?.xtags ?? raw.xtags ?? '', fromUrl?.vssId || raw.vss_id || raw.vssId || '');
  return {
    ...track, url,
    label: raw.displayName || raw.name?.simpleText || raw.languageName,
    native: { languageCode: raw.languageCode, kind: track.kind === 'asr' ? 'asr' : '', name, xtags: track.xtags, vss_id: raw.vss_id || raw.vssId || fromUrl?.vssId },
  };
}

/** 原文和译文轨道共用：保留目标自身签名，更新为当前视频最近的 pot。 */
export function captionUrlFor(track: Pick<PlayerCaptionTrack, 'id' | 'url'>, tokenSource: string, href: string): string | null {
  const base = track.url || (trackOfUrl(tokenSource, href)?.id === track.id ? tokenSource : '');
  if (!base) return null;
  const u = new URL(base, href || undefined);
  const pot = paramsOf(tokenSource, href).get('pot');
  if (pot) u.searchParams.set('pot', pot);
  return buildJson3Url(u.toString(), href);
}

/** 轨道身份只取视频和内容字段；签名、令牌、参数顺序均不参与。 */
export function normTrackKey(url: string, href: string): string {
  try {
    const u = new URL(url, href || undefined);
    if (!isTimedtextUrl(url) || !u.searchParams.has('lang')) return url;
    const track = trackOfUrl(url, href)!;
    const videoId = u.searchParams.get('v') || videoIdFromUrl(href);
    u.search = '';
    u.searchParams.set('v', videoId);
    u.searchParams.set('lang', track.lang);
    if (track.kind === 'asr') u.searchParams.set('kind', 'asr');
    if (track.name) u.searchParams.set('name', track.name);
    if (track.xtags) u.searchParams.set('xtags', track.xtags);
    if (track.vssId) u.searchParams.set('vssId', track.vssId);
    return u.toString();
  } catch {
    return url;
  }
}

export function stripTlang(url: string, href: string): string {
  try {
    const u = new URL(url, href || undefined);
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
  const u = new URL(base, href || undefined);
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
  sourceKey = '';
  producedForUrl = '';
  tokenSourceUrl = ''; // 当前视频最近携带 pot 的 URL，不随一次选轨失败或取消丢失。
  selectedTrack: SubtitleTrack | null = null;
  private playerTrackId: string | null = null;
  private latestCaptureTime = -1;
  selectionVersion = 0;

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
   * 只在视频身份变化时重置。捕获先于 config 对齐身份后，后续 config 不再
   * 重置同一视频的来源（时序 A）。
   */
  resetForVideo(newVideoId: string): boolean {
    if (newVideoId === this.currentVideoId) return false;
    this.currentVideoId = newVideoId;
    this.tokenSourceUrl = '';
    this.selectedTrack = null;
    this.playerTrackId = null;
    this.latestCaptureTime = -1;
    this.selectionVersion++;
    this.clearSource();
    return true;
  }

  /** 明确意图与播放器确认值分开；setOption 后的旧读数不是新意图。 */
  observePlayer(track: SubtitleTrack | null): SubtitleTrack | null {
    if (!track || track.id === this.playerTrackId) return null;
    this.playerTrackId = track.id;
    return track.id === this.selectedTrack?.id ? null : track;
  }

  selectTrack(track: SubtitleTrack): boolean {
    if (track.id === this.selectedTrack?.id) return false;
    const { id, lang, kind, name, label, xtags, vssId } = track;
    this.selectedTrack = { id, lang, kind, name, label, xtags, vssId };
    this.selectionVersion++;
    this.clearSource();
    return true;
  }

  clearSource(): void {
    this.sourceUrl = ''; this.sourceKey = ''; this.producedForUrl = '';
  }

  /** 记录在途 timedtext URL。调用方已排除自身请求（selfUrls）。 */
  noteTimedtext(url: string, locationHref: string, startedAt?: number): CaptureResult {
    if (!isTimedtextUrl(url)) return 'ignored';
    // 捕获先对齐视频身份，再判定 URL 归属；不依赖 config／轮询到达顺序。
    this.syncVideo(locationHref);
    const vidHere = this.currentVideoId;
    const urlVid = vidOfTimedtext(url, locationHref);
    if (vidHere && urlVid !== vidHere) return 'other-video';
    const track = trackOfUrl(url, locationHref);
    if (!track || (this.selectedTrack && track.id !== this.selectedTrack.id)) return 'ignored';
    if (startedAt !== undefined) {
      if (startedAt < this.latestCaptureTime) return 'ignored';
      this.latestCaptureTime = startedAt;
    }
    const effective = hasTlangParam(url, locationHref)
      ? stripTlang(url, locationHref)
      : url;
    if (paramsOf(effective, locationHref).has('pot')) this.tokenSourceUrl = effective;
    const key = normTrackKey(url, locationHref);
    const wasKey = this.sourceKey;
    this.sourceUrl = effective;
    if (key !== wasKey) {
      this.sourceKey = key;
      return 'new';
    }
    return 'refresh'; // 同轨道 pot 轮换：保存最新 URL，不重新触发产出
  }

  /** 当前是否存在可用的（属于当前视频的）来源。 */
  hasCurrentSource(): boolean {
    return !!this.sourceUrl;
  }

  /**
   * 产出开始时固定来源与轨道身份（时序 B）：此后一切读取都用固定值，
   * 不再触碰 live 状态。
   */
  pinForProduce(): PinnedSource | null {
    if (!this.sourceUrl) return null;
    return { src: this.sourceUrl, trackKey: this.sourceKey };
  }

  /**
   * 拉取结束后判定本结果是否已过期（时序 B）：轨道变化（含视频变化导致的
   * 来源清空）都算过期，旧结果整体丢弃，不得带新轨道的元数据发出。
   */
  staleAfterFetch(pinnedTrackKey: string): boolean {
    if (!this.sourceUrl) return true;
    return this.sourceKey !== pinnedTrackKey;
  }
}
