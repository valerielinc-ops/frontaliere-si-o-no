/**
 * `dist-hash-manifest.mjs --mask-timestamps` — the bench's variant comparison
 * must ignore wall-clock instants and NOTHING else.
 *
 * Bench run 40080692388: 174,631 of 1,554,241 files differed between two
 * variants of one commit built 2 h 20 min apart, because emitters print
 * `now`-derived ISO date-times (e.g. the `validThrough` floor). The mask makes
 * those comparable; these tests pin that it does not also hide a real change.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'ci', 'dist-hash-manifest.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-mask-ts-'));

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function manifest(name: string, files: Record<string, string>, flags: string[]): Map<string, string> {
  const dist = path.join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
    fs.writeFileSync(path.join(dist, rel), body);
  }
  const out = path.join(tmp, `${name}-${flags.join('_') || 'raw'}.txt`);
  execFileSync('node', [SCRIPT, dist, out, ...flags], { stdio: 'pipe' });
  const m = new Map<string, string>();
  for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf('  ');
    m.set(line.slice(sp + 2), line.slice(0, sp));
  }
  return m;
}

const page = (validThrough: string, posted: string, title = 'Elettricista') =>
  `<html><script type="application/ld+json">{"title":"${title}","datePosted":"${posted}","validThrough":"${validThrough}"}</script></html>`;

describe('dist-hash-manifest --mask-timestamps', () => {
  const a = {
    'job/index.html': page('2026-11-23T08:10:28.123Z', '2026-10-01'),
    'sitemap.xml': '<lastmod>2026-10-24T09:25:07+02:00</lastmod>',
  };
  const b = {
    'job/index.html': page('2026-11-23T10:31:02.987Z', '2026-10-01'),
    'sitemap.xml': '<lastmod>2026-10-24T11:44:07+02:00</lastmod>',
  };

  it('a raw manifest sees the wall-clock difference', () => {
    const ra = manifest('a', a, []);
    const rb = manifest('b', b, []);
    expect(ra.get('job/index.html')).not.toBe(rb.get('job/index.html'));
  });

  it('masked manifests of two builds that differ only in date-times are identical', () => {
    const ma = manifest('a', a, ['--mask-timestamps']);
    const mb = manifest('b', b, ['--mask-timestamps']);
    expect([...ma.entries()]).toEqual([...mb.entries()]);
  });

  it('still sees a calendar-date change and a content change', () => {
    const base = manifest('c0', { 'job/index.html': page('2026-11-23T08:10:28.123Z', '2026-10-01') }, ['--mask-timestamps']);
    const date = manifest('c1', { 'job/index.html': page('2026-11-23T08:10:28.123Z', '2026-10-02') }, ['--mask-timestamps']);
    const text = manifest('c2', { 'job/index.html': page('2026-11-23T08:10:28.123Z', '2026-10-01', 'Idraulico') }, ['--mask-timestamps']);
    expect(date.get('job/index.html')).not.toBe(base.get('job/index.html'));
    expect(text.get('job/index.html')).not.toBe(base.get('job/index.html'));
  });
});
