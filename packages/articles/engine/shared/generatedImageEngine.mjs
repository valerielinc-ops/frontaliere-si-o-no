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
  GENERATED_IMAGE_LICENSE,
  GENERATED_IMAGE_LICENSE_URLS,
  GENERATED_IMAGE_MAX_BYTES,
  GENERATED_IMAGE_POLICY,
  GENERATED_IMAGE_PROMPT_VERSION,
  GENERATED_IMAGE_RESTRICTIONS,
  validateGeneratedImageRecord,
} from './generatedImageRegistry.mjs';
import { eventImageLibrarySlots } from './eventImageLibrary.mjs';

export const CODEX_IMAGE_MODEL = 'gpt-image-2.5';
export const CODEX_IMAGE_EXECUTOR_MODEL = process.env.CODEX_IMAGE_EXECUTOR_MODEL || 'gpt-5.6-luna';
export const GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image';
export const OPENAI_TERMS_URL = GENERATED_IMAGE_LICENSE_URLS['openai-codex'];
export const GEMINI_TERMS_URL = GENERATED_IMAGE_LICENSE_URLS.gemini;
export const DEFAULT_IMAGE_TIMEOUT_MS = 10 * 60 * 1000;
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
    looks_like_specific_real_event: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['ok', 'contains_text', 'contains_logo', 'contains_recognizable_face', 'looks_like_specific_real_event', 'notes'],
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
        response_format: { type: 'image', mime_type: 'image/png', aspect_ratio: '16:9', image_size: '1K' },
      }),
    });
    if (!response.ok) throw new Error(`Gemini image request failed with HTTP ${response.status}`);
    const json = await response.json();
    const stepImage = json.steps?.flatMap((step) => step.content || [])
      .find((content) => content?.type === 'image' && typeof content.data === 'string')?.data;
    const imageData = json.output_image?.data || stepImage;
    if (!imageData) throw new Error('Gemini returned no image data');
    const encoded = String(imageData).replace(/^data:[^;]+;base64,/i, '');
    fs.writeFileSync(destination, Buffer.from(encoded, 'base64'), { mode: 0o600 });
    return { imagePath: destination, model: GEMINI_IMAGE_MODEL };
  } finally {
    clearTimeout(timer);
  }
}

async function runGeminiVision(filePath, { timeoutMs = 120_000 } = {}) {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured for the vision fallback');
  const image = fs.readFileSync(filePath).toString('base64');
  const prompt = [
    'Inspect the attached generated image for a publication safety gate.',
    'Return only one JSON object with the keys ok, contains_text, contains_logo, contains_recognizable_face, looks_like_specific_real_event and notes.',
    'Set ok=true only when the image is an original generic illustration and has none of the forbidden properties.',
    'Mark any readable or decorative lettering, signage, watermark or signature as contains_text=true.',
    'Mark any logo, brand or trademark as contains_logo=true.',
    'Mark any recognizable human face or public figure as contains_recognizable_face=true.',
    'Mark a documentary/news image of a specific real event as looks_like_specific_real_event=true.',
    `Policy: ${GENERATED_IMAGE_POLICY.join(' ')}`,
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
    if (!response.ok) throw new Error(`Gemini vision request failed with HTTP ${response.status}`);
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

function xmpFor({ title, provider, model }) {
  const digitalSourceType = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';
  const escapeXml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
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
      .withXmp(xmpFor(metadata))
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

async function inspectWebp(filePath, expected) {
  const buffer = fs.readFileSync(filePath);
  const metadata = await sharp(buffer).metadata();
  if (metadata.format !== 'webp') throw new Error('normalized image is not WebP');
  if (metadata.width !== expected.width || metadata.height !== expected.height) throw new Error('normalized image dimensions mismatch');
  if (buffer.byteLength > expected.maxBytes) throw new Error('normalized image exceeds byte limit');
  const bytes = buffer.toString('utf8');
  if (!bytes.includes('trainedAlgorithmicMedia') || !bytes.includes(GENERATED_IMAGE_CREDIT)) {
    throw new Error('XMP/IPTC generated-media marker is missing');
  }
  return { buffer, metadata };
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

export async function verifyGeneratedImage(filePath, { deadlineAt } = {}) {
  const prompt = [
    'Inspect the attached generated image for a publication safety gate.',
    'Return only the requested JSON object.',
    'Set ok=true only when the image is an original generic illustration and has none of the forbidden properties.',
    'contains_text is true for any readable or decorative lettering, signage, watermark or signature.',
    'contains_logo is true for any logo, brand or trademark.',
    'contains_recognizable_face is true for any recognizable human face or public figure.',
    'looks_like_specific_real_event is true for a documentary/news photograph of a specific real event.',
    `Policy: ${GENERATED_IMAGE_POLICY.join(' ')}`,
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
    });
  }
  assertBeforeDeadline(deadlineAt, 'image vision result');
  if (!verdict.ok || verdict.contains_text || verdict.contains_logo || verdict.contains_recognizable_face || verdict.looks_like_specific_real_event) {
    throw new Error(`vision gate rejected image: ${String(verdict.notes || 'forbidden content')}`);
  }
  return verdict;
}

function providerRecordFields(provider) {
  return provider === 'openai-codex'
    ? { model: CODEX_IMAGE_MODEL, executorModel: CODEX_IMAGE_EXECUTOR_MODEL, licenseUrl: OPENAI_TERMS_URL }
    : { model: GEMINI_IMAGE_MODEL, executorModel: GEMINI_IMAGE_MODEL, licenseUrl: GEMINI_TERMS_URL };
}

/** Generate, verify, convert and return `{ filePath, record }`. */
export async function generateImageFromSpec(spec, {
  outputDir,
  assetId,
  maxAttempts = 3,
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
  const providers = ['openai-codex', 'openai-codex', 'gemini'];
  const attemptLimit = Number.isInteger(maxAttempts) && maxAttempts > 0
    ? Math.min(maxAttempts, providers.length)
    : providers.length;
  let lastError;
  for (let attempt = 0; attempt < attemptLimit; attempt++) {
    assertBeforeDeadline(deadlineAt, 'image generation');
    const provider = providers[attempt];
    const variation = attempt === 0 ? variationBase : `${variationBase}; safety revision ${attempt}`;
    const prompt = buildGeneratedImagePrompt(normalized, { variation });
    const promptHash = sha256(prompt);
    const rawPath = path.join(destinationDir, `.${finalAssetId}.${attempt}.raw`);
    onProviderAttempt?.({ provider, attempt: attempt + 1, assetId: finalAssetId });
    try {
      const providerInfo = providerRecordFields(provider);
      if (provider === 'openai-codex') {
        await runCodex({
          prompt,
          generate: true,
          imageOutputPath: rawPath,
          timeoutMs: timeoutForDeadline(deadlineAt, DEFAULT_IMAGE_TIMEOUT_MS),
          deadlineAt,
        });
      } else {
        await runGeminiImage(prompt, rawPath, {
          timeoutMs: timeoutForDeadline(deadlineAt, 120_000),
        });
      }
      const generatedAt = now().toISOString();
      assertBeforeDeadline(deadlineAt, 'image normalization');
      await normalizeToWebp(rawPath, finalPath, normalized, {
        title: normalized.subject,
        provider,
        model: providerInfo.model,
      });
      const inspected = await inspectWebp(finalPath, normalized.format);
      assertBeforeDeadline(deadlineAt, 'image vision verification');
      const vision = await verifyGeneratedImage(finalPath, { deadlineAt });
      assertBeforeDeadline(deadlineAt, 'image record finalization');
      const verifiedAt = now().toISOString();
      const record = {
        schema: 1,
        assetId: finalAssetId,
        provider,
        model: providerInfo.model,
        executorModel: providerInfo.executorModel,
        promptVersion: GENERATED_IMAGE_PROMPT_VERSION,
        promptHash,
        license: GENERATED_IMAGE_LICENSE,
        licenseUrl: providerInfo.licenseUrl,
        credit: GENERATED_IMAGE_CREDIT,
        sha256: sha256(inspected.buffer),
        bytes: inspected.buffer.byteLength,
        width: inspected.metadata.width,
        height: inspected.metadata.height,
        format: 'webp',
        generatedAt,
        verifiedAt,
        restrictions: [...GENERATED_IMAGE_RESTRICTIONS],
        scope: normalized.scope,
        imageUrl: `${normalized.scope === 'event-library' ? '/images/events/library/' : '/images/generated/'}${finalAssetId}.webp`,
        category: normalized.category,
        area: normalized.area,
        season: normalized.season,
        variant: normalized.variant,
        vision,
      };
      const validation = validateGeneratedImageRecord(record);
      if (!validation.valid) throw new Error(`generated record invalid: ${validation.errors.join(', ')}`);
      fs.rmSync(rawPath, { force: true });
      return { filePath: finalPath, record, prompt };
    } catch (error) {
      lastError = error;
      fs.rmSync(rawPath, { force: true });
      fs.rmSync(finalPath, { force: true });
      if (deadlineExpired(deadlineAt)) break;
    }
  }
  throw new Error(`All image providers failed for ${finalAssetId}: ${lastError?.message || 'unknown error'}`);
}

function readRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) return { schema: 1, libraryVersion: new Date().toISOString().slice(0, 10), cdnPrefix: '/images/events/library/', assets: [] };
  const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  return { ...parsed, assets: Array.isArray(parsed.assets) ? parsed.assets : [] };
}

export async function generateEventImageLibrary({ registryPath, outputDir, limit = 20, onAssetGenerated } = {}) {
  const boundedLimit = Math.min(MAX_LIBRARY_GENERATIONS, Math.max(0, Number(limit) || 0));
  const resolvedRegistryPath = path.resolve(registryPath || 'data/event-image-library.json');
  const resolvedOutputDir = path.resolve(outputDir || '.cache/event-image-library');
  const registry = readRegistry(resolvedRegistryPath);
  const assetsById = new Map(registry.assets.map((record) => [record.assetId, record]));
  const generated = [];
  let generationCalls = 0;
  const providerCounts = { 'openai-codex': 0, gemini: 0 };
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
  for (const slot of eventImageLibrarySlots()) {
    if (generated.length >= boundedLimit) break;
    const existing = assetsById.get(slot.assetId);
    // The registry is the source of truth for already-published slots. CI
    // deliberately starts with an empty local cache, so requiring a local
    // byte here would regenerate the first N assets on every weekly run.
    if (existing && validateGeneratedImageRecord(existing).valid) continue;
    const result = await generateImageFromSpec({
      scope: 'event-library',
      subject: slot.subject,
      area: slot.areaLabel,
      season: slot.season,
      category: slot.category,
      variant: slot.variant,
      assetId: slot.assetId,
      format: GENERATED_IMAGE_DEFAULT_FORMAT,
    }, {
      outputDir: resolvedOutputDir,
      assetId: slot.assetId,
      onProviderAttempt: ({ provider }) => {
        if (generationCalls >= MAX_LIBRARY_GENERATIONS) {
          throw new Error(`event image generation budget exhausted at ${MAX_LIBRARY_GENERATIONS} provider attempts`);
        }
        generationCalls += 1;
        providerCounts[provider] += 1;
      },
    });
    // The prompt gets a human-readable area label; the registry keeps the
    // canonical taxonomy key used by the deterministic selector.
    result.record.area = slot.area;
    assetsById.set(slot.assetId, result.record);
    generated.push(result);
    persist();
    onAssetGenerated?.({ record: result.record, generatedCount: generated.length, providerCounts: { ...providerCounts } });
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
  return { registry: output, generated, generationCalls, providerCounts };
}
