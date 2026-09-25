#!/usr/bin/env node
/**
 * report-crawler-content-error.mjs — segnalazione MANUALE, in un comando, di un
 * annuncio crawlato che non e' un annuncio di lavoro.
 *
 * Perche' esiste: i due difetti che hanno innescato questa pipeline
 * (`hotel-international` che pubblicava offerte di camere d'hotel, `schindler`
 * col widget di consenso cookie come titolo) sono stati trovati dal
 * proprietario NAVIGANDO IL SITO A MANO. Prima di questo script l'unico modo di
 * agire su una scoperta del genere era aprire una sessione Claude Code
 * dedicata. Qui una riga di shell mette la segnalazione nella stessa pipeline
 * autonoma di tutto il resto:
 *
 *   segnalazione → `issue-triage` → `issue-fix` → PR → `## LGTM` → auto-merge
 *
 * Uso:
 *   node scripts/report-crawler-content-error.mjs <crawler-key|url> "<descrizione>"
 *   node scripts/report-crawler-content-error.mjs schindler "titolo = widget cookie"
 *   node scripts/report-crawler-content-error.mjs https://www.hotel-international.ch/it/offerte/... "sono offerte hotel"
 *
 * Opzioni:
 *   --urgent     instrada come `crawler` → `agent:fix` IMMEDIATO invece della
 *                coda. Vedi «Routing» sotto: e' una scelta, non il default.
 *   --dry-run    stampa l'issue che aprirebbe e non tocca GitHub.
 *   --title="…"  sovrascrive il titolo generato (raro: il default e' gia'
 *                stabile per il dedup a 60 char).
 *
 * ROUTING — la decisione, esplicita (`scripts/lib/classify-issue.mjs`):
 *   default  → nessuna label di routing → categoria `other` → `agent:fix-queued`,
 *              drenata UNA alla volta da `followup-drainer`. E' la stessa
 *              posizione del `crawler-data-quality-audit.yml` esistente, e la
 *              ragione e' quella scritta nel suo commento: il bypass diretto
 *              alla coda (`route: 'fix'`) e' documentato in classify-issue.mjs
 *              come «l'UNICA eccezione, provata sicura da mesi». Aggiungerne
 *              una seconda per default reintrodurrebbe il rischio di starvation
 *              che quella coda esiste per evitare.
 *   --urgent → label `parser-broken`, che in `classifyIssue()` da sola basta a
 *              dare categoria `crawler` → `route: 'fix'`. Ha senso quando il
 *              contenuto sbagliato e' LIVE e visibile agli utenti (i due casi
 *              reali lo erano): la segnalazione umana e' gia' verifica, non
 *              c'e' un giudizio LLM da revisionare.
 *
 * Auth: `gh` gia' autenticato (come ovunque nel repo). `GH_REPO` per forzare il
 * repo se lanciato fuori dal checkout.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGithubIssue } from './lib/github-issue-creator.mjs';
import { scanSlice } from './lib/job-content-plausibility.mjs';
import { isSliceFile } from './lib/crawler-slice-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');

/**
 * Risolve l'argomento in una crawler key. Accetta la key diretta (`schindler`)
 * o un URL qualunque di un annuncio: un umano che ha appena visto la pagina
 * sbagliata ha in mano l'URL, non la key interna — chiedergli la key
 * significherebbe chiedergli di aprire il repo, cioe' esattamente l'attrito che
 * questo script rimuove.
 *
 * @param {string} input
 * @param {string} [dir]
 * @returns {{ crawlerKey: string|null, how: string }}
 */
export function resolveCrawlerKey(input, dir = SLICES_DIR) {
  const raw = String(input || '').trim();
  if (!raw) return { crawlerKey: null, how: 'input vuoto' };

  let files = [];
  try {
    files = fs.readdirSync(dir).filter(isSliceFile);
  } catch {
    // Worktree sparse senza `data/`: la key diretta resta utilizzabile, l'URL no.
    return /^https?:/i.test(raw)
      ? { crawlerKey: null, how: `${dir} non leggibile: passa la crawler key invece dell'URL` }
      : { crawlerKey: raw, how: 'key passata direttamente (dataset non leggibile, non verificata)' };
  }

  if (files.includes(`${raw}.json`)) return { crawlerKey: raw, how: 'key esatta' };

  if (/^https?:/i.test(raw)) {
    let host;
    try {
      host = new URL(raw).host.replace(/^www\./, '');
    } catch {
      return { crawlerKey: null, how: 'URL non parsabile' };
    }
    // Primo giro: match esatto sull'URL del job (il caso piu' preciso).
    // Secondo giro: match sull'host. Entrambi su testo grezzo, senza
    // JSON.parse — la directory e' ~420 MB e il parse di tutto costerebbe
    // decine di secondi per una risposta che una substring da' subito.
    for (const pass of ['url', 'host']) {
      for (const file of files) {
        let text;
        try {
          text = fs.readFileSync(path.join(dir, file), 'utf8');
        } catch {
          continue;
        }
        if (pass === 'url' ? text.includes(raw) : text.includes(host)) {
          return { crawlerKey: path.basename(file, '.json'), how: `match per ${pass} (${host})` };
        }
      }
    }
    return { crawlerKey: null, how: `nessun crawler contiene ${host}` };
  }

  return { crawlerKey: raw, how: 'key passata direttamente (nessun file corrispondente)' };
}

/**
 * Allega al report umano l'evidenza che il rilevatore deterministico trova da
 * solo su quel crawler. Serve a due cose: dare al fixer un punto di partenza
 * gia' misurato, e rendere visibile il caso in cui l'umano vede un difetto che
 * il lessico NON prende — che e' il segnale per estendere il lessico, non solo
 * per riparare il parser.
 *
 * @param {string} crawlerKey
 * @returns {string} blocco markdown
 */
export function buildMachineEvidence(crawlerKey, dir = SLICES_DIR) {
  let slice;
  try {
    slice = JSON.parse(fs.readFileSync(path.join(dir, `${crawlerKey}.json`), 'utf8'));
  } catch {
    return '_Dataset non leggibile da qui (worktree sparse o crawler inesistente): nessuna evidenza automatica allegata._';
  }
  const result = scanSlice({ ...slice, crawlerKey });
  if (!result.findings.length) {
    return (
      `Il rilevatore deterministico (\`scripts/lib/job-content-plausibility.mjs\`) **NON** segnala nulla ` +
      `su questo crawler (${result.totalJobs} record). Se la segnalazione umana e' corretta, il lessico ha un buco: ` +
      `il fix completo include un caso nuovo in \`tests/job-content-plausibility.test.ts\` e la regola che lo prende.`
    );
  }
  const lines = [
    `Rilevatore deterministico: **${result.flagged}/${result.totalJobs}** record segnalati ` +
      `(livello: ${result.level === 'crawler' ? 'crawler intero' : 'record singoli'}).`,
    '',
  ];
  for (const f of result.findings.slice(0, 10)) {
    lines.push(`- \`[${f.codes.join('+')}]\` ${JSON.stringify(f.title)}`);
    if (f.url) lines.push(`  - url: ${f.url}`);
  }
  if (result.findings.length > 10) lines.push(`- … e altri ${result.findings.length - 10}.`);
  return lines.join('\n');
}

function usage() {
  console.error(
    'Uso: node scripts/report-crawler-content-error.mjs <crawler-key|url> "<descrizione>" ' +
      '[--urgent] [--dry-run] [--title="..."]'
  );
}

if (process.argv[1] && process.argv[1].endsWith('report-crawler-content-error.mjs')) {
  const argv = process.argv.slice(2);
  const flags = argv.filter((a) => a.startsWith('--'));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const urgent = flags.includes('--urgent');
  const dryRun = flags.includes('--dry-run');
  const titleOverride = (flags.find((a) => a.startsWith('--title=')) || '').slice(8) || null;

  const [target, ...descParts] = positional;
  const description = descParts.join(' ').trim();
  if (!target || !description) {
    usage();
    process.exit(1);
  }

  const { crawlerKey, how } = resolveCrawlerKey(target);
  if (!crawlerKey) {
    console.error(`Impossibile risolvere "${target}" in un crawler: ${how}`);
    process.exit(1);
  }

  // Titolo stabile per il dedup a 60 char di github-issue-creator.mjs, con il
  // discriminante (la crawler key) SUBITO dopo il prefisso: due segnalazioni su
  // crawler diversi non devono collassare sulla stessa issue.
  const shortDesc = description.replace(/\s+/g, ' ').slice(0, 90);
  const title = titleOverride || `[job-content] ${crawlerKey}: ${shortDesc}`;

  const labels = ['job-content-quality'];
  if (urgent) labels.push('parser-broken'); // → categoria `crawler` → agent:fix immediato

  const body = [
    '## Segnalazione manuale — contenuto crawlato che non e\' un annuncio di lavoro',
    '',
    `**Crawler:** \`${crawlerKey}\` (risolto: ${how})`,
    `**Segnalato per:** \`${target}\``,
    '',
    '### Cosa ha osservato la persona',
    '',
    description,
    '',
    '### Evidenza automatica',
    '',
    buildMachineEvidence(crawlerKey),
    '',
    '### Cosa fare',
    '',
    `1. Riprodurre: \`node scripts/audit-job-content-plausibility.mjs --crawler=${crawlerKey}\``,
    `2. Riparare il parser/selettore in \`scripts/lib/\` o la definizione del crawler, ` +
      `NON cancellare a mano i record da \`data/jobs/by-crawler/${crawlerKey}.json\` — ` +
      `il prossimo giro di crawl li riscriverebbe identici.`,
    `3. Se il rilevatore deterministico non prendeva questo caso, aggiungere la regola ` +
      `in \`scripts/lib/job-content-plausibility.mjs\` e il caso in \`tests/job-content-plausibility.test.ts\`, ` +
      `cosi' la classe di difetto e' coperta la prossima volta.`,
    '',
    `_Aperta da \`scripts/report-crawler-content-error.mjs\`. Pipeline: ` +
      `\`docs/CRAWLERS.md\` → "Job-Content Plausibility"._`,
  ].join('\n');

  if (dryRun) {
    console.log(`TITLE: ${title}`);
    console.log(`LABELS: ${labels.join(', ')}`);
    console.log(`PRIORITY: ${urgent ? 2 : 3}`);
    console.log('---');
    console.log(body);
    process.exit(0);
  }

  createGithubIssue({
    title,
    description: body,
    priority: urgent ? 2 : 3,
    labels,
    workflow: 'report-crawler-content-error (manuale)',
  })
    .then(() => {
      console.log(`Segnalazione inviata per \`${crawlerKey}\`.`);
      console.log(
        urgent
          ? 'Routing: categoria `crawler` → `agent:fix` immediato.'
          : 'Routing: categoria `other` → `agent:fix-queued` (drenata da followup-drainer).'
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[report-crawler-content-error] ${err.message}`);
      process.exit(1);
    });
}
