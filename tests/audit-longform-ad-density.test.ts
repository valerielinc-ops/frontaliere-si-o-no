import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { articleBodyCounts } from '../scripts/audit-longform-ad-density.mjs';
import { collectArticleBodySegments, countArticleBodyChars, countArticleBodyWords } from '../services/articleBodySegments';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/audit-longform-ad-density.mjs');

const words = (count: number) => Array.from({ length: count }, (_, index) => `parola${index}`).join(' ');
const segment = (start: number, count: number) => [
  words(250),
  ...Array.from({ length: count }, (_, index) => `## Sezione ${start + index}\n\n${words(250)}`),
].join('\n\n');
const escapeTsString = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');

describe('audit-longform-ad-density.mjs', () => {
  it('invoca il comando sul fixture e produce l istogramma 0/1/2/3+', () => {
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'longform-ad-density-'));
    const bodyDir = path.join(fixtureRoot, 'it');
    mkdirSync(bodyDir);
    const bodies = [segment(1, 3), segment(4, 2), segment(6, 2)];
    const source = [
      'export default {',
      ...bodies.map((body, index) => `  'blog.article.fixture-longform.body${index + 1}': '${escapeTsString(body)}',`),
      '};',
    ].join('\n');
    writeFileSync(path.join(bodyDir, 'fixture-longform.ts'), source);

    try {
      const output = execFileSync('node', ['--import', 'tsx', SCRIPT, '--body-dir', bodyDir], { cwd: ROOT, encoding: 'utf8' });
      expect(output).toContain('longform articles: 1');
      expect(output).toContain('ads per longform: 0=0, 1=0, 2=0, 3+=1');
      expect(output).toMatch(/distinct inline slots observed: [1-3]\/5/);
      expect(output).toMatch(/## boundaries emitted=\d+, deferred=\d+, neither=\d+/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('non promuove a longform gli heading presenti solo in un fence', () => {
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'longform-ad-density-fence-'));
    const bodyDir = path.join(fixtureRoot, 'it');
    mkdirSync(bodyDir);
    const fence = String.fromCharCode(96).repeat(3);
    const body = [
      segment(1, 6),
      [fence + 'md', '## Sezione nel fence', '## Un altra sezione nel fence', fence].join('\n'),
    ].join('\n\n');
    const source = [
      'export default {',
      `  'blog.article.fixture-fenced.body1': '${escapeTsString(body)}',`,
      '};',
    ].join('\n');
    writeFileSync(path.join(bodyDir, 'fixture-fenced.ts'), source);

    try {
      const output = execFileSync('node', ['--import', 'tsx', SCRIPT, '--body-dir', bodyDir], { cwd: ROOT, encoding: 'utf8' });
      expect(output).toContain('longform articles: 0');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('confronta observer e renderer sugli stessi segmenti, incluso body4', () => {
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'longform-ad-density-segments-'));
    const bodyDir = path.join(fixtureRoot, 'it');
    mkdirSync(bodyDir);
    const id = 'fixture-four-segments';
    const bodies = [words(4), '## Uno\n\n' + words(5), words(6), '## Quattro\n\n' + words(7)];
    const source = [
      'export default {',
      ...bodies.map((body, index) => `  'blog.article.${id}.body${index + 1}': '${escapeTsString(body)}',`),
      '};',
    ].join('\n');
    const filePath = path.join(bodyDir, `${id}.ts`);
    writeFileSync(filePath, source);

    try {
      const observer = articleBodyCounts(filePath, id);
      const renderer = collectArticleBodySegments(id, (key) => {
        const match = key.match(/\.body(\d+)$/);
        return match ? bodies[Number(match[1]) - 1] ?? key : key;
      });

      expect(observer.segments).toEqual(renderer);
      expect(observer.segments).toHaveLength(4);
      expect(observer.wordCount).toBe(countArticleBodyWords(renderer));
      expect(observer.charCount).toBe(countArticleBodyChars(renderer));
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
