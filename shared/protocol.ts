// MAIN world 嗅探脚本与隔离世界 content script 之间的消息协议。
// 双方各自带 videoId 与 nonce：换视频后旧消息按 videoId 丢弃，
// 同一视频内旧请求的回复按 nonce 丢弃。

export const CONTENT_SOURCE = 'blc-content';
export const INJECT_SOURCE = 'blc-inject';

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

/** content → MAIN：优先取某语言的轨道（manual 优先于 asr）。 */
export interface PreferMessage {
  source: typeof CONTENT_SOURCE;
  type: 'prefer';
  nonce: number;
  lang: string;
  kind: 'manual' | 'asr';
}

export type ContentMessage = ConfigMessage | NudgeMessage | ByeMessage | PreferMessage;

export interface CuesMessage {
  source: typeof INJECT_SOURCE;
  type: 'cues';
  videoId: string;
  nonce: number;
  /** manual = 人工字幕；asr = 平台自动生成 */
  trackKind: 'manual' | 'asr';
  /** 字幕轨道语言，如 en */
  trackLang: string;
  /** 稳定轨道标识（去除 pot/fmt/tlang 后的 URL） */
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

/** MAIN → content：播放器自报的字幕轨道表（语言 + 类型）。 */
export interface TracklistMessage {
  source: typeof INJECT_SOURCE;
  type: 'tracklist';
  videoId: string;
  nonce: number;
  tracks: { lang: string; kind: 'manual' | 'asr'; name?: string }[];
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

export type InjectMessage = CuesMessage | NoCuesMessage | TracklistMessage | TranslationCuesMessage;

export function formatCue(c: Cue): string {
  const s = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  return `[${s(c.start)}–${s(c.start + c.dur)}] ${c.text}`;
}
