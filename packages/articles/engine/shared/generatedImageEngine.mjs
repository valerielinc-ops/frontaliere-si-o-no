#!/usr/bin/env node
/**
 * The one provider boundary for generated site imagery. This Node adapter
 * lives in the mirrored articles engine so the corpus can use the same API.
 *
 * Public callers provide a normalized specification. This module owns provider
 * order, the Codex OAuth transport, the Gemini fallback, WebP conversion,
 * XMP/IPTC marking, and the vision gate. It never returns bytes without the
 * matching registry record.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import {
  buildGeneratedImagePrompt,
  generatedImagePromptInput,
  normalizeGeneratedImageSpec,
  GENERATED_IMAGE_CREDIT,
  GENERATED_IMAGE_DEFAULT_FORMAT,
  GENERATED_IMAGE_KIND,
  GENERATED_IMAGE_LICENSE,
  GENERATED_IMAGE_LICENSE_URLS,
  GENERATED_IMAGE_MAX_BYTES,
  GENERATED_IMAGE_POLICY,
  GENERATED_IMAGE_PROMPT_VERSION,
  GENERATED_IMAGE_RESTRICTIONS,
  LICENSED_PHOTO_MODIFICATIONS,
  LICENSED_PHOTO_KIND,
  LICENSED_PHOTO_LICENSES,
  LICENSED_PHOTO_LICENSE_URLS,
  LICENSED_PHOTO_PROVIDERS,
  LICENSED_PHOTO_RESTRICTIONS,
  IMAGE_PROVIDERS,
  generatedImagePathForScope,
  scopeAllowsLicensedPhoto,
  validateGeneratedImageRecord,
} from './generatedImageRegistry.mjs';
import {
  eventImageLibrarySlots,
  eventImagePhotoSearchQueries,
  EVENT_IMAGE_LIBRARY_MAX_VARIANTS,
} from './eventImageLibrary.mjs';

export const CODEX_IMAGE_MODEL = 'gpt-image-2.5';
export const CODEX_IMAGE_EXECUTOR_MODEL = process.env.CODEX_IMAGE_EXECUTOR_MODEL || 'gpt-5.6-luna';
export const GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image';
export const FAL_IMAGE_MODEL = 'fal-ai/flux/schnell';
export const TOGETHER_IMAGE_MODEL = 'black-forest-labs/FLUX.1-schnell-Free';
export const POLLINATIONS_IMAGE_MODEL = 'flux';
export const DEFAULT_GENERATION_PROVIDER_CHAIN = Object.freeze([
  'openai-codex',
  'gemini',
  'fal',
  'together',
  'pollinations',
]);
export const DEFAULT_PHOTO_PROVIDER_CHAIN = Object.freeze([
  'wikimedia',
  'pexels',
  'pixabay',
  ...DEFAULT_GENERATION_PROVIDER_CHAIN,
]);
export const DEFAULT_AUTO_PROVIDER_CHAIN = Object.freeze([
  ...DEFAULT_GENERATION_PROVIDER_CHAIN,
  'wikimedia',
  'pexels',
  'pixabay',
]);
export const OPENAI_TERMS_URL = GENERATED_IMAGE_LICENSE_URLS['openai-codex'];
export const GEMINI_TERMS_URL = GENERATED_IMAGE_LICENSE_URLS.gemini;
export const FAL_TERMS_URL = GENERATED_IMAGE_LICENSE_URLS.fal;
export const TOGETHER_TERMS_URL = GENERATED_IMAGE_LICENSE_URLS.together;
export const POLLINATIONS_TERMS_URL = GENERATED_IMAGE_LICENSE_URLS.pollinations;
export const DEFAULT_IMAGE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_PROVIDER_TIMEOUTS = Object.freeze({
  'openai-codex': DEFAULT_IMAGE_TIMEOUT_MS,
  gemini: 120_000,
  fal: 120_000,
  together: 120_000,
  pollinations: 120_000,
  wikimedia: 45_000,
  pexels: 45_000,
  pixabay: 45_000,
});
export const MAX_LIBRARY_GENERATIONS = 150;

function deadlineExpired(deadlineAt) {
  return Number.isFinite(deadlineAt) && Date.now() >= deadlineAt;
}

function assertBeforeDeadline(deadlineAt, phase) {
  if (!deadlineExpired(deadlineAt)) return;
  const error = new Error(`${phase} deadline exceeded`);
  error.code = 'ETIMEDOUT';
  throw error;
}

function timeoutForDeadline(deadlineAt, fallbackMs) {
  if (!Number.isFinite(deadlineAt)) return fallbackMs;
  return Math.max(1, Math.min(fallbackMs, Math.floor(deadlineAt - Date.now())));
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif']);
const VISION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    contains_text: { type: 'boolean' },
    contains_logo: { type: 'boolean' },
    contains_recognizable_face: { type: 'boolean' },
    contains_recognizable_foreground_person: { type: 'boolean' },
    looks_like_specific_real_event: { type: 'boolean' },
    is_photograph: { type: 'boolean' },
    is_topic_relevant: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['ok', 'contains_text', 'contains_logo', 'contains_recognizable_face', 'contains_recognizable_foreground_person', 'looks_like_specific_real_event', 'is_photograph', 'is_topic_relevant', 'notes'],
});

function listFilesRecursively(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(filePath);
    }
  };
  visit(root);
  return files;
}

function newestImage(root, minimumMtimeMs = 0) {
  return listFilesRecursively(root)
    .map((filePath) => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
    .filter(({ mtimeMs }) => mtimeMs >= minimumMtimeMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.filePath || null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeJsonParse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

const MAX_PROVIDER_ERROR_BODY_CHARS = 600;

/** Keep provider diagnostics useful without allowing credentials into logs. */
export function summarizeProviderErrorBody(body, maxChars = MAX_PROVIDER_ERROR_BODY_CHARS) {
  const compact = String(body || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|token)["']?\s*[:=]\s*["']?)[^,"'}\s]+/gi, '$1[redacted]');
  return compact.slice(0, maxChars);
}

export function formatProviderHttpError(provider, status, body) {
  const detail = summarizeProviderErrorBody(body);
  return `${provider} image request failed with HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

/** Extract the image block returned by the current Gemini Interactions API. */
export function extractGeminiImageData(response) {
  const stepContents = Array.isArray(response?.steps)
    ? response.steps.flatMap((step) => Array.isArray(step?.content) ? step.content : [])
    : [];
  const imageData = [
    response?.output_image?.data,
    ...stepContents
      .filter((content) => content?.type === 'image')
      .map((content) => content?.data),
  ].find((data) => typeof data === 'string' && data.trim());
  if (!imageData) throw new Error('Gemini returned no image data');
  return String(imageData).replace(/^data:[^;]+;base64,/i, '');
}

function normalizeProviderList(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[,\s]+/);
  return [...new Set(values.map((item) => String(item).trim().toLowerCase()).filter((item) => IMAGE_PROVIDERS.includes(item)))];
}

/** Return the one deterministic chain used by every caller. Explicit provider
 * lists keep their order; `auto` tries generation first and appends licensed
 * photos only for scopes that permit real photographs. */
export function imageProviderSequence({ kind = GENERATED_IMAGE_KIND, scope, provider = 'auto', chain, providers } = {}) {
  const requested = providers || chain || (provider !== 'auto' ? provider : '');
  const explicit = normalizeProviderList(requested);
  if (explicit.length) return explicit;
  if (scopeAllowsLicensedPhoto(scope)) return [...DEFAULT_AUTO_PROVIDER_CHAIN];
  // Keep the legacy photo-kind default for callers that have not supplied a
  // scope. All governed engine calls have a scope and use the rule above.
  if (kind === LICENSED_PHOTO_KIND && scope === undefined) return [...DEFAULT_PHOTO_PROVIDER_CHAIN];
  return [...DEFAULT_GENERATION_PROVIDER_CHAIN];
}

export function providerConfiguration(provider, env = process.env) {
  const keyByProvider = {
    gemini: 'GEMINI_API_KEY',
    fal: 'FAL_KEY',
    together: 'TOGETHER_API_KEY',
    pollinations: 'POLLINATIONS_API_KEY',
    pexels: 'PEXELS_API_KEY',
    pixabay: 'PIXABAY_API_KEY',
  };
  const key = keyByProvider[provider];
  if (!key) return { configured: true, reason: '' };
  return String(env[key] || '').trim()
    ? { configured: true, reason: '' }
    : { configured: false, reason: `missing-key:${key}` };
}

export function providerTimeoutMs(provider, override) {
  const value = typeof override === 'object' ? override?.[provider] : override;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return DEFAULT_PROVIDER_TIMEOUTS[provider] || DEFAULT_IMAGE_TIMEOUT_MS;
}

function parseThreadId(jsonl) {
  for (const line of String(jsonl || '').split(/\r?\n/)) {
    const event = safeJsonParse(line);
    if (event?.type === 'thread.started' && typeof event.thread_id === 'string') return event.thread_id;
  }
  const match = /"thread_id"\s*:\s*"([a-f0-9-]{20,})"/i.exec(String(jsonl || ''));
  return match?.[1] || null;
}

function runProcess(command, args, { cwd, env, input = '', timeoutMs = DEFAULT_IMAGE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* child already exited */ }
      const error = new Error(`${command} timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      finish(error);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_000); });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (code !== 0) {
        const detail = stderr.replace(/\s+/g, ' ').trim().slice(-500);
        finish(new Error(`${command} exited with ${code ?? signal}${detail ? `: ${detail}` : ''}`));
      } else finish(null, { stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function ensureInsideWorkspace(target, label) {
  const root = fs.realpathSync(process.cwd());
  const absolute = path.resolve(target);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the current workspace`);
  }
  return absolute;
}

async function runCodexDirect({ prompt, imagePath = '', imageOutputPath = '', generate = false, schema = null, timeoutMs = DEFAULT_IMAGE_TIMEOUT_MS }) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-codex-image-'));
  const imageGenerationStartedAt = Date.now();
  const outputPath = path.join(runtime, 'last-message.txt');
  const schemaPath = schema ? path.join(runtime, 'schema.json') : '';
  if (schema) fs.writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
  const args = [
    'exec',
    '--ephemeral',
    '--json',
    '--skip-git-repo-check',
    '--cd', runtime,
    '--sandbox', 'workspace-write',
    '--model', CODEX_IMAGE_EXECUTOR_MODEL,
    '-o', outputPath,
  ];
  if (generate) args.push('--enable', 'image_generation');
  if (imagePath) args.push('--image', ensureInsideWorkspace(imagePath, 'imagePath'));
  if (schemaPath) args.push('--output-schema', schemaPath);
  args.push('-');
  try {
    const result = await runProcess(process.env.CODEX_CLI_BIN || 'codex', args, {
      cwd: runtime,
      env: { ...process.env, CODEX_HOME: codexHome() },
      input: prompt,
      timeoutMs,
    });
    const threadId = parseThreadId(result.stdout);
    const generated = threadId
      ? newestImage(path.join(codexHome(), 'generated_images', threadId), imageGenerationStartedAt - 1000)
      : newestImage(path.join(codexHome(), 'generated_images'), imageGenerationStartedAt - 1000);
    if (generate) {
      if (!generated) throw new Error('Codex completed without a generated image file');
      const destination = imageOutputPath ? ensureInsideWorkspace(imageOutputPath, 'imageOutputPath') : path.join(runtime, path.basename(generated));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(generated, destination);
      return { text: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8').trim() : '', imagePath: destination, threadId };
    }
    return { text: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8').trim() : '', threadId };
  } finally {
    fs.rmSync(runtime, { recursive: true, force: true });
  }
}

function requestCodexBroker({ prompt, imagePath = '', imageOutputPath = '', generate = false, schema = null, timeoutMs = DEFAULT_IMAGE_TIMEOUT_MS, deadlineAt }) {
  const socketPath = String(process.env.CODEX_AUTH_BROKER_SOCKET || '').trim();
  if (!socketPath) return Promise.reject(new Error('CODEX_AUTH_BROKER_SOCKET is not configured'));
  const request = {
    op: 'exec',
    prompt,
    timeoutMs,
    schema,
    profile: 'agent',
    notifyStart: true,
    imageGeneration: generate,
    ...(imagePath ? { imagePath: ensureInsideWorkspace(imagePath, 'imagePath') } : {}),
    ...(imageOutputPath ? { imageOutputPath: ensureInsideWorkspace(imageOutputPath, 'imageOutputPath') } : {}),
  };
  return new Promise((resolve, reject) => {
    let data = '';
    let started = false;
    let settled = false;
    const client = net.createConnection(socketPath);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      client.destroy();
      if (error) reject(error); else resolve(value);
    };
    const socketTimeoutMs = Number.isFinite(deadlineAt)
      ? Math.max(1, deadlineAt - Date.now())
      : timeoutMs + 30_000;
    const socketTimeout = setTimeout(() => finish(new Error(`Codex broker timed out after ${timeoutMs}ms`)), socketTimeoutMs);
    socketTimeout.unref?.();
    client.setEncoding('utf8');
    client.on('error', (error) => finish(error));
    client.on('data', (chunk) => {
      let text = String(chunk);
      while (!data && text && (text[0] === '\0' || text[0] === '\x01')) {
        if (text[0] === '\x01') started = true;
        text = text.slice(1);
      }
      if (!text) return;
      data += text;
      const newline = data.indexOf('\n');
      if (newline < 0) return;
      const parsed = safeJsonParse(data.slice(0, newline));
      if (!parsed?.ok) finish(new Error(`Codex broker rejected the request: ${parsed?.error || 'unknown error'}`));
      else finish(null, { text: String(parsed.result || ''), started });
    });
    client.on('end', () => { if (!settled) finish(new Error('Codex broker closed without a response')); });
    client.on('connect', () => client.end(`${JSON.stringify(request)}\n`));
  });
}

async function runCodex({ prompt, imagePath = '', imageOutputPath = '', generate = false, schema = null, timeoutMs = DEFAULT_IMAGE_TIMEOUT_MS, deadlineAt }) {
  if (process.env.CODEX_AUTH_BROKER_SOCKET) {
    return requestCodexBroker({ prompt, imagePath, imageOutputPath, generate, schema, timeoutMs, deadlineAt });
  }
  return runCodexDirect({ prompt, imagePath, imageOutputPath, generate, schema, timeoutMs });
}

async function runGeminiImage(prompt, destination, { timeoutMs = 120_000 } = {}) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  // The stable 3.1 Flash Image model is exposed through the Interactions API;
  // keeping the key in the header also prevents it from entering URL logs.
  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/interactions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.floor(timeoutMs)));
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        model: GEMINI_IMAGE_MODEL,
        input: prompt,
        // The current Interactions image response format accepts JPEG here;
        // PNG remains valid for image input/content blocks, but returns HTTP
        // 400 when requested as the generated response MIME type.
        response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '16:9', image_size: '1K' },
      }),
    });
    if (!response.ok) {
      throw new Error(formatProviderHttpError('Gemini', response.status, await response.text()));
    }
    const json = await response.json();
    const encoded = extractGeminiImageData(json);
    fs.writeFileSync(destination, Buffer.from(encoded, 'base64'), { mode: 0o600 });
    return { imagePath: destination, model: GEMINI_IMAGE_MODEL };
  } finally {
    clearTimeout(timer);
  }
}

export function extractTogetherImageData(response) {
  const item = Array.isArray(response?.data) ? response.data[0] : null;
  const encoded = item?.b64_json || item?.base64 || response?.b64_json;
  if (typeof encoded === 'string' && encoded.trim()) return encoded.replace(/^data:[^;]+;base64,/i, '');
  return null;
}

export function extractFalImageData(response) {
  const item = Array.isArray(response?.images) ? response.images[0] : null;
  const encoded = item?.b64_json || item?.base64 || response?.data?.[0]?.b64_json;
  if (typeof encoded === 'string' && encoded.trim()) return encoded.replace(/^data:[^;]+;base64,/i, '');
  const url = item?.url || response?.data?.[0]?.url;
  if (typeof url !== 'string' || !url.trim()) return null;
  return url.replace(/^data:[^;]+;base64,/i, '');
}

async function downloadImageToFile(url, destination, { provider, timeoutMs, headers = {} } = {}) {
  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))),
  });
  if (!response.ok) throw new Error(formatProviderHttpError(provider, response.status, await response.text()));
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error(`${provider} returned a non-image response (${contentType || 'unknown content type'})`);
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  return { imagePath: destination, contentType };
}

async function runTogetherImage(prompt, destination, { timeoutMs = 120_000 } = {}) {
  const apiKey = String(process.env.TOGETHER_API_KEY || '').trim();
  if (!apiKey) throw new Error('TOGETHER_API_KEY is not configured');
  const response = await fetch('https://api.together.xyz/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))),
    body: JSON.stringify({
      model: TOGETHER_IMAGE_MODEL,
      prompt: prompt.replace(/\n/g, ' ').slice(0, 800),
      width: 1280,
      height: 720,
      steps: 4,
      n: 1,
      response_format: 'b64_json',
    }),
  });
  if (!response.ok) throw new Error(formatProviderHttpError('Together', response.status, await response.text()));
  const json = await response.json();
  const encoded = extractTogetherImageData(json);
  if (encoded) {
    fs.writeFileSync(destination, Buffer.from(encoded, 'base64'), { mode: 0o600 });
    return { imagePath: destination, model: TOGETHER_IMAGE_MODEL };
  }
  const url = json?.data?.[0]?.url;
  if (url) return downloadImageToFile(url, destination, { provider: 'Together', timeoutMs });
  throw new Error('Together returned no image data');
}

async function runFalImage(prompt, destination, { timeoutMs = 120_000 } = {}) {
  const apiKey = String(process.env.FAL_KEY || '').trim();
  if (!apiKey) throw new Error('FAL_KEY is not configured');
  const response = await fetch('https://fal.run/fal-ai/flux/schnell', {
    method: 'POST',
    headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))),
    body: JSON.stringify({
      prompt: prompt.replace(/\n/g, ' ').slice(0, 800),
      image_size: 'landscape_16_9',
      num_inference_steps: 4,
      num_images: 1,
    }),
  });
  if (!response.ok) throw new Error(formatProviderHttpError('Fal', response.status, await response.text()));
  const json = await response.json();
  const image = extractFalImageData(json);
  if (!image) throw new Error('Fal returned no image data');
  if (/^https:\/\//i.test(image)) return downloadImageToFile(image, destination, { provider: 'Fal', timeoutMs });
  fs.writeFileSync(destination, Buffer.from(image, 'base64'), { mode: 0o600 });
  return { imagePath: destination, model: FAL_IMAGE_MODEL };
}

async function runPollinationsImage(prompt, destination, { timeoutMs = 120_000, seed = 1 } = {}) {
  const encodedPrompt = encodeURIComponent(prompt.replace(/\n/g, ' ').slice(0, 800));
  const url = `https://gen.pollinations.ai/image/${encodedPrompt}?width=1280&height=720&model=${POLLINATIONS_IMAGE_MODEL}&nologo=true&seed=${Math.abs(Number(seed) || 1)}`;
  const apiKey = String(process.env.POLLINATIONS_API_KEY || '').trim();
  if (!apiKey) throw new Error('POLLINATIONS_API_KEY is not configured');
  const result = await downloadImageToFile(url, destination, {
    provider: 'Pollinations',
    timeoutMs,
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return { ...result, model: POLLINATIONS_IMAGE_MODEL };
}

function stripMarkup(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function positiveDimension(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

const NON_PHOTOGRAPHIC_TERMS = Object.freeze([
  'painting',
  'paintings',
  'painted',
  'drawing',
  'drawings',
  'illustration',
  'illustrations',
  'illustrated',
  'map',
  'maps',
  'cartographic',
  'coat of arms',
  'heraldic',
  'logo',
  'logos',
  'scan',
  'scans',
  'scanned',
  'poster',
  'posters',
  'engraving',
  'etching',
  'lithograph',
  'woodcut',
  'fresco',
  'collage',
  'watercolour',
  'watercolor',
  'sketch',
  'diagram',
  'flag',
  'screenshot',
  'rendering',
]);

export function isPhotographicMetadata(value) {
  const text = stripMarkup(
    Array.isArray(value)
      ? value.map((item) => typeof item === 'object' ? item?.title || item?.value || '' : item).join(' ')
      : typeof value === 'object' && value !== null
        ? value.value || value.title || value.text || ''
        : value,
  ).toLowerCase();
  return !NON_PHOTOGRAPHIC_TERMS.some((term) => new RegExp(`\\b${term.replace(/ /g, '\\s+')}\\b`, 'i').test(text));
}

export function isSuitablePhotoCandidate(candidate) {
  if (!candidate || (candidate.type !== undefined && String(candidate.type).toLowerCase() !== 'photo')) return false;
  if (!isPhotographicMetadata([
    candidate.title,
    candidate.alt,
    candidate.description,
    candidate.tags,
    candidate.categories,
  ])) return false;
  const width = positiveDimension(candidate.width);
  const height = positiveDimension(candidate.height);
  return Boolean(width && height
    && Math.max(width, height) >= 1600
    && width / height >= 1.2);
}

const PHOTO_AREA_ANCHORS = Object.freeze({
  'ticino-confine': ['lugano', 'locarno', 'bellinzona', 'mendrisio', 'melide', 'morcote', 'agno', 'chiasso', 'ticino', 'como', 'varese'],
  'svizzera-urbana': ['zurich', 'zürich', 'bern', 'basel', 'geneva', 'geneve', 'lausanne', 'lucerne', 'luzern', 'st gallen'],
  'alpi-montagna': ['swiss alps', 'zermatt', 'engadin', 'valais', 'wallis', 'graubunden', 'grisons', 'davos', 'moleson', 'moléson', 'bernese alps'],
  laghi: ['lake lugano', 'lago lugano', 'lac lugano', 'lake maggiore', 'lago maggiore', 'lake geneva', 'lac leman', 'lake zurich', 'lake lucerne', 'lake neuchatel', 'lugano', 'maggiore', 'geneva', 'zurich', 'lucerne', 'neuchatel'],
});

/** Small, explicit vocabulary bridge for Italian article metadata → photo APIs. */
const ARTICLE_PHOTO_TERM_MAP = Object.freeze({
  fiscale: 'fiscal',
  fiscalita: 'taxation',
  stipendio: 'salary',
  stipendi: 'salary',
  salario: 'salary',
  salari: 'salary',
  netto: 'net',
  lordi: 'gross',
  lordo: 'gross',
  calcolo: 'calculation',
  calcoli: 'calculation',
  deduzione: 'deduction',
  deduzioni: 'deductions',
  fonte: 'withholding',
  accordo: 'agreement',
  reddito: 'income',
  redditi: 'income',
  tassa: 'tax',
  tasse: 'tax',
  tassazione: 'taxation',
  fiscale: 'fiscal',
  fisco: 'tax',
  imposta: 'tax',
  imposte: 'tax',
  lavoro: 'employment',
  lavoratore: 'employment',
  lavoratori: 'employment',
  occupazione: 'employment',
  impiego: 'employment',
  impieghi: 'employment',
  professione: 'employment',
  pensione: 'retirement',
  pensioni: 'retirement',
  previdenza: 'retirement',
  affitto: 'rent',
  affitti: 'rent',
  casa: 'housing',
  case: 'housing',
  abitazione: 'housing',
  traffico: 'traffic',
  mobilita: 'mobility',
  mobilità: 'mobility',
  trasporto: 'transport',
  trasporti: 'transport',
  treno: 'railway',
  treni: 'railway',
  salute: 'health',
  sanitaria: 'health',
  sanitario: 'health',
  assicurazione: 'insurance',
  assicurazioni: 'insurance',
  lamal: 'insurance',
  cmi: 'health',
  cassa: 'health',
  malati: 'health',
  copertura: 'coverage',
  coperture: 'coverage',
  premi: 'premiums',
  premio: 'premium',
  diritto: 'right',
  opzione: 'option',
  costi: 'costs',
  costo: 'cost',
  sanita: 'healthcare',
  sanità: 'healthcare',
  famiglia: 'family',
  famiglie: 'family',
  bambini: 'children',
  scuola: 'school',
  istruzione: 'education',
  educazione: 'education',
  banca: 'banking',
  banche: 'banking',
  bancario: 'banking',
  turismo: 'tourism',
  viaggi: 'travel',
  viaggio: 'travel',
  clima: 'climate',
  ambiente: 'environment',
  confine: 'border',
  frontaliere: 'cross-border',
  frontalieri: 'cross-border',
  transfrontaliero: 'cross-border',
  transfrontalieri: 'cross-border',
  regione: 'region',
  regioni: 'regions',
  ticino: 'Ticino',
  svizzera: 'Switzerland',
  svizzero: 'Swiss',
  svizzeri: 'Swiss',
  zurigo: 'Zurich',
  ginevra: 'Geneva',
  berna: 'Bern',
  lugano: 'Lugano',
  locarno: 'Locarno',
  bellinzona: 'Bellinzona',
  mendrisio: 'Mendrisio',
  como: 'Como',
  varese: 'Varese',
  italia: 'Italy',
  italiano: 'Italian',
  italiani: 'Italian',
});
const ARTICLE_PHOTO_STOP_WORDS = new Set([
  'a', 'ad', 'al', 'alla', 'alle', 'and', 'anche', 'at', 'con', 'da', 'de', 'del', 'della', 'delle',
  'di', 'e', 'for', 'from', 'gli', 'il', 'in', 'la', 'le', 'lo', 'nel', 'of', 'per', 'su', 'the', 'to',
  'un', 'una', 'uno', 'with', 'and', 'article', 'articolo', 'editorial', 'illustration', 'scene',
  'come', 'quando', 'quale', 'quali', 'quanto', 'quanti', 'perche', 'perché',
]);
const ARTICLE_PHOTO_FORBIDDEN_METADATA = Object.freeze([
  'brand', 'branding', 'lettering', 'logo', 'logos', 'signage', 'trademark', 'watermark',
  'poster', 'text overlay', 'typography', 'wordmark',
]);
const ARTICLE_GENERIC_PLACE_TERMS = new Set([
  'border', 'canton', 'cantons', 'cross', 'italian', 'italy', 'region', 'regions', 'swiss', 'switzerland', 'ticino',
]);

function foldArticlePhotoText(value) {
  return String(value ?? '')
    .toLocaleLowerCase('it-CH')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function articlePhotoTerms(value) {
  return [...new Set(foldArticlePhotoText(value)
    .split(/\s+/)
    .filter((token) => token.length > 2 && !ARTICLE_PHOTO_STOP_WORDS.has(token))
    .map((token) => ARTICLE_PHOTO_TERM_MAP[token] || token))];
}

function articlePhotoContext(spec = {}) {
  const title = articlePhotoTerms(spec.title || '');
  const subject = title.length ? title : articlePhotoTerms(spec.subject || '');
  const topic = articlePhotoTerms([spec.topic, spec.category].filter(Boolean).join(' '));
  const keywords = articlePhotoTerms(Array.isArray(spec.keywords) ? spec.keywords.join(' ') : spec.keywords || '');
  const explicitPlace = articlePhotoTerms(spec.place || '');
  const place = explicitPlace.length ? explicitPlace : articlePhotoTerms(spec.area || '');
  return {
    topic: [...new Set([...topic, ...keywords, ...subject])],
    place: [...new Set(place)],
    title: [...new Set(subject)],
    requiresPlace: explicitPlace.length > 0,
  };
}

function photoCandidateText(candidate) {
  return stripMarkup([
    candidate?.title,
    candidate?.alt,
    candidate?.description,
    candidate?.tags,
    Array.isArray(candidate?.categories)
      ? candidate.categories.map((value) => typeof value === 'object' ? value?.title || value?.value || '' : value).join(' ')
      : candidate?.categories,
  ].map((value) => value || '').join(' ')).toLowerCase();
}

/** Keep a search hit tied to the geographical area encoded by its slot. */
export function isPhotoCandidateRelevantToSpec(spec, candidate) {
  if (String(spec?.scope || '').trim() === 'article-hero') {
    const context = articlePhotoContext(spec);
    const text = articlePhotoTerms(photoCandidateText(candidate)).map((term) => term.toLowerCase());
    const topic = context.topic.map((term) => term.toLowerCase());
    const place = context.place.map((term) => term.toLowerCase());
    const topicalTerms = topic.filter((term) => !place.includes(term));
    const specificPlace = place.filter((term) => !ARTICLE_GENERIC_PLACE_TERMS.has(term));
    if (!text.length || !topicalTerms.length) return false;
    const hasTopic = topicalTerms.some((term) => text.includes(term));
    const placeTerms = specificPlace.length ? specificPlace : place;
    const hasPlace = !context.requiresPlace || !placeTerms.length || placeTerms.some((term) => text.includes(term));
    return hasTopic && hasPlace;
  }
  const anchors = PHOTO_AREA_ANCHORS[String(spec?.area || '').trim()];
  if (!anchors) return true;
  const text = photoCandidateText(candidate);
  if (!text) return false;
  return anchors.some((anchor) => text.includes(String(anchor).toLowerCase()));
}

export function isSuitableArticlePhotoCandidate(spec, candidate) {
  if (!isSuitablePhotoCandidate(candidate)) return false;
  const text = photoCandidateText(candidate);
  return !ARTICLE_PHOTO_FORBIDDEN_METADATA.some((term) => text.includes(term));
}

export function canonicalPhotoSourceUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return raw;
    const decodedPath = decodeURIComponent(parsed.pathname);
    parsed.pathname = decodedPath.replace(/\/+$/u, '') || '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    // Keep a non-URL value visible to the existing fail-closed filters instead
    // of making a malformed record disappear from collision diagnostics.
    return raw;
  }
}

function recordSourcePageUrl(record) {
  return canonicalPhotoSourceUrl(record?.sourcePageUrl || record?.pageUrl);
}

function photoCollisionKey(value) {
  return String(value || '').trim();
}

export function photoRecordCollision(record, usedRecords = []) {
  if (!record || record.kind !== LICENSED_PHOTO_KIND) return null;
  const sourcePageUrl = recordSourcePageUrl(record);
  const hash = photoCollisionKey(record.sha256);
  for (const used of Array.isArray(usedRecords) ? usedRecords : []) {
    if (!used || used.scope !== record.scope) continue;
    if (sourcePageUrl && sourcePageUrl === recordSourcePageUrl(used)) {
      return { type: 'sourcePageUrl', value: sourcePageUrl, assetId: used.assetId };
    }
    if (hash && hash === photoCollisionKey(used.sha256)) {
      return { type: 'sha256', value: hash, assetId: used.assetId };
    }
  }
  return null;
}

export function selectDeterministicPhotoCandidates(spec, candidates, { usedRecords = [], excludedSourcePageUrls = [] } = {}) {
  const usedPages = new Set((Array.isArray(usedRecords) ? usedRecords : [])
    .filter((record) => record?.scope === spec?.scope)
    .map(recordSourcePageUrl)
    .filter(Boolean));
  const usedHashes = new Set((Array.isArray(usedRecords) ? usedRecords : [])
    .filter((record) => record?.scope === spec?.scope)
    .map((record) => photoCollisionKey(record.sha256))
    .filter(Boolean));
  const excludedPages = new Set((excludedSourcePageUrls instanceof Set
    ? [...excludedSourcePageUrls]
    : Array.isArray(excludedSourcePageUrls) ? excludedSourcePageUrls : [])
    .map(canonicalPhotoSourceUrl)
    .filter(Boolean));
  const unique = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const sourcePageUrl = recordSourcePageUrl(candidate);
    const candidateHash = photoCollisionKey(candidate.sha256 || candidate.sourceSha256);
    const suitable = String(spec?.scope || '').trim() === 'article-hero'
      ? isSuitableArticlePhotoCandidate(spec, candidate)
      : isSuitablePhotoCandidate(candidate);
    if (!sourcePageUrl || !suitable || !isPhotoCandidateRelevantToSpec(spec, candidate)) continue;
    if (usedPages.has(sourcePageUrl) || excludedPages.has(sourcePageUrl) || (candidateHash && usedHashes.has(candidateHash))) continue;
    if (!unique.has(sourcePageUrl)) unique.set(sourcePageUrl, candidate);
  }
  return [...unique.values()].sort((a, b) => {
    const aScore = sha256(`${spec?.scope || ''}|${spec?.assetId || ''}|${spec?.category || ''}|${spec?.area || ''}|${spec?.season || ''}|${spec?.variant || ''}|${spec?.title || ''}|${spec?.topic || ''}|${spec?.place || ''}|${recordSourcePageUrl(a)}`);
    const bScore = sha256(`${spec?.scope || ''}|${spec?.assetId || ''}|${spec?.category || ''}|${spec?.area || ''}|${spec?.season || ''}|${spec?.variant || ''}|${spec?.title || ''}|${spec?.topic || ''}|${spec?.place || ''}|${recordSourcePageUrl(b)}`);
    return aScore.localeCompare(bScore) || recordSourcePageUrl(a).localeCompare(recordSourcePageUrl(b));
  });
}

export function selectDeterministicPhotoCandidate(spec, candidates, options) {
  return selectDeterministicPhotoCandidates(spec, candidates, options)[0] || null;
}

function canonicalPhotoLicense(provider, licenseText, licenseUrl) {
  const text = stripMarkup(licenseText);
  const lower = text.toLowerCase();
  if (provider === 'wikimedia') {
    if (/cc0|creative commons zero/.test(lower)) {
      return { name: 'CC0', family: 'cc0', url: /^https:\/\//i.test(licenseUrl) ? licenseUrl : 'https://creativecommons.org/publicdomain/zero/1.0/' };
    }
    if (/public\s*domain|publicdomain/.test(lower)) {
      return { name: 'Public domain', family: 'pd', url: /^https:\/\//i.test(licenseUrl) ? licenseUrl : 'https://creativecommons.org/publicdomain/mark/1.0/' };
    }
    if (/cc\s*by-sa\b/.test(lower) && !/\b(?:nc|nd)\b/.test(lower)) {
      return { name: text || 'CC BY-SA', family: 'cc-by-sa', url: /^https:\/\//i.test(licenseUrl) ? licenseUrl : 'https://creativecommons.org/licenses/by-sa/4.0/' };
    }
    if (/cc\s*by\b/.test(lower) && !/\b(?:nc|nd)\b/.test(lower)) {
      return { name: text || 'CC BY', family: 'cc-by', url: /^https:\/\//i.test(licenseUrl) ? licenseUrl : 'https://creativecommons.org/licenses/by/4.0/' };
    }
    return null;
  }
  if (provider === 'pexels') return { name: 'Pexels License', family: 'pexels', url: LICENSED_PHOTO_LICENSE_URLS.pexels };
  if (provider === 'pixabay') return { name: 'Pixabay Content License', family: 'pixabay', url: LICENSED_PHOTO_LICENSE_URLS.pixabay };
  return null;
}

/** Verify Wikimedia's extmetadata instead of trusting a search result title. */
export function verifyWikimediaExtmetadata(page) {
  const info = page?.imageinfo?.[0];
  const metadata = info?.extmetadata;
  if (!info || !metadata || typeof metadata !== 'object') return null;
  const title = String(page.title || '');
  const description = metadata.ImageDescription?.value || metadata.ObjectName?.value || '';
  const categories = Array.isArray(page.categories) ? page.categories : [];
  if (!isPhotographicMetadata([title, description, metadata.DepictedPeople?.value, categories])) return null;
  const derivedPageUrl = title
    ? `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, '_')).replace(/%3A/gi, ':')}`
    : '';
  const pageUrl = String(page.fullurl || derivedPageUrl);
  const sourceImageUrl = String(info.thumburl || info.url || '');
  if (!/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/i.test(pageUrl)) return null;
  if (!/^https:\/\//i.test(sourceImageUrl)) return null;
  const mime = String(info.mime || '').toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return null;
  const license = canonicalPhotoLicense(
    'wikimedia',
    metadata.LicenseShortName?.value || metadata.UsageTerms?.value,
    metadata.LicenseUrl?.value,
  );
  const author = stripMarkup(metadata.Artist?.value || metadata.Credit?.value);
  if (!license || !author) return null;
  const width = positiveDimension(info.width);
  const height = positiveDimension(info.height);
  if (!isSuitablePhotoCandidate({ type: 'photo', title, description, categories, width, height })) return null;
  const authorUrl = /^https:\/\//i.test(String(metadata.Artist?.source || '')) ? metadata.Artist.source : undefined;
  return {
    type: 'photo',
    title,
    description,
    categories,
    license: license.name,
    licenseFamily: license.family,
    licenseUrl: license.url,
    author: { name: author, ...(authorUrl ? { url: authorUrl } : {}) },
    sourcePageUrl: pageUrl,
    sourceImageUrl,
    width,
    height,
    sourceWidth: width,
    sourceHeight: height,
    copyrightNotice: license.family === 'pd' || license.family === 'cc0' ? license.name : `© ${author}`,
    acquireLicensePage: pageUrl,
    credit: `${author} · ${license.name}`,
  };
}

function pexelsPhotoRecord(photo) {
  if (!photo?.photographer || !photo?.url) return null;
  const imageUrl = photo.src?.large2x || photo.src?.large || photo.src?.original;
  if (!imageUrl) return null;
  return {
    type: 'photo',
    title: photo.alt || '',
    alt: photo.alt || '',
    license: 'Pexels License',
    licenseFamily: 'pexels',
    licenseUrl: LICENSED_PHOTO_LICENSE_URLS.pexels,
    author: { name: String(photo.photographer), ...(photo.photographer_url ? { url: photo.photographer_url } : {}) },
    sourcePageUrl: String(photo.url),
    sourceImageUrl: String(imageUrl),
    width: positiveDimension(photo.width),
    height: positiveDimension(photo.height),
    sourceWidth: positiveDimension(photo.width),
    sourceHeight: positiveDimension(photo.height),
    copyrightNotice: `© ${photo.photographer}`,
    acquireLicensePage: String(photo.url),
    credit: `${photo.photographer} · Pexels`,
  };
}

export function pixabayAuthorProfileUrl(photo) {
  const user = typeof photo?.user === 'string' ? photo.user.trim() : '';
  const userId = Number(photo?.user_id);
  if (!user || !Number.isInteger(userId) || userId <= 0) return undefined;
  return `https://pixabay.com/users/${encodeURIComponent(user)}-${userId}/`;
}

export function extractPexelsPhotos(response) {
  return (Array.isArray(response?.photos) ? response.photos : [])
    .map(pexelsPhotoRecord)
    .filter(Boolean);
}

export function extractPexelsPhoto(response) {
  return extractPexelsPhotos(response)[0] || null;
}

function pixabayPhotoRecord(photo) {
  const imageUrl = photo?.largeImageURL || photo?.webformatURL;
  if (!photo?.user || !photo?.pageURL || !imageUrl) return null;
  const authorUrl = pixabayAuthorProfileUrl(photo);
  return {
    type: photo.type || 'photo',
    title: photo.tags || '',
    tags: photo.tags || '',
    license: 'Pixabay Content License',
    licenseFamily: 'pixabay',
    licenseUrl: LICENSED_PHOTO_LICENSE_URLS.pixabay,
    author: { name: String(photo.user), ...(authorUrl ? { url: authorUrl } : {}) },
    sourcePageUrl: String(photo.pageURL),
    sourceImageUrl: String(imageUrl),
    width: positiveDimension(photo.imageWidth),
    height: positiveDimension(photo.imageHeight),
    sourceWidth: positiveDimension(photo.imageWidth),
    sourceHeight: positiveDimension(photo.imageHeight),
    copyrightNotice: `© ${photo.user}`,
    acquireLicensePage: String(photo.pageURL),
    credit: `${photo.user} · Pixabay`,
  };
}

export function extractPixabayPhotos(response) {
  return (Array.isArray(response?.hits) ? response.hits : [])
    .map(pixabayPhotoRecord)
    .filter(Boolean);
}

export function extractPixabayPhoto(response) {
  return extractPixabayPhotos(response)[0] || null;
}

export function articleHeroPhotoSearchQueries(spec = {}) {
  const context = articlePhotoContext(spec);
  const topicTerms = context.topic.filter((term) => !context.place.includes(term));
  const titleTerms = context.title.filter((term) => !context.place.includes(term));
  const topic = (topicTerms.length ? topicTerms : context.topic).slice(0, 6).join(' ');
  const place = context.place.slice(0, 5).join(' ');
  const title = (titleTerms.length ? titleTerms : context.title).slice(0, 6).join(' ');
  const queries = [
    [topic, place, 'photograph'],
    [title, place, 'photograph'],
    [topic, 'Switzerland', 'photograph'],
    [place, topic, 'photograph'],
    [topic, 'editorial photograph'],
    [place, 'landscape photograph'],
  ];
  return [...new Set(queries
    .map((parts) => parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean))];
}

export function photoSearchQueries(spec) {
  return String(spec?.scope || '').trim() === 'article-hero'
    ? articleHeroPhotoSearchQueries(spec)
    : eventImagePhotoSearchQueries(spec);
}

export function photoQuery(spec) {
  return photoSearchQueries(spec)[0];
}

export function wikimediaSearchQueries(spec) {
  return photoSearchQueries(spec);
}

async function runWikimediaPhoto(spec, destination, { timeoutMs = 45_000, usedRecords = [], excludedSourcePageUrls = [] } = {}) {
  const userAgent = { 'User-Agent': 'FrontaliereImageEngine/1.0 (https://frontaliereticino.ch/)' };
  const providerDeadline = Date.now() + Math.max(1, Math.floor(timeoutMs));
  const remainingTimeout = () => Math.max(1, providerDeadline - Date.now());
  let lastError = '';
  const candidates = [];
  for (const search of wikimediaSearchQueries(spec)) {
    if (Date.now() >= providerDeadline) break;
    const query = encodeURIComponent(search);
    const endpoint = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${query}&gsrnamespace=6&gsrlimit=20&prop=imageinfo|categories&cllimit=30&inprop=url&iiprop=url|size|mime|extmetadata&iiurlwidth=1600&format=json`;
    let json;
    try {
      const response = await fetch(endpoint, {
        headers: userAgent,
        signal: AbortSignal.timeout(remainingTimeout()),
      });
      if (!response.ok) {
        lastError = formatProviderHttpError('Wikimedia', response.status, await response.text());
        continue;
      }
      json = await response.json();
    } catch (error) {
      lastError = summarizeProviderErrorBody(error?.message || error);
      continue;
    }
    if (json?.error) {
      lastError = `Wikimedia API error: ${String(json.error.info || json.error.code || 'unknown error')}`;
      continue;
    }
    for (const page of Object.values(json?.query?.pages || {})) {
      const metadata = verifyWikimediaExtmetadata(page);
      if (metadata) candidates.push(metadata);
    }
  }
  const ranked = selectDeterministicPhotoCandidates(spec, candidates, { usedRecords, excludedSourcePageUrls });
  for (const photo of ranked) {
    try {
      await downloadImageToFile(photo.sourceImageUrl, destination, {
        provider: 'Wikimedia',
        timeoutMs: remainingTimeout(),
        headers: userAgent,
      });
      return { imagePath: destination, model: 'Wikimedia Commons file mirror', photo };
    } catch (error) {
      // A licensed metadata hit with a broken CDN URL is not a usable record;
      // continue to the next verified file rather than downgrading the gate.
      lastError = summarizeProviderErrorBody(error?.message || error);
    }
  }
  throw new Error(lastError || 'Wikimedia returned no image with a verified CC0/public-domain/CC BY/CC BY-SA licence');
}

async function runPexelsPhoto(spec, destination, { timeoutMs = 45_000, usedRecords = [], excludedSourcePageUrls = [] } = {}) {
  const apiKey = String(process.env.PEXELS_API_KEY || '').trim();
  if (!apiKey) throw new Error('PEXELS_API_KEY is not configured');
  const providerDeadline = Date.now() + Math.max(1, Math.floor(timeoutMs));
  const candidates = [];
  let lastError = '';
  for (const search of photoSearchQueries(spec)) {
    if (Date.now() >= providerDeadline) break;
    const endpoint = `https://api.pexels.com/v1/search?query=${encodeURIComponent(search)}&orientation=landscape&size=large&per_page=20`;
    try {
      const response = await fetch(endpoint, {
        headers: { Authorization: apiKey },
        signal: AbortSignal.timeout(Math.max(1, providerDeadline - Date.now())),
      });
      if (!response.ok) {
        lastError = formatProviderHttpError('Pexels', response.status, await response.text());
        continue;
      }
      candidates.push(...extractPexelsPhotos(await response.json()));
    } catch (error) {
      lastError = summarizeProviderErrorBody(error?.message || error);
    }
  }
  const photo = selectDeterministicPhotoCandidate(spec, candidates, { usedRecords, excludedSourcePageUrls });
  if (!photo) throw new Error(lastError || 'Pexels returned no suitable photo with photographer and source page');
  await downloadImageToFile(photo.sourceImageUrl, destination, { provider: 'Pexels', timeoutMs: Math.max(1, providerDeadline - Date.now()) });
  return { imagePath: destination, model: 'Pexels photo search', photo };
}

async function runPixabayPhoto(spec, destination, { timeoutMs = 45_000, usedRecords = [], excludedSourcePageUrls = [] } = {}) {
  const apiKey = String(process.env.PIXABAY_API_KEY || '').trim();
  if (!apiKey) throw new Error('PIXABAY_API_KEY is not configured');
  const providerDeadline = Date.now() + Math.max(1, Math.floor(timeoutMs));
  const candidates = [];
  let lastError = '';
  for (const search of photoSearchQueries(spec)) {
    if (Date.now() >= providerDeadline) break;
    const endpoint = `https://pixabay.com/api/?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(search)}&image_type=photo&orientation=horizontal&per_page=50&min_width=1600&safesearch=true`;
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(Math.max(1, providerDeadline - Date.now())) });
      if (!response.ok) {
        lastError = formatProviderHttpError('Pixabay', response.status, await response.text());
        continue;
      }
      candidates.push(...extractPixabayPhotos(await response.json()));
    } catch (error) {
      lastError = summarizeProviderErrorBody(error?.message || error);
    }
  }
  const photo = selectDeterministicPhotoCandidate(spec, candidates, { usedRecords, excludedSourcePageUrls });
  if (!photo) throw new Error(lastError || 'Pixabay returned no suitable photo with author and source page');
  await downloadImageToFile(photo.sourceImageUrl, destination, { provider: 'Pixabay', timeoutMs: Math.max(1, providerDeadline - Date.now()) });
  return { imagePath: destination, model: 'Pixabay photo search', photo };
}

async function runGeminiVision(filePath, {
  timeoutMs = 120_000,
  kind = GENERATED_IMAGE_KIND,
  scope,
  subject,
  topic,
  place,
  keywords,
} = {}) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured for the vision fallback');
  const image = fs.readFileSync(filePath).toString('base64');
  const prompt = [
    'Inspect the attached generated image for a publication safety gate.',
    'Return only one JSON object with the keys ok, contains_text, contains_logo, contains_recognizable_face, contains_recognizable_foreground_person, looks_like_specific_real_event, is_photograph, is_topic_relevant and notes.',
    kind === LICENSED_PHOTO_KIND
      ? 'This is a real licensed photo candidate; a real place is allowed, but reject recognizable people in the foreground and logos or brands.'
      : 'Set ok=true only when the image is an original generic illustration and has none of the forbidden properties.',
    kind === LICENSED_PHOTO_KIND
      ? 'Mark contains_text only when present; it is not by itself a rejection for a licensed photo.'
      : 'Mark any readable or decorative lettering, signage, watermark or signature as contains_text=true.',
    'Mark any logo, brand or trademark as contains_logo=true.',
    'Mark any recognizable human face or public figure as contains_recognizable_face=true.',
    'Mark any recognizable person in the foreground as contains_recognizable_foreground_person=true, even when the face is not fully visible.',
    'Mark a documentary/news image of a specific real event as looks_like_specific_real_event=true.',
    kind === LICENSED_PHOTO_KIND
      ? 'Set is_photograph=true only when the image is a real camera photograph, not a painting, drawing, map, scan, poster, logo or illustration.'
      : 'Set is_photograph=false for this generated illustration.',
    scope === 'article-hero'
      ? `For an article hero, set is_topic_relevant=true only when the photograph visibly matches the article topic and place. Subject: ${subject || 'unspecified'}. Topic: ${topic || 'unspecified'}. Place: ${place || 'unspecified'}. Keywords: ${Array.isArray(keywords) ? keywords.join(', ') : keywords || 'unspecified'}. Reject readable text, signage, watermarks and logos.`
      : '',
    `Policy: ${kind === LICENSED_PHOTO_KIND ? LICENSED_PHOTO_RESTRICTIONS.join(' ') : GENERATED_IMAGE_POLICY.join(' ')}`,
  ].join('\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.floor(timeoutMs)));
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        model: GEMINI_IMAGE_MODEL,
        input: [
          { type: 'image', mime_type: 'image/webp', data: image },
          { type: 'text', text: prompt },
        ],
        response_format: { type: 'text' },
      }),
    });
    if (!response.ok) {
      throw new Error(formatProviderHttpError('Gemini vision', response.status, await response.text()));
    }
    const json = await response.json();
    const text = [
      json.output_text,
      ...(json.steps || []).flatMap((step) => (step.content || [])
        .filter((content) => content?.type === 'text')
        .map((content) => content.text)),
    ].filter(Boolean).join('\n');
    return parseVisionResult(text);
  } finally {
    clearTimeout(timer);
  }
}

function xmpFor({ title, provider, model, kind = GENERATED_IMAGE_KIND, licenseUrl = '', credit = '', author, sourcePageUrl = '' }) {
  const digitalSourceType = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';
  const escapeXml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  if (kind === LICENSED_PHOTO_KIND) {
    const authorName = author?.name || credit;
    return `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="frontaliereticino image engine">\n <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/" photoshop:Credit="${escapeXml(credit)}" photoshop:Source="${escapeXml(sourcePageUrl)}" xmpRights:WebStatement="${escapeXml(licenseUrl)}">\n   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(title)}</rdf:li></rdf:Alt></dc:title>\n   <dc:creator><rdf:Seq><rdf:li>${escapeXml(authorName)}</rdf:li></rdf:Seq></dc:creator>\n   <dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(licenseUrl)}</rdf:li></rdf:Alt></dc:rights>\n  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>`;
  }
  return `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="frontaliereticino image engine">\n <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" photoshop:Credit="${escapeXml(GENERATED_IMAGE_CREDIT)}" photoshop:Source="${escapeXml(provider)}" Iptc4xmpExt:DigitalSourceType="${digitalSourceType}">\n   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(title)}</rdf:li></rdf:Alt></dc:title>\n   <dc:creator><rdf:Seq><rdf:li>${escapeXml(GENERATED_IMAGE_CREDIT)}</rdf:li></rdf:Seq></dc:creator>\n   <dc:rights><rdf:Alt><rdf:li xml:lang="x-default">Generated media; ${escapeXml(model)}; provider terms apply.</rdf:li></rdf:Alt></dc:rights>\n  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>`;
}

async function normalizeToWebp(rawPath, outputPath, spec, metadata) {
  const format = spec.format || GENERATED_IMAGE_DEFAULT_FORMAT;
  const qualities = [82, 76, 70, 64, 58, 52, 46];
  let lastBuffer = null;
  for (const quality of qualities) {
    const buffer = await sharp(rawPath, { failOn: 'none' })
      .rotate()
      .resize({ width: format.width, height: format.height, fit: 'cover', position: 'attention' })
      .withXmp(xmpFor({ ...metadata, kind: spec.kind }))
      .webp({ quality, effort: 6 })
      .toBuffer();
    lastBuffer = buffer;
    if (buffer.byteLength <= format.maxBytes) {
      fs.writeFileSync(outputPath, buffer, { mode: 0o600 });
      return { buffer, quality };
    }
  }
  throw new Error(`WebP output remains above ${format.maxBytes} bytes (${lastBuffer?.byteLength || 0})`);
}

async function inspectWebp(filePath, expected, xmpMetadata = {}) {
  const buffer = fs.readFileSync(filePath);
  const imageMetadata = await sharp(buffer).metadata();
  if (imageMetadata.format !== 'webp') throw new Error('normalized image is not WebP');
  if (imageMetadata.width !== expected.width || imageMetadata.height !== expected.height) throw new Error('normalized image dimensions mismatch');
  if (buffer.byteLength > expected.maxBytes) throw new Error('normalized image exceeds byte limit');
  const bytes = buffer.toString('utf8');
  if (expected.kind === LICENSED_PHOTO_KIND) {
    if (!bytes.includes(String(xmpMetadata.licenseUrl || '')) || !bytes.includes(String(xmpMetadata.credit || '')) || bytes.includes('trainedAlgorithmicMedia')) {
      throw new Error('XMP/IPTC licensed-photo marker is missing or contains a generated-media marker');
    }
  } else if (!bytes.includes('trainedAlgorithmicMedia') || !bytes.includes(GENERATED_IMAGE_CREDIT)) {
    throw new Error('XMP/IPTC generated-media marker is missing');
  }
  return { buffer, metadata: imageMetadata };
}

function parseVisionResult(text) {
  const raw = String(text || '').trim();
  const candidates = [raw, ...[...raw.matchAll(/\{[\s\S]*?\}/g)].map((match) => match[0]).reverse()];
  for (const candidate of candidates) {
    const parsed = safeJsonParse(candidate);
    if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') return parsed;
  }
  throw new Error('vision verifier returned no JSON result');
}

export async function verifyGeneratedImage(filePath, {
  deadlineAt,
  kind = GENERATED_IMAGE_KIND,
  scope,
  subject,
  topic,
  place,
  keywords,
} = {}) {
  const prompt = [
    'Inspect the attached generated image for a publication safety gate.',
    'Return only the requested JSON object.',
    kind === LICENSED_PHOTO_KIND
      ? 'This is a real licensed photo candidate; a real place is allowed, but recognizable foreground people and logos or brands are forbidden.'
      : 'Set ok=true only when the image is an original generic illustration and has none of the forbidden properties.',
    kind === LICENSED_PHOTO_KIND
      ? 'contains_text may be true for a real photo and is not alone a rejection.'
      : 'contains_text is true for any readable or decorative lettering, signage, watermark or signature.',
    'contains_logo is true for any logo, brand or trademark.',
    'contains_recognizable_face is true for any recognizable human face or public figure.',
    'contains_recognizable_foreground_person is true for any recognizable person in the foreground, even when the face is not fully visible.',
    'looks_like_specific_real_event is true for a documentary/news photograph of a specific real event.',
    kind === LICENSED_PHOTO_KIND
      ? 'is_photograph is true only for a real camera photograph, never a painting, drawing, map, scan, poster, logo or illustration.'
      : 'is_photograph is false for this generated illustration.',
    scope === 'article-hero'
      ? `This article hero must be relevant to its subject. Subject: ${subject || 'unspecified'}. Topic: ${topic || 'unspecified'}. Place: ${place || 'unspecified'}. Keywords: ${Array.isArray(keywords) ? keywords.join(', ') : keywords || 'unspecified'}. Set is_topic_relevant=true only for a clear match; reject readable text, signage, watermarks and logos.`
      : '',
    `Policy: ${kind === LICENSED_PHOTO_KIND ? LICENSED_PHOTO_RESTRICTIONS.join(' ') : GENERATED_IMAGE_POLICY.join(' ')}`,
  ].join('\n');
  let verdict;
  try {
    assertBeforeDeadline(deadlineAt, 'image vision verification');
    const result = await runCodex({
      prompt,
      imagePath: filePath,
      schema: VISION_SCHEMA,
      timeoutMs: timeoutForDeadline(deadlineAt, DEFAULT_IMAGE_TIMEOUT_MS),
      deadlineAt,
    });
    verdict = parseVisionResult(result.text);
  } catch (codexError) {
    assertBeforeDeadline(deadlineAt, 'image vision fallback');
    if (!String(process.env.GEMINI_API_KEY || '').trim()) throw codexError;
    verdict = await runGeminiVision(filePath, {
      timeoutMs: timeoutForDeadline(deadlineAt, 120_000),
      kind,
      scope,
      subject,
      topic,
      place,
      keywords,
    });
  }
  assertBeforeDeadline(deadlineAt, 'image vision result');
  const articlePhoto = kind === LICENSED_PHOTO_KIND && scope === 'article-hero';
  const rejected = kind === LICENSED_PHOTO_KIND
    ? (!verdict.ok
      || verdict.is_photograph !== true
      || verdict.contains_logo
      || verdict.contains_recognizable_face
      || (articlePhoto && verdict.contains_recognizable_foreground_person !== false)
      || (articlePhoto && verdict.contains_text)
      || (articlePhoto && verdict.is_topic_relevant !== true))
    : (!verdict.ok || verdict.contains_text || verdict.contains_logo || verdict.contains_recognizable_face || verdict.looks_like_specific_real_event);
  if (rejected) {
    throw new Error(`vision gate rejected image: ${String(verdict.notes || 'forbidden content')}`);
  }
  return verdict;
}

function providerRecordFields(provider) {
  const generated = {
    'openai-codex': { model: CODEX_IMAGE_MODEL, executorModel: CODEX_IMAGE_EXECUTOR_MODEL, licenseUrl: OPENAI_TERMS_URL },
    gemini: { model: GEMINI_IMAGE_MODEL, executorModel: GEMINI_IMAGE_MODEL, licenseUrl: GEMINI_TERMS_URL },
    fal: { model: FAL_IMAGE_MODEL, executorModel: FAL_IMAGE_MODEL, licenseUrl: FAL_TERMS_URL },
    together: { model: TOGETHER_IMAGE_MODEL, executorModel: TOGETHER_IMAGE_MODEL, licenseUrl: TOGETHER_TERMS_URL },
    pollinations: { model: POLLINATIONS_IMAGE_MODEL, executorModel: POLLINATIONS_IMAGE_MODEL, licenseUrl: POLLINATIONS_TERMS_URL },
  };
  return generated[provider] || null;
}

/** Generate, verify, convert and return `{ filePath, record }`. */
export async function generateImageFromSpec(spec, {
  outputDir,
  assetId,
  maxAttempts,
  publishedImageUrl,
  provider = 'auto',
  chain,
  providers,
  providerTimeouts,
  verifyImage = verifyGeneratedImage,
  usedRecords = [],
  onProviderAttempt,
  now = () => new Date(),
  deadlineAt,
} = {}) {
  const normalized = normalizeGeneratedImageSpec({ ...spec, assetId: assetId || spec.assetId });
  const finalAssetId = normalized.assetId || `generated-${sha256(generatedImagePromptInput(normalized)).slice(0, 24)}`;
  const destinationDir = path.resolve(outputDir || path.join(process.cwd(), '.cache', 'generated-images'));
  fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
  const finalPath = path.join(destinationDir, `${finalAssetId}.webp`);
  const variationBase = normalized.variant ? `variant ${normalized.variant}` : 'balanced composition';
  const sequence = imageProviderSequence({ scope: normalized.scope, kind: normalized.kind, provider, chain, providers });
  const attemptLimit = Number.isInteger(maxAttempts) && maxAttempts > 0
    ? Math.min(maxAttempts, sequence.length)
    : sequence.length;
  let lastError;
  const failures = [];
  const rejectedPhotoSources = new Set();
  for (let attempt = 0; attempt < attemptLimit; attempt++) {
    assertBeforeDeadline(deadlineAt, 'image generation');
    const selectedProvider = sequence[attempt];
    const availability = providerConfiguration(selectedProvider);
    if (!availability.configured) {
      onProviderAttempt?.({ provider: selectedProvider, attempt: attempt + 1, assetId: finalAssetId, status: 'skipped', reason: availability.reason });
      failures.push({ provider: selectedProvider, reason: availability.reason });
      continue;
    }
    const isPhotoProvider = LICENSED_PHOTO_PROVIDERS.includes(selectedProvider);
    const recordKind = isPhotoProvider ? LICENSED_PHOTO_KIND : GENERATED_IMAGE_KIND;
    if (recordKind === LICENSED_PHOTO_KIND && !scopeAllowsLicensedPhoto(normalized.scope)) {
      const error = new Error(`licensed photos are not allowed for scope ${normalized.scope}`);
      error.code = 'PHOTO_SCOPE_FORBIDDEN';
      failures.push({ provider: selectedProvider, reason: error.message });
      lastError = error;
      continue;
    }
    const variation = attempt === 0 ? variationBase : `${variationBase}; safety revision ${attempt}`;
    const prompt = recordKind === GENERATED_IMAGE_KIND
      ? buildGeneratedImagePrompt({ ...normalized, kind: GENERATED_IMAGE_KIND }, { variation })
      : null;
    const promptHash = prompt ? sha256(prompt) : undefined;
    const rawPath = path.join(destinationDir, `.${finalAssetId}.${attempt}.raw`);
    onProviderAttempt?.({ provider: selectedProvider, attempt: attempt + 1, assetId: finalAssetId, status: 'started', kind: recordKind });
    let photoCandidateAttempts = 0;
    while (true) {
      let attemptedPhotoSource = '';
      try {
      const timeoutMs = timeoutForDeadline(deadlineAt, providerTimeoutMs(selectedProvider, providerTimeouts));
      let providerResult;
      if (selectedProvider === 'openai-codex') {
        await runCodex({
          prompt,
          generate: true,
          imageOutputPath: rawPath,
          timeoutMs,
          deadlineAt,
        });
        providerResult = { imagePath: rawPath, model: CODEX_IMAGE_MODEL };
      } else if (selectedProvider === 'gemini') {
        await runGeminiImage(prompt, rawPath, {
          timeoutMs,
        });
        providerResult = { imagePath: rawPath, model: GEMINI_IMAGE_MODEL };
      } else if (selectedProvider === 'fal') {
        providerResult = await runFalImage(prompt, rawPath, { timeoutMs });
      } else if (selectedProvider === 'together') {
        providerResult = await runTogetherImage(prompt, rawPath, { timeoutMs });
      } else if (selectedProvider === 'pollinations') {
        providerResult = await runPollinationsImage(prompt, rawPath, {
          timeoutMs,
          seed: sha256(`${finalAssetId}:${attempt}`).slice(0, 8),
        });
      } else if (selectedProvider === 'wikimedia') {
        providerResult = await runWikimediaPhoto(normalized, rawPath, {
          timeoutMs,
          usedRecords,
          excludedSourcePageUrls: rejectedPhotoSources,
        });
      } else if (selectedProvider === 'pexels') {
        providerResult = await runPexelsPhoto(normalized, rawPath, {
          timeoutMs,
          usedRecords,
          excludedSourcePageUrls: rejectedPhotoSources,
        });
      } else if (selectedProvider === 'pixabay') {
        providerResult = await runPixabayPhoto(normalized, rawPath, {
          timeoutMs,
          usedRecords,
          excludedSourcePageUrls: rejectedPhotoSources,
        });
      } else {
        throw new Error(`Unsupported image provider: ${selectedProvider}`);
      }
      const generatedAt = now().toISOString();
      assertBeforeDeadline(deadlineAt, 'image normalization');
      const photo = providerResult.photo || null;
      attemptedPhotoSource = recordSourcePageUrl(photo);
      const providerInfo = providerRecordFields(selectedProvider) || {
        model: providerResult.model,
        executorModel: providerResult.model,
        licenseUrl: photo?.licenseUrl,
      };
      if (recordKind === LICENSED_PHOTO_KIND && !photo) throw new Error('licensed-photo provider returned no photo metadata');
      const modifications = recordKind === LICENSED_PHOTO_KIND
        && ['cc-by', 'cc-by-sa'].includes(photo.licenseFamily)
        ? [...LICENSED_PHOTO_MODIFICATIONS]
        : undefined;
      const normalizedForProvider = { ...normalized, kind: recordKind };
      const xmpMetadata = {
        title: normalized.subject,
        provider: selectedProvider,
        model: providerInfo.model,
        licenseUrl: photo?.licenseUrl || providerInfo.licenseUrl,
        credit: photo?.credit || GENERATED_IMAGE_CREDIT,
        author: photo?.author,
        sourcePageUrl: photo?.sourcePageUrl,
        modifications,
      };
      await normalizeToWebp(rawPath, finalPath, normalizedForProvider, xmpMetadata);
      const inspected = await inspectWebp(finalPath, { ...normalized.format, kind: recordKind }, xmpMetadata);
      assertBeforeDeadline(deadlineAt, 'image vision verification');
      const vision = await verifyImage(finalPath, {
        deadlineAt,
        kind: recordKind,
        scope: normalized.scope,
        subject: normalized.subject,
        topic: normalized.topic,
        place: normalized.place,
        keywords: normalized.keywords,
      });
      assertBeforeDeadline(deadlineAt, 'image record finalization');
      const verifiedAt = now().toISOString();
      const record = {
        schema: 1,
        assetId: finalAssetId,
        kind: recordKind,
        provider: selectedProvider,
        model: providerInfo.model,
        executorModel: providerInfo.executorModel,
        ...(recordKind === GENERATED_IMAGE_KIND ? {
          promptVersion: GENERATED_IMAGE_PROMPT_VERSION,
          promptHash,
          license: GENERATED_IMAGE_LICENSE,
          licenseUrl: providerInfo.licenseUrl,
          credit: GENERATED_IMAGE_CREDIT,
        } : {
          license: photo.license,
          licenseFamily: photo.licenseFamily,
          licenseUrl: photo.licenseUrl,
          credit: photo.credit,
          author: photo.author,
          sourcePageUrl: photo.sourcePageUrl,
          sourceImageUrl: photo.sourceImageUrl,
          sourceWidth: photo.sourceWidth || photo.width,
          sourceHeight: photo.sourceHeight || photo.height,
          photoTitle: stripMarkup(photo.title || normalized.title || normalized.subject),
          copyrightNotice: photo.copyrightNotice,
          acquireLicensePage: photo.acquireLicensePage,
          ...(modifications ? { modifications } : {}),
        }),
        sha256: sha256(inspected.buffer),
        bytes: inspected.buffer.byteLength,
        width: inspected.metadata.width,
        height: inspected.metadata.height,
        format: 'webp',
        generatedAt,
        verifiedAt,
        restrictions: [...(recordKind === GENERATED_IMAGE_KIND ? GENERATED_IMAGE_RESTRICTIONS : LICENSED_PHOTO_RESTRICTIONS)],
        scope: normalized.scope,
        imageUrl: publishedImageUrl || generatedImagePathForScope(normalized.scope, finalAssetId),
        category: normalized.category,
        area: normalized.area,
        season: normalized.season,
        variant: normalized.variant,
        vision,
      };
      const collision = recordKind === LICENSED_PHOTO_KIND ? photoRecordCollision(record, usedRecords) : null;
      if (collision) {
        const duplicate = new Error(`licensed photo duplicates ${collision.type} already used by ${collision.assetId}`);
        duplicate.code = 'DUPLICATE_PHOTO';
        throw duplicate;
      }
      const validation = validateGeneratedImageRecord(record);
      if (!validation.valid) throw new Error(`generated record invalid: ${validation.errors.join(', ')}`);
      fs.rmSync(rawPath, { force: true });
      return { filePath: finalPath, record, prompt };
      } catch (error) {
        lastError = error;
        failures.push({ provider: selectedProvider, reason: summarizeProviderErrorBody(error?.message || error) });
        fs.rmSync(rawPath, { force: true });
        fs.rmSync(finalPath, { force: true });
        if (deadlineExpired(deadlineAt)) break;
        if (recordKind === LICENSED_PHOTO_KIND && attemptedPhotoSource && photoCandidateAttempts < 19) {
          rejectedPhotoSources.add(attemptedPhotoSource);
          photoCandidateAttempts += 1;
          continue;
        }
        break;
      }
    }
  }
  const error = new Error(`All image providers failed for ${finalAssetId}: ${failures.map((item) => `${item.provider} (${item.reason})`).join('; ') || lastError?.message || 'unknown error'}`);
  error.failures = failures;
  throw error;
}

function readRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) return { schema: 1, libraryVersion: new Date().toISOString().slice(0, 10), cdnPrefix: '/images/events/library/', assets: [] };
  const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  return { ...parsed, assets: Array.isArray(parsed.assets) ? parsed.assets : [] };
}

export async function generateEventImageLibrary({
  registryPath,
  outputDir,
  limit = 20,
  provider = 'auto',
  chain,
  kind,
  variants = EVENT_IMAGE_LIBRARY_MAX_VARIANTS,
  replaceAssetIds = [],
  onAssetGenerated,
} = {}) {
  const boundedLimit = Math.min(MAX_LIBRARY_GENERATIONS, Math.max(0, Number(limit) || 0));
  const resolvedRegistryPath = path.resolve(registryPath || 'data/event-image-library.json');
  const resolvedOutputDir = path.resolve(outputDir || '.cache/event-image-library');
  const firstRequestedProvider = String(chain || provider || '').split(/[,\s]+/)[0].trim().toLowerCase();
  const resolvedKind = kind || (LICENSED_PHOTO_PROVIDERS.includes(firstRequestedProvider) ? LICENSED_PHOTO_KIND : GENERATED_IMAGE_KIND);
  const registry = readRegistry(resolvedRegistryPath);
  const assetsById = new Map(registry.assets.map((record) => [record.assetId, record]));
  for (const assetId of Array.isArray(replaceAssetIds) ? replaceAssetIds : []) {
    assetsById.delete(String(assetId));
  }
  const generated = [];
  let generationCalls = 0;
  const providerCounts = Object.fromEntries(IMAGE_PROVIDERS.map((name) => [name, 0]));
  const providerFailures = {};
  const explicitProviderRequest = provider !== 'auto' || Boolean(chain);
  const addProviderFailure = (providerName, reason) => {
    providerFailures[providerName] = providerFailures[providerName] || [];
    const entries = providerFailures[providerName];
    const diagnostic = String(reason || 'provider failure');
    if (!entries.includes(diagnostic) && entries.length < 5) entries.push(diagnostic);
  };
  const persist = () => {
    if (registryPath === null) return;
    const partialAssets = [...assetsById.values()].sort((a, b) => String(a.assetId).localeCompare(String(b.assetId)));
    const partial = {
      schema: 1,
      libraryVersion: registry.libraryVersion || new Date().toISOString().slice(0, 10),
      cdnPrefix: '/images/events/library/',
      assetCount: partialAssets.length,
      generatedAt: generated.length > 0 ? new Date().toISOString() : (registry.generatedAt || new Date().toISOString()),
      assets: partialAssets,
    };
    fs.mkdirSync(path.dirname(resolvedRegistryPath), { recursive: true });
    fs.writeFileSync(resolvedRegistryPath, `${JSON.stringify(partial, null, 2)}\n`, 'utf8');
  };
  for (const slot of eventImageLibrarySlots({ variants })) {
    if (generated.length >= boundedLimit) break;
    const existing = assetsById.get(slot.assetId);
    // The registry is the source of truth for already-published slots. CI
    // deliberately starts with an empty local cache, so requiring a local
    // byte here would regenerate the first N assets on every weekly run.
    if (existing && validateGeneratedImageRecord(existing).valid) continue;
    try {
      const result = await generateImageFromSpec({
        scope: 'event-library',
        subject: slot.subject,
        area: slot.area,
        season: slot.season,
        category: slot.category,
        variant: slot.variant,
        assetId: slot.assetId,
        kind: resolvedKind,
        format: GENERATED_IMAGE_DEFAULT_FORMAT,
      }, {
        outputDir: resolvedOutputDir,
        assetId: slot.assetId,
        provider,
        chain,
        usedRecords: [...assetsById.values()],
        onProviderAttempt: ({ provider: attemptedProvider, status = 'started', reason }) => {
          if (status === 'skipped') {
            addProviderFailure(attemptedProvider, reason || 'not configured');
            return;
          }
          if (generationCalls >= MAX_LIBRARY_GENERATIONS) {
            throw new Error(`event image generation budget exhausted at ${MAX_LIBRARY_GENERATIONS} provider attempts`);
          }
          generationCalls += 1;
          providerCounts[attemptedProvider] += 1;
        },
      });
      // The registry and provider queries use the canonical taxonomy key.
      result.record.area = slot.area;
      assetsById.set(slot.assetId, result.record);
      generated.push(result);
      persist();
      onAssetGenerated?.({
        record: result.record,
        generatedCount: generated.length,
        providerCounts: { ...providerCounts },
        providerFailures: { ...providerFailures },
      });
    } catch (error) {
      const failures = Array.isArray(error?.failures) && error.failures.length
        ? error.failures
        : [{ provider: firstRequestedProvider || 'auto', reason: summarizeProviderErrorBody(error?.message || error) }];
      for (const failure of failures) {
        const failureProvider = String(failure.provider || firstRequestedProvider || 'auto');
        addProviderFailure(failureProvider, summarizeProviderErrorBody(failure.reason || error?.message || error));
      }
      // A provider outage must not prevent the remaining chain or other
      // provider-specific runs from filling later slots.
      if (String(error?.message || '').includes('generation budget exhausted')) break;
      if (explicitProviderRequest) break;
    }
  }
  const assets = [...assetsById.values()].sort((a, b) => String(a.assetId).localeCompare(String(b.assetId)));
  const output = {
    schema: 1,
    libraryVersion: registry.libraryVersion || new Date().toISOString().slice(0, 10),
    cdnPrefix: '/images/events/library/',
    assetCount: assets.length,
    generatedAt: generated.length > 0 ? new Date().toISOString() : (registry.generatedAt || new Date().toISOString()),
    assets,
  };
  persist();
  return { registry: output, generated, generationCalls, providerCounts, providerFailures };
}
