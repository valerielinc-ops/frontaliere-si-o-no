import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Un monitor apre la sua issue di degrado da uno step `run:` sotto
 * `set -euo pipefail`. Lì un'estrazione `jq` che pipe un campo GREZZO dentro
 * `join`/`map`/`to_entries` muore se quel campo è assente o `null` — e con lo
 * step morto l'issue NON viene aperta: il degrado passa muto (#7379, item 2).
 *
 * Il contratto è quindi: in uno step che apre issue, ogni campo del report che
 * finisce in un operatore di collezione deve avere un default (`// []`, `// {}`,
 * `// 0`, `// "?"`). Un campo mancante può impoverire il CORPO dell'issue, mai
 * sopprimerne l'apertura.
 */

const WORKFLOWS_DIR = join(process.cwd(), '.github/workflows');

// `.campo | join(`, `.campo["x"] | map(`, `.campo.sub | to_entries` — dove il
// campo NON è già protetto da un `// default` racchiuso fra parentesi.
const RAW_FIELD_INTO_COLLECTION_OP =
  /(^|[^)\w])\.[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*|\[["'][^"']+["']\])*(\[\])?\s*\|\s*(?:join|map|to_entries|sort_by|add|group_by)\b/;

function issueOpeningSteps(text: string): string[] {
  return text
    .split(/^ {4,6}- name: /m)
    .filter((step) => step.includes('github-issue-creator.mjs') && step.includes('jq'));
}

function jqExpressions(step: string): string[] {
  // Intero blocco `run:` dello step, non le sole stringhe quotate: un
  // `'"'"'` bash (o un apice escaped) tronca `[\s\S]*?` al primo closer e
  // nasconde il `| map(...) | join` che segue (glossario-definitions-monitor,
  // persist-job-stats).
  return [step];
}

describe('monitor: le estrazioni jq che alimentano una issue non muoiono su campo assente', () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml'));

  it('trova almeno un monitor che apre issue con jq (il test non è vuoto per costruzione)', () => {
    const withSteps = files.filter((f) =>
      issueOpeningSteps(readFileSync(join(WORKFLOWS_DIR, f), 'utf8')).length > 0,
    );
    expect(withSteps.length).toBeGreaterThan(0);
  });

  it('lo scan vede il map/join dopo un apice bash escaped (non tronca al primo closer)', () => {
    const text = readFileSync(join(WORKFLOWS_DIR, 'glossario-definitions-monitor.yml'), 'utf8');
    const steps = issueOpeningSteps(text);
    expect(steps.join('\n')).toContain('map("- " + .url) | join("\\n")');
    expect(steps.join('\n')).toContain('(.flagged | type) == "array"');
  });

  it('nessun campo grezzo entra in join/map/to_entries in uno step che apre issue', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
      for (const step of issueOpeningSteps(text)) {
        for (const expr of jqExpressions(step)) {
          if (RAW_FIELD_INTO_COLLECTION_OP.test(expr)) offenders.push(`${file}: ${expr.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
