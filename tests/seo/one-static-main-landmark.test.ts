import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');

describe('static SEO page landmarks', () => {
  it('keeps the comparison and border-wait pages to one main landmark', () => {
    const sources = [
      'build-plugins/comparisonsHubPlugin.ts',
      'build-plugins/borderWaitMapPlugin.ts',
    ].map((relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8'));

    for (const source of sources) {
      expect(source).not.toContain('<main class="s-EDtWsL">');
      expect(source).toContain('<div class="s-EDtWsL">');
    }
  });
});
