#!/usr/bin/env node
/**
 * Cold-email DRAFT generator — sistema di outreach per convertire le aziende
 * crawlate in inserzionisti sponsorizzati.
 *
 * ⚠️  NON INVIA NULLA. Genera solo BOZZE su file per revisione umana.
 *     Nessun provider email viene importato o chiamato. L'invio resterà un
 *     passo separato, manuale e gated (vedi `## Non implementato` nella PR).
 *
 * Pipeline:
 *   1) node scripts/employer-traffic-report.mjs --source posthog --days 90 \
 *        --json data/employer-outreach/report.json
 *   2) (enrichment manuale) compila data/employer-outreach/contacts.json con le
 *      email HR delle aziende target — vedi contacts.example.json.
 *   3) node scripts/generate-cold-emails.mjs --report data/employer-outreach/report.json \
 *        --out data/employer-outreach/drafts --top 10
 *
 * La leva: ogni email parte da una metrica di interazione dichiarata, registrata
 * gratis sugli annunci dell'azienda. Il gancio: un click non è una candidatura —
 * lo sponsorizzato può portare il CV direttamente nella casella.
 *
 * Flags:
 *   --report PATH    JSON prodotto da employer-traffic-report.mjs (richiesto)
 *   --contacts PATH  registry email HR (default data/employer-outreach/contacts.json)
 *   --out DIR        cartella bozze (default data/employer-outreach/drafts)
 *   --top N          genera per le prime N aziende per metrica (default 10)
 *   --min N          soglia minima della metrica (default 10)
 *   --days-label STR compatibilità legacy: la bozza usa comunque la finestra del report
 *
 * Nessuna azienda è esclusa: il settore è solo un'etichetta di contesto.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySector } from './lib/employer-sectors.mjs';
// Sequence lives in ONE pure module shared with the browser admin preview
// (AGENTS.md Non-Negotiable #6: no copy-paste of the touch bodies). Re-exported
// here so send-cold-emails.mjs keeps importing the shared sequence and its
// outreach metric selector from this file.
import { buildSequence, OPTOUT_EMAIL, formatItalianPeriodLabel } from './lib/cold-email-sequence.mjs';

export { buildSequence, OPTOUT_EMAIL };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i < 0) return def;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true; // boolean flags
}

function loadJson(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}

function countOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.trunc(count) : null;
}

/**
 * Pick the metric that outreach is allowed to name. Raw apply clicks are the
 * primary metric; the legacy proxy remains usable only as a clearly-labelled
 * interest signal, never as a person or an application.
 */
export function selectOutreachMetric(entry = {}) {
  const applyClicks = countOrNull(entry.applyClicks);
  if (applyClicks !== null && applyClicks > 0) {
    return { value: applyClicks, label: 'click per candidarsi', source: 'applyClicks' };
  }
  const proxyField = entry.applyClickProxy !== undefined
    && entry.applyClickProxy !== null
    && entry.applyClickProxy !== ''
    ? 'applyClickProxy'
    : 'candidates';
  const proxy = countOrNull(entry[proxyField]);
  if (proxy !== null) {
    return { value: proxy, label: 'segnali di interesse', source: proxyField };
  }
  return null;
}

function run() {
  const reportPath = arg('--report');
  if (!reportPath || reportPath === true) { console.error('--report PATH richiesto (output di employer-traffic-report.mjs --json)'); process.exit(2); }
  const contactsPath = arg('--contacts', path.join(ROOT, 'data/employer-outreach/contacts.json'));
  const outDir = arg('--out', path.join(ROOT, 'data/employer-outreach/drafts'));
  const top = Number(arg('--top', '10'));
  const min = Number(arg('--min', '10'));

  const report = loadJson(path.resolve(reportPath), null);
  if (!report || !Array.isArray(report.employers)) { console.error(`report illeggibile: ${reportPath}`); process.exit(1); }
  if (!report.window || typeof report.window !== 'object' || !report.window.from || !report.window.to) {
    console.error('report senza finestra esplicita: nessuna bozza numerica generata');
    process.exit(1);
  }
  const periodLabel = formatItalianPeriodLabel(`${report.window.from} → ${report.window.to}`);
  const contacts = loadJson(path.resolve(contactsPath), {});

  // Nessuna azienda esclusa: top `top` per metrica, sopra la soglia `min`.
  const targets = report.employers
    .map((entry) => ({ entry, metric: selectOutreachMetric(entry) }))
    .filter(({ metric }) => metric && metric.value >= min)
    .sort((a, b) => b.metric.value - a.metric.value
      || String(a.entry.key || a.entry.name || '').localeCompare(String(b.entry.key || b.entry.name || '')))
    .slice(0, top)
    .map(({ entry }) => entry);

  fs.mkdirSync(outDir, { recursive: true });
  console.log('═════════════════════════════════════════════════════════════');
  console.log(' ⚠️  DRY-RUN — SOLO BOZZE, NESSUN INVIO');
  console.log('═════════════════════════════════════════════════════════════');
  console.log(`Report: ${reportPath} (${report.source}, ${report.days}gg)`);
  console.log(`Target: ${targets.length} aziende (top ${top}, min ${min} sulla metrica outreach, nessuna esclusa)\n`);

  let withContact = 0;
  for (const e of targets) {
    const c = contacts[e.key] || contacts[e.name] || {};
    const email = c.email || null;
    if (email) withContact++;
    const sector = c.sector || classifySector(e.name);
    const metric = selectOutreachMetric(e);
    const seq = buildSequence({
      company: e.name,
      metricValue: metric?.value,
      metricLabel: metric?.label,
      periodLabel,
      contactName: c.contactName,
      topRole: c.topRole,
    });
    const slug = e.key || e.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const lines = [
      `# Cold email — ${e.name}`,
      ``,
      ...(metric && metric.value > 0
        ? [`- ${metric.label[0].toUpperCase()}${metric.label.slice(1)} (${periodLabel}): **${metric.value}**`]
        : []),
      `- Settore: ${sector} (calibra il tono a mano se serve)`,
      `- Ruolo più cliccato: ${c.topRole || '(da arricchire)'}`,
      `- Pagina careers: ${e.careersUrl || '(da arricchire)'}`,
      `- Email contatto: ${email || '⚠️ MANCANTE — arricchire contacts.json'}`,
      `- Stato: BOZZA, non inviata`,
      ``,
      `---`,
      ``,
    ];
    for (const m of seq) {
      lines.push(`## Touch ${m.touch}${m.gapDays ? ` (+${m.gapDays} giorni)` : ''} — oggetto: ${m.subject}`);
      lines.push('');
      lines.push(m.body);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
    const file = path.join(outDir, `${String(targets.indexOf(e) + 1).padStart(2, '0')}-${slug}.md`);
    fs.writeFileSync(file, lines.join('\n'));
    console.log(`  ✏️  ${e.name} — ${metric?.value ?? 'metrica non disponibile'} ${metric?.label || ''} ${email ? '✓ email' : '⚠ no email'} → ${path.relative(ROOT, file)}`);
  }
  console.log(`\n${targets.length} bozze scritte in ${path.relative(ROOT, outDir)}/ (${withContact} con email, ${targets.length - withContact} da arricchire).`);
  console.log('Nessun invio eseguito. Revisiona le bozze prima di qualunque step di invio.');
}

// Esegui solo se invocato direttamente (così buildSequence è importabile senza side-effect).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) run();
