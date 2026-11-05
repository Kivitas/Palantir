// Direct browser calls to AI providers, using the user's own API key.
//
// Security notes:
// - Keys are passed only in request headers, never in URLs, never logged, never stored here.
// - Error text returned by a provider is truncated and any occurrence of the key is redacted.
// - Callers should go through src/ai/gate.ts (sendThroughGate). Do not call this directly with case data.

import type { AIProvider } from '../types';

export const PROVIDER_LABELS: Record<AIProvider, string> = {
  anthropic: 'Anthropic Claude',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  mistral: 'Mistral AI',
};

/** Default model names. Editable in the UI; verify against each provider's model list before relying on them. */
export const DEFAULT_MODELS: Record<AIProvider, string> = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-5',
  gemini: 'gemini-2.5-flash',
  mistral: 'mistral-large-latest',
};

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 4096;
const MODEL_NAME_PATTERN = /^[A-Za-z0-9._:/-]{1,100}$/;

export interface ProviderRequest {
  provider: AIProvider;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Error with a message that is safe to show to the user. */
export class ProviderError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function redact(message: string, secret: string): string {
  const trimmed = message.length > 300 ? `${message.slice(0, 300)}...` : message;
  return secret ? trimmed.split(secret).join('[redacted]') : trimmed;
}

function providerMessage(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const err = data.error;
  if (isRecord(err) && typeof err.message === 'string') return err.message;
  if (typeof err === 'string') return err;
  if (typeof data.message === 'string') return data.message;
  return null;
}

function describeHttpError(label: string, status: number, detail: string | null, model: string): string {
  const suffix = detail ? `: ${detail}` : '';
  if (status === 401 || status === 403) {
    return `${label} rejected the API key (HTTP ${status}). Check that the key is correct and enabled for this provider.`;
  }
  if (status === 404) {
    return `${label} could not find model "${model}" (HTTP 404). Check the model name, or use the default.`;
  }
  if (status === 429) {
    return `${label} rate limit or quota reached (HTTP 429). Wait and try again, or check billing.`;
  }
  if (status === 400 || status === 413 || status === 422) {
    return `${label} rejected the request (HTTP ${status})${suffix}.`;
  }
  if (status >= 500) {
    return `${label} is unavailable right now (HTTP ${status}). Try again later.`;
  }
  return `${label} returned HTTP ${status}${suffix}.`;
}

/** POSTs JSON and returns the parsed body. Throws ProviderError with a user-safe message. */
async function postJson(label: string, url: string, headers: Record<string, string>, body: unknown, req: ProviderRequest): Promise<unknown> {
  if (req.signal?.aborted) throw new ProviderError('Analysis cancelled.');

  const controller = new AbortController();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCancel = () => controller.abort();
  req.signal?.addEventListener('abort', onCancel);

  const timeoutError = () =>
    new ProviderError(`${label} did not respond within ${Math.round(timeoutMs / 1000)} seconds. Try again or shorten the request.`);
  const networkError = () =>
    new ProviderError(`Could not reach ${label}. Check the connection, browser extensions, or network filters, then try again.`);

  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      if (req.signal?.aborted) throw new ProviderError('Analysis cancelled.');
      if (timedOut) throw timeoutError();
      throw networkError();
    }

    let text: string;
    try {
      text = await res.text();
    } catch {
      if (req.signal?.aborted) throw new ProviderError('Analysis cancelled.');
      if (timedOut) throw timeoutError();
      throw networkError();
    }

    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!res.ok) {
      const detail = providerMessage(data);
      const message = describeHttpError(label, res.status, detail ? redact(detail, req.apiKey) : null, req.model);
      throw new ProviderError(redact(message, req.apiKey), res.status);
    }
    return data;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onCancel);
  }
}

function chatCompletionText(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.choices)) return '';
  const first: unknown = data.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return '';
  const content = first.message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }
  return '';
}

async function callAnthropic(req: ProviderRequest): Promise<string> {
  const data = await postJson(
    'Anthropic',
    'https://api.anthropic.com/v1/messages',
    {
      'x-api-key': req.apiKey,
      'anthropic-version': '2023-06-01',
      // Required for direct calls from a browser. The key is visible to anyone who can run this page.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    {
      model: req.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    },
    req,
  );
  const content: unknown[] = isRecord(data) && Array.isArray(data.content) ? data.content : [];
  return content
    .map((block: unknown) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim();
}

async function callOpenAI(req: ProviderRequest): Promise<string> {
  const data = await postJson(
    'OpenAI',
    'https://api.openai.com/v1/chat/completions',
    { authorization: `Bearer ${req.apiKey}` },
    {
      model: req.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    },
    req,
  );
  return chatCompletionText(data);
}

async function callMistral(req: ProviderRequest): Promise<string> {
  const data = await postJson(
    'Mistral AI',
    'https://api.mistral.ai/v1/chat/completions',
    { authorization: `Bearer ${req.apiKey}` },
    {
      model: req.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    },
    req,
  );
  return chatCompletionText(data);
}

async function callGemini(req: ProviderRequest): Promise<string> {
  // The key goes in a header, not the URL, so it does not show up in address-bar history or error text.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`;
  const data = await postJson(
    'Google Gemini',
    url,
    { 'x-goog-api-key': req.apiKey },
    {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    },
    req,
  );
  if (!isRecord(data) || !Array.isArray(data.candidates)) return '';
  const first: unknown = data.candidates[0];
  if (!isRecord(first) || !isRecord(first.content) || !Array.isArray(first.content.parts)) return '';
  return first.content.parts
    .map((part: unknown) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

/** Calls the selected provider and returns the model's text. Throws ProviderError on failure. */
export async function callProvider(req: ProviderRequest): Promise<string> {
  const apiKey = req.apiKey.trim();
  const model = req.model.trim();
  if (!apiKey) throw new ProviderError('No API key is stored for this provider.');
  if (!MODEL_NAME_PATTERN.test(model)) {
    throw new ProviderError('Model name may only contain letters, digits, dots, dashes, colons, underscores and slashes.');
  }
  const normalized: ProviderRequest = { ...req, apiKey, model };

  let text: string;
  switch (req.provider) {
    case 'anthropic': text = await callAnthropic(normalized); break;
    case 'openai': text = await callOpenAI(normalized); break;
    case 'gemini': text = await callGemini(normalized); break;
    case 'mistral': text = await callMistral(normalized); break;
  }
  if (!text) throw new ProviderError(`${PROVIDER_LABELS[req.provider]} returned no text. Try again or change the model.`);
  return text;
}
