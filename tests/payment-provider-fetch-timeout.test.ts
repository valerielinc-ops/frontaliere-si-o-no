import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

describe('payment provider upstream requests', () => {
  it('bounds SumUp request bodies and Stripe publisher dispatch', () => {
    const sumup = readFileSync(resolve(ROOT, 'functions/src/sumupAssistedApplicationCore.js'), 'utf8');
    const stripe = readFileSync(resolve(ROOT, 'functions/src/stripePublisherCore.js'), 'utf8');

    expect(sumup).toContain('export const SUMUP_API_REQUEST_TIMEOUT_MS = 30_000;');
    expect(sumup).toContain('signal: AbortSignal.timeout(SUMUP_API_REQUEST_TIMEOUT_MS)');
    expect(stripe).toContain('const PUBLISHER_SYNC_DISPATCH_TIMEOUT_MS = 20_000;');
    expect(stripe).toContain('signal: AbortSignal.timeout(PUBLISHER_SYNC_DISPATCH_TIMEOUT_MS)');
  });
});
