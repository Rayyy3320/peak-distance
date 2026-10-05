// MAIN world 嗅探脚本与隔离世界 content script 之间的消息协议。
// 双方各自带 videoId 与 nonce：换视频后旧消息按 videoId 丢弃，
// 同一视频内旧请求的回复按 nonce 丢弃。

export const CONTENT_SOURCE = 'blc-content';
export const INJECT_SOURCE = 'blc-inject';
import type { SubtitleTrack } from './subtitleTracker';

/** 一条字幕：毫秒时间轴 + 文本。lastOff 是最后一个非空白词的绝对时间（ASR 专有）。 */
export interface Cue {
  start: number;
  dur: number;
  text: string;
  lastOff: number;
  zh?: string;
}

export interface ConfigMessage {
  source: typeof CONTENT_SOURCE;
  type: 'config';
  nonce: number;
}

export interface NudgeMessage {
  source: typeof CONTENT_SOURCE;
  type: 'nudge';
}

export interface ByeMessage {
  source: typeof CONTENT_SOURCE;
  type: 'bye';
}

export interface SourceCancelMessage {
  source: typeof CONTENT_SOURCE;
  type: 'source-cancel';
  nonce: number;
}

export interface SelectTrackMessage {
  source: typeof CONTENT_SOURCE;
  type: 'select-track';
  videoId: string;
  nonce: number;
  trackId: string;
}

export type ContentMessage = ConfigMessage | NudgeMessage | ByeMessage | SelectTrackMessage | SourceCancelMessage;

export interface CuesMessage {
  source: typeof INJECT_SOURCE;
  type: 'cues';
  videoId: string;
  nonce: number;
  /** manual = 人工字幕；asr = 平台自动生成 */
  trackKind: 'manual' | 'asr';
  /** 字幕轨道语言，如 en */
  trackLang: string;
  /** 内容身份 URL；请求凭据和展示格式不参与。 */
  trackId: string;
  /** 嗅探器至今见过的 timedtext 请求数（诊断用，不受过滤影响） */
  seen: number;
  cues: Cue[];
}

export interface NoCuesMessage {
  source: typeof INJECT_SOURCE;
  type: 'nocues';
  videoId: string;
  nonce: number;
  reason: string;
  /** 嗅探器至今见过的 timedtext 请求数（诊断用，不受过滤影响） */
  seen: number;
}

/** MAIN → content：完整轨道描述，id 用于选择，label 用于区分具名轨道。 */
export interface TracklistMessage {
  source: typeof INJECT_SOURCE;
  type: 'tracklist';
  videoId: string;
  nonce: number;
  tracks: SubtitleTrack[];
}

export interface TranslationCuesMessage {
  source: typeof INJECT_SOURCE;
  type: 'translation';
  videoId: string;
  nonce: number;
  trackId: string;
  requestId: string;
  cues: Cue[];
}

export interface TrackSelectedMessage {
  source: typeof INJECT_SOURCE;
  type: 'track-selected';
  videoId: string;
  nonce: number;
  track: SubtitleTrack;
}

export type InjectMessage = CuesMessage | NoCuesMessage | TracklistMessage | TranslationCuesMessage | TrackSelectedMessage;

export function formatCue(c: Cue): string {
  const s = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  return `[${s(c.start)}–${s(c.start + c.dur)}] ${c.text}`;
}
