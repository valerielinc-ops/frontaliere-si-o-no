#!/usr/bin/env node
/**
 * Re-enrich existing jobs with updated salary estimation (SECTORS data)
 * and company address lookup.
 *
 * This is a one-time script to apply the improved enrichment logic
 * from scripts/lib/shared-jobs-crawler.mjs to the existing job data.
 *
 * Usage: node scripts/re-enrich-jobs.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLLM, isAnyModelAvailable } from './lib/ai-models.mjs';
import { detectLanguage } from './lib/detect-language.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
function roundTo500(n) {
  return Math.round(n / 500) * 500;
}

const LOCALES = ['it', 'en', 'de', 'fr'];

/** Strip locale fields that are just copies of the source text (not translated). */
function stripCopyPasteLocales(job) {
  if (!job || typeof job !== 'object') return job;
  const out = { ...job };
  const baseDesc = String(out.description || '').trim();
  if (!baseDesc || baseDesc.length < 30) return out;

  const det = detectLanguage(baseDesc);
  const sourceLang = det?.language || 'en';

  if (out.descriptionByLocale && typeof out.descriptionByLocale === 'object') {
    const dbl = { ...out.descriptionByLocale };
    const sourceText = String(dbl[sourceLang] || baseDesc).trim().toLowerCase();
    for (const locale of LOCALES) {
      if (locale === sourceLang) continue;
      const localized = String(dbl[locale] || '').trim();
      if (localized && localized.toLowerCase() === sourceText) dbl[locale] = '';
    }
    out.descriptionByLocale = dbl;
  }

  if (out.requirementsByLocale && typeof out.requirementsByLocale === 'object') {
    const rbl = { ...out.requirementsByLocale };
    const sourceReqs = JSON.stringify(rbl[sourceLang] || []);
    for (const locale of LOCALES) {
      if (locale === sourceLang) continue;
      if (JSON.stringify(rbl[locale] || []) === sourceReqs && sourceReqs !== '[]') rbl[locale] = [];
    }
    out.requirementsByLocale = rbl;
  }

  if (out.titleByLocale && typeof out.titleByLocale === 'object') {
    const tbl = { ...out.titleByLocale };
    const baseTitle = String(out.title || '').trim();
    const sourceTitleNorm = String(tbl[sourceLang] || baseTitle).trim().toLowerCase();
    if (sourceTitleNorm.length > 25) {
      for (const locale of LOCALES) {
        if (locale === sourceLang) continue;
        const localized = String(tbl[locale] || '').trim();
        if (localized && localized.toLowerCase() === sourceTitleNorm) tbl[locale] = '';
      }
      out.titleByLocale = tbl;
    }
  }

  // Mark as needing retranslation if any locale was stripped
  const hasEmptyTitle = out.titleByLocale && LOCALES.some(l => !(out.titleByLocale[l] || '').trim());
  const hasEmptyDesc = out.descriptionByLocale && LOCALES.some(l => !(out.descriptionByLocale[l] || '').trim());

  // Also detect cross-locale leaks in canonicalContent.byLocale
  let hasCanonicalLeak = false;
  if (out.canonicalContent?.byLocale) {
    const byLocale = out.canonicalContent.byLocale;
    const localeTexts = {};
    for (const locale of LOCALES) {
      const entry = byLocale[locale];
      if (!entry) continue;
      const text = JSON.stringify(entry.summary || []) + JSON.stringify(entry.responsibilities || []) + JSON.stringify(entry.requirements || []);
      if (text.length < 10) continue;
      localeTexts[locale] = text;
    }
    const vals = Object.values(localeTexts);
    const unique = new Set(vals);
    if (vals.length > 1 && unique.size < vals.length) {
      hasCanonicalLeak = true;
    }
  }

  if (hasEmptyTitle || hasEmptyDesc || hasCanonicalLeak) {
    out.needsRetranslation = true;
  }

  return out;
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const CANONICAL_SECTION_RULES = [
  { id: 'responsibilities', patterns: [/mansion/i, /compit/i, /responsabil/i, /your tasks?/i, /what you will do/i, /deine aufgaben/i, /vos missions?/i] },
  { id: 'requirements', patterns: [/requisit/i, /profil/i, /competenz/i, /requirements?/i, /qualifications?/i, /anforderungen?/i, /votre profil/i] },
  { id: 'benefits', patterns: [/cosa ti offriamo/i, /offriamo/i, /vantagg/i, /benefits?/i, /what we offer/i, /vorteile/i, /avantages?/i] },
  { id: 'process', patterns: [/candid/i, /application/i, /apply/i, /recruit/i, /selection/i, /selezion/i, /bewerb/i, /postuler/i, /contact/i] },
  { id: 'company', patterns: [/chi siamo/i, /about us/i, /uber uns/i, /a propos/i, /azienda/i, /societe/i, /unternehmen/i] },
  { id: 'details', patterns: [/dettagli/i, /details?/i, /informazioni/i, /additional information/i, /weitere informationen/i, /informations complementaires/i] },
];

const SECTION_KEYWORDS_RE = /(Mansioni|Compiti|Responsabilità|Le tue mansioni|Requisiti|Il tuo profilo|Profilo|Competenze richieste|Cosa ti offriamo|Vantaggi|Benefici|Contatti|Informazioni aggiuntive|Your tasks|Your responsibilities|Requirements|Your profile|What we offer|Benefits|About us|Contact|Deine Aufgaben|Anforderungen|Dein Profil|Was wir bieten|Vorteile|Kontakt|Vos missions|Exigences|Votre profil|Ce que nous offrons|Avantages|À propos|Contact)/gi;

const KEYWORD_STOPWORDS = new Set([
  'della', 'delle', 'degli', 'dello', 'dall', 'nell', 'sulla', 'con', 'per', 'che', 'come', 'sono', 'sarai', 'azienda',
  'your', 'with', 'from', 'this', 'that', 'will', 'have', 'must', 'work', 'role', 'team', 'you',
  'und', 'mit', 'der', 'die', 'das', 'ein', 'eine', 'fur', 'sind', 'sie', 'wir',
  'avec', 'pour', 'dans', 'vous', 'nous', 'une', 'des', 'les', 'est', 'sont',
  'job', 'lavoro', 'ticino', 'lugan', 'position', 'ruolo', 'offerta',
]);

const CANONICAL_AI_FALLBACK_ENABLED = /^(1|true|yes)$/i.test(String(process.env.JOBS_CANONICAL_AI_FALLBACK || '1'));
const CANONICAL_AI_MAX_JOBS = Math.max(0, Number(process.env.JOBS_CANONICAL_AI_MAX_JOBS || 25));
const CANONICAL_AI_TIMEOUT_MS = Math.max(3000, Number(process.env.JOBS_CANONICAL_AI_TIMEOUT_MS || 12000));
const CANONICAL_AI_MIN_COVERAGE = Math.min(99, Math.max(30, Number(process.env.JOBS_CANONICAL_AI_MIN_COVERAGE || 65)));
const FORCE_REESTIMATE = /^(1|true|yes)$/i.test(String(process.env.FORCE_REESTIMATE || '0'));

function cleanText(raw = '') {
  return String(raw || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\s+$/gm, '')
    .trim();
}

function compactText(raw = '') {
  return String(raw || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toStringArray(value, max = 12) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const clean = compactText(String(item || ''));
    if (!clean || clean.length < 3) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

function splitIntoParagraphs(raw = '', max = 10) {
  const clean = cleanText(raw);
  if (!clean) return [];
  const byBreaks = clean
    .split(/\n{2,}/)
    .map((p) => compactText(p))
    .filter((p) => p.length >= 25);
  if (byBreaks.length > 0) return byBreaks.slice(0, max);
  const bySentence = compactText(clean)
    .split(/(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 25);
  return bySentence.slice(0, max);
}

function normalizeDescriptionForSections(raw = '') {
  let text = cleanText(raw);
  if (!text) return '';
  text = text.replace(/([^#\n])\s*(#{1,3}\s)/g, '$1\n$2');
  text = text.replace(/([.!?:])\s+([•·▪◦*-]\s+)/g, '$1\n- ');
  text = text.replace(/\s+([•·▪◦]\s+)/g, '\n- ');
  text = text.replace(/\s+(-\s)(?=[A-ZÀ-ÖÙ-Ü])/g, '\n$1');
  text = text.replace(SECTION_KEYWORDS_RE, (m) => `\n## ${m}`);
  return text
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function classifySectionId(heading = '') {
  const h = String(heading || '').trim();
  if (!h) return 'details';
  for (const rule of CANONICAL_SECTION_RULES) {
    if (rule.patterns.some((rx) => rx.test(h))) return rule.id;
  }
  return 'details';
}

function splitLineIntoItems(line = '') {
  const compact = compactText(line);
  if (!compact) return [];
  if (compact.length <= 140) return [compact];
  return compact
    .split(/(?<=[.!?])\s+(?=[A-ZÀ-ÖÙ-Ü])/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 20);
}

function uniqueTrimmed(items, max = 12) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    let clean = compactText(String(item || '').replace(/^[-•*]\s*/, '').replace(/&[A-Za-z]+;/g, ' ').replace(/\s+/g, ' '));
    if (!clean) continue;
    if (clean.length < 4 || clean.length > 260) continue;
    // Skip truncated artifacts (e.g. "Requisiti di ordine ge ...")
    if (/\.{2,}\s*$/.test(clean)) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

function extractKeywords(text = '', max = 10) {
  const tokens = compactText(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !KEYWORD_STOPWORDS.has(w));
  const freq = new Map();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .slice(0, max)
    .map(([w]) => w);
}

function normalizeComparableText(raw = '') {
  return compactText(raw)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&(?:newline|raquo);/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeParseJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return null;
}

function splitMixedCanonicalItems(line = '') {
  const clean = compactText(
    String(line || '')
      .replace(/&[A-Za-z]+;/g, ' ')
      .replace(/^\.{2,}\s*$/, '')
      .replace(/^\s*#{1,6}\s*/, '')
      .replace(/\s+/g, ' ')
  );
  if (!clean) return [];
  // Skip truncated artifacts (e.g. "Requisiti di ordine ge ...")
  if (/\.{2,}\s*$/.test(clean)) return [];
  const pieces = clean
    .replace(/\s*[•·▪◦]\s*/g, ' | ')
    .split(/\s+\|\s+|\s*;\s*[-•]\s+|\s*;\s+(?=[A-ZÀ-ÖÙ-Ü])|(?<=[.!?])\s+(?=[A-ZÀ-ÖÙ-Ü])/)
    .map((x) => compactText(String(x || '').replace(/^[-*]\s*/, '')))
    .filter(Boolean);
  return uniqueTrimmed(pieces.length > 0 ? pieces : [clean], 20);
}

function inferSectionFromContent(text = '') {
  const t = normalizeComparableText(text);
  if (!t) return null;
  if (/@/.test(t) || /\b(tel|telefono|phone|email|e mail|kontakt|contatt)\b/.test(t)) return 'process';
  if (/\b(requisit|profilo|competenz|requirements|qualifications|anforder|votre profil|required|preferred|eligibility)\b/.test(t)) return 'requirements';
  if (/\b(mansion|compit|responsabil|tasks|attivita|deine aufgaben|vos missions)\b/.test(t)) return 'responsibilities';
  if (/\b(offriamo|benefits|vorteile|avantages|cosa ti offriamo|what we offer)\b/.test(t)) return 'benefits';
  if (/\b(candid|apply|application|selection|selezion|bewerb|postuler)\b/.test(t)) return 'process';
  if (/\b(chi siamo|about us|uber uns|a propos|azienda|societe|unternehmen)\b/.test(t)) return 'company';
  return null;
}

function isChunkCovered(chunk, usedItems) {
  const n = normalizeComparableText(chunk);
  if (!n) return true;
  for (const item of usedItems) {
    const u = normalizeComparableText(item);
    if (!u) continue;
    if (u === n) return true;
    if (u.length >= 28 && n.includes(u)) return true;
    if (n.length >= 28 && u.includes(n)) return true;
  }
  return false;
}

function toCanonicalList(value, max = 12) {
  if (Array.isArray(value)) return uniqueTrimmed(value, max);
  if (typeof value === 'string') return uniqueTrimmed(splitMixedCanonicalItems(value), max);
  return [];
}

function mergeCanonicalSections(sections, max = 10) {
  if (!Array.isArray(sections)) return [];
  const out = [];
  const seen = new Set();
  for (const section of sections) {
    const heading = compactText(String(section?.heading || ''));
    const id = compactText(String(section?.id || 'details')).toLowerCase() || 'details';
    const paragraphs = uniqueTrimmed(Array.isArray(section?.paragraphs) ? section.paragraphs : [], 10);
    const bullets = uniqueTrimmed(Array.isArray(section?.bullets) ? section.bullets : [], 12);
    if (!heading && paragraphs.length === 0 && bullets.length === 0) continue;
    const key = `${id}|${heading.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id,
      heading: heading || 'Dettagli',
      paragraphs,
      bullets,
    });
    if (out.length >= max) break;
  }
  return out;
}

function containsFormattingArtifacts(content) {
  const pool = [
    ...toCanonicalList(content?.summary, 6),
    ...toCanonicalList(content?.responsibilities, 16),
    ...toCanonicalList(content?.requirements, 16),
    ...toCanonicalList(content?.benefits, 16),
    ...toCanonicalList(content?.process, 16),
    ...(Array.isArray(content?.sections)
      ? content.sections.flatMap((s) => [s?.heading, ...(s?.paragraphs || []), ...(s?.bullets || [])])
      : []),
  ]
    .map((x) => String(x || ''))
    .join('\n');
  return /&(?:newline|raquo);|(^|\s)#{1,6}\s+|^\?+$|^-+\s*(?:chiave|key)$/gim.test(pool);
}

function parseStructuredLocaleContent(description, requirements = []) {
  const text = normalizeDescriptionForSections(description);
  const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
  const sectionsPass1 = [];
  let current = null;
  const introParagraphs = [];

  const flushCurrent = () => {
    if (!current) return;
    current.paragraphs = uniqueTrimmed(current.paragraphs, 10);
    current.bullets = uniqueTrimmed(current.bullets, 12);
    if (current.heading || current.paragraphs.length > 0 || current.bullets.length > 0) {
      sectionsPass1.push(current);
    }
    current = null;
  };

  // Pass 1: heading-aware extraction
  for (const line of lines) {
    const normalizedLine = compactText(String(line || '').replace(/&(?:newline|raquo);/gi, ' '));
    if (!normalizedLine) continue;
    const h1 = normalizedLine.match(/^#{1,3}\s+(.+)/);
    if (h1) {
      flushCurrent();
      const heading = compactText(h1[1].replace(/:$/, ''));
      current = { id: classifySectionId(heading), heading, paragraphs: [], bullets: [] };
      continue;
    }
    if (/^[A-ZÀ-ÖÙ-Ü][^.!?]{2,90}:$/.test(normalizedLine)) {
      flushCurrent();
      const heading = compactText(normalizedLine.replace(/:$/, ''));
      current = { id: classifySectionId(heading), heading, paragraphs: [], bullets: [] };
      continue;
    }

    const bullet = normalizedLine.match(/^[-•*]\s+(.+)/);
    if (bullet) {
      const items = splitMixedCanonicalItems(bullet[1]);
      if (current) current.bullets.push(...items);
      else introParagraphs.push(...items);
      continue;
    }

    const items = splitMixedCanonicalItems(normalizedLine);
    if (current) current.paragraphs.push(...items);
    else introParagraphs.push(...items);
  }
  flushCurrent();

  // Pass 2: content-based reclassification (fix mixed sections)
  const coreBuckets = {
    responsibilities: [],
    requirements: toStringArray(requirements, 12),
    benefits: [],
    process: [],
  };
  const detailSections = [];
  const addToDetails = (sourceSection, item, isBullet = false) => {
    const heading = compactText(String(sourceSection?.heading || 'Dettagli'));
    const id = compactText(String(sourceSection?.id || 'details')).toLowerCase() || 'details';
    const key = `${id}|${heading.toLowerCase()}`;
    let target = detailSections.find((s) => s._key === key);
    if (!target) {
      target = { _key: key, id, heading: heading || 'Dettagli', paragraphs: [], bullets: [] };
      detailSections.push(target);
    }
    if (isBullet) target.bullets.push(item);
    else target.paragraphs.push(item);
  };

  for (const section of sectionsPass1) {
    const items = [
      ...section.paragraphs.map((value) => ({ value, isBullet: false })),
      ...section.bullets.map((value) => ({ value, isBullet: true })),
    ];
    for (const entry of items) {
      const item = compactText(entry.value);
      if (!item) continue;
      const inferred = inferSectionFromContent(item);
      const sectionId = inferred || section.id || 'details';
      if (Object.prototype.hasOwnProperty.call(coreBuckets, sectionId)) {
        coreBuckets[sectionId].push(item);
      } else {
        addToDetails(section, item, entry.isBullet);
      }
    }
  }

  for (const item of introParagraphs) {
    const inferred = inferSectionFromContent(item);
    if (inferred && Object.prototype.hasOwnProperty.call(coreBuckets, inferred)) {
      coreBuckets[inferred].push(item);
    }
  }

  // Pass 3: preserve uncovered source chunks in "notes" section
  const sourceChunks = uniqueTrimmed([
    ...splitIntoParagraphs(description, 28).flatMap(splitMixedCanonicalItems),
    ...toStringArray(requirements, 12),
  ], 140);

  const summary = uniqueTrimmed(introParagraphs, 3);
  const sectionResponsibilities = uniqueTrimmed(coreBuckets.responsibilities, 12);
  const sectionRequirements = uniqueTrimmed(coreBuckets.requirements, 12);
  const sectionBenefits = uniqueTrimmed(coreBuckets.benefits, 10);
  const sectionProcess = uniqueTrimmed(coreBuckets.process, 8);
  const mergedRequirements = uniqueTrimmed([...toStringArray(requirements, 10), ...sectionRequirements], 12);

  const detailSectionsClean = mergeCanonicalSections(
    detailSections.map((s) => ({
      id: s.id || 'details',
      heading: s.heading || 'Dettagli',
      paragraphs: s.paragraphs,
      bullets: s.bullets,
    })),
    9
  );
  const usedItems = [
    ...summary,
    ...sectionResponsibilities,
    ...mergedRequirements,
    ...sectionBenefits,
    ...sectionProcess,
    ...detailSectionsClean.flatMap((s) => [...s.paragraphs, ...s.bullets]),
  ];
  const residual = uniqueTrimmed(sourceChunks.filter((chunk) => !isChunkCovered(chunk, usedItems)), 24);
  const sections = mergeCanonicalSections([
    ...detailSectionsClean,
    ...(residual.length > 0 ? [{ id: 'notes', heading: 'Note', paragraphs: residual.slice(0, 10), bullets: residual.slice(10, 20) }] : []),
  ], 10);

  const usedFinal = [
    ...summary,
    ...sectionResponsibilities,
    ...mergedRequirements,
    ...sectionBenefits,
    ...sectionProcess,
    ...sections.flatMap((s) => [...s.paragraphs, ...s.bullets]),
  ];
  const coveredChunks = sourceChunks.filter((chunk) => isChunkCovered(chunk, usedFinal)).length;
  const coverage = sourceChunks.length > 0 ? Math.round((coveredChunks / sourceChunks.length) * 100) : 100;
  const compactDescription = compactText(description);
  const wordCount = compactDescription ? compactDescription.split(/\s+/).length : 0;
  const readingMinutes = Math.max(1, Math.round(wordCount / 180));
  const highlights = uniqueTrimmed(
    [...sectionResponsibilities.slice(0, 4), ...sectionBenefits.slice(0, 3), ...mergedRequirements.slice(0, 2)],
    8
  );

  return {
    summary: summary.length > 0 ? summary : splitIntoParagraphs(description, 2),
    sections,
    responsibilities: sectionResponsibilities,
    requirements: mergedRequirements,
    benefits: sectionBenefits,
    process: sectionProcess,
    highlights,
    keywords: extractKeywords(`${compactDescription} ${mergedRequirements.join(' ')}`, 10),
    readingMinutes,
    _meta: {
      coverage,
      sourceChunks: sourceChunks.length,
      coveredChunks,
      pass3Residual: residual.length,
    },
  };
}

function needsCanonicalAiFallback(parsed = null) {
  if (!parsed) return true;
  const coverage = Number(parsed?._meta?.coverage || 0);
  const coreCount =
    Number(parsed?.responsibilities?.length || 0)
    + Number(parsed?.requirements?.length || 0)
    + Number(parsed?.benefits?.length || 0)
    + Number(parsed?.process?.length || 0);
  if (coverage < CANONICAL_AI_MIN_COVERAGE) return true;
  if (coreCount < 2) return true;
  if (containsFormattingArtifacts(parsed)) return true;
  return false;
}

async function applyCanonicalAiFallback(locale, description, requirements, parsed) {
  const prompt = [
    `Canonicalize this job description in locale "${locale}" into structured sections.`,
    'Return STRICT JSON only with this schema:',
    '{"summary":[],"responsibilities":[],"requirements":[],"benefits":[],"process":[],"details":[],"notes":[],"keywords":[]}',
    'Rules:',
    '- Keep factual content only from source text.',
    '- Preserve key requirements and steps.',
    '- Use short bullet items (max 220 chars each).',
    '- Do not invent salary/location/company data.',
    '',
    'SOURCE_DESCRIPTION:',
    String(description || '').slice(0, 14000),
    '',
    'SOURCE_REQUIREMENTS:',
    JSON.stringify(toStringArray(requirements, 12)),
  ].join('\n');

  try {
    const raw = await callLLM(
      [{ role: 'user', content: prompt }],
      {
        temperature: 0,
        maxTokens: 1600,
        jsonMode: true,
        timeout: CANONICAL_AI_TIMEOUT_MS,
      }
    );
    const ai = safeParseJsonObject(raw);
    if (!ai || typeof ai !== 'object') return null;

    const aiSummary = toCanonicalList(ai.summary, 4);
    const aiResponsibilities = toCanonicalList(ai.responsibilities, 12);
    const aiRequirements = toCanonicalList(ai.requirements, 12);
    const aiBenefits = toCanonicalList(ai.benefits, 10);
    const aiProcess = toCanonicalList(ai.process, 8);
    const aiDetails = toCanonicalList(ai.details, 12);
    const aiNotes = toCanonicalList(ai.notes, 12);
    const aiKeywords = toCanonicalList(ai.keywords, 10);

    const merged = {
      ...parsed,
      summary: uniqueTrimmed([...parsed.summary, ...aiSummary], 3),
      responsibilities: uniqueTrimmed([...parsed.responsibilities, ...aiResponsibilities], 12),
      requirements: uniqueTrimmed([...toStringArray(requirements, 10), ...parsed.requirements, ...aiRequirements], 12),
      benefits: uniqueTrimmed([...parsed.benefits, ...aiBenefits], 10),
      process: uniqueTrimmed([...parsed.process, ...aiProcess], 8),
      sections: mergeCanonicalSections([
        ...(Array.isArray(parsed.sections) ? parsed.sections : []),
        ...(aiDetails.length > 0 ? [{ id: 'details', heading: 'Dettagli', paragraphs: aiDetails, bullets: [] }] : []),
        ...(aiNotes.length > 0 ? [{ id: 'notes', heading: 'Note', paragraphs: aiNotes.slice(0, 8), bullets: aiNotes.slice(8, 12) }] : []),
      ], 10),
      keywords: uniqueTrimmed([...parsed.keywords, ...aiKeywords], 10),
      _meta: {
        ...(parsed._meta || {}),
        aiFallbackUsed: true,
      },
    };
    if (!merged.summary.length) {
      merged.summary = splitIntoParagraphs(description, 2);
    }
    return merged;
  } catch {
    return null;
  }
}

async function buildCanonicalContent(job, aiState) {
  const byLocale = {};
  const localeList = ['it', 'en', 'de', 'fr'];
  for (const locale of localeList) {
    const localizedDescription = compactText(job?.descriptionByLocale?.[locale] || '');
    if (!localizedDescription) continue;
    const localizedReqs = toStringArray(job?.requirementsByLocale?.[locale] || job?.requirements, 10);
    let parsed = parseStructuredLocaleContent(localizedDescription, localizedReqs);

    if (
      aiState?.enabled
      && aiState.remaining > 0
      && needsCanonicalAiFallback(parsed)
    ) {
      aiState.attempted += 1;
      aiState.remaining -= 1;
      const aiParsed = await applyCanonicalAiFallback(locale, localizedDescription, localizedReqs, parsed);
      if (aiParsed) {
        parsed = aiParsed;
        aiState.used += 1;
      } else {
        aiState.failed += 1;
      }
    }
    byLocale[locale] = parsed;
  }

  if (Object.keys(byLocale).length === 0) {
    const fallbackDescription = compactText(job?.description || '');
    if (!fallbackDescription) return null;
    let fallbackParsed = parseStructuredLocaleContent(fallbackDescription, toStringArray(job?.requirements, 10));
    if (
      aiState?.enabled
      && aiState.remaining > 0
      && needsCanonicalAiFallback(fallbackParsed)
    ) {
      aiState.attempted += 1;
      aiState.remaining -= 1;
      const aiParsed = await applyCanonicalAiFallback('it', fallbackDescription, toStringArray(job?.requirements, 10), fallbackParsed);
      if (aiParsed) {
        fallbackParsed = aiParsed;
        aiState.used += 1;
      } else {
        aiState.failed += 1;
      }
    }
    byLocale.it = fallbackParsed;
  }

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    byLocale,
  };
}

function parseSalaryNumber(raw = '') {
  const input = String(raw || '').trim();
  if (!input) return null;
  let cleaned = input
    .replace(/[’']/g, '')
    .replace(/\s+/g, '')
    .replace(/CHF|EUR/gi, '');
  // 1.850 -> 1850 (thousands separator)
  if (/^\d{1,3}\.\d{3}$/.test(cleaned)) cleaned = cleaned.replace('.', '');
  // 1,850 -> 1850 (thousands separator)
  if (/^\d{1,3},\d{3}$/.test(cleaned)) cleaned = cleaned.replace(',', '');
  // fallback: normalize comma decimal to dot
  if (cleaned.includes(',') && !cleaned.includes('.')) cleaned = cleaned.replace(',', '.');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n;
}

function extractReportedAnnualSalary(job) {
  const source = [
    String(job?.description || ''),
    String(job?.descriptionByLocale?.en || ''),
    String(job?.descriptionByLocale?.it || ''),
    String(job?.descriptionByLocale?.de || ''),
    String(job?.descriptionByLocale?.fr || ''),
  ]
    .join('\n')
    .replace(/\u00a0/g, ' ');

  const monthlyPatterns = [
    /gross\s+monthly\s+salary\s*[:\-]?\s*([0-9][0-9'’.,\s]{1,16})\s*(CHF|EUR)/i,
    /monthly\s+gross\s+salary\s*[:\-]?\s*([0-9][0-9'’.,\s]{1,16})\s*(CHF|EUR)/i,
    /bruttomonat(?:s|liches)\s+gehalt\s*[:\-]?\s*([0-9][0-9'’.,\s]{1,16})\s*(CHF|EUR)/i,
    /stipendio\s+mensile\s+lordo\s*[:\-]?\s*([0-9][0-9'’.,\s]{1,16})\s*(CHF|EUR)/i,
    /salaire\s+mensuel\s+brut\s*[:\-]?\s*([0-9][0-9'’.,\s]{1,16})\s*(CHF|EUR)/i,
  ];
  for (const rx of monthlyPatterns) {
    const m = source.match(rx);
    if (!m) continue;
    const monthly = parseSalaryNumber(m[1]);
    if (!monthly || monthly < 300 || monthly > 20000) continue;
    const annual = Math.round(monthly * 12);
    return {
      salaryMin: annual,
      salaryMax: annual,
      currency: String(m[2] || 'CHF').toUpperCase(),
      source: 'reported_monthly_text',
    };
  }

  const annualPatterns = [
    /(?:annual|yearly|annuo|annuale|jahresgehalt|salaire\s+annuel)\s*[:\-]?\s*([0-9][0-9'’.,\s]{2,16})\s*(CHF|EUR)/i,
  ];
  for (const rx of annualPatterns) {
    const m = source.match(rx);
    if (!m) continue;
    const annual = parseSalaryNumber(m[1]);
    if (!annual || annual < 5000 || annual > 500000) continue;
    return {
      salaryMin: Math.round(annual),
      salaryMax: Math.round(annual),
      currency: String(m[2] || 'CHF').toUpperCase(),
      source: 'reported_annual_text',
    };
  }

  return null;
}

function extractExistingAnnualSalary(job) {
  const existingMin = toFiniteNumber(job?.salaryMin) ?? toFiniteNumber(job?.baseSalary?.value?.minValue);
  const existingMax = toFiniteNumber(job?.salaryMax) ?? toFiniteNumber(job?.baseSalary?.value?.maxValue);
  if (existingMin == null) return null;
  const unitRaw = String(job?.baseSalary?.value?.unitText || 'YEAR').toUpperCase();
  const factor = unitRaw === 'MONTH' ? 12 : 1;
  const minAnnual = Math.round(existingMin * factor);
  const maxAnnual = Math.round((existingMax ?? existingMin) * factor);
  if (!Number.isFinite(minAnnual) || minAnnual <= 0) return null;
  return {
    salaryMin: minAnnual,
    salaryMax: Math.max(minAnnual, maxAnnual),
    currency: String(job?.currency || job?.baseSalary?.currency || job?.baseSalary?.value?.currency || 'CHF').toUpperCase(),
    source: 'existing_structured_salary',
  };
}

const STRONG_HEALTH_ROLE_RE = /(nurse|doctor|clinica|ospedal|healthcare|health\s*care|medical|infermier\w*|farmac\w*|medic\w*|psicolog\w*|psichiatr\w*|sanitar\w*|terapist\w*|chirurg\w*|ostetric\w*|ortoped\w*|salute\s+mentale|curant\w*)/i;

function inferCategoryFromText(title = '', description = '') {
  const t = `${title} ${description}`.toLowerCase();
  if (STRONG_HEALTH_ROLE_RE.test(t)) return 'health';
  if (/(software|developer|devops|cloud|frontend|backend|full stack|security|informatica|sviluppo\s+software)\b/.test(t)) return 'tech';
  if (/\b(data\s+(?:engineer|scien|analy|warehouse|lake|pipelin|mining|govern)|programm(?:er|ier|ing|ierung))\b/.test(t)) return 'tech';
  if (/(finance|bank|contab|account|audit|tax|wealth|risk|finanz|cred|invest|payroll|treasury)/.test(t)) return 'finance';
  if (/(engineer|ingegner|mechanic|electrical|automation|industrial|lavori\s+pubblici|edil|costruzion)/.test(t)) return 'engineering';
  if (/(admin|assistant|back office|hr|human resources|segret|amministrativ|servizi\s+generali|collaborat\w+\s+amministrativ)/.test(t)) return 'admin';
  if (/(sales|commercial|business development|account manager|retail|store|vendita|commerciale|marketing|merchandising|allocator|crm|seo|media|trading)/.test(t)) return 'sales';
  return 'other';
}

function normalizeCategoryForJob(job) {
  const current = String(job?.category || '').toLowerCase().trim() || 'other';
  const title = String(job?.title || '');
  const description = String(job?.description || '');

  // Strong healthcare markers always win.
  if (STRONG_HEALTH_ROLE_RE.test(`${title} ${description}`)) return 'health';

  // Generic inference for all companies.
  const inferred = inferCategoryFromText(title, description);
  if (!inferred || inferred === 'other') return current;

  // Upgrade weak/missing category.
  if (current === 'other') return inferred;

  // Fix common false positive: non-health jobs tagged as health.
  if (current === 'health' && inferred !== 'health') return inferred;

  // Keep existing category for all other cases (conservative mode).
  return current;
}

// --- Salary estimation: unified Ticino-adjusted estimation ---
// Uses shared module derived from salaryData.ts medians × 0.90 Ticino factor
import { estimateTicinoSalary } from './lib/salary-estimation.mjs';

function estimateSalaryFromSectors(job) {
  return estimateTicinoSalary(job);
}

// --- Company address lookup ---
const COMPANY_ADDRESSES = {
  'ubs':                                      { streetAddress: 'Via G. Calgari 2',        postalCode: '6900', addressLocality: 'Lugano' },
  'credit-suisse-ora-ubs':                    { streetAddress: 'Via Canova 16',            postalCode: '6901', addressLocality: 'Lugano' },
  'banca-dello-stato-del-canton-ticino':       { streetAddress: 'Viale H. Guisan 5',       postalCode: '6501', addressLocality: 'Bellinzona' },
  'corner-banca':                              { streetAddress: 'Via Canova 16',            postalCode: '6901', addressLocality: 'Lugano' },
  'julius-baer':                               { streetAddress: 'Via Cattedrale 9',         postalCode: '6900', addressLocality: 'Lugano' },
  'banca-migros':                              { streetAddress: 'Via Pretorio 22',          postalCode: '6900', addressLocality: 'Lugano' },
  'banca-cler':                                { streetAddress: 'Piazza Grande 5',          postalCode: '6600', addressLocality: 'Locarno' },
  'piguet-galland':                            { streetAddress: 'Via Nassa 5',              postalCode: '6900', addressLocality: 'Lugano' },
  'postfinance':                               { streetAddress: 'Viale Stazione 16',       postalCode: '6500', addressLocality: 'Bellinzona' },
  'bsi-ora-efg':                               { streetAddress: 'Via Magatti 2',            postalCode: '6900', addressLocality: 'Lugano' },
  'gruppo-fidinam':                             { streetAddress: 'Via Maggio 1',             postalCode: '6900', addressLocality: 'Lugano' },
  'vf-international-the-north-face-timberland':{ streetAddress: 'Via Laveggio 5',           postalCode: '6855', addressLocality: 'Stabio' },
  'hugo-boss-ticino':                          { streetAddress: 'Via Penate 4',             postalCode: '6877', addressLocality: 'Coldrerio' },
  'guess-europe':                              { streetAddress: 'Via Campagna 2',           postalCode: '6934', addressLocality: 'Bioggio' },
  'bally':                                     { streetAddress: 'Via Industria 1',          postalCode: '6987', addressLocality: 'Caslano' },
  'philipp-plein':                             { streetAddress: 'Via Nassa 68',             postalCode: '6900', addressLocality: 'Lugano' },
  'diesel-otb':                                { streetAddress: 'Via Industria',            postalCode: '6855', addressLocality: 'Stabio' },
  'ermenegildo-zegna-logistica':               { streetAddress: 'Via Industria 14',         postalCode: '6855', addressLocality: 'Stabio' },
  'bulgari-logistica':                         { streetAddress: 'Via dei Pioppi 2',         postalCode: '6850', addressLocality: 'Mendrisio' },
  'bottega-veneta-logistica':                  { streetAddress: 'Via dei Pioppi 6',         postalCode: '6850', addressLocality: 'Mendrisio' },
  'gucci-logistica':                           { streetAddress: 'Via Industria 5',          postalCode: '6855', addressLocality: 'Stabio' },
  'moncler-logistica':                         { streetAddress: 'Via Industria 12',         postalCode: '6855', addressLocality: 'Stabio' },
  'giorgio-armani-operations':                 { streetAddress: 'Via Penate 3',             postalCode: '6850', addressLocality: 'Mendrisio' },
  'globus-magazine-zum-globus':                { streetAddress: 'Via Nassa 32',             postalCode: '6900', addressLocality: 'Lugano' },
  'manor':                                     { streetAddress: 'Via Pretorio 15',          postalCode: '6900', addressLocality: 'Lugano' },
  'helsinn':                                   { streetAddress: 'Via Pian Scairolo 9',     postalCode: '6912', addressLocality: 'Lugano' },
  'ibsa-institut-biochimique':                 { streetAddress: 'Via del Piano 29',         postalCode: '6926', addressLocality: 'Montagnola' },
  'zambon':                                    { streetAddress: 'Via Industria 13',         postalCode: '6814', addressLocality: 'Cadempino' },
  'sintetica':                                 { streetAddress: 'Via Penate 5',             postalCode: '6850', addressLocality: 'Mendrisio' },
  'medacta-international':                     { streetAddress: 'Strada Regina',            postalCode: '6874', addressLocality: 'Castel San Pietro' },
  'adc-therapeutics':                           { streetAddress: 'Via Benteler 1',           postalCode: '6900', addressLocality: 'Lugano' },
  'sta-pharmaceutical-wuxi':                   { streetAddress: 'Via Benteler 4',           postalCode: '6900', addressLocality: 'Lugano' },
  'istituto-di-ricerca-in-biomedicina-irb':    { streetAddress: 'Via Vincenzo Vela 6',     postalCode: '6500', addressLocality: 'Bellinzona' },
  'ente-ospedaliero-cantonale-eoc':            { streetAddress: 'Viale Officina 3',        postalCode: '6500', addressLocality: 'Bellinzona' },
  'abb-svizzera-sede-ticino':                  { streetAddress: 'Via Luserte Sud 9',        postalCode: '6572', addressLocality: 'Quartino' },
  'mikron-group':                              { streetAddress: 'Via Campagna 3',           postalCode: '6982', addressLocality: 'Agno' },
  'interroll':                                 { streetAddress: 'Via Gorelle 3',            postalCode: '6592', addressLocality: 'S. Antonino' },
  'ferriere-cattaneo':                         { streetAddress: 'Via Industria 18',         postalCode: '6512', addressLocality: 'Giubiasco' },
  'precicast-sa':                              { streetAddress: 'Via Cantonale',            postalCode: '6883', addressLocality: 'Novazzano' },
  'riri-group':                                { streetAddress: 'Via alla Campagna 22',     postalCode: '6850', addressLocality: 'Mendrisio' },
  'kendrion-sede-ticino':                      { streetAddress: 'Via Industria 7',          postalCode: '6855', addressLocality: 'Stabio' },
  'glas-trosch-sede-ti':                       { streetAddress: 'Via Industria',            postalCode: '6743', addressLocality: 'Bodio' },
  'tenconi-sa':                                { streetAddress: 'Via al Gas 6',             postalCode: '6900', addressLocality: 'Lugano' },
  'benteler-argor-heraeus':                    { streetAddress: 'Via alle Brughiere 18',    postalCode: '6850', addressLocality: 'Mendrisio' },
  'benteler-international':                    { streetAddress: 'Via alle Brughiere 18',    postalCode: '6850', addressLocality: 'Mendrisio' },
  'carlo-benteler-turck-duotec':               { streetAddress: 'Via Artigianato 6',        postalCode: '6883', addressLocality: 'Novazzano' },
  'pamp-sa':                                   { streetAddress: 'Via Cantonale 55',         postalCode: '6874', addressLocality: 'Castel San Pietro' },
  'rapelli':                                   { streetAddress: 'Via Laveggio 13',          postalCode: '6855', addressLocality: 'Stabio' },
  'chocolat-stella':                           { streetAddress: 'Via Industria',            postalCode: '6512', addressLocality: 'Giubiasco' },
  'caffe-chicco-d':                            { streetAddress: 'Via Laveggio 21',          postalCode: '6828', addressLocality: 'Balerna' },
  'emmi-svizzera-latteria-lugano':             { streetAddress: 'Via Industria 40',         postalCode: '6814', addressLocality: 'Cadempino' },
  'migros-ticino':                             { streetAddress: 'Via Cantonale',            postalCode: '6592', addressLocality: 'S. Antonino' },
  'coop-ticino':                               { streetAddress: 'Via Vedeggio 4',           postalCode: '6805', addressLocality: 'Mezzovico' },
  'aldi-suisse-logistica':                     { streetAddress: 'Via Progresso',            postalCode: '6593', addressLocality: 'Cadenazzo' },
  'lidl-svizzera':                             { streetAddress: 'Via Campagna 8',           postalCode: '6934', addressLocality: 'Bioggio' },
  'lidl-svizzera-logistica':                   { streetAddress: 'Via Campagna 8',           postalCode: '6934', addressLocality: 'Bioggio' },
  'generali-svizzera':                         { streetAddress: 'Via Maraini 23',           postalCode: '6900', addressLocality: 'Lugano' },
  'zurich-insurance-sede-ticino':              { streetAddress: 'Via Pretorio 22',          postalCode: '6900', addressLocality: 'Lugano' },
  'helvetia-sede-ticino':                      { streetAddress: 'Via G.B. Pioda 12',       postalCode: '6900', addressLocality: 'Lugano' },
  'css-assicurazione':                         { streetAddress: 'Via Ghiringhelli 15',     postalCode: '6500', addressLocality: 'Bellinzona' },
  'allianz-suisse':                            { streetAddress: 'Via Pretorio 22',          postalCode: '6900', addressLocality: 'Lugano' },
  'axa-svizzera':                              { streetAddress: 'Via della Posta 8',       postalCode: '6900', addressLocality: 'Lugano' },
  'suva-sede-ticino':                          { streetAddress: 'Via Lugano 4',             postalCode: '6500', addressLocality: 'Bellinzona' },
  'deloitte-ticino':                           { streetAddress: 'Via Ferruccio Pelli 1',   postalCode: '6900', addressLocality: 'Lugano' },
  'kpmg-lugano':                               { streetAddress: 'Via Balestra 33',          postalCode: '6900', addressLocality: 'Lugano' },
  'pwc-lugano':                                { streetAddress: 'Via della Posta 7',       postalCode: '6900', addressLocality: 'Lugano' },
  'ey-lugano':                                 { streetAddress: 'Corso Elvezia 33',         postalCode: '6900', addressLocality: 'Lugano' },
  'bdo-ticino':                                { streetAddress: 'Via Maggio 3',             postalCode: '6900', addressLocality: 'Lugano' },
  'aet-azienda-elettrica-ticinese':            { streetAddress: 'Via Lavizzari 4',          postalCode: '6500', addressLocality: 'Bellinzona' },
  'ail-aziende-industriali-lugano':            { streetAddress: 'Via della Scuole 13',     postalCode: '6900', addressLocality: 'Lugano' },
  'ses-societa-elettrica-sopracenerina':       { streetAddress: 'Via Luini 18',             postalCode: '6600', addressLocality: 'Locarno' },
  'swatch-group-assembly':                     { streetAddress: 'Via Luserte Sud 7',        postalCode: '6928', addressLocality: 'Manno' },
  'eta-sa-swatch-group':                       { streetAddress: 'Via Industria 1',          postalCode: '6855', addressLocality: 'Stabio' },
  'swiss-timing-swatch-group':                 { streetAddress: 'Via Industria 1',          postalCode: '6855', addressLocality: 'Stabio' },
  'nivarox-swatch-group':                      { streetAddress: 'Via Industria 1',          postalCode: '6855', addressLocality: 'Stabio' },
  'comadur-swatch-group':                      { streetAddress: 'Via Industria 1',          postalCode: '6855', addressLocality: 'Stabio' },
  'rado':                                      { streetAddress: 'Via Industria 1',          postalCode: '6855', addressLocality: 'Stabio' },
  'ffs-officine-ferrovie-federali':            { streetAddress: 'Via Ludovico Benteler 12', postalCode: '6500', addressLocality: 'Bellinzona' },
  'planzer':                                   { streetAddress: 'Via Industria 3',          postalCode: '6593', addressLocality: 'Cadenazzo' },
  'hupac':                                     { streetAddress: 'Viale Roncaccio 8',       postalCode: '6830', addressLocality: 'Chiasso' },
  'kuehne-nagel':                              { streetAddress: 'Via Industria 1',          postalCode: '6830', addressLocality: 'Chiasso' },
  'dhl-express-ticino':                        { streetAddress: 'Via Vedeggio 4',           postalCode: '6805', addressLocality: 'Mezzovico' },
  'tilo-treni-regionali-ticino-lombardia':     { streetAddress: 'Piazza Indipendenza 1',   postalCode: '6830', addressLocality: 'Chiasso' },
  'rsi-radiotelevisione-svizzera':             { streetAddress: 'Via Canevascini 7',       postalCode: '6903', addressLocality: 'Lugano' },
  'tamedia-20-minuti':                         { streetAddress: 'Via Pretorio 11',          postalCode: '6900', addressLocality: 'Lugano' },
  'tio-sa':                                    { streetAddress: 'Via Campagna 11',          postalCode: '6933', addressLocality: 'Muzzano' },
  'usi-universita-della-svizzera-italiana':    { streetAddress: 'Via G. Buffi 13',          postalCode: '6904', addressLocality: 'Lugano' },
  'supsi-dti':                                 { streetAddress: 'Via Cantonale 2c',         postalCode: '6928', addressLocality: 'Manno' },
  'amministrazione-cantonale-ti':              { streetAddress: 'Piazza Governo',           postalCode: '6501', addressLocality: 'Bellinzona' },
  'citta-di-lugano':                           { streetAddress: 'Piazza Riforma 1',        postalCode: '6900', addressLocality: 'Lugano' },
  'ticino-turismo':                            { streetAddress: 'Via C. Ghiringhelli 7',   postalCode: '6501', addressLocality: 'Bellinzona' },
  'swisscom-sede-ticino':                      { streetAddress: 'Via Guido Calgari 2',     postalCode: '6900', addressLocality: 'Lugano' },
  'sunrise-sede-ticino':                       { streetAddress: 'Via Ferruccio Pelli 14a', postalCode: '6900', addressLocality: 'Lugano' },
  'schindler':                                 { streetAddress: 'Via Pian Scairolo 35',    postalCode: '6933', addressLocality: 'Muzzano' },
  'investglass':                               { streetAddress: 'Via Nassa 3',              postalCode: '6900', addressLocality: 'Lugano' },
  'avaloq':                                    { streetAddress: 'Via Ferruccio Pelli 14a', postalCode: '6900', addressLocality: 'Lugano' },
  'doodle-parte':                              { streetAddress: 'Via Ferruccio Pelli 2',   postalCode: '6900', addressLocality: 'Lugano' },
  'ti-m':                                      { streetAddress: 'Via Ferruccio Pelli 2',   postalCode: '6900', addressLocality: 'Lugano' },
  'artificialy':                               { streetAddress: 'Via Cantonale 2c',         postalCode: '6928', addressLocality: 'Manno' },
  'nozomi-networks':                           { streetAddress: 'Via Ferruccio Pelli 14a', postalCode: '6900', addressLocality: 'Lugano' },
  'nexthink-sede-ti':                          { streetAddress: 'Via Ferruccio Pelli 14a', postalCode: '6900', addressLocality: 'Lugano' },
  'bitcoin-suisse':                            { streetAddress: 'Via Ferruccio Pelli 14a', postalCode: '6900', addressLocality: 'Lugano' },
  'tether-usdt':                               { streetAddress: 'Via Ferruccio Pelli 14a', postalCode: '6900', addressLocality: 'Lugano' },
  'polygon-labs-sede-lugano':                  { streetAddress: 'Via Ferruccio Pelli 14a', postalCode: '6900', addressLocality: 'Lugano' },
  'fetch-ai-sede-ch':                          { streetAddress: 'Via Ferruccio Pelli 14a', postalCode: '6900', addressLocality: 'Lugano' },
  'lykke':                                     { streetAddress: 'Via Ferruccio Pelli 14a', postalCode: '6900', addressLocality: 'Lugano' },
  'plan-forum-lugano':                         { streetAddress: 'Piazza Riforma 1',        postalCode: '6900', addressLocality: 'Lugano' },
  'ated-ict-ticino':                           { streetAddress: 'Via Cantonale 2c',         postalCode: '6928', addressLocality: 'Manno' },
  'netcomm-suisse':                            { streetAddress: 'Via Ferruccio Pelli 2',   postalCode: '6900', addressLocality: 'Lugano' },
  'tecnopolo-ticino':                          { streetAddress: 'Via Cantonale 18',         postalCode: '6928', addressLocality: 'Manno' },
  'agire-invest':                              { streetAddress: 'Via Cantonale 2c',         postalCode: '6928', addressLocality: 'Manno' },
  'cardis-sotheby':                            { streetAddress: 'Riva Albertolli 1',       postalCode: '6900', addressLocality: 'Lugano' },
};

const TICINO_CITY_POSTAL = {
  'lugano': '6900', 'bellinzona': '6500', 'locarno': '6600', 'mendrisio': '6850',
  'chiasso': '6830', 'stabio': '6855', 'manno': '6928', 'giubiasco': '6512',
  's. antonino': '6592', 'sant\'antonino': '6592', 'mezzovico': '6805',
  'cadenazzo': '6593', 'balerna': '6828', 'coldrerio': '6877', 'caslano': '6987',
  'agno': '6982', 'bioggio': '6934', 'cadempino': '6814', 'novazzano': '6883',
  'castel san pietro': '6874', 'castel s. pietro': '6874', 'muzzano': '6933',
  'bodio': '6743', 'noranco': '6900', 'lugano-besso': '6903', 'montagnola': '6926',
  'quartino': '6572', 'massagno': '6900', 'paradiso': '6900', 'viganello': '6962',
};

async function enrichJob(job, aiState) {
  if (!job) return job;
  const companyKey = String(job.companyKey || '').toLowerCase();
  const normalizedCategory = normalizeCategoryForJob(job);
  const jobWithNormalizedCategory = { ...job, category: normalizedCategory };

  // --- Salary: prefer reported text > existing structured salary > sector estimation ---
  // When FORCE_REESTIMATE=1, skip existing salary so sector estimation is reapplied
  const reportedSalary = extractReportedAnnualSalary(jobWithNormalizedCategory);
  const existingSalary = FORCE_REESTIMATE ? null : extractExistingAnnualSalary(jobWithNormalizedCategory);
  const estimated = estimateSalaryFromSectors(jobWithNormalizedCategory);
  const salary = reportedSalary || existingSalary || {
    salaryMin: estimated.minValue,
    salaryMax: estimated.maxValue,
    currency: String(job.currency || 'CHF').toUpperCase() || 'CHF',
    source: 'sectors_estimation',
  };
  const salaryMin = salary.salaryMin;
  const salaryMax = salary.salaryMax;
  const currency = String(salary.currency || job.currency || 'CHF').toUpperCase() || 'CHF';
  job = {
    ...jobWithNormalizedCategory,
    baseSalary: {
      '@type': 'MonetaryAmount',
      currency,
      value: {
        '@type': 'QuantitativeValue',
        minValue: salaryMin,
        maxValue: salaryMax,
        unitText: 'YEAR',
      },
    },
    salaryMin,
    salaryMax,
    currency,
  };

  // --- Update address from company lookup ---
  const knownAddr = COMPANY_ADDRESSES[companyKey];
  if (knownAddr) {
    // Preserve the per-job locality (location/addressLocality) instead of
    // overwriting it with the company HQ. Only fall back to HQ when the job
    // has no real city. When the job has a real city, prefer a matching
    // postal code from TICINO_CITY_POSTAL over the HQ default.
    const realLocality = String(job.location || job.addressLocality || '').trim();
    const realLocalityKey = realLocality.toLowerCase();
    const postalFromRealCity = realLocality && TICINO_CITY_POSTAL[realLocalityKey];
    job = {
      ...job,
      streetAddress: job.streetAddress || knownAddr.streetAddress,
      postalCode: job.postalCode || postalFromRealCity || knownAddr.postalCode,
      addressLocality: realLocality || knownAddr.addressLocality,
      addressCountry: 'CH',
    };
  } else {
    // Ensure postalCode from city
    if (!job.postalCode) {
      const city = String(job.addressLocality || job.location || '').toLowerCase().trim();
      job = { ...job, postalCode: TICINO_CITY_POSTAL[city] || '6900' };
    }
    // Ensure streetAddress
    if (!job.streetAddress) {
      const locality = job.addressLocality || job.location || '';
      if (locality) job = { ...job, streetAddress: locality };
    }
    // Ensure addressLocality
    if (!job.addressLocality) {
      const loc = String(job.location || '');
      const parts = loc.split('·').map(s => s.trim()).filter(Boolean);
      if (parts.length > 0) job = { ...job, addressLocality: parts[parts.length - 1] };
    }
    // Ensure addressCountry
    if (!job.addressCountry) job = { ...job, addressCountry: 'CH' };
  }

  const canonicalContent = await buildCanonicalContent(job, aiState);
  if (canonicalContent) {
    job = { ...job, canonicalContent };
  }

  return job;
}

async function main() {
  console.log('🔄 Re-enriching existing jobs with SECTORS salary data and company addresses...\n');

  const jobs = readJson(DATA_JOBS);
  console.log(`  Jobs found: ${jobs.length}\n`);

  const canonicalAiState = {
    enabled: CANONICAL_AI_FALLBACK_ENABLED && isAnyModelAvailable(),
    remaining: CANONICAL_AI_MAX_JOBS,
    attempted: 0,
    used: 0,
    failed: 0,
  };
  console.log(
    `  Canonical AI fallback: ${canonicalAiState.enabled ? 'ON' : 'OFF'}`
    + ` (maxJobs=${CANONICAL_AI_MAX_JOBS}, minCoverage=${CANONICAL_AI_MIN_COVERAGE}%, timeout=${CANONICAL_AI_TIMEOUT_MS}ms)\n`
  );

  const enriched = [];
  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i];
    const before = {
      category: job.category,
      baseSalary: job.baseSalary?.value,
      streetAddress: job.streetAddress,
      postalCode: job.postalCode,
    };
    const result = await enrichJob(job, canonicalAiState);
    const after = {
      category: result.category,
      baseSalary: result.baseSalary?.value,
      streetAddress: result.streetAddress,
      postalCode: result.postalCode,
    };
    const salaryChanged = before.baseSalary?.minValue !== after.baseSalary?.minValue || before.baseSalary?.maxValue !== after.baseSalary?.maxValue;
    const addrChanged = before.streetAddress !== after.streetAddress || before.postalCode !== after.postalCode;
    const categoryChanged = String(before.category || '') !== String(after.category || '');
    if (salaryChanged || addrChanged || categoryChanged) {
      const est = estimateSalaryFromSectors({ ...job, category: after.category || job.category });
      console.log(`  [${i + 1}] ${job.company} — "${job.title}" (${job.category})`);
      console.log(`       Salary: ${before.baseSalary?.minValue}-${before.baseSalary?.maxValue} → ${after.baseSalary.minValue}-${after.baseSalary.maxValue} (${est.sectorName}/${est.level})`);
      if (categoryChanged) {
        console.log(`       Category: ${before.category} → ${after.category}`);
      }
      if (addrChanged) {
        console.log(`       Address: "${before.streetAddress}, ${before.postalCode}" → "${after.streetAddress}, ${after.postalCode}"`);
      }
    }
    enriched.push(result);
  }

  const cleaned = enriched.map(stripCopyPasteLocales);
  writeJson(DATA_JOBS, cleaned);
  writeJson(PUBLIC_JOBS, cleaned);

  console.log(
    `\n🤖 Canonical AI fallback summary: attempted=${canonicalAiState.attempted},`
    + ` used=${canonicalAiState.used}, failed=${canonicalAiState.failed}, remainingBudget=${canonicalAiState.remaining}`
  );
  console.log(`\n✅ Re-enriched ${enriched.length} jobs → data/jobs.json + public/data/jobs.json`);
}

main().catch((err) => {
  console.error(`❌ re-enrich failed: ${err?.message || err}`);
  process.exit(1);
});
