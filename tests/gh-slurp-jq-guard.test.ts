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

function slurpWithJq(text: string) {
  return logicalLines(text)
    .filter(({ text: line }) => /--slurp\b/.test(line) && /(--jq\b|--template\b|\s-q\s|\s-t\s)/.test(line))
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
});
