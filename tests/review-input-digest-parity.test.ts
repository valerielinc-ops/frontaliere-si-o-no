import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  reviewInputRevisionFromBody,
  reviewInputSerialization,
} from '../scripts/ci/lib/review-input-revision.mjs';

/**
 * Il digest della body revision esiste in DUE posti: il modulo condiviso e una
 * copia inline dentro `retry-code-check-after-body-edit.yml`, che gira in
 * `actions/github-script` senza il repo a disposizione e quindi non può
 * importare il modulo. #9328 ha corretto la formula del modulo — hasha la
 * rappresentazione con cui i marker sono emessi, `body` più l'a capo che
 * `gh api --jq` scrive — e ha lasciato indietro la copia inline. Risultato: il
 * recovery non riconosceva più i propri marker, con tre test rossi su main che
 * la selezione a diff non ha mostrato finché una PR non ha toccato quei file.
 *
 * Questo test non confronta due sorgenti a occhio: ESEGUE la funzione inline
 * estratta dal workflow e ne confronta l'output con quello del modulo.
 */
const recovery = YAML.parse(
  readFileSync(new URL('../.github/workflows/retry-code-check-after-body-edit.yml', import.meta.url), 'utf8'),
);
const script = String(recovery.jobs.recover.steps[0].with.script);

function inlineDigestFn(): (body: string) => string {
  const start = script.indexOf('body:${crypto.createHash');
  expect(start, 'la copia inline del digest è sparita dal workflow').toBeGreaterThan(-1);
  const lineStart = script.lastIndexOf('\n', start) + 1;
  const lineEnd = script.indexOf('\n', start);
  const line = script.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
  // eslint-disable-next-line no-new-func
  return new Function('crypto', 'body', line) as (crypto: unknown, body: string) => string extends never
    ? never
    : never as unknown as (body: string) => string;
}

describe('parità del digest della body revision fra modulo e copia inline', () => {
  const crypto = require('node:crypto');
  const inline = inlineDigestFn() as unknown as (c: unknown, body: string) => string;

  const bodies = [
    '## Implementato\n- una cosa\n\n## Non implementato (ancora)\n- Nessuno\n',
    '',
    'corpo su una riga sola',
    'con un a capo finale già presente\n',
    'con caratteri non ASCII: àèìòù — 🔴',
  ];

  it.each(bodies)('produce lo stesso digest per %j', (body) => {
    expect(inline(crypto, body)).toBe(reviewInputRevisionFromBody(body));
  });

  it('la rappresentazione hashata è il body più l’a capo di `gh api --jq`', () => {
    expect(reviewInputSerialization('x')).toBe('x\n');
    const expected = `body:${crypto.createHash('sha256').update('x\n', 'utf8').digest('hex')}`;
    expect(reviewInputRevisionFromBody('x')).toBe(expected);
    expect(inline(crypto, 'x')).toBe(expected);
  });

  it('un body diverso dà un digest diverso in entrambe le copie', () => {
    expect(inline(crypto, 'a')).not.toBe(inline(crypto, 'b'));
    expect(reviewInputRevisionFromBody('a')).not.toBe(reviewInputRevisionFromBody('b'));
  });
});
