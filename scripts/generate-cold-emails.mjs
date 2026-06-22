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
 * La leva: ogni email parte col numero REALE di candidati che abbiamo già
 * mandato gratis a quell'azienda (reciprocità misurata). Il gancio: click ≠
 * candidatura — lo sponsorizzato fa arrivare il CV diretto.
 *
 * Flags:
 *   --report PATH    JSON prodotto da employer-traffic-report.mjs (richiesto)
 *   --contacts PATH  registry email HR (default data/employer-outreach/contacts.json)
 *   --out DIR        cartella bozze (default data/employer-outreach/drafts)
 *   --top N          genera per le prime N aziende per candidati (default 10)
 *   --min N          soglia minima candidati (default 10)
 *   --days-label STR etichetta periodo nelle email (default "negli ultimi 3 mesi")
 *
 * Nessuna azienda è esclusa: il settore è solo un'etichetta di contesto.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySector } from './lib/employer-sectors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i < 0) return def;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true; // boolean flags
}

const PRICE = 'CHF 49 al mese per annuncio';
// Indirizzo opt-out: chi risponde qui (o "STOP") va messo `suppressed` nel send-log.
export const OPTOUT_EMAIL = 'valerie@frontaliereticino.ch';

/**
 * Le 4 email della sequenza. Personalizzazione Livello 4 (skill cold-email):
 * numero REALE di candidati + RUOLO più cliccato, connessi al problema (i click
 * si perdono). Tono da pari, una sola call-to-action a basso attrito per touch.
 */
export function buildSequence({ company, candidates, periodLabel, contactName, topRole }) {
  // Solo il nome di battesimo nel saluto ("Ciao Denise,"), non nome+cognome.
  const firstName = (contactName || '').trim().split(/\s+/)[0];
  const hi = firstName ? `Ciao ${firstName},` : 'Buongiorno,';
  // Ruolo accorciato per leggibilità; fallback neutro se assente o generico
  // (titoli-pagina tipo "Lavora con noi", "Concorsi", "Careers" non sono ruoli).
  const role = (topRole || '').replace(/\s+/g, ' ').trim();
  const GENERIC_ROLE = /lavora con noi|lavorare con noi|concors|careers?|^jobs?$|offerte di lavoro|posizioni aperte|unsolicited|spontane/i;
  const pagina = role && !GENERIC_ROLE.test(role) ? `pagina di "${role.slice(0, 48)}"` : 'pagina lavoro';
  // Opt-out obbligatorio su ogni touch (norma cold-email B2B + deliverability).
  // Footer leggibile dall'umano; l'header List-Unsubscribe lo aggiunge il sender.
  const footer = `\n\n—\nSe non volete più ricevere queste email, rispondete con "STOP" (o scrivete a ${OPTOUT_EMAIL}) e vi rimuoviamo subito.`;
  const seq = [
    {
      touch: 1, gapDays: 0, subject: 'candidati inviati',
      body: `${hi}

${periodLabel} vi abbiamo mandato ${candidates} persone alla vostra ${pagina} da frontaliereticino.ch — gratis, dagli annunci che pubblichiamo per voi.

Il punto è che quei click arrivano sul vostro sito e spesso si perdono. Possiamo farveli arrivare come candidature dirette, CV incluso, nella vostra casella.

Ha senso che vi mostri come, sul vostro annuncio più visto?

Valerie`,
    },
    {
      touch: 2, gapDays: 4, subject: 'di quei click',
      body: `${hi}

Di quei ${candidates} candidati che vi abbiamo mandato ${periodLabel}, quanti si sono poi candidati davvero da voi?

Con l'annuncio sponsorizzato la candidatura arriva diretta nella vostra casella — niente form esterni, niente dispersione. Vi mando un esempio reale?

Valerie`,
    },
    {
      touch: 3, gapDays: 5, subject: '49 vs migliaia',
      body: `${hi}

Diverse aziende ticinesi hanno già reso sponsorizzati i loro ruoli da noi. Costa ${PRICE} — contro la fee di un recruiter (migliaia di CHF a ruolo) o un singolo posting su jobs.ch.

Se vi aiuta a coprire anche un solo ruolo, si ripaga da solo. Provo a mostrarvelo sul vostro annuncio più visto?

Valerie`,
    },
    {
      touch: 4, gapDays: 7, subject: 'chiudo',
      body: `${hi}

Non vi disturbo oltre. In ogni caso vi lascio il riepilogo dei candidati che vi abbiamo mandato finora — usatelo come volete.

Se più avanti volete amplificarlo, sapete dove trovarmi.

Valerie`,
    },
  ];
  // Append the opt-out footer to every touch so drafts and real sends match.
  return seq.map((m) => ({ ...m, body: m.body + footer }));
}

function loadJson(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}

function run() {
  const reportPath = arg('--report');
  if (!reportPath || reportPath === true) { console.error('--report PATH richiesto (output di employer-traffic-report.mjs --json)'); process.exit(2); }
  const contactsPath = arg('--contacts', path.join(ROOT, 'data/employer-outreach/contacts.json'));
  const outDir = arg('--out', path.join(ROOT, 'data/employer-outreach/drafts'));
  const top = Number(arg('--top', '10'));
  const min = Number(arg('--min', '10'));
  const periodLabel = typeof arg('--days-label', 0) === 'string' ? arg('--days-label') : 'negli ultimi 3 mesi';

  const report = loadJson(path.resolve(reportPath), null);
  if (!report || !Array.isArray(report.employers)) { console.error(`report illeggibile: ${reportPath}`); process.exit(1); }
  const contacts = loadJson(path.resolve(contactsPath), {});

  // Nessuna azienda esclusa: top `top` per candidati, sopra la soglia `min`.
  const targets = report.employers.filter((e) => e.candidates >= min).slice(0, top);

  fs.mkdirSync(outDir, { recursive: true });
  console.log('═════════════════════════════════════════════════════════════');
  console.log(' ⚠️  DRY-RUN — SOLO BOZZE, NESSUN INVIO');
  console.log('═════════════════════════════════════════════════════════════');
  console.log(`Report: ${reportPath} (${report.source}, ${report.days}gg)`);
  console.log(`Target: ${targets.length} aziende (top ${top}, min ${min} candidati, nessuna esclusa)\n`);

  let withContact = 0;
  for (const e of targets) {
    const c = contacts[e.key] || contacts[e.name] || {};
    const email = c.email || null;
    if (email) withContact++;
    const sector = c.sector || classifySector(e.name);
    const seq = buildSequence({ company: e.name, candidates: e.candidates, periodLabel, contactName: c.contactName, topRole: c.topRole });
    const slug = e.key || e.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const lines = [
      `# Cold email — ${e.name}`,
      ``,
      `- Candidati inviati (${periodLabel}): **${e.candidates}** · click totali: ${e.clicks}`,
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
    console.log(`  ✏️  ${e.name} — ${e.candidates} candidati ${email ? '✓ email' : '⚠ no email'} → ${path.relative(ROOT, file)}`);
  }
  console.log(`\n${targets.length} bozze scritte in ${path.relative(ROOT, outDir)}/ (${withContact} con email, ${targets.length - withContact} da arricchire).`);
  console.log('Nessun invio eseguito. Revisiona le bozze prima di qualunque step di invio.');
}

// Esegui solo se invocato direttamente (così buildSequence è importabile senza side-effect).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) run();
