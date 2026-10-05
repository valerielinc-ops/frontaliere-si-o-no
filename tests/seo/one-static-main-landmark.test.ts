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

  it('keeps annual report pages to the shell-provided main landmark', () => {
    const source = fs.readFileSync(path.join(root, 'build-plugins/annualReportPlugin.ts'), 'utf8');

    expect(source).not.toContain('<main class="s-xzWvwM">');
    expect(source).toContain('<div class="s-xzWvwM">');
  });

  it('keeps job landing pages on the shell-provided main landmark', () => {
    const jobs = fs.readFileSync(path.join(root, 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf8');
    const career = fs.readFileSync(path.join(root, 'build-plugins/careerLandingsPlugin.ts'), 'utf8');

    expect(jobs).not.toContain('<main class="s-LFxJYv">');
    expect(jobs).toContain('<div class="s-LFxJYv">');
    expect(career).not.toContain('<main class="s-xzWvwM cl-fun">');
    expect(career).toContain('<div class="s-xzWvwM cl-fun">');
  });
});
