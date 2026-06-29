/**
 * auto-merge-eval — codeContributionFingerprint: il fingerprint del contributo
 * della PR usato per il carry-forward dell'## LGTM. Reso CODE-only così un push
 * che tocca SOLO file dati/static (data/public/reports/_newsletter_variants/docs)
 * non cambia il fingerprint → l'approvazione regge senza ri-eseguire la review
 * (token-lever #1). Un file dati grosso senza `.patch` NON deve forzare il bail.
 */
import { describe, it, expect } from 'vitest';
import { codeContributionFingerprint, NON_REVIEWABLE_FINGERPRINT_RE, prContributionFingerprint } from '../scripts/ci/auto-merge-eval.mjs';

type F = { filename: string; status: string; patch?: string };

describe('codeContributionFingerprint (code-only carry-forward)', () => {
  const codeFile: F = { filename: 'scripts/foo.mjs', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' };
  const dataFile: F = { filename: 'data/jobs/by-crawler/x.json', status: 'modified', patch: '@@ -1 +1 @@\n-1\n+2' };

  it('un push data-only NON cambia il fingerprint code (carry-forward regge)', () => {
    const before = codeContributionFingerprint([codeFile]);
    const after = codeContributionFingerprint([codeFile, dataFile]);
    expect(after).toBe(before);
  });

  it('escludendo TUTTI i file non-code resta un fingerprint stabile (vuoto)', () => {
    const fp = codeContributionFingerprint([
      dataFile,
      { filename: 'public/img/a.webp', status: 'added' },
      { filename: 'docs/x.md', status: 'modified', patch: '@@\n+a' },
    ]);
    expect(fp).toBe(''); // nessun file code → stringa vuota, deterministica
  });

  it('un cambiamento CODE reale cambia il fingerprint', () => {
    const a = codeContributionFingerprint([codeFile]);
    const b = codeContributionFingerprint([{ ...codeFile, patch: '@@ -1 +1 @@\n-old\n+different' }]);
    expect(b).not.toBe(a);
  });

  it('un file CODE senza patch (binario/troppo grande) → bail null', () => {
    expect(codeContributionFingerprint([{ filename: 'build-plugins/x.ts', status: 'modified' }])).toBeNull();
  });

  it('un file DATI senza patch NON forza il bail (viene escluso prima)', () => {
    const fp = codeContributionFingerprint([codeFile, { filename: 'data/big.json', status: 'modified' }]);
    expect(fp).toBe(codeContributionFingerprint([codeFile])); // dati ignorato, non bail
  });

  it('NON_REVIEWABLE_FINGERPRINT_RE copre le directory non-code', () => {
    for (const p of ['data/x', 'public/y', 'reports/z', '_newsletter_variants/v', 'docs/d']) {
      expect(NON_REVIEWABLE_FINGERPRINT_RE.test(p)).toBe(true);
    }
    for (const p of ['scripts/x.mjs', 'build-plugins/y.ts', 'components/z.tsx']) {
      expect(NON_REVIEWABLE_FINGERPRINT_RE.test(p)).toBe(false);
    }
  });

  // Il re-review guard di pr-review-loop.yml (via scripts/ci/pr-contribution-
  // fingerprint.mjs) RIUSA questa funzione per decidere "contributo invariato →
  // skip Claude" con la STESSA semantica del carry-forward (no drift, AGENTS.md
  // #6). Se l'export sparisse, il CLI fallirebbe a runtime nel guard.
  it('prContributionFingerprint resta esportata (riuso dal re-review guard CLI)', () => {
    expect(typeof prContributionFingerprint).toBe('function');
  });
});
