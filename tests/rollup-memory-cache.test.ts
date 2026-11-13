import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('production Rollup memory settings', () => {
  it('disables the unused incremental module cache for the one-shot SSG build', () => {
    const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

    expect(config).toMatch(/rollupOptions:\s*\{[\s\S]{0,500}?cache:\s*false/u);
  });

  it('keeps Rollup file-operation fan-out capped for the memory-bound build', () => {
    const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

    expect(config).toMatch(/rollupOptions:\s*\{[\s\S]{0,500}?maxParallelFileOps:\s*64/u);
  });
});
