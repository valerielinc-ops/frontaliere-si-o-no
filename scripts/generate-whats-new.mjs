#!/usr/bin/env node
/**
 * generate-whats-new.mjs — Auto-generate WhatsNew release entries from pending commits.
 *
 * Reads data/pending-releases.json (populated by the post-commit hook),
 * uses Gemini AI to generate i18n translations, and outputs:
 *   1. A new RELEASES entry for WhatsNewModal.tsx
 *   2. i18n keys for all 4 locales (it, en, de, fr)
 *
 * Usage:
 *   node scripts/generate-whats-new.mjs          # Preview mode (stdout)
 *   node scripts/generate-whats-new.mjs --apply  # Auto-apply changes to files
 *
 * The script batches all pending commits into a single release version bump.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const PENDING_FILE = resolve(ROOT, 'data/pending-releases.json');
const WHATS_NEW_FILE = resolve(ROOT, 'components/community/WhatsNewModal.tsx');
const LOCALE_FILES = {
  it: resolve(ROOT, 'services/locales/it-core.ts'),
  en: resolve(ROOT, 'services/locales/en-core.ts'),
  de: resolve(ROOT, 'services/locales/de-core.ts'),
  fr: resolve(ROOT, 'services/locales/fr-core.ts'),
};

const applyMode = process.argv.includes('--apply');

// ── Load AI model service ──
let callLLM;
let flushScores;
try {
  const aiModule = await import('./lib/ai-models.mjs');
  callLLM = aiModule.callLLM;
  flushScores = aiModule.flushScores;
} catch {
  console.error('⚠️  Cannot load AI models. Set GEMINI_API_KEY or GH_MODELS_PAT.');
  console.error('   Running in preview-only mode (no translations).');
  callLLM = null;
  flushScores = null;
}

// ── Load pending releases ──
if (!existsSync(PENDING_FILE)) {
  console.log('ℹ️  No pending releases found (data/pending-releases.json missing).');
  process.exit(0);
}

let pending;
try {
  pending = JSON.parse(readFileSync(PENDING_FILE, 'utf8'));
} catch {
  console.error('❌ Cannot parse data/pending-releases.json');
  process.exit(1);
}

if (!Array.isArray(pending) || pending.length === 0) {
  console.log('ℹ️  No pending release entries to process.');
  process.exit(0);
}

console.log(`📋 Found ${pending.length} pending release entries:\n`);
for (const entry of pending) {
  const typeEmoji = entry.type === 'feature' ? '✨' : entry.type === 'fix' ? '🐛' : '⚡';
  console.log(`   ${typeEmoji} [${entry.type}] ${entry.description} (${entry.hash}, ${entry.date})`);
}
console.log('');

// ── Determine next version ──
const whatsNewContent = readFileSync(WHATS_NEW_FILE, 'utf8');
const versionMatch = whatsNewContent.match(/version:\s*'(\d+)\.(\d+)\.(\d+)'/);
if (!versionMatch) {
  console.error('❌ Cannot find current version in WhatsNewModal.tsx');
  process.exit(1);
}
const [, major, minor, patch] = versionMatch.map(Number);
const hasFeature = pending.some(e => e.type === 'feature');
const nextMinor = hasFeature ? minor + 1 : minor;
const nextPatch = hasFeature ? 0 : Number(patch) + 1;
const nextVersion = `${major}.${nextMinor}.${nextPatch}`;
const versionKey = `v${major}${nextMinor}${nextPatch}`;
const today = new Date().toISOString().slice(0, 10);

console.log(`📦 Next version: ${nextVersion} (key prefix: whatsNew.${versionKey})`);
console.log('');

// ── Generate item IDs from descriptions ──
function descToId(desc) {
  return desc
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join('-')
    .replace(/-+/g, '-');
}

const rawItems = pending.map(entry => {
  const id = entry.scope || descToId(entry.description);
  return {
    ...entry,
    id,
    titleKeyBase: `whatsNew.${versionKey}.${id}.title`,
    descKeyBase: `whatsNew.${versionKey}.${id}.desc`,
  };
});

const MAX_RELEASE_ITEMS = 5;
const items = rawItems
  .filter((item, index, arr) => arr.findIndex((x) => x.id === item.id) === index)
  .slice(0, MAX_RELEASE_ITEMS);

const LINK_KEYWORDS = [
  { test: /(job|lavor|annunci|offerte|crawler|azienda|company|recruit|vacanc)/i, link: { tab: 'job-board' } },
  { test: /(salary|stipendio|busta|calculator|calcolo|ral|whatif)/i, link: { tab: 'calculator', subTab: 'calculator' } },
  { test: /(health|lamal|assicurazione|insurance)/i, link: { tab: 'confronti', subTab: 'health' } },
  { test: /(exchange|cambio|chf|eur)/i, link: { tab: 'confronti', subTab: 'exchange' } },
];

function inferLink(item) {
  const text = `${item.scope || ''} ${item.description || ''}`.toLowerCase();
  const match = LINK_KEYWORDS.find((rule) => rule.test.test(text));
  return match ? { ...match.link } : null;
}

for (const item of items) {
  item.link = inferLink(item);
}

// ── Generate i18n translations ──
async function generateTranslations(items) {
  if (!callLLM) {
    // Fallback: Italian-only, raw commit descriptions
    const result = {};
    for (const locale of ['it', 'en', 'de', 'fr']) {
      result[locale] = {};
      result[locale][`whatsNew.${versionKey}.title`] = locale === 'it'
        ? 'Aggiornamenti e miglioramenti'
        : locale === 'en' ? 'Updates and improvements'
        : locale === 'de' ? 'Aktualisierungen und Verbesserungen'
        : 'Mises à jour et améliorations';
      for (const item of items) {
        result[locale][item.titleKeyBase] = item.description.slice(0, 50);
        result[locale][item.descKeyBase] = item.description;
      }
    }
    return result;
  }

  const prompt = `Sei un editor UX per un'app web usata da persone non tecniche.
Devi generare release note in 4 lingue: italiano (it), inglese (en), tedesco (de), francese (fr).
Scrivi in stile umano, chiaro e utile.

La release include questi cambiamenti:
${items.map(item => `- [${item.type}] ${item.description} (scope: ${item.scope || 'general'})`).join('\n')}

Per ogni cambiamento, genera:
1. Un titolo breve (4-8 parole), comprensibile a chi non è tecnico
2. Una descrizione (1-2 frasi) focalizzata sul beneficio reale per l'utente

Regole obbligatorie:
- Evita gergo tecnico (es. crawler, payload, json, Firestore, pipeline, schema).
- Non copiare il messaggio del commit.
- Se il cambiamento riguarda una pagina/strumento, nomina esplicitamente la pagina in modo naturale.
- Testo localizzato in ciascuna lingua (niente italiano dentro en/de/fr).

Genera anche un titolo per la release complessiva.

Output SOLO un JSON valido con questa struttura esatta (nessun code fence, nessuna spiegazione):
{
  "releaseTitle": { "it": "...", "en": "...", "de": "...", "fr": "..." },
  "items": [
    {
      "id": "${items[0]?.id || 'example'}",
      "title": { "it": "...", "en": "...", "de": "...", "fr": "..." },
      "desc": { "it": "...", "en": "...", "de": "...", "fr": "..." }
    }
  ]
}

IDs da usare nell'ordine: ${items.map(i => `"${i.id}"`).join(', ')}`;

  try {
    const raw = await callLLM(
      [{ role: 'user', content: prompt }],
      { model: 'gemini-2.0-flash', maxTokens: 4000, temperature: 0.3 }
    );
    if (!raw) throw new Error('Empty LLM response');

    // Strip code fences if present
    const jsonStr = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    const data = JSON.parse(jsonStr);

    const result = {};
    for (const locale of ['it', 'en', 'de', 'fr']) {
      result[locale] = {};
      result[locale][`whatsNew.${versionKey}.title`] = data.releaseTitle?.[locale] || data.releaseTitle?.it || 'Updates';
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const aiItem = data.items?.[i] || {};
        result[locale][item.titleKeyBase] = aiItem.title?.[locale] || item.description.slice(0, 50);
        result[locale][item.descKeyBase] = aiItem.desc?.[locale] || item.description;
      }
    }
    return result;
  } catch (err) {
    console.error(`⚠️  AI translation failed: ${err.message}`);
    console.error('   Falling back to raw commit descriptions.');
    return generateTranslations.__fallback(items);
  }
}

// Fallback for when AI fails
generateTranslations.__fallback = function (items) {
  const result = {};
  for (const locale of ['it', 'en', 'de', 'fr']) {
    result[locale] = {};
    result[locale][`whatsNew.${versionKey}.title`] = 'Aggiornamenti';
    for (const item of items) {
      result[locale][item.titleKeyBase] = item.description.slice(0, 50);
      result[locale][item.descKeyBase] = item.description;
    }
  }
  return result;
};

const translations = await generateTranslations(items);

// ── Generate RELEASES array entry ──
const releaseEntry = `  {
    version: '${nextVersion}',
    date: '${today}',
    titleKey: 'whatsNew.${versionKey}.title',
    items: [
${items.map(item => `      {
        type: '${item.type}',
        titleKey: '${item.titleKeyBase}',
        descKey: '${item.descKeyBase}',
${item.link ? `        link: { tab: '${item.link.tab}'${item.link.subTab ? `, subTab: '${item.link.subTab}'` : ''} },` : ''}
      },`).join('\n')}
    ],
  },`;

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📝 Generated RELEASES entry:\n');
console.log(releaseEntry);
console.log('');

console.log('📝 Generated i18n keys:\n');
for (const [locale, keys] of Object.entries(translations)) {
  console.log(`  [${locale}]`);
  for (const [key, value] of Object.entries(keys)) {
    console.log(`    '${key}': '${value}',`);
  }
  console.log('');
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// ── Apply mode: write changes to files ──
if (applyMode) {
  console.log('\n🔧 Applying changes...\n');

  // 1. Update WhatsNewModal.tsx — insert new release at top of RELEASES array
  const insertMarker = 'export const RELEASES: Release[] = [';
  if (whatsNewContent.includes(insertMarker)) {
    const updated = whatsNewContent.replace(
      insertMarker,
      `${insertMarker}\n${releaseEntry}`
    );
    writeFileSync(WHATS_NEW_FILE, updated);
    console.log('   ✅ WhatsNewModal.tsx updated');
  } else {
    console.error('   ❌ Cannot find RELEASES insert marker in WhatsNewModal.tsx');
  }

  // 2. Update locale files — insert keys before the last whatsNew entry
  for (const [locale, keys] of Object.entries(translations)) {
    const localeFile = LOCALE_FILES[locale];
    if (!existsSync(localeFile)) {
      console.error(`   ❌ Locale file not found: ${localeFile}`);
      continue;
    }

    let content = readFileSync(localeFile, 'utf8');

    // Find the first existing whatsNew key and insert before it
    const firstWhatsNewMatch = content.match(/^(\s*)'whatsNew\./m);
    if (firstWhatsNewMatch) {
      const indent = firstWhatsNewMatch[1];
      const keysBlock = Object.entries(keys)
        .map(([k, v]) => `${indent}'${k}': '${v.replace(/'/g, "\\'")}',`)
        .join('\n');

      content = content.replace(
        /^(\s*'whatsNew\.)/m,
        `${keysBlock}\n$1`
      );
      writeFileSync(localeFile, content);
      console.log(`   ✅ ${locale}-core.ts updated (${Object.keys(keys).length} keys)`);
    } else {
      console.error(`   ⚠️  No existing whatsNew keys in ${locale}-core.ts — skipping`);
    }
  }

  // 3. Clear pending releases
  writeFileSync(PENDING_FILE, '[]\n');
  console.log('   ✅ Pending releases cleared');

  console.log('\n✅ All changes applied. Review and commit.');
} else {
  console.log('\nℹ️  Preview mode. Run with --apply to write changes to files.');
  console.log('   node scripts/generate-whats-new.mjs --apply');
}

// Flush persistent scores to Firestore before exit
if (flushScores) await flushScores();
