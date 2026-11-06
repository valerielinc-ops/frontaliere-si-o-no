/**
 * validate-jobposting-schema.mjs overlaps its syscalls (bounded concurrency)
 * instead of walking and reading strictly in series. This pins that the
 * change is pure scheduling: same scanned-file count, same counters, same
 * verdict, and the failures listed in the SAME order the old sequential
 * depth-first walk produced — the reference walk below is that old walk.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../scripts/validate-jobposting-schema.mjs', import.meta.url));

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const daysAgoIso = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function posting(i: number): Record<string, unknown> {
  const p: Record<string, unknown> = {
    '@type': 'JobPosting',
    title: 'Ruolo ' + i,
    description: 'Descrizione abbastanza lunga da superare il minimo di cinquanta caratteri richiesto.',
    datePosted: daysAgoIso(3),
    employmentType: 'FULL_TIME',
    hiringOrganization: { name: 'Azienda ' + i },
    jobLocation: {
      address: {
        postalCode: '6900', streetAddress: 'Via ' + i, addressLocality: 'Lugano',
        addressRegion: 'TI', addressCountry: 'CH',
      },
    },
    baseSalary: { currency: 'CHF', value: { minValue: 70000, maxValue: 90000, unitText: 'YEAR' } },
  };
  if (i % 7 === 0) delete p.title;
  if (i % 11 === 0) (p.jobLocation as { address: Record<string, unknown> }).address.addressCountry = 'Svizzera';
  return p;
}

function html(i: number): string {
  if (i % 5 === 0) return '<html><body>no structured data</body></html>';
  const blocks = i % 9 === 0
    ? JSON.stringify({ '@graph': [posting(i), posting(i + 1)] })
    : JSON.stringify(posting(i));
  return `<html><head><script type="application/ld+json">${blocks}</script></head><body></body></html>`;
}

function makeDist(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobposting-scan-'));
  tmpDirs.push(tmp);
  const dist = path.join(tmp, 'dist');
  let i = 0;
  for (const section of ['cerca-lavoro-ticino', 'de/jobs-im-tessin', 'fr']) {
    for (let a = 0; a < 6; a++) {
      for (let b = 0; b < 40; b++) {
        const dir = path.join(dist, section, 'g' + a, 'job-' + b);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'index.html'), html(i++));
      }
    }
  }
  fs.writeFileSync(path.join(dist, 'index.html'), html(1));
  fs.writeFileSync(path.join(dist, 'sitemap.xml'), '<urlset/>');
  // A symlinked page is still a stat()-regular *.html file and is read.
  fs.symlinkSync(path.join(dist, 'fr', 'g0', 'job-1', 'index.html'), path.join(dist, 'linked.html'));
  return tmp;
}

/** The pre-change walk, verbatim in behaviour: readdirSync + statSync, DFS. */
function referenceOrder(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = path.join(dir, name);
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) referenceOrder(full, out);
    else if (st.isFile() && full.endsWith('.html')) out.push(full);
  }
  return out;
}

function run(tmp: string, concurrency: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', [SCRIPT], {
      cwd: tmp, encoding: 'utf8', stdio: 'pipe',
      env: { ...process.env, JOBPOSTING_SCAN_CONCURRENCY: concurrency },
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, out: e.stdout + e.stderr };
  }
}

describe('validate-jobposting-schema concurrent scan', () => {
  it('keeps count, verdict and failure order of the sequential walk', () => {
    const tmp = makeDist();
    const files = referenceOrder(path.join(tmp, 'dist'));
    const conc = run(tmp, '32');
    const serial = run(tmp, '1');

    expect(conc.code).toBe(1);
    expect(conc.out).toContain(`Scanned ${files.length} HTML files`);
    expect(conc.out).toBe(serial.out);

    // Failing files appear in the reference walk order.
    const listed = [...conc.out.matchAll(/^\s{2}(dist\/\S+)$/gm)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(20);
    const rank = new Map(files.map((f, k) => [path.relative(tmp, f), k]));
    const ranks = listed.map((f) => rank.get(f) ?? -1);
    expect(ranks.every((r) => r >= 0)).toBe(true);
    expect([...ranks].sort((x, y) => x - y)).toEqual(ranks);
  });

  it('passes a dist whose postings are complete', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobposting-scan-ok-'));
    tmpDirs.push(tmp);
    const dir = path.join(tmp, 'dist', 'a', 'b');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), html(1));
    const res = run(tmp, '32');
    expect(res.code).toBe(0);
    expect(res.out).toContain('Scanned 1 HTML files — 1 pages carry 1 JobPosting schemas.');
  });
});
