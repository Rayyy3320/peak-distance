import { defaultAiProfile, normalizeAiBaseUrl, readAiServices, validateAiProfile, type AiConfig, type AiProtocol } from '@/shared/aiConfig';
import { parseStreamEvent, type ChatCompletionMessage } from '@/shared/chat';

export async function getAiConfig(): Promise<AiConfig> {
  const state = readAiServices(await browser.storage.local.get(['aiServices', 'deepseekApiKey']));
  return { ...state.profiles[state.active] ?? defaultAiProfile(state.active), provider: state.active };
}

export function buildAiRequest(config: AiConfig, messages: ChatCompletionMessage[], stream: boolean, maxTokens: number) {
  const base = normalizeAiBaseUrl(config.baseUrl);
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const turns = messages.filter(m => m.role !== 'system');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.protocol === 'anthropic') {
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    return { url: `${base}/messages`, headers, body: { model: config.model, system, messages: turns, max_tokens: maxTokens, stream } };
  }
  if (config.protocol === 'gemini') {
    headers['x-goog-api-key'] = config.apiKey;
    return {
      url: `${base}/models/${encodeURIComponent(config.model.replace(/^models\//, ''))}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
      headers, body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: turns.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: maxTokens },
      },
    };
  }
  headers.Authorization = `Bearer ${config.apiKey}`;
  // OpenAI uses max_completion_tokens; compatible providers commonly require max_tokens.
  const tokenField = new URL(base).hostname === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens';
  return { url: `${base}/chat/completions`, headers, body: { model: config.model, messages, stream, [tokenField]: maxTokens } };
}

export async function requestAi(config: AiConfig, messages: ChatCompletionMessage[], stream: boolean, maxTokens: number, signal: AbortSignal): Promise<Response> {
  if (validateAiProfile(config)) throw Error('invalid-config');
  const request = buildAiRequest(config, messages, stream, maxTokens);
  const origin = `${new URL(request.url).origin}/*`;
  if (!await browser.permissions.contains({ origins: [origin] })) throw Error('permission');
  return fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal, credentials: 'omit', redirect: 'error' });
}

export function parseAiResponse(protocol: AiProtocol, json: any, streaming = false): { content: string | null; finishReason: string | null; hasReasoning: boolean } {
  if (protocol === 'anthropic') {
    const content = Array.isArray(json?.content) ? json.content.filter((b: any) => b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('') : '';
    return { content: content.trim() ? content : null, finishReason: json?.stop_reason ?? null, hasReasoning: !!json?.content?.some?.((b: any) => b.type === 'thinking') };
  }
  if (protocol === 'gemini') {
    const candidate = json?.candidates?.[0];
    const parts = candidate?.content?.parts;
    const content = Array.isArray(parts) ? parts.filter((p: any) => !p.thought && typeof p.text === 'string').map((p: any) => p.text).join('') : '';
    return { content: (streaming ? content.length : content.trim()) ? content : null, finishReason: candidate?.finishReason ?? null, hasReasoning: !!parts?.some?.((p: any) => p.thought) };
  }
  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  return { content: typeof content === 'string' && content.trim() ? content : null, finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null, hasReasoning: typeof choice?.message?.reasoning_content === 'string' && !!choice.message.reasoning_content.trim() };
}

export function parseAiStreamEvent(protocol: AiProtocol, payload: string): { content: string | null; finishReason: string | null; done?: boolean; error?: boolean } {
  let data: any;
  try { data = JSON.parse(payload); } catch { return { content: null, finishReason: null }; }
  if (data?.error || data?.type === 'error') return { content: null, finishReason: null, error: true };
  if (protocol === 'openai') return parseStreamEvent(payload);
  if (protocol === 'gemini') return parseAiResponse(protocol, data, true);
  return {
    content: data?.type === 'content_block_delta' && data.delta?.type === 'text_delta' && typeof data.delta.text === 'string' ? data.delta.text : null,
    finishReason: data?.type === 'message_delta' ? data.delta?.stop_reason ?? null : null,
    done: data?.type === 'message_stop',
  };
}
