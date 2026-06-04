/**
 * jina-proxy — regression test per il rilevamento "200-but-not-target" della
 * proxy egress Jina (scripts/lib/jina-proxy.mjs, #1422 item 1).
 *
 * Jina risponde 200 anche quando NON ha raggiunto il target (pagina di
 * challenge/error, body vuoto): `res.ok` è true e il parser riceve una
 * non-job-page → 0 link/ruoli → skip silenzioso indistinguibile da "sorgente
 * vuota". `detectJinaErrorBody` deve segnalare il body sospetto (per un warning
 * esplicito) senza falsi positivi su una pagina target reale.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — modulo .mjs senza tipi
import { detectJinaErrorBody } from '../scripts/lib/jina-proxy.mjs';

describe('detectJinaErrorBody', () => {
  it('flags an empty / whitespace-only body', () => {
    expect(detectJinaErrorBody('')).toBe('empty body');
    expect(detectJinaErrorBody('   \n\t  ')).toBe('empty body');
    expect(detectJinaErrorBody(null)).toBe('empty body');
    expect(detectJinaErrorBody(undefined)).toBe('empty body');
  });

  it('flags a suspiciously short body', () => {
    const reason = detectJinaErrorBody('<html><body>nope</body></html>');
    expect(reason).toMatch(/body too short/);
  });

  it('flags a Jina failure-to-fetch envelope', () => {
    const body = `<html><body>Failed to fetch the target URL after 3 attempts. ${'x'.repeat(300)}</body></html>`;
    expect(detectJinaErrorBody(body)).toMatch(/error\/challenge marker/);
  });

  it('flags a WAF/anti-bot challenge page served on a 200', () => {
    const body = `<!doctype html><title>Just a moment...</title><body>Checking your browser before accessing the site. ${'x'.repeat(300)}</body>`;
    expect(detectJinaErrorBody(body)).toMatch(/error\/challenge marker/);
  });

  it('returns null for a genuine target page', () => {
    const realPage = `<!doctype html><html><head><title>Opportunities</title></head><body>` +
      `<h2 class="wp-block-heading">Frontend Developer</h2>` +
      `<p>We are hiring a frontend developer to join our team in Lugano. ${'job description '.repeat(40)}</p>` +
      `</body></html>`;
    expect(detectJinaErrorBody(realPage)).toBeNull();
  });

  it('respects a custom minLength floor', () => {
    const body = `<html><body>${'x'.repeat(120)}</body></html>`;
    expect(detectJinaErrorBody(body, { minLength: 100 })).toBeNull();
    expect(detectJinaErrorBody(body, { minLength: 500 })).toMatch(/body too short/);
  });
});
