import { describe, expect, it } from 'vitest';
import { parseMimeMessage } from '../functions/src/lib/mimeMessage.js';
import {
  buildAssertions,
  buildSendPayload,
  buildTestCases,
  resolveTestingApiKey,
  validateAssertionsReport,
  validateContentAnalysis,
} from '../scripts/ci/maileroo-email-testing.mjs';

describe('Maileroo Email Testing CI fixtures', () => {
  const cases = buildTestCases({ recipient: 'frontaliere-ci@example.invalid', runId: 'unit-test' });

  it('renders the production transactional, newsletter and application-reminder builders', () => {
    expect(cases.map((testCase) => testCase.name)).toEqual(['transactional-confirmation', 'newsletter-weekly', 'application-intent-reminder', 'welcome', 'assisted-application-retry']);
    for (const testCase of cases) {
      expect(testCase.html).toContain('frontaliereticino.ch');
      expect(testCase.text).not.toMatch(/<\/?[a-z][^>]*>/i);
      expect(testCase.headers['X-Frontaliere-CI-Run']).toContain('unit-test');
    }
  });

  it('renders visible previews without invisible filler or zero-sized fonts', () => {
    for (const testCase of cases) {
      expect(testCase.subject).toContain(testCase.subjectContains);
      expect(testCase.html).not.toMatch(/display\s*:\s*none|font-size\s*:\s*0(?:px)?[;"']|[\u200b\u200c\u034f]|&#(?:8203|847);|&zwnj;/i);
      // Some email clients and antispam parsers cannot render gradients. Keep
      // the explicit base color so text never falls back onto a white canvas.
      for (const [style] of testCase.html.matchAll(/style="[^"]*background-image:linear-gradient[^\"]*"/g)) {
        expect(style).toMatch(/background:\s*#[0-9a-f]{3,6};/i);
      }
    }
    expect(cases[3].html).toContain('class="email-preview"');
    expect(cases[4].html).toContain('class="email-preview"');
  });

  it('fails the live check when either HTML antispam heuristic regresses', () => {
    for (const symbol of ['ZERO_FONT', 'MANY_INVISIBLE_PARTS']) {
      expect(() => validateContentAnalysis({ rspamd: { status: 'ok', symbols: [symbol] } }, 'fixture')).toThrow(symbol);
    }
    expect(() => validateContentAnalysis({}, 'fixture')).toThrow('unavailable');
    // MIME wrapping belongs to the provider, not the HTML renderer.
    expect(() => validateContentAnalysis({ rspamd: { status: 'ok', symbols: ['CTYPE_MIXED_BOGUS'] } }, 'fixture')).not.toThrow();
  });

  it('routes each fixture to its stream Application without embedding credentials', () => {
    expect(buildSendPayload(cases[0])).toMatchObject({ from: { address: 'confirmation@frontaliereticino.ch' }, to: [{ address: 'frontaliere-ci@example.invalid' }], tracking: false });
    expect(buildSendPayload(cases[1])).toMatchObject({ from: { address: 'newsletter@frontaliereticino.ch' }, to: [{ address: 'frontaliere-ci@example.invalid' }], tracking: false });
    expect(buildSendPayload(cases[2])).toMatchObject({ from: { address: 'alerts@frontaliereticino.ch' }, to: [{ address: 'frontaliere-ci@example.invalid' }], tracking: false });
    expect(JSON.stringify(buildSendPayload(cases[0]))).not.toContain('API_KEY');
  });

  it('prefers a dedicated testing key and accepts the scoped account key from RC', () => {
    expect(resolveTestingApiKey({ MAILEROO_EMAIL_TESTING_API_KEY: 'dedicated', MAILEROO_ACCOUNT_API_KEY: 'account' })).toBe('dedicated');
    expect(resolveTestingApiKey({ MAILEROO_ACCOUNT_API_KEY: 'account' })).toBe('account');
    expect(() => resolveTestingApiKey({})).toThrow('MAILEROO_EMAIL_TESTING_API_KEY or MAILEROO_ACCOUNT_API_KEY');
  });

  it('covers authentication, reputation, rendering and newsletter opt-out checks', () => {
    const transactional = buildAssertions(cases[0]).map((item) => item.type);
    const newsletter = buildAssertions(cases[1]).map((item) => item.type);
    const applicationIntent = buildAssertions(cases[2]).map((item) => item.type);
    expect(transactional).toEqual(expect.arrayContaining(['spf_eq', 'dkim_eq', 'dmarc_eq', 'auth_aligned_eq', 'rspamd_score_lte', 'links_rbl_clean', 'ip_rbl_clean', 'gmail_clip_eq', 'accessibility_score_gte']));
    expect(newsletter).toContain('unsubscribe_valid_eq');
    expect(applicationIntent).toContain('unsubscribe_valid_eq');
  });

  it('keeps the application reminder unsubscribe label separate from its URL', () => {
    const applicationIntent = cases[2];
    expect(applicationIntent.html).toMatch(/<a href="https:\/\/frontaliereticino\.ch\/disiscrivi-promemoria-candidature\/[^"]*"[^>]*>Disiscriviti da questi promemoria<\/a>/);
    expect(applicationIntent.html).not.toMatch(/>https:\/\/frontaliereticino\.ch\/disiscrivi-promemoria-candidature\/[^<]*<\/a>/);
  });

  it('rejects a positive but incomplete Maileroo assertion report', () => {
    expect(() => validateAssertionsReport({ pass: true }, buildAssertions(cases[0]), cases[0].name))
      .toThrow('Maileroo returned no assertion results');

    const partial = buildAssertions(cases[0]).slice(0, -1).map(({ type }) => ({ type, pass: true }));
    expect(() => validateAssertionsReport({ pass: true, results: partial }, buildAssertions(cases[0]), cases[0].name))
      .toThrow('expected 12 assertion results, received 11');
  });

  it('accepts only a complete report whose passing results match the request', () => {
    const expected = buildAssertions(cases[1]);
    const report = { pass: true, results: expected.map(({ type }) => ({ type, pass: true })) };
    expect(validateAssertionsReport(report, expected, cases[1].name)).toBe(report);
  });

  it('keeps the plain-text alternative aligned with the captured HTML payload', () => {
    const testCase = cases[1];
    const payload = buildSendPayload(testCase);
    const boundary = 'frontaliere-unit-boundary';
    const raw = [
      `From: ${testCase.from.display_name} <${testCase.from.address}>`,
      `To: ${testCase.recipient}`,
      `Subject: ${testCase.subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      payload.plain,
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      payload.html,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const parsed = parseMimeMessage(raw);
    expect(parsed.from).toContain(testCase.from.address);
    expect(parsed.subject).toBe(testCase.subject);
    expect(parsed.text).toContain('Parliamoci chiaro.');
  });
});
