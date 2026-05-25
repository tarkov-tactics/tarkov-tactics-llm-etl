// Provider-agnostic LLM client
// Priority: VertexAI (Claude Code's auth) > Anthropic API > OpenAI-compatible

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
}

type Provider = 'vertex' | 'anthropic' | 'openai-compatible';

interface ResolvedConfig {
  provider: Provider;
  model: string;
  projectId?: string;
  region?: string;
  apiKey?: string;
  apiBase?: string;
}

function resolveConfig(): ResolvedConfig | null {
  // 1. VertexAI — reuse Claude Code's GCP credentials
  const vertexProject = process.env.ANTHROPIC_VERTEX_PROJECT_ID || process.env.GCP_PROJECT_ID;
  if (vertexProject) {
    return {
      provider: 'vertex',
      model: process.env.LLM_MODEL || 'claude-haiku-4-5@20251001',
      projectId: vertexProject,
      region: process.env.ANTHROPIC_VERTEX_REGION || 'us-east5',
    };
  }

  // 2. Anthropic API key
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return {
      provider: 'anthropic',
      model: process.env.LLM_MODEL || 'claude-sonnet-4-20250514',
      apiKey: anthropicKey,
    };
  }

  // 3. Generic OpenAI-compatible (OpenRouter, Ollama, etc.)
  const apiBase = process.env.LLM_API_BASE;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (apiBase && apiKey && model) {
    return { provider: 'openai-compatible', model, apiKey, apiBase };
  }

  return null;
}

export function isLLMConfigured(): boolean {
  return resolveConfig() !== null;
}

export function getLLMModelIdentifier(): string {
  const config = resolveConfig();
  if (!config) return 'none';
  return `${config.provider}:${config.model}`;
}

export async function callLLM(messages: LLMMessage[]): Promise<LLMResponse> {
  const config = resolveConfig();
  if (!config) {
    throw new Error(
      'LLM not configured. Set ANTHROPIC_VERTEX_PROJECT_ID (VertexAI), ' +
      'ANTHROPIC_API_KEY (direct API), or LLM_API_BASE + LLM_MODEL + LLM_API_KEY (OpenAI-compatible).'
    );
  }

  switch (config.provider) {
    case 'vertex':
      return callVertex(config, messages);
    case 'anthropic':
      return callAnthropic(config, messages);
    case 'openai-compatible':
      return callOpenAICompatible(config, messages);
  }
}

async function callVertex(config: ResolvedConfig, messages: LLMMessage[]): Promise<LLMResponse> {
  const client = new AnthropicVertex({
    projectId: config.projectId,
    region: config.region,
    timeout: 30_000,
  });

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
  return { content, model: `vertex:${response.model}` };
}

async function callAnthropic(config: ResolvedConfig, messages: LLMMessage[]): Promise<LLMResponse> {
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
  return { content, model: `anthropic:${response.model}` };
}

async function callOpenAICompatible(config: ResolvedConfig, messages: LLMMessage[]): Promise<LLMResponse> {
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

  return { content, model: `openai-compatible:${result.model || config.model}` };
}