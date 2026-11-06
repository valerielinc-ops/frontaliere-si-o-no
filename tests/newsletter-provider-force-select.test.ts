import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guardrail for #3135 item 1 (follow-up of #3132): the manual
 * `workflow_dispatch` `provider` choice in send-newsletter.yml let an
 * operator force ALL sends through a single provider, bypassing the
 * cascade's quota/rotation. `maileroo` was removed from that forceable set
 * because, at the time, its DKIM/DNS wasn't verified (tracked in #3066).
 *
 * Maileroo's participation as an AUTOMATIC cascade rotation tier (see
 * PROVIDERS in functions/src/emailCascade.js) is a separate mechanism that
 * was re-enabled and DKIM/DMARC-verified in #3154 — this test asserts that
 * role stays intact while the manual force-select path stays closed.
 */

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_SRC = readFileSync(resolve(ROOT, '.github/workflows/send-newsletter.yml'), 'utf-8');
const SEND_NEWSLETTER_SRC = readFileSync(resolve(ROOT, 'scripts/send-newsletter.mjs'), 'utf-8');
// Canonical cascade impl lives in functions/src/emailCascade.js (relocated
// 2026-07-16 so no-bundler Cloud Functions can import it directly);
// scripts/lib/email-cascade.mjs is now just a re-export shim with no source
// text of its own to match against.
const EMAIL_CASCADE_SRC = readFileSync(resolve(ROOT, 'functions/src/emailCascade.js'), 'utf-8');

/** Extracts the YAML list items under a `provider:` -> `options:` block. */
function extractProviderOptions(yaml: string): string[] {
  const block = yaml.match(/provider:\n(?:.*\n)*?\s+options:\n((?:\s+- .+\n?)+)/);
  if (!block) throw new Error('could not locate `provider:` options block in send-newsletter.yml');
  return block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
}

describe('send-newsletter.yml — provider manual-dispatch choice (#3135 item 1)', () => {
  const options = extractProviderOptions(WORKFLOW_SRC);

  it('does not expose maileroo as a forceable single-provider choice', () => {
    expect(options).not.toContain('maileroo');
  });

  it('still exposes the other legitimate forceable providers', () => {
    expect(options).toEqual(expect.arrayContaining(['cascade', 'mailgun', 'mailjet', 'mailtrap', 'resend', 'cloudflare']));
  });
});

describe('scripts/send-newsletter.mjs — SINGLE_PROVIDERS force-select allowlist', () => {
  it('does not include maileroo in SINGLE_PROVIDERS', () => {
    const match = SEND_NEWSLETTER_SRC.match(/const SINGLE_PROVIDERS = \[([^\]]+)\];/);
    expect(match, 'SINGLE_PROVIDERS array literal not found').not.toBeNull();
    const providers = match![1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    expect(providers).not.toContain('maileroo');
    expect(providers).toEqual(expect.arrayContaining(['mailgun', 'mailjet', 'mailtrap', 'cloudflare', 'resend']));
  });
});

describe('scripts/lib/email-cascade.mjs — automatic cascade role left untouched', () => {
  it('still registers maileroo as an automatic cascade rotation tier', () => {
    expect(EMAIL_CASCADE_SRC).toMatch(/\{\s*id:\s*'maileroo'/);
  });

  it('still exports the sendViaMaileroo sender used by the cascade', () => {
    expect(EMAIL_CASCADE_SRC).toMatch(/async function sendViaMaileroo\(/);
    expect(EMAIL_CASCADE_SRC).toMatch(/maileroo:\s*sendViaMaileroo/);
  });
});
