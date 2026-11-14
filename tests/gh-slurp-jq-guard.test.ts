import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// `gh api --slurp` non si combina con `--jq`/`--template`: il gh reale esce
// con «the `--slurp` option is not supported with `--jq` or `--template`».
// Con lo stderr scartato e un fallback (`2>/dev/null || echo ""`,
// `allowFail`) il rifiuto diventa un risultato vuoto e plausibile: il
// preflight del ❌-check-fixer ha letto «nessuna PR aperta» su ogni PR dal
// 2026-09-20 al 2026-09-25. Lo shim locale del coordinatore accetta la
// combinazione, quindi in locale non si vede: serve un controllo statico.

const ROOT = path.resolve(__dirname, '..');
const SCAN = ['.github', 'scripts', 'bin'];
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

// Righe logiche: le continuazioni `\` della shell vengono unite, i commenti
// scartati (citano la combinazione proprio per vietarla).
function logicalLines(text: string) {
  const out: Array<{ line: number; text: string }> = [];
  let buffer = '';
  let start = 0;
  text.split('\n').forEach((raw, index) => {
    if (!buffer && COMMENT.test(raw)) return;
    if (!buffer) start = index + 1;
    const continued = /\\\s*$/.test(raw);
    buffer += ` ${raw.replace(/\\\s*$/, '')}`;
    if (!continued) {
      out.push({ line: start, text: buffer });
      buffer = '';
    }
  });
  if (buffer) out.push({ line: start, text: buffer });
  return out;
}

// I flag contano solo come TOKEN di comando: delimitati da inizio riga, spazio,
// apice, virgolette o backtick prima, e da fine riga, spazio, apice, virgolette,
// backtick, `=` o virgola (forma array JS) dopo. Una regex che cita
// `/--slurp\b/` o `\s-[qt]\s` (scripts/ci/run-related-tests.mjs) non e' un
// comando: accanto al flag ci sono `/` o `\`. Inoltre la riga logica deve
// invocare davvero `gh api` (shell) o avere `'gh'` e `'api'` fra gli argomenti
// (execFileSync): senza, il flag appartiene a un altro programma o a un testo.
const BEFORE = String.raw`(?:^|[\s'"` + '`' + String.raw`])`;
const AFTER = String.raw`(?=$|[\s'"` + '`' + String.raw`=,])`;
const SLURP = new RegExp(`${BEFORE}--slurp${AFTER}`);
const JQ_OR_TEMPLATE = new RegExp(`${BEFORE}(?:--jq|--template|-q|-t)${AFTER}`);
const GH_WORD = /(?:^|[\s'"`(;&|])gh(?=$|[\s'"`),;&|])/;
const API_WORD = /(?:^|[\s'"`[,])api(?=$|[\s'"`\],])/;

function invokesGhApi(line: string) {
  return GH_WORD.test(line) && API_WORD.test(line);
}

function slurpWithJq(text: string) {
  return logicalLines(text)
    .filter(({ text: line }) => invokesGhApi(line) && SLURP.test(line) && JQ_OR_TEMPLATE.test(line))
    .map(({ line }) => line);
}

describe('gh api: --slurp mai insieme a --jq/--template', () => {
  it('nessun workflow o script lo combina', () => {
    const offenders: string[] = [];
    for (const dir of SCAN) {
      for (const file of walk(path.join(ROOT, dir))) {
        const text = readFileSync(file, 'utf8');
        if (!text.includes('--slurp')) continue;
        for (const line of slurpWithJq(text)) offenders.push(`${path.relative(ROOT, file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('riconosce la forma spezzata su piu\' righe che ha fermato il fixer', () => {
    const broken = [
      '            PR=$(gh api "repos/$REPO/pulls?state=open&per_page=100" \\',
      '              --paginate --slurp \\',
      '              --jq "[.[].[] | select(.head.ref==\\"$RUN_BRANCH\\")][0].number // empty" 2>/dev/null || echo "")',
    ].join('\n');
    expect(slurpWithJq(broken)).toEqual([1]);
  });

  it('accetta --slurp da solo e ignora i commenti che citano la combinazione', () => {
    const ok = [
      '# il gh reale rifiuta `--slurp` insieme a `--jq`',
      'jobs=$(gh api "repos/$REPO/actions/runs/1/jobs" --paginate --slurp)',
      '  // `--slurp` senza `--jq`: si appiattisce in JS',
    ].join('\n');
    expect(slurpWithJq(ok)).toEqual([]);
  });

  it('non scambia per un comando la riga di regex di run-related-tests', () => {
    const regexLine =
      "  ['tests/gh-slurp-jq-guard.test.ts', pathAndSourceMatch(/^(?:\\.github|scripts|bin)\\//, /--slurp\\b/, /(?:--jq\\b|--template\\b|\\s-[qt]\\s)/)],";
    expect(slurpWithJq(regexLine)).toEqual([]);
    // e il sorgente reale, finche' contiene quella riga, non e' un offender.
    const real = readFileSync(path.join(ROOT, 'scripts/ci/run-related-tests.mjs'), 'utf8');
    expect(real).toContain('--slurp');
    expect(slurpWithJq(real)).toEqual([]);
  });

  it('riconosce la forma JS execFileSync con gli argomenti in array', () => {
    const js = "const out = execFileSync('gh', ['api', url, '--paginate', '--slurp', '--jq', q]);";
    expect(slurpWithJq(js)).toEqual([1]);
    const tpl = 'execFileSync("gh", ["api", url, "--slurp", "--template", t]);';
    expect(slurpWithJq(tpl)).toEqual([1]);
    const short = "run('gh', ['api', url, '--slurp', '-q', q]);";
    expect(slurpWithJq(short)).toEqual([1]);
  });

  it('riconosce la forma --jq= e i flag corti nella shell', () => {
    expect(slurpWithJq('gh api repos/a/b/pulls --slurp --jq=".[]"')).toEqual([1]);
    expect(slurpWithJq('gh api repos/a/b/pulls --slurp -q ".[]"')).toEqual([1]);
  });

  it('ignora --slurp da solo, altri programmi e regex che citano i flag', () => {
    expect(slurpWithJq("execFileSync('gh', ['api', url, '--paginate', '--slurp']);")).toEqual([]);
    expect(slurpWithJq('jq --slurp -q x file.json')).toEqual([]);
    expect(slurpWithJq('const re = /--slurp\\b/; const r2 = /--jq\\b/; // gh api')).toEqual([]);
  });
});
