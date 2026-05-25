// Provider-agnostic LLM client
// Primary: Anthropic SDK. Fallback: OpenAI-compatible endpoints (OpenRouter, Ollama).

import Anthropic from '@anthropic-ai/sdk';

export interface LLMConfig {
  apiBase: string;
  model: string;
  apiKey: string;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
}

function getLLMConfig(): LLMConfig | null {
  // Primary: Anthropic API key
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return {
      apiBase: 'https://api.anthropic.com',
      model: process.env.LLM_MODEL || 'claude-sonnet-4-20250514',
      apiKey: anthropicKey,
    };
  }

  // Fallback: generic LLM env vars (OpenRouter, Ollama, etc.)
  const apiBase = process.env.LLM_API_BASE;
  const model = process.env.LLM_MODEL;
  const apiKey = process.env.LLM_API_KEY;

  if (apiBase && model && apiKey) {
    return { apiBase, model, apiKey };
  }

  return null;
}

export function isLLMConfigured(): boolean {
  return getLLMConfig() !== null;
}

export async function callLLM(messages: LLMMessage[]): Promise<LLMResponse> {
  const config = getLLMConfig();
  if (!config) {
    throw new Error('LLM is not configured. Set ANTHROPIC_API_KEY or LLM_API_BASE + LLM_MODEL + LLM_API_KEY.');
  }

  if (config.apiBase === 'https://api.anthropic.com') {
    return callAnthropic(config, messages);
  }

  return callOpenAICompatible(config, messages);
}

async function callAnthropic(config: LLMConfig, messages: LLMMessage[]): Promise<LLMResponse> {
  const client = new Anthropic({ apiKey: config.apiKey });

  const systemMessage = messages.find(m => m.role === 'system');
  const nonSystemMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const response = await client.messages.create({
    model: config.model,
    max_tokens: 4096,
    temperature: 0,
    system: systemMessage?.content,
    messages: nonSystemMessages,
  });

  const content = response.content[0].type === 'text' ? response.content[0].text : '';

  return {
    content,
    model: `anthropic:${response.model}`,
  };
}

async function callOpenAICompatible(config: LLMConfig, messages: LLMMessage[]): Promise<LLMResponse> {
  const response = await fetch(`${config.apiBase}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: 0,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM API error ${response.status}: ${text}`);
  }

  const result = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; model?: string };
  const content = result.choices?.[0]?.message?.content || '';

  const provider = config.apiBase.includes('openrouter')
    ? 'openrouter'
    : config.apiBase.includes('localhost') || config.apiBase.includes('127.0.0.1')
      ? 'ollama'
      : 'openai-compatible';

  return {
    content,
    model: `${provider}:${result.model || config.model}`,
  };
}

export function getLLMModelIdentifier(): string {
  const config = getLLMConfig();
  if (!config) return 'none';

  if (config.apiBase === 'https://api.anthropic.com') {
    return `anthropic:${config.model}`;
  }

  const provider = config.apiBase.includes('openrouter')
    ? 'openrouter'
    : config.apiBase.includes('localhost') || config.apiBase.includes('127.0.0.1')
      ? 'ollama'
      : 'openai-compatible';

  return `${provider}:${config.model}`;
}