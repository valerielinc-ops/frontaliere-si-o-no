import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_MEMORY_PATH = path.resolve(ROOT, 'data', 'jobs-localization-memory.json');
const FILE_VERSION = 1;
const LOCALES = ['it', 'en', 'de', 'fr'];
const NLLB_LANG_MAP = {
  it: 'ita_Latn',
  en: 'eng_Latn',
  de: 'deu_Latn',
  fr: 'fra_Latn',
};

let loadedMemoryPath = '';
let loadedStore = new Map();
let stats = {
  memoryHits: 0,
  memoryMisses: 0,
  providerHits: {
    nllb: 0,
    libretranslate: 0,
    ollama: 0,
  },
  providerFailures: {
    nllb: 0,
    libretranslate: 0,
    ollama: 0,
  },
};

function normalizeSpace(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeParagraphs(value = '') {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sha256(value = '') {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function getConfig() {
  return {
    enabled: String(process.env.JOBS_LOCALIZATION_LOCAL_ENABLED || '1') !== '0',
    memoryPath: path.resolve(process.env.JOBS_LOCALIZATION_MEMORY_PATH || DEFAULT_MEMORY_PATH),
    memoryMaxEntries: Math.max(200, Math.min(100000, Number(process.env.JOBS_LOCALIZATION_MEMORY_MAX_ENTRIES || 30000))),
    nllbEndpoint: normalizeSpace(process.env.JOBS_NLLB_ENDPOINT || ''),
    libreEndpoint: normalizeSpace(process.env.JOBS_LIBRETRANSLATE_ENDPOINT || process.env.LIBRETRANSLATE_URL || ''),
    libreApiKey: normalizeSpace(process.env.JOBS_LIBRETRANSLATE_API_KEY || ''),
    ollamaEndpoint: normalizeSpace(process.env.JOBS_OLLAMA_ENDPOINT || 'http://127.0.0.1:11434/api/generate'),
    ollamaModel: normalizeSpace(process.env.JOBS_OLLAMA_MODEL || ''),
    requestTimeoutMs: Math.max(2000, Math.min(120000, Number(process.env.JOBS_LOCALIZATION_TIMEOUT_MS || 30000))),
  };
}

function ensureStoreLoaded() {
  const { memoryPath } = getConfig();
  if (loadedMemoryPath === memoryPath) return;
  loadedMemoryPath = memoryPath;
  loadedStore = new Map();
  try {
    if (!fs.existsSync(memoryPath)) return;
    const raw = JSON.parse(fs.readFileSync(memoryPath, 'utf-8'));
    if (!raw || raw.version !== FILE_VERSION || !Array.isArray(raw.entries)) return;
    for (const entry of raw.entries) {
      if (!entry?.key || typeof entry.value !== 'string') continue;
      loadedStore.set(entry.key, entry);
    }
  } catch {
    loadedStore = new Map();
  }
}

function persistStore() {
  const { memoryPath, memoryMaxEntries } = getConfig();
  ensureStoreLoaded();
  while (loadedStore.size > memoryMaxEntries) {
    const oldestKey = loadedStore.keys().next().value;
    if (!oldestKey) break;
    loadedStore.delete(oldestKey);
  }
  const entries = Array.from(loadedStore.values());
  fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
  fs.writeFileSync(memoryPath, `${JSON.stringify({ version: FILE_VERSION, entries }, null, 2)}\n`, 'utf-8');
}

function buildMemoryKey({ text, sourceLang, targetLang, kind, context = {} }) {
  return sha256(JSON.stringify({
    kind,
    sourceLang,
    targetLang,
    text: normalizeParagraphs(text),
    title: normalizeSpace(context.title || ''),
    company: normalizeSpace(context.company || ''),
    location: normalizeSpace(context.location || ''),
  }));
}

function getMemoryEntry(key) {
  ensureStoreLoaded();
  const entry = loadedStore.get(key);
  if (!entry) {
    stats.memoryMisses += 1;
    return null;
  }
  stats.memoryHits += 1;
  loadedStore.delete(key);
  loadedStore.set(key, { ...entry, touchedAt: Date.now() });
  return entry.value;
}

function setMemoryEntry(key, value, meta = {}) {
  ensureStoreLoaded();
  loadedStore.set(key, {
    key,
    value,
    provider: meta.provider || 'unknown',
    kind: meta.kind || 'text',
    sourceLang: meta.sourceLang || '',
    targetLang: meta.targetLang || '',
    sourceHash: meta.sourceHash || '',
    createdAt: meta.createdAt || Date.now(),
    touchedAt: Date.now(),
  });
  persistStore();
}

function hasProviderConfigured() {
  const config = getConfig();
  return Boolean(
    config.enabled &&
    (config.nllbEndpoint || config.libreEndpoint || config.ollamaModel)
  );
}

function countBullets(text = '') {
  return (String(text || '').match(/^\s*[-*•]\s+/gm) || []).length;
}

function countHeadings(text = '') {
  return (String(text || '').match(/^##\s+/gm) || []).length;
}

function looksLikeCopy(source = '', candidate = '', kind = 'description') {
  const sourceNorm = normalizeParagraphs(source).toLowerCase();
  const candidateNorm = normalizeParagraphs(candidate).toLowerCase();
  if (!sourceNorm || !candidateNorm) return false;
  if (sourceNorm !== candidateNorm) return false;
  if (kind !== 'title') return true;
  return /[a-zà-öø-ÿ]{4,}/i.test(sourceNorm);
}

function passesQualityGate({ sourceText, candidate, kind, minChars = 0 }) {
  const source = normalizeParagraphs(sourceText);
  const output = normalizeParagraphs(candidate);
  if (!output) return false;
  if (output.length < minChars) return false;
  if (looksLikeCopy(source, output, kind)) return false;
  if (kind === 'title' || kind === 'requirement') {
    if (output.length < Math.max(2, minChars)) return false;
    // Reject titles that look truncated mid-word: single short word ending with
    // lowercase that is a prefix of a word in the source text
    if (kind === 'title' && output.length < source.length * 0.6) {
      const outWords = output.trim().split(/\s+/);
      const lastWord = outWords[outWords.length - 1] || '';
      if (lastWord.length >= 3 && /[a-zà-öø-ÿ]$/.test(lastWord)) {
        const srcWords = source.toLowerCase().split(/\s+/);
        const lwLower = lastWord.toLowerCase();
        for (const sw of srcWords) {
          if (sw.length > lwLower.length + 2 && sw.startsWith(lwLower)) {
            return false; // Looks like a truncated word fragment
          }
        }
      }
    }
    return true;
  }
  const sourceLen = source.length;
  if (sourceLen >= 180 && output.length < Math.max(minChars, Math.floor(sourceLen * 0.45))) {
    return false;
  }
  const sourceBullets = countBullets(source);
  const outputBullets = countBullets(output);
  if (sourceBullets >= 3 && outputBullets === 0) return false;
  const sourceHeadings = countHeadings(source);
  const outputHeadings = countHeadings(output);
  if (sourceHeadings >= 1 && outputHeadings === 0) return false;
  return true;
}

async function fetchJson(url, options = {}, timeoutMs = 30000) {
  const res = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return await res.json();
}

function parseTranslationPayload(payload) {
  const direct = [
    payload?.translated_text,
    payload?.translatedText,
    payload?.translation,
    payload?.text,
    payload?.output,
    payload?.data?.translatedText,
    payload?.data?.translation,
  ];
  for (const value of direct) {
    const clean = normalizeParagraphs(value || '');
    if (clean) return clean;
  }
  if (Array.isArray(payload?.translations) && payload.translations[0]) {
    const first = payload.translations[0];
    return normalizeParagraphs(first?.text || first?.translation || '');
  }
  return '';
}

async function translateWithNllb({ text, sourceLang, targetLang }) {
  const { nllbEndpoint, requestTimeoutMs } = getConfig();
  if (!nllbEndpoint) return '';
  const payload = await fetchJson(
    nllbEndpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        q: text,
        source: sourceLang,
        target: targetLang,
        sourceLang,
        targetLang,
        src_lang: sourceLang,
        tgt_lang: targetLang,
        source_language: NLLB_LANG_MAP[sourceLang] || sourceLang,
        target_language: NLLB_LANG_MAP[targetLang] || targetLang,
      }),
    },
    requestTimeoutMs,
  );
  return parseTranslationPayload(payload);
}

async function translateWithLibreTranslate({ text, sourceLang, targetLang }) {
  const { libreEndpoint, libreApiKey, requestTimeoutMs } = getConfig();
  if (!libreEndpoint) return '';
  const payload = {
    q: text,
    source: sourceLang,
    target: targetLang,
    format: 'text',
  };
  if (libreApiKey) payload.api_key = libreApiKey;
  const result = await fetchJson(
    libreEndpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    requestTimeoutMs,
  );
  return parseTranslationPayload(result);
}

async function translateWithOllama({ text, sourceLang, targetLang, kind, context = {}, draft = '' }) {
  const { ollamaEndpoint, ollamaModel, requestTimeoutMs } = getConfig();
  if (!ollamaModel) return '';
  const roleLabel = kind === 'title'
    ? 'job title'
    : kind === 'requirement'
      ? 'job requirement bullet'
      : 'job description';
  const prompt = [
    `Translate this ${roleLabel} from ${sourceLang} to ${targetLang}.`,
    'Rules:',
    '- Keep company names, brand names, acronyms, product names and legal entities unchanged (e.g. "The North Face" stays "The North Face", never translate brand names literally).',
    '- Preserve every fact and every section.',
    '- Do not summarize or embellish.',
    '- Return only the translated text.',
    context.company ? `Company: ${context.company}` : '',
    context.location ? `Location: ${context.location}` : '',
    context.title ? `Source title: ${context.title}` : '',
    draft ? `Previous low-quality draft to improve:\n${draft}` : '',
    `Source text:\n${text}`,
  ].filter(Boolean).join('\n');
  const result = await fetchJson(
    ollamaEndpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        prompt,
        stream: false,
        options: {
          temperature: 0.1,
        },
      }),
    },
    requestTimeoutMs,
  );
  return normalizeParagraphs(result?.response || result?.text || '');
}

function providerOrder() {
  return [
    { name: 'nllb', fn: translateWithNllb },
    { name: 'libretranslate', fn: translateWithLibreTranslate },
  ];
}

export async function translateTextWithLocalPipeline({
  text,
  sourceLang,
  targetLang,
  kind = 'description',
  context = {},
  minChars = 0,
}) {
  const clean = normalizeParagraphs(text);
  if (!clean) return '';
  if (sourceLang === targetLang) return clean;
  if (!hasProviderConfigured()) return '';
  const key = buildMemoryKey({ text: clean, sourceLang, targetLang, kind, context });
  const memoized = getMemoryEntry(key);
  if (memoized && passesQualityGate({ sourceText: clean, candidate: memoized, kind, minChars })) {
    return memoized;
  }

  let bestDraft = '';
  for (const provider of providerOrder()) {
    try {
      const candidate = normalizeParagraphs(await provider.fn({ text: clean, sourceLang, targetLang, kind, context }));
      if (!candidate) continue;
      if (passesQualityGate({ sourceText: clean, candidate, kind, minChars })) {
        stats.providerHits[provider.name] += 1;
        setMemoryEntry(key, candidate, {
          provider: provider.name,
          kind,
          sourceLang,
          targetLang,
          sourceHash: sha256(clean),
        });
        return candidate;
      }
      bestDraft = candidate;
      stats.providerFailures[provider.name] += 1;
    } catch {
      stats.providerFailures[provider.name] += 1;
    }
  }

  try {
    const repaired = normalizeParagraphs(await translateWithOllama({
      text: clean,
      sourceLang,
      targetLang,
      kind,
      context,
      draft: bestDraft,
    }));
    if (passesQualityGate({ sourceText: clean, candidate: repaired, kind, minChars })) {
      stats.providerHits.ollama += 1;
      setMemoryEntry(key, repaired, {
        provider: 'ollama',
        kind,
        sourceLang,
        targetLang,
        sourceHash: sha256(clean),
      });
      return repaired;
    }
    if (repaired) stats.providerFailures.ollama += 1;
  } catch {
    stats.providerFailures.ollama += 1;
  }

  return '';
}

export async function localizeJobContentWithPipeline({
  title,
  company,
  location,
  description,
  requirements = [],
  sourceLang = 'it',
  targetLocales = LOCALES.filter((locale) => locale !== sourceLang),
}) {
  if (!hasProviderConfigured()) return null;
  const cleanDescription = normalizeParagraphs(description);
  if (!cleanDescription || cleanDescription.length < 120) return null;

  const context = { title, company, location };
  const localized = {
    [sourceLang]: {
      title: normalizeSpace(title),
      description: cleanDescription,
      requirements: Array.isArray(requirements)
        ? requirements.map((item) => normalizeSpace(item)).filter(Boolean).slice(0, 12)
        : [],
    },
  };

  for (const locale of targetLocales) {
    const translatedTitle = await translateTextWithLocalPipeline({
      text: title,
      sourceLang,
      targetLang: locale,
      kind: 'title',
      context,
      minChars: 2,
    });
    const translatedDescription = await translateTextWithLocalPipeline({
      text: cleanDescription,
      sourceLang,
      targetLang: locale,
      kind: 'description',
      context,
      minChars: 120,
    });
    if (!translatedDescription) continue;
    const translatedRequirements = [];
    for (const item of requirements || []) {
      const cleanItem = normalizeSpace(item);
      if (!cleanItem) continue;
      const translatedItem = await translateTextWithLocalPipeline({
        text: cleanItem,
        sourceLang,
        targetLang: locale,
        kind: 'requirement',
        context,
        minChars: 2,
      });
      translatedRequirements.push(translatedItem || cleanItem);
    }
    localized[locale] = {
      title: translatedTitle || '',
      description: translatedDescription,
      requirements: translatedRequirements.filter(Boolean).slice(0, 12),
    };
  }

  return Object.keys(localized).length > 1 ? localized : null;
}

export function getJobLocalizationPipelineStats() {
  ensureStoreLoaded();
  return {
    ...stats,
    memoryEntries: loadedStore.size,
    providersConfigured: {
      nllb: Boolean(getConfig().nllbEndpoint),
      libretranslate: Boolean(getConfig().libreEndpoint),
      ollama: Boolean(getConfig().ollamaModel),
    },
  };
}

export function resetJobLocalizationPipelineStateForTests() {
  loadedMemoryPath = '';
  loadedStore = new Map();
  stats = {
    memoryHits: 0,
    memoryMisses: 0,
    providerHits: {
      nllb: 0,
      libretranslate: 0,
      ollama: 0,
    },
    providerFailures: {
      nllb: 0,
      libretranslate: 0,
      ollama: 0,
    },
  };
}
