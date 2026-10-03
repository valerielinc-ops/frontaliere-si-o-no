import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createdSince,
  createdSinceFilter,
  createdSinceQuery,
  newestFirst,
} from '../scripts/ci/lib/run-listing-window.mjs';

// Un elenco di run filtrato per `branch` senza finestra `created`
// (`…/runs?branch=…` o `gh run list --branch …`) restituisce a tratti un
// elenco fermo a settimane o mesi prima: il resolver dell'artifact Pages ha
// ricevuto il 2026-10-02 150 candidati, il piu' recente del 16-08, e il
// coordinatore del workspace un «ultimo verde» vecchio di quattro giorni
// (2026-09-28). Il difetto e' intermittente e in locale non si vede: serve
// un controllo statico. Regola e helper: scripts/ci/lib/run-listing-window.mjs.

const ROOT = path.resolve(__dirname, '..');
const SCAN = ['.github', 'scripts', 'bin', 'functions'];
const EXT = /\.(ya?ml|mjs|cjs|js|ts|sh)$/;

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules') continue;
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walk(full);
    else if (EXT.test(name)) yield full;
  }
}

const COMMENT = /^\s*(#|\/\/|\*|\/\*)/;
// Dove comincia un elenco di run: `gh run list`, la sua forma ad array di
// argomenti (`'run', 'list'`), o l'endpoint REST `…/runs?…`.
const LISTING = /\brun\s+list\b|['"]run['"]\s*,\s*['"]list['"]|actions\/(?:workflows\/[^/\s'"`]+\/)?runs\?/;
const ARRAY_FORM = /['"]run['"]\s*,\s*['"]list['"]/;
const BRANCH =/--branch\b|\s-b\s|['"]-b['"]|[?&]branch=/;
// Solo la finestra vera: il flag `--created`, il parametro REST `created=` o
// l'helper. NON la parola nuda: `--json databaseId,createdAt` nomina
// «created» senza filtrare nulla, e con `/created/i` meta' dei call site
// risultava a posto anche senza finestra.
const CREATED = /--created\b|[?&]created=|createdSince(?:Filter|Query)?\(/;
// Il branch puo' arrivare dopo la chiusura dell'array, con
// `args.push('-b', 'main')`: si guardano le righe subito dopo.
const PUSH_BRANCH = /\.push\([^)]*['"](?:-b|--branch)['"]/;
const PUSH_LOOKAHEAD_LINES = 8;
// Un array di argomenti puo' stendersi su piu' righe: il comando finisce alla
// riga che chiude l'array, entro un tetto che non scavalca nel comando dopo.
const MAX_STATEMENT_LINES = 12;

/**
 * Righe (1-based) in cui comincia un elenco di run filtrato per `branch` il
 * cui comando non porta una finestra `created` (il flag `--created`, il
 * parametro REST `created=` o l'helper): il campo `createdAt` non conta.
 */
function branchListingsWithoutCreated(text: string): number[] {
  const lines = text.split('\n');
  const offenders: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (COMMENT.test(lines[index]) || !LISTING.test(lines[index])) continue;
    let statement = lines[index];
    let end = index;
    // Nella forma ad array la `[` puo' stare sulla riga prima di `'run',
    // 'list'`: conta solo se la `]` e' gia' arrivata dopo l'inizio.
    const fromListing = () => statement.slice(statement.search(LISTING));
    const continues = (line: string) => /\\\s*$/.test(line)
      || (ARRAY_FORM.test(lines[index]) && !/\]/.test(fromListing()));
    while (end + 1 < lines.length && end - index < MAX_STATEMENT_LINES && continues(lines[end])) {
      end += 1;
      if (!COMMENT.test(lines[end])) statement += `\n${lines[end]}`;
    }
    // Forma ad array: gli argomenti aggiunti con `.push(…)` nelle righe dopo
    // fanno parte dello stesso comando, fino al prossimo elenco o alla fine
    // della funzione.
    let tail = '';
    if (ARRAY_FORM.test(lines[index])) {
      for (let next = end + 1; next < lines.length && next - end <= PUSH_LOOKAHEAD_LINES; next += 1) {
        if (LISTING.test(lines[next]) || /^}/.test(lines[next])) break;
        if (!COMMENT.test(lines[next])) tail += `\n${lines[next]}`;
      }
    }
    const filtersByBranch = BRANCH.test(statement) || PUSH_BRANCH.test(tail);
    if (filtersByBranch && !CREATED.test(statement + tail)) offenders.push(index + 1);
  }
  return offenders;
}

// ALLOWLIST A SCALARE: file → numero di elenchi per `branch` ancora senza
// finestra `created`. PUO' SOLO DIMINUIRE. Il confronto e' esatto: una voce
// nuova o un conteggio piu' alto falliscono, e quando un file viene migrato la
// sua voce va tolta (altrimenti il test fallisce lo stesso). Non aggiungere
// voci: usa `createdSinceQuery()` / `createdSinceFilter()`.
const ALLOWLIST: Record<string, number> = {
  // File `adapted` con gemello nel corpus, posseduto da un'altra scheda in
  // corso: le tre chiamate (tests.yml su main, tests.yml e pr-redflag-fixer
  // sul branch della PR) migrano nella PR che lo tocca.
  'scripts/ci/pr-autorebase.mjs': 3,
  // Testo per chi legge la issue (un comando suggerito a un umano), non una
  // chiamata eseguita: nessun elenco viene consumato da codice.
  'scripts/build-rpm-canary-issue-body.mjs': 1,
  'scripts/build-user-value-canary-issue-body.mjs': 1,
};

describe('elenchi di run per branch: sempre con una finestra created', () => {
  it('nessun workflow o script elenca le run di un branch senza `created`', () => {
    const found: Record<string, number> = {};
    const where: string[] = [];
    for (const dir of SCAN) {
      for (const file of walk(path.join(ROOT, dir))) {
        const text = readFileSync(file, 'utf8');
        if (!LISTING.test(text)) continue;
        const offenders = branchListingsWithoutCreated(text);
        if (!offenders.length) continue;
        const relative = path.relative(ROOT, file).split(path.sep).join('/');
        found[relative] = offenders.length;
        where.push(...offenders.map((line) => `${relative}:${line}`));
      }
    }
    expect(found, `elenchi per branch senza created: ${where.join(', ')}`).toEqual(ALLOWLIST);
  });

  it('la allowlist non cresce', () => {
    // Tetto letterale: alzarlo richiede di modificare questa riga, e la regola
    // e' che non si alza. Si abbassa insieme alla allowlist.
    expect(Object.values(ALLOWLIST).reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(5);
  });

  it('riconosce la forma REST che ha fermato il resolver dell\'artifact Pages', () => {
    const broken = [
      '          while [ "$page" -le "$MAX_PAGES" ]; do',
      '            if ! gh api "repos/$GH_REPO/actions/workflows/deploy.yml/runs?branch=main&status=success&per_page=$PER_PAGE&page=$page" \\',
      '                 > "$WORK/page-$page.json"; then',
    ].join('\n');
    expect(branchListingsWithoutCreated(broken)).toEqual([2]);
    expect(branchListingsWithoutCreated(broken.replace('&status=success', '&status=success&created=%3E%3D$CREATED_SINCE'))).toEqual([]);
  });

  it('riconosce `gh run list --branch` spezzato su piu\' righe e la forma ad array', () => {
    const shell = [
      '          busy=$(gh run list --repo "$REPO" --workflow=x.yml --branch "$head_ref" \\',
      '            --json status --jq \'length\')',
    ].join('\n');
    expect(branchListingsWithoutCreated(shell)).toEqual([1]);
    const array = [
      '      const raw = execFileSyncImpl(\'gh\', [',
      '        \'run\', \'list\',',
      '        \'--repo\', repo,',
      '        \'--branch\', \'main\',',
      '        \'--limit\', String(maxRecords),',
      '      ], {',
    ].join('\n');
    expect(branchListingsWithoutCreated(array)).toEqual([2]);
    expect(branchListingsWithoutCreated(array.replace("'--limit'", "'--created', created,\n        '--limit'"))).toEqual([]);
  });

  it('il campo `createdAt` di --json non vale come finestra', () => {
    const shell = 'gh run list --workflow x.yml --branch main --limit 1 --json databaseId,createdAt';
    expect(branchListingsWithoutCreated(shell)).toEqual([1]);
    expect(branchListingsWithoutCreated(`${shell} --created ">=$SINCE"`)).toEqual([]);
    const array = [
      "  const listArgs = ['run', 'list', '-w', workflowName, '-b', 'main', '-L', String(LIMIT),",
      "    '--json', 'databaseId,status,conclusion,createdAt'];",
    ].join('\n');
    expect(branchListingsWithoutCreated(array)).toEqual([1]);
    expect(branchListingsWithoutCreated(array.replace("'-L'", "'--created', createdSinceFilter(35), '-L'"))).toEqual([]);
  });

  it('riconosce il branch aggiunto con `.push` dopo la chiusura dell\'array', () => {
    const pushed = [
      "  const args = ['run', 'list', '-w', workflowName];",
      "  if (!allBranches) args.push('-b', 'main');",
      '  args.push(',
      "    '-L', String(LIMIT),",
      "    '--json', 'databaseId,conclusion,status,createdAt,headBranch',",
      '  );',
      '  return args;',
      '}',
    ].join('\n');
    expect(branchListingsWithoutCreated(pushed)).toEqual([1]);
    expect(branchListingsWithoutCreated(pushed.replace("'-b', 'main'", "'-b', 'main', '--created', since"))).toEqual([]);
  });

  it('ignora i commenti e gli elenchi non filtrati per branch', () => {
    const ok = [
      '# `gh run list --branch main` senza finestra torna fermo',
      ' * `.workflow_runs` di `actions/workflows/tests.yml/runs?branch=main`.',
      'gh run list --workflow deploy.yml --limit 5',
      'gh api "repos/$REPO/actions/runs?head_sha=$SHA&per_page=100"',
    ].join('\n');
    expect(branchListingsWithoutCreated(ok)).toEqual([]);
  });
});

describe('run-listing-window', () => {
  const now = Date.UTC(2030, 0, 10, 12, 0, 0);

  it('createdSince tronca al giorno UTC e non accorcia mai la finestra', () => {
    expect(createdSince(9, now)).toBe('2030-01-01');
    expect(createdSince(0.5, now)).toBe('2030-01-10');
    expect(createdSince(3, now)).toBe('2030-01-07');
    expect(() => createdSince(0, now)).toThrow(TypeError);
    expect(() => createdSince(Number.NaN, now)).toThrow(TypeError);
  });

  it('filtro per `gh run list --created` e parametro REST codificato', () => {
    expect(createdSinceFilter(9, now)).toBe('>=2030-01-01');
    expect(createdSinceQuery(9, now)).toBe('created=%3E%3D2030-01-01');
  });

  it('newestFirst ordina entrambe le forme e non muta l\'ingresso', () => {
    const rest = [{ id: 1, created_at: '2030-01-01T00:00:00Z' }, { id: 2, created_at: '2030-01-03T00:00:00Z' }];
    expect(newestFirst(rest).map((run) => run.id)).toEqual([2, 1]);
    expect(rest.map((run) => run.id)).toEqual([1, 2]);
    const cli = [{ databaseId: 1, createdAt: '2030-01-02T00:00:00Z' }, { databaseId: 2 }, { databaseId: 3, createdAt: '2030-01-05T00:00:00Z' }];
    expect(newestFirst(cli).map((run) => run.databaseId)).toEqual([3, 1, 2]);
    expect(newestFirst(null)).toEqual([]);
  });
});
