import { describe, expect, it } from 'vitest';

import {
  MIN_SCANNED_FILES,
  SECRET_PATTERNS,
  isScanned,
  redact,
  scanRepo,
  scanText,
} from '../scripts/ci/scan-site-hardcoded-secrets.mjs';

describe('hardcoded-secret source gate', () => {
  it('scans the tracked site source tree without findings', () => {
    const { findings, scanned } = scanRepo();
    expect(scanned).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
    expect(findings).toEqual([]);
  });

  it('recognizes every declared credential shape without storing samples', () => {
    const samples = [
      { id: 'google-api-key', value: `${'AIza'}${'Sy'}${'A'.repeat(33)}` },
      { id: 'google-oauth-secret', value: `${'GOCSPX'}-${'A'.repeat(24)}` },
      { id: 'github-token', value: `${'ghp'}_${'A'.repeat(36)}` },
      { id: 'github-pat-fine-grained', value: `${'github'}_${'pat'}_${'A'.repeat(60)}` },
      { id: 'anthropic-key', value: `${'sk'}-${'ant'}-${'A'.repeat(24)}` },
      { id: 'openai-key', value: `${'sk'}-${'A'.repeat(32)}` },
      { id: 'slack-token', value: `${'xoxb'}-${'A'.repeat(12)}` },
      { id: 'aws-access-key-id', value: `${'AKIA'}${'A'.repeat(16)}` },
      { id: 'private-key-block', value: `-----${'BEGIN'} RSA PRIVATE KEY-----` },
    ];

    for (const sample of samples) {
      expect(scanText(sample.value, 'sample').map((finding) => finding.patternId)).toContain(sample.id);
    }
    expect(samples).toHaveLength(SECRET_PATTERNS.length);
  });

  it('does not print a credential verbatim', () => {
    const sample = `${'AIza'}${'Sy'}${'Z'.repeat(33)}`;
    const [finding] = scanText(sample, 'sample');
    expect(finding.redacted).not.toContain(sample);
    expect(redact('short')).toBe('sho…');
  });

  it('excludes only generated/content-heavy trees', () => {
    expect(isScanned('services/firebase.ts')).toBe(true);
    expect(isScanned('build-plugins/constants.ts')).toBe(true);
    expect(isScanned('tests/fixtures/example.html')).toBe(true);
    expect(isScanned('public/favicon.svg')).toBe(false);
    expect(isScanned('data/border-wait-current.json')).toBe(false);
    expect(isScanned('packages/articles/content/it/example.json')).toBe(false);
  });
});
