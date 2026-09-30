/**
 * Gemini on Vertex AI for the assisted-application AI draft.
 *
 * Why Vertex and not the free-first chain in geminiGenerate.js: this flow
 * sends a customer's CV. Vertex runs inside the project's own Google Cloud
 * account (Cloud Data Processing Addendum, no training on customer data, EU
 * region), authenticates with the function's runtime service account and
 * needs no API key. The free providers of the site chatbot are never used
 * here, not even as a fallback: a failed call leaves the order to the
 * operator, it does not move the CV to another processor.
 *
 * Configuration lives in Remote Config (defaults below are the safe ones):
 *   ASSISTED_APPLICATION_AI_DRAFT     'true' → draft automatically when a CV lands
 *   ASSISTED_APPLICATION_AI_MODEL     Vertex publisher model id
 *   ASSISTED_APPLICATION_AI_LOCATION  Vertex region (Gemini is not served in
 *                                     europe-west6, where the functions run)
 */

import { getRemoteConfigValue } from './remoteConfigSecrets.js';

export const AI_DRAFT_FLAG_KEY = 'ASSISTED_APPLICATION_AI_DRAFT';
export const AI_MODEL_KEY = 'ASSISTED_APPLICATION_AI_MODEL';
export const AI_LOCATION_KEY = 'ASSISTED_APPLICATION_AI_LOCATION';
export const DEFAULT_AI_MODEL = 'gemini-2.5-flash';
export const DEFAULT_AI_LOCATION = 'europe-west8';

const MODEL_RE = /^[a-z0-9][a-z0-9.-]{1,80}$/;
const LOCATION_RE = /^(?:global|[a-z]+-[a-z]+\d{1,2})$/;
const CALL_TIMEOUT_MS = 120_000;

async function readConfigValue(key, read) {
  try {
    return String(await read(key) || '').trim();
  } catch (error) {
    console.warn('[assistedApplicationAi] Remote Config read failed', key, error instanceof Error ? error.message : String(error));
    return '';
  }
}

/** Remote Config → validated settings; any unreadable value falls back to the safe default. */
export async function getAssistedApplicationAiConfig({ read = getRemoteConfigValue } = {}) {
  const [flag, model, location] = await Promise.all([
    readConfigValue(AI_DRAFT_FLAG_KEY, read),
    readConfigValue(AI_MODEL_KEY, read),
    readConfigValue(AI_LOCATION_KEY, read),
  ]);
  return {
    autoDraft: flag.toLowerCase() === 'true',
    model: MODEL_RE.test(model) ? model : DEFAULT_AI_MODEL,
    location: LOCATION_RE.test(location) ? location : DEFAULT_AI_LOCATION,
  };
}

export function projectId() {
  return process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino';
}

/** OAuth token of the runtime identity (metadata server on Cloud Functions). */
export async function defaultAccessToken() {
  const { applicationDefault } = await import('firebase-admin/app');
  const token = await applicationDefault().getAccessToken();
  if (!token?.access_token) throw new Error('vertex_no_access_token');
  return token.access_token;
}

export class VertexCallError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'VertexCallError';
    this.code = code;
  }
}

/**
 * One structured call. `parts` follow the Vertex Content shape
 * ({text} or {inlineData:{mimeType,data}}); `schema` is an OpenAPI-subset
 * response schema, so the model can only answer with that JSON shape.
 * @returns {Promise<{data: any, usage: {input:number, output:number, thinking:number}, modelVersion: string}>}
 */
export async function generateStructured({
  systemPrompt,
  parts,
  schema,
  model = DEFAULT_AI_MODEL,
  location = DEFAULT_AI_LOCATION,
  temperature = 0.2,
  maxOutputTokens = 8192,
  thinkingBudget = 1024,
  getAccessToken = defaultAccessToken,
  fetchImpl = fetch,
}) {
  const token = await getAccessToken();
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${projectId()}`
    + `/locations/${location}/publishers/google/models/${model}:generateContent`;
  // Gemini 2.x takes a token budget; Gemini 3.x rejects it and takes a level.
  const thinkingConfig = /^gemini-[3-9]/.test(model)
    ? { thinkingLevel: thinkingBudget > 1024 ? 'high' : 'low' }
    : { thinkingBudget };
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature,
      // Thinking tokens count against this budget.
      maxOutputTokens: maxOutputTokens + Math.max(thinkingBudget, 4096),
      responseMimeType: 'application/json',
      responseSchema: schema,
      thinkingConfig,
    },
  };
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new VertexCallError(`vertex_http_${response.status}`, detail.slice(0, 200));
  }
  const payload = await response.json();
  const candidate = payload?.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();
  if (!text) throw new VertexCallError('vertex_empty', candidate?.finishReason || 'no_text');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new VertexCallError('vertex_invalid_json', candidate?.finishReason || '');
  }
  const usage = payload?.usageMetadata || {};
  return {
    data,
    usage: {
      input: Number(usage.promptTokenCount) || 0,
      output: Number(usage.candidatesTokenCount) || 0,
      thinking: Number(usage.thoughtsTokenCount) || 0,
    },
    modelVersion: String(payload?.modelVersion || model),
  };
}
