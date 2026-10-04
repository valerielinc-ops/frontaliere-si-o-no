import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Closer: un chiamante nuovo decide su un numero e chiude per titolo.
 *
 * `resolveGithubIssue(title)` cerca per titolo (prefisso, o titolo esatto) e
 * chiude la PIÙ RECENTE fra le aperte. Un closer che ha giudicato un'issue
 * precisa (le sue run, i suoi commenti, le sue label) e poi chiude per titolo
 * può chiuderne un'altra, gemella o col prefisso in comune, scavalcando i
 * controlli fatti sul numero. Il 2026-10-04 lo stesso difetto è comparso tre
 * volte: PR 11317 (`monitor-issue-reconcile.mjs`), 11358
 * (`close-recovered-failure-issues.mjs`), 11355 (`scan-job-timeouts.mjs`).
 * Ogni closer nuovo lo ripeteva perché era l'unica API di chiusura nei modelli
 * da copiare.
 *
 * La regola: chi decide su un numero chiude con
 * `resolveGithubIssueByNumber(number, { expectedTitle })`, che rilegge stato e
 * titolo subito prima di scrivere. `resolveGithubIssue` resta per chi decide
 * davvero per titolo (un monitor che apre e chiude un titolo stabile), e ogni
 * file che la usa sta nell'elenco qui sotto con il motivo e il numero di
 * chiamate. Un chiamante nuovo, una chiamata in più, o un file che smette di
 * usarla fa fallire il test finché l'elenco non viene aggiornato.
 *
 * Il test legge i sorgenti da disco e non importa i file che giudica: il
 * selettore lo lega al diff con `sourceTreeLintTests` in
 * `scripts/ci/run-related-tests.mjs`, con lo stesso perimetro dello scan.
 */

type Entry = { calls: number; why: string };

const TITLE_DECIDERS: Record<string, Entry> = {
  'scripts/lib/github-issue-creator.mjs': {
    calls: 1,
    why: 'la CLI `--resolve` riceve solo `--title`: un passo `if: success()` chiude il titolo stabile del suo reporter',
  },
  'scripts/audit-duplicate-crawler-companies.mjs': {
    // 0 chiamate dirette: l'unico uso passa dal default iniettabile
    // `creator.resolveGithubIssue` di reportFindingIssues.
    calls: 0,
    why: 'audit settimanale dei crawler: una famiglia (duplicate/coverage-gap/snapshot-stale) misurata a 0 chiude la issue della sua chiave stabile, la stessa dedupKey con cui la apre; nessun numero valutato',
  },
  'scripts/audit-missing-company-logos.mjs': {
    // 0 chiamate dirette: l'unico uso passa dal default iniettabile
    // `resolveIssue` di reportIssue (issue 6504).
    calls: 0,
    why: 'audit loghi settimanale: 0 aziende senza logo verificato chiude il titolo stabile MISSING_LOGOS_ISSUE_TITLE che lo stesso audit apre, nessun numero valutato',
  },
  'scripts/audit-cls-live.mjs': {
    // 0 chiamate dirette: l'unico uso passa dal default iniettabile
    // `resolve: resolveIssue = resolveGithubIssue` di syncClsRegressionIssue.
    calls: 0,
    why: 'gate CLS post-deploy (CLS-2): una misura completa senza regressioni hard chiude il titolo stabile esatto CLS_REGRESSION_ISSUE_TITLE che lo stesso gate apre, nessun numero valutato',
  },
  'scripts/check-source-liveness.mjs': {
    calls: 1,
    why: 'sorgente misurata viva chiude il titolo stabile ISSUE_TITLE dell\'outage che lo stesso script apre; nessun numero valutato',
  },
  'scripts/ci/check-employer-insights-freshness.mjs': {
    calls: 1,
    why: 'dato fresco → chiude il titolo stabile esatto che lo stesso monitor apre quando è stantio',
  },
  'scripts/ci/information-gain-loop-issues.mjs': {
    calls: 1,
    why: 'il verdetto è per famiglia: apre e chiude il titolo esatto calcolato dalla famiglia, nessun numero letto',
  },
  'scripts/ci/orchestrator-heartbeat.mjs': {
    calls: 3,
    why: 'lo stato del heartbeat (missing/inconclusive/observed) apre e chiude due titoli stabili',
  },
  'scripts/ci/reconcile-followups.mjs': {
    // 0 chiamate dirette: l'unico uso passa dal default iniettabile
    // `resolve = resolveGithubIssue` di applyBucketAlarm (sostituibile nei test).
    calls: 0,
    why: 'allarme dei bucket illeggibili (FU-12, PR 11359): un solo titolo stabile, BUCKET_ALARM_TITLE con exactTitle, aperto o chiuso dal piano su TUTTE le issue lette, non su un numero valutato',
  },
  'scripts/ci/report-synced-article-fabrication.mjs': {
    calls: 1,
    why: 'scope calcolabile in questo sync → chiude il titolo stabile «guard scollegato» che lo stesso script apre',
  },
  'scripts/ci/report-validate-dist-failure.mjs': {
    calls: 2,
    why: 'un gate passato chiude il titolo esatto del gate: la decisione è sul gate, il listing legge solo i titoli',
  },
  'scripts/ci/report-workflow-failure.mjs': {
    calls: 1,
    why: '`--resolve` del reporter generico: il workflow verde chiude il suo `FAILURE_TITLE`, nessun numero letto',
  },
  'scripts/experiments/jobgate-v3-monitor.mjs': {
    calls: 1,
    why: 'un allarme rientrato nel diff di stato chiude il titolo stabile di quell\'allarme',
  },
  'scripts/monitor-telegram-member-count.mjs': {
    calls: 1,
    why: 'il conteggio iscritti cambiato entro la soglia chiude il titolo stabile STABLE_ISSUE_TITLE della stagnazione che lo stesso monitor apre',
  },
  'scripts/monitor-gcp-costs.mjs': {
    calls: 1,
    why: 'nessun driver sopra soglia → chiude il titolo stabile del monitor costi',
  },
  'scripts/send-job-alerts.mjs': {
    calls: 1,
    why: 'sonde sintetiche del matcher tutte verdi → chiude il titolo stabile del monitor',
  },
  'scripts/seo/seo-health-loop.mjs': {
    calls: 1,
    why: 'osservazione verde dopo una rossa → chiude il titolo stabile del loop SEO',
  },
  'scripts/translation-provider-readiness.mjs': {
    calls: 1,
    why: 'provider di nuovo accettato → chiude il titolo per-provider che lo stesso script apre',
  },
};

const ROOT = path.resolve(__dirname, '..');
// Perimetro dello scan: lo stesso registrato in run-related-tests.mjs.
const SCAN: Array<[string, RegExp]> = [
  ['scripts', /\.mjs$/],
  ['functions', /\.(?:js|mjs|ts)$/],
];

function* walk(dir: string, ext: RegExp): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full, ext);
    else if (ext.test(name)) yield full;
  }
}

const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;
const REFERENCE = /\bresolveGithubIssue\b/;
const CALL = /\bresolveGithubIssue\s*\(/g;

/** Testo dell'argomento di una chiamata che si apre a `open` (la `(`), saltando le stringhe. */
function callArguments(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      for (i += 1; i < text.length && text[i] !== ch; i += 1) if (text[i] === '\\') i += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

type Usage = { calls: number; byNumber: number };

/**
 * Uso di `resolveGithubIssue` in un sorgente: le chiamate (la definizione
 * esclusa) e quante di esse passano `issueNumber`, cioè una decisione su un
 * numero vestita da chiusura per titolo. `null` se il file non la nomina fuori
 * dai commenti (un import con alias conta come riferimento).
 */
function titleResolveUsage(source: string): Usage | null {
  const code = source.split('\n').filter((line) => !COMMENT_LINE.test(line)).join('\n');
  if (!REFERENCE.test(code)) return null;
  let calls = 0;
  let byNumber = 0;
  for (const match of code.matchAll(CALL)) {
    if (/function\s+$/.test(code.slice(Math.max(0, match.index! - 20), match.index))) continue;
    calls += 1;
    const open = match.index! + match[0].length - 1;
    if (/\bissueNumber\b/.test(callArguments(code, open))) byNumber += 1;
  }
  return { calls, byNumber };
}

/** Differenze fra l'uso trovato e l'elenco dichiarato. Vuoto = ratchet verde. */
function ratchetViolations(found: Map<string, Usage>, declared: Record<string, Entry>): string[] {
  const out: string[] = [];
  for (const [file, usage] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
    if (usage.byNumber > 0) {
      out.push(`${file}: ${usage.byNumber} chiamata/e passano issueNumber — chi decide su un numero usa resolveGithubIssueByNumber`);
    }
    const entry = declared[file];
    if (!entry) {
      out.push(`${file}: usa resolveGithubIssue ma non è nell'elenco — se decide su un numero usa resolveGithubIssueByNumber, altrimenti dichiaralo col motivo`);
    } else if (entry.calls !== usage.calls) {
      out.push(`${file}: ${usage.calls} chiamate, l'elenco ne dichiara ${entry.calls} — ogni chiamata nuova va giudicata`);
    }
  }
  for (const file of Object.keys(declared).sort()) {
    if (!found.has(file)) out.push(`${file}: nell'elenco ma non usa più resolveGithubIssue — togli la voce`);
  }
  return out;
}

function scanTree(): Map<string, Usage> {
  const found = new Map<string, Usage>();
  for (const [dir, ext] of SCAN) {
    for (const full of walk(path.join(ROOT, dir), ext)) {
      const usage = titleResolveUsage(readFileSync(full, 'utf8'));
      if (usage) found.set(path.relative(ROOT, full).split(path.sep).join('/'), usage);
    }
  }
  return found;
}

describe('ratchet sulle chiusure per titolo', () => {
  it('ogni file che chiude per titolo è dichiarato, col motivo e le sue chiamate', () => {
    for (const [file, entry] of Object.entries(TITLE_DECIDERS)) {
      expect(entry.why.length, `${file}: motivo mancante`).toBeGreaterThan(20);
    }
    expect(ratchetViolations(scanTree(), TITLE_DECIDERS)).toEqual([]);
  });

  it('un chiamante nuovo non dichiarato fa fallire, l\'elenco aggiornato lo fa passare', () => {
    const closer = `
      import { resolveGithubIssue } from '../lib/github-issue-creator.mjs';
      for (const issue of listed) {
        if (decide(issue.number).action === 'close') resolveGithubIssue(issue.title, { exactTitle: true });
      }
    `;
    const usage = titleResolveUsage(closer)!;
    expect(usage).toEqual({ calls: 1, byNumber: 0 });
    const found = new Map([['scripts/ci/new-closer.mjs', usage]]);
    expect(ratchetViolations(found, {})).toEqual([
      expect.stringContaining('scripts/ci/new-closer.mjs: usa resolveGithubIssue ma non è nell\'elenco'),
    ]);
    expect(ratchetViolations(found, {
      'scripts/ci/new-closer.mjs': { calls: 1, why: 'fixture: decide per titolo stabile' },
    })).toEqual([]);
  });

  it('una chiamata in più in un file dichiarato, o una voce orfana, fanno fallire', () => {
    const found = new Map([['scripts/a.mjs', { calls: 2, byNumber: 0 }]]);
    const declared = {
      'scripts/a.mjs': { calls: 1, why: 'fixture: titolo stabile' },
      'scripts/gone.mjs': { calls: 1, why: 'fixture: titolo stabile' },
    };
    expect(ratchetViolations(found, declared)).toEqual([
      expect.stringContaining('scripts/a.mjs: 2 chiamate, l\'elenco ne dichiara 1'),
      expect.stringContaining('scripts/gone.mjs: nell\'elenco ma non usa più'),
    ]);
  });

  it('una decisione su un numero passata a resolveGithubIssue fa fallire anche se dichiarata', () => {
    const usage = titleResolveUsage(`
      const result = resolveGithubIssue(issue.title, {
        issueNumber: issue.number,
        workflow: fmt('(x)'),
      });
    `)!;
    expect(usage).toEqual({ calls: 1, byNumber: 1 });
    expect(ratchetViolations(
      new Map([['scripts/ci/x.mjs', usage]]),
      { 'scripts/ci/x.mjs': { calls: 1, why: 'fixture: titolo stabile' } },
    )).toEqual([expect.stringContaining('passano issueNumber')]);
  });

  it('commenti, definizione e la variante per numero non contano come chiamate per titolo', () => {
    expect(titleResolveUsage(`
      // si chiudeva con resolveGithubIssue(it.title): sbagliato
      resolveGithubIssueByNumber(it.number, { expectedTitle: it.title });
    `)).toBeNull();
    expect(titleResolveUsage(`
      export function resolveGithubIssue(titlePrefix, ctx = {}) { return null; }
    `)).toEqual({ calls: 0, byNumber: 0 });
    // Un alias è un riferimento: il file entra nel ratchet anche senza la chiamata letterale.
    expect(titleResolveUsage(`
      const { resolveGithubIssue: close } = await import('./lib/github-issue-creator.mjs');
    `)).toEqual({ calls: 0, byNumber: 0 });
  });
});
