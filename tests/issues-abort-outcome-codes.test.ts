/**
 * ISSUES.md > «Abort senza PR» parla solo il vocabolario FIX_OUTCOME di
 * issue-fix.yml.
 *
 * #10153 (proposta del lessons-harvester) aveva prescritto `no-pr-no-root-cause`,
 * che nessun workflow riconosce: `followup-drainer.mjs` non lo trova in
 * `NON_RETRYABLE` e ri-accoda la issue invece di parcheggiarla. La prosa e il
 * codice non si parlavano; questo test li confronta.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NON_RETRYABLE } from '../scripts/ci/followup-drainer.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const issuesMd = readFileSync(join(ROOT, 'ISSUES.md'), 'utf8');
const issueFix = readFileSync(join(ROOT, '.github/workflows/issue-fix.yml'), 'utf8');

function abortSection(): string {
  const start = issuesMd.indexOf('### Abort senza PR');
  expect(start, 'sezione «Abort senza PR» sparita da ISSUES.md').toBeGreaterThan(-1);
  const end = issuesMd.indexOf('\n#', start + 5);
  return issuesMd.slice(start, end === -1 ? undefined : end);
}

function issueFixCodes(): string[] {
  const m = /`<code>` ∈ ([^\n]*?)\. /u.exec(issueFix);
  expect(m, 'issue-fix.yml non dichiara piu\' `<code>` ∈ ...').not.toBeNull();
  return [...m![1].matchAll(/`([a-z0-9-]+)`/gu)].map((x) => x[1]);
}

// Nomi che la sezione cita legittimamente e che NON sono esiti: la label che
// accompagna `no-root-cause` e la famiglia `blocked-*`.
const NOT_OUTCOMES = new Set(['automation-deferred', 'blocked-*']);

describe('ISSUES.md «Abort senza PR» ↔ issue-fix.yml', () => {
  it('ogni codice citato nella sezione esiste in issue-fix.yml', () => {
    const allowed = new Set(issueFixCodes());
    const cited = [...abortSection().matchAll(/`([a-z0-9]+(?:-[a-z0-9*]+)+)`/gu)]
      .map((m) => m[1])
      .filter((c) => !NOT_OUTCOMES.has(c));
    const markers = [...abortSection().matchAll(/FIX_OUTCOME:\s*([a-z0-9-]+)/gu)].map((m) => m[1]);
    const unknown = [...new Set([...cited, ...markers])].filter((c) => !allowed.has(c));
    expect(unknown).toEqual([]);
  });

  it('elenca l\'intero vocabolario, non un sottoinsieme', () => {
    const section = abortSection();
    for (const code of issueFixCodes()) expect(section).toContain(`\`${code}\``);
  });

  it('causa non determinabile = no-root-cause + AUTOMATION_DEFERRED, senza domande al proprietario', () => {
    const section = abortSection();
    expect(section).toContain('<!-- FIX_OUTCOME: no-root-cause -->');
    expect(section).toContain('<!-- AUTOMATION_DEFERRED: technical -->');
    expect(section).not.toMatch(/indagine umana|no-pr-no-root-cause/u);
  });

  it('i verdetti fermi della sezione vengono parcheggiati dal drainer, non ri-accodati', () => {
    for (const code of ['no-root-cause', 'already-fixed', 'blocked-workflows-scope', 'blocked-admin-settings']) {
      expect(NON_RETRYABLE.has(code), code).toBe(true);
    }
    expect(NON_RETRYABLE.has('no-pr-no-root-cause')).toBe(false);
  });
});
