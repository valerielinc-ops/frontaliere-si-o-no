import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Baseline pre-Claude e verifica di non-progress silenzioso dei due fixer
// contano i commenti della PR. `--paginate --jq 'length'` stampava un numero
// per pagina; la correzione con `--slurp --jq` (PR 9959) usciva 1 sul gh reale,
// che rifiuta la combinazione, e il fallback rendeva il conteggio sempre 0.
// Il gh finto qui sotto la rifiuta allo stesso modo: una prova che passa solo
// contro il coordinatore locale, che la accetta, non è una prova.

const ROOT = path.resolve(__dirname, '..');
const FIXERS = ['.github/workflows/pr-redflag-fixer.yml', '.github/workflows/pr-redcheck-fixer.yml'];

function fakeGh(dir: string, pagesJson: string, { fail = false } = {}) {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const gh = path.join(bin, 'gh');
  writeFileSync(gh, `#!/bin/bash
set -u
${fail ? 'exit 1' : ''}
slurp=0; filter=0
for arg in "$@"; do
  case "$arg" in --slurp) slurp=1 ;; --jq|--template) filter=1 ;; esac
done
if [ "$slurp" = 1 ] && [ "$filter" = 1 ]; then
  echo "the --slurp option is not supported with --jq or --template" >&2
  exit 1
fi
[ "$slurp" = 1 ] && printf '%s\\n' '${pagesJson}'
exit 0
`);
  chmodSync(gh, 0o755);
  return gh;
}

function snippet(file: string, variable: 'n' | 'NOW_COMMENTS') {
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  const re = variable === 'n'
    ? /^[ \t]*comment_pages=\$\(.*\\\n.*\|\| n=0$/mu
    : /^[ \t]*comment_pages=\$\(.*\\\n.*\\\n[ \t]*\|\| NOW_COMMENTS="\$\{BASE_COMMENTS:-0\}"$/mu;
  const match = text.match(re);
  expect(match, `${file}: riga del conteggio ${variable} non trovata`).not.toBeNull();
  return match![0];
}

function run(code: string, gh: string, env: Record<string, string> = {}) {
  const result = spawnSync('bash', ['-e', '-c', `${code}\nprintf '%s' "\${n:-\${NOW_COMMENTS:-}}"`], {
    encoding: 'utf8',
    env: { ...process.env, TRUSTED_GH_BIN: gh, REPO: 'o/r', PR_NUMBER: '9959', ...env },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe('conteggio commenti dei fixer (baseline e verifica di non-progress)', () => {
  for (const file of FIXERS) {
    it(`${path.basename(file)}: somma i commenti di tutte le pagine`, () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'fixer-comments-'));
      try {
        const gh = fakeGh(dir, JSON.stringify([Array(30).fill({}), Array(12).fill({})]));
        expect(run(snippet(file, 'n'), gh)).toBe('42');
        expect(run(snippet(file, 'NOW_COMMENTS'), gh, { BASE_COMMENTS: '41' })).toBe('42');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`${path.basename(file)}: se gh fallisce conserva i fallback`, () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'fixer-comments-'));
      try {
        const gh = fakeGh(dir, '[]', { fail: true });
        expect(run(snippet(file, 'n'), gh)).toBe('0');
        expect(run(snippet(file, 'NOW_COMMENTS'), gh, { BASE_COMMENTS: '7' })).toBe('7');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
