import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('Node-side Vite config imports', () => {
  it('can import i18n without the browser-only glob transform', () => {
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--eval', "import('./services/i18n.ts').then(() => console.log('i18n-node-load-ok'))"],
      { cwd: resolve(__dirname, '..'), encoding: 'utf8' },
    );
    expect(output).toContain('i18n-node-load-ok');
  });
});
