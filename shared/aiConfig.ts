export type AiProtocol = 'openai' | 'anthropic' | 'gemini';
export interface AiProfile { protocol: AiProtocol; baseUrl: string; model: string; apiKey: string }
export const AI_PRESETS = {
  deepseek: { label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
  openai: { label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  anthropic: { label: 'Anthropic · Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-haiku-4-5' },
  gemini: { label: 'Google · Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.8-flash' },
  glm: { label: '智谱 · GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3' },
  kimi: { label: '月之暗面 · Kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3' },
  custom: { label: '自定义服务', protocol: 'openai', baseUrl: '', model: '' },
} satisfies Record<string, { label: string; protocol: AiProtocol; baseUrl: string; model: string }>;
export type AiProvider = keyof typeof AI_PRESETS;
export interface AiServices { active: AiProvider; profiles: Partial<Record<AiProvider, AiProfile>> }
export type AiConfig = AiProfile & { provider: AiProvider };

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === 'string' && Object.hasOwn(AI_PRESETS, value);
}
export function defaultAiProfile(provider: AiProvider): AiProfile {
  const { protocol, baseUrl, model } = AI_PRESETS[provider];
  return { protocol, baseUrl, model, apiKey: '' };
}
export function normalizeAiBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('请填写不含凭据、查询参数或片段的 HTTPS API 地址');
  url.pathname = url.pathname.replace(/\/(chat\/completions|messages)\/?$/, '');
  return url.href.replace(/\/+$/, '');
}
export function validateAiProfile(profile: AiProfile): string | null {
  if (!['openai', 'anthropic', 'gemini'].includes(profile.protocol)) return '请选择接口格式';
  try { normalizeAiBaseUrl(profile.baseUrl); } catch { return '请填写有效的 HTTPS API 地址（Base URL）'; }
  if (!profile.model.trim() || profile.model.length > 200 || /[\s?#]/.test(profile.model)) return '请填写有效的模型 ID';
  if (!profile.apiKey.trim() || /[\r\n]/.test(profile.apiKey) || profile.apiKey.length > 4096) return '请填写有效的 API Key';
  return null;
}
export function readAiServices(stored: Record<string, unknown>): AiServices {
  // Legacy key stays usable until the first settings save; canonical storage then owns all profiles.
  if (stored.aiServices === undefined) return { active: 'deepseek', profiles: { deepseek: { ...defaultAiProfile('deepseek'), apiKey: typeof stored.deepseekApiKey === 'string' ? stored.deepseekApiKey.trim() : '' } } };
  const value = stored.aiServices as AiServices;
  const profiles: AiServices['profiles'] = {};
  for (const provider of Object.keys(AI_PRESETS) as AiProvider[]) {
    const p = value?.profiles?.[provider];
    if (p && ['openai', 'anthropic', 'gemini'].includes(p.protocol) && ['baseUrl','model','apiKey'].every(k => typeof p[k as keyof AiProfile] === 'string')) profiles[provider] = { protocol:p.protocol, baseUrl:p.baseUrl, model:p.model, apiKey:p.apiKey };
  }
  return { active: isAiProvider(value?.active) ? value.active : 'custom', profiles };
}
export function aiCacheScope(config: AiConfig): string {
  return JSON.stringify([config.provider, config.protocol, normalizeAiBaseUrl(config.baseUrl), config.model]);
}
