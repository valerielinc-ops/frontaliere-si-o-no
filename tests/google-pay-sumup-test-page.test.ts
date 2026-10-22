import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(__dirname, '..', 'public', 'google-pay-sumup-test.html'), 'utf8');

describe('Google Pay SumUp sandbox page', () => {
  it('is never indexable and therefore does not require content-page structured data', () => {
    expect(page).toMatch(/<meta\s+name=["']robots["']\s+content=["'][^"']*noindex[^"']*["']/i);
    expect(page).not.toMatch(/<meta\s+name=["']robots["']\s+content=["'][^"']*index\s*,\s*follow[^"']*["']/i);
  });
});
