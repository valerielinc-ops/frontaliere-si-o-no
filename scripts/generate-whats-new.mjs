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

// ── Available app routes for AI link selection ──
const AVAILABLE_ROUTES = [
  { tab: 'calculator', desc: 'Calcolatore stipendio netto frontaliere' },
  { tab: 'calculator', subTab: 'calculator', desc: 'Simulatore stipendio netto' },
  { tab: 'calculator', subTab: 'whatif', desc: 'Simulatore What-If scenario' },
  { tab: 'calculator', subTab: 'payslip', desc: 'Analisi busta paga' },
  { tab: 'calculator', subTab: 'ral', desc: 'Calcolatore RAL' },
  { tab: 'calculator', subTab: 'bonus', desc: 'Calcolatore bonus/tredicesima' },
  { tab: 'calculator', subTab: 'parental-leave', desc: 'Congedo parentale' },
  { tab: 'calculator', subTab: 'residency', desc: 'Residenza e domicilio' },
  { tab: 'calculator', subTab: 'salary-quiz', desc: 'Quiz stipendio' },
  { tab: 'confronti', subTab: 'exchange', desc: 'Confronto cambio valuta CHF/EUR' },
  { tab: 'confronti', subTab: 'banks', desc: 'Confronto banche e conti' },
  { tab: 'confronti', subTab: 'health', desc: 'Confronto assicurazioni sanitarie LAMal' },
  { tab: 'confronti', subTab: 'mobile', desc: 'Confronto operatori telefonici' },
  { tab: 'confronti', subTab: 'shopping', desc: 'Confronto shopping e prezzi' },
  { tab: 'confronti', subTab: 'cost-of-living', desc: 'Confronto costo della vita' },
  { tab: 'confronti', subTab: 'jobs', desc: 'Confronto offerte di lavoro' },
  { tab: 'confronti', subTab: 'renovation', desc: 'Ristrutturazione casa' },
  { tab: 'fisco', subTab: 'tax-return', desc: 'Dichiarazione dei redditi' },
  { tab: 'fisco', subTab: 'calendar', desc: 'Calendario fiscale scadenze' },
  { tab: 'fisco', subTab: 'holidays', desc: 'Festività e giorni lavorativi' },
  { tab: 'fisco', subTab: 'ristorni', desc: 'Ristorni fiscali' },
  { tab: 'fisco', subTab: 'pension', desc: 'Pensione AVS/LPP' },
  { tab: 'fisco', subTab: 'pillar3', desc: 'Terzo pilastro 3a' },
  { tab: 'fisco', subTab: 'quiz', desc: 'Quiz fiscale' },
  { tab: 'fisco', subTab: 'tax-credit', desc: 'Credito d\'imposta' },
  { tab: 'fisco', subTab: 'withholding-rates', desc: 'Aliquote imposta alla fonte' },
  { tab: 'fisco', subTab: 'new-frontier-tax-sim', desc: 'Simulatore nuovo accordo fiscale' },
  { tab: 'guida', subTab: 'first-day', desc: 'Primo giorno di lavoro in Svizzera' },
  { tab: 'guida', subTab: 'permits', desc: 'Permessi di lavoro (B/G/L)' },
  { tab: 'guida', subTab: 'border', desc: 'Valichi di frontiera e traffico' },
  { tab: 'guida', subTab: 'unemployment', desc: 'Disoccupazione frontaliere' },
  { tab: 'guida', subTab: 'car-transfer', desc: 'Immatricolazione auto' },
  { tab: 'guida', subTab: 'car-cost', desc: 'Costi auto e trasporto' },
  { tab: 'guida', subTab: 'permit-compare', desc: 'Confronto permessi B vs G' },
  { tab: 'guida', subTab: 'border-map', desc: 'Mappa valichi di frontiera' },
  { tab: 'vita', subTab: 'living-ch', desc: 'Vivere in Svizzera' },
  { tab: 'vita', subTab: 'living-it', desc: 'Vivere in Italia come frontaliere' },
  { tab: 'vita', subTab: 'companies', desc: 'Aziende in Ticino' },
  { tab: 'vita', subTab: 'schools', desc: 'Scuole e formazione' },
  { tab: 'vita', subTab: 'nursery', desc: 'Asili nido' },
  { tab: 'vita', subTab: 'places', desc: 'Luoghi e attrazioni' },
  { tab: 'vita', subTab: 'transport', desc: 'Trasporti pubblici' },
  { tab: 'vita', subTab: 'municipalities', desc: 'Comuni ticinesi' },
  { tab: 'stats', subTab: 'overview', desc: 'Panoramica statistiche' },
  { tab: 'stats', subTab: 'livability', desc: 'Indice vivibilità' },
  { tab: 'stats', subTab: 'jobs-observatory', desc: 'Osservatorio lavoro' },
  { tab: 'stats', subTab: 'salary-compare', desc: 'Confronto stipendi' },
  { tab: 'stats', subTab: 'traffic-history', desc: 'Storico traffico ai valichi' },
  { tab: 'stats', subTab: 'unemployment', desc: 'Statistiche disoccupazione' },
  { tab: 'stats', subTab: 'mortgage', desc: 'Tassi ipotecari' },
  { tab: 'stats', subTab: 'fuel-prices', desc: 'Prezzi carburante' },
  { tab: 'job-board', desc: 'Bacheca lavori / Cerca lavoro' },
  { tab: 'blog', desc: 'Blog e articoli' },
  { tab: 'weekly-digest', desc: 'Newsletter settimanale' },
  { tab: 'profile', desc: 'Profilo utente e impostazioni' },
  { tab: 'glossario', desc: 'Glossario termini' },
  { tab: 'faq', desc: 'Domande frequenti' },
  { tab: 'permit-quiz', desc: 'Quiz permesso ideale' },
  { tab: 'tredicesima', desc: 'Calcolatore tredicesima' },
  { tab: 'sindacati', desc: 'Sindacati e associazioni' },
  { tab: 'tfr-calculator', desc: 'Calcolatore TFR' },
  { tab: 'contracts', desc: 'Contratti di lavoro CCL/CCN' },
];

// ── Generate i18n translations ──
async function generateTranslations(items) {
  if (!callLLM) {
    // Fallback: Italian-only, raw commit descriptions, no links
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
        item.link = null;
      }
    }
    return result;
  }

  const routeCatalog = AVAILABLE_ROUTES.map(r =>
    `  - tab: "${r.tab}"${r.subTab ? `, subTab: "${r.subTab}"` : ''} → ${r.desc}`
  ).join('\n');

  const prompt = `Sei un editor UX per un'app web usata da persone non tecniche.
Devi generare release note in 4 lingue: italiano (it), inglese (en), tedesco (de), francese (fr).
Scrivi in stile umano, chiaro e utile.

La release include questi cambiamenti:
${items.map(item => `- [${item.type}] ${item.description} (scope: ${item.scope || 'general'})`).join('\n')}

Per ogni cambiamento, genera:
1. Un titolo breve (4-8 parole), comprensibile a chi non è tecnico
2. Una descrizione (1-2 frasi) focalizzata sul beneficio reale per l'utente
3. Un link alla pagina più pertinente dell'app (vedi catalogo sotto)

Regole obbligatorie:
- Evita gergo tecnico (es. crawler, payload, json, Firestore, pipeline, schema).
- Non copiare il messaggio del commit.
- Se il cambiamento riguarda una pagina/strumento, nomina esplicitamente la pagina in modo naturale.
- Testo localizzato in ciascuna lingua (niente italiano dentro en/de/fr).
- Per il link, scegli la pagina più specifica e pertinente dal catalogo. Se il cambiamento è infrastrutturale e non riguarda una pagina specifica, usa null.

Catalogo pagine disponibili:
${routeCatalog}

Genera anche un titolo per la release complessiva.

Output SOLO un JSON valido con questa struttura esatta (nessun code fence, nessuna spiegazione):
{
  "releaseTitle": { "it": "...", "en": "...", "de": "...", "fr": "..." },
  "items": [
    {
      "id": "${items[0]?.id || 'example'}",
      "title": { "it": "...", "en": "...", "de": "...", "fr": "..." },
      "desc": { "it": "...", "en": "...", "de": "...", "fr": "..." },
      "link": { "tab": "...", "subTab": "..." }
    }
  ]
}

Per il campo "link": usa { "tab": "..." } o { "tab": "...", "subTab": "..." } dal catalogo, oppure null se non pertinente.

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

    // Apply AI-chosen links to items
    for (let i = 0; i < items.length; i++) {
      const aiItem = data.items?.[i] || {};
      if (aiItem.link && aiItem.link.tab) {
        // Validate that the AI chose a route from our catalog
        const valid = AVAILABLE_ROUTES.some(r =>
          r.tab === aiItem.link.tab && ((!r.subTab && !aiItem.link.subTab) || r.subTab === aiItem.link.subTab)
        );
        items[i].link = valid ? { tab: aiItem.link.tab, ...(aiItem.link.subTab ? { subTab: aiItem.link.subTab } : {}) } : null;
        if (!valid) {
          console.warn(`   ⚠️  AI suggested invalid link for "${items[i].id}": tab="${aiItem.link.tab}" subTab="${aiItem.link.subTab || ''}" — ignoring`);
        }
      } else {
        items[i].link = null;
      }
    }

    return result;
  } catch (err) {
    console.error(`⚠️  AI translation failed: ${err.message}`);
    console.error('   Falling back to raw commit descriptions.');
    return generateTranslations.__fallback(items);
  }
}

// Fallback for when AI fails — no links assigned
generateTranslations.__fallback = function (items) {
  const result = {};
  for (const locale of ['it', 'en', 'de', 'fr']) {
    result[locale] = {};
    result[locale][`whatsNew.${versionKey}.title`] = 'Aggiornamenti';
    for (const item of items) {
      result[locale][item.titleKeyBase] = item.description.slice(0, 50);
      result[locale][item.descKeyBase] = item.description;
      item.link = null;
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
