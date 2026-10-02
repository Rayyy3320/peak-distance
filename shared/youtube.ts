// 从当前 location 解析 YouTube 视频 ID —— 纯解析在 subtitleTracker，
// 这里仅提供 location 版本的薄封装（隔离世界 content script 使用）。
import { videoIdFromUrl } from './subtitleTracker';

export function videoIdFromLocation(): string {
  return videoIdFromUrl(location.href);
}
