/**
 * Regression coverage for follow-up issue #15111.
 *
 * A historical `--mask-timestamps` implementation replaced every ISO
 * date-time in every text file. That could make a changed semantic SEO/data
 * timestamp disappear from the compare-variants gate. The compatibility flag
 * is now constrained by an explicit build-clock allowlist, so non-allowlisted
 * timestamps must remain visible in the hash.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'dist-hash-manifest.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-hash-timestamp-safety-'));

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function manifest(name: string, files: Record<string, string>): Map<string, string> {
  const dist = path.join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dist, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  const out = path.join(tmp, `${name}.manifest.txt`);
  execFileSync('node', [SCRIPT, dist, out, '--mask-timestamps'], { cwd: ROOT, stdio: 'pipe' });
  const result = new Map<string, string>();
  for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
    if (!line) continue;
    const separator = line.indexOf('  ');
    result.set(line.slice(separator + 2), line.slice(0, separator));
  }
  return result;
}

describe('dist-hash-manifest timestamp safety (#15111)', () => {
  it('keeps non-allowlisted ISO date-times hash-sensitive', () => {
    const first = manifest('first', {
      'job/index.html': '<time datetime="2026-10-24T09:25:07.123Z">24 ottobre</time>',
      'sitemap.xml': '<lastmod>2026-10-24T09:25:07+02:00</lastmod>',
    });
    const second = manifest('second', {
      'job/index.html': '<time datetime="2026-10-24T11:44:07.987Z">24 ottobre</time>',
      'sitemap.xml': '<lastmod>2026-10-24T11:44:07+02:00</lastmod>',
    });

    expect(first.get('job/index.html')).not.toBe(second.get('job/index.html'));
    expect(first.get('sitemap.xml')).not.toBe(second.get('sitemap.xml'));
  });
});
