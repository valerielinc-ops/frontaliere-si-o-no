import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const DIST_DIR = path.resolve(__dirname, '..', '..', 'dist');

/**
 * Recursively gather all index.html files under a directory.
 */
function collectHtmlFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          results.push(...collectHtmlFiles(full));
        } else if (entry.name === 'index.html') {
          results.push(full);
        }
      } catch { /* skip entries with path issues (e.g. names too long for the filesystem) */ }
    }
  } catch { /* skip directories that can't be read */ }
  return results;
}

/**
 * Extract all JSON-LD blocks from an HTML file and return parsed objects.
 */
function extractJsonLd(html: string): any[] {
  const blocks: any[] = [];
  const regex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(match[1]));
    } catch { /* skip malformed */ }
  }
  return blocks;
}

// Job section directories across all locales
const JOB_SECTION_DIRS = [
  'cerca-lavoro-ticino',
  'en/find-jobs-ticino',
  'de/jobs-im-tessin',
  'fr/trouver-emploi-tessin',
];

// Pre-load all HTML files and their JSON-LD blocks ONCE to avoid repeated I/O
interface PageData {
  rel: string;
  html: string;
  ldBlocks: any[];
  jobPostings: any[];
  isArchive: boolean;
}

const jobDirs = JOB_SECTION_DIRS.map((d) => path.join(DIST_DIR, d));
const allPages: PageData[] = [];
for (const dir of jobDirs) {
  for (const file of collectHtmlFiles(dir)) {
    const rel = path.relative(DIST_DIR, file);
    const html = readFileSync(file, 'utf-8');
    const ldBlocks = extractJsonLd(html);
    const jobPostings = ldBlocks.filter((ld) => ld['@type'] === 'JobPosting');
    const isArchive = /non[\s\S]{0,5}(più|more)\s+(disponibile|available|verfügbar|disponible)/i.test(html)
      || /nicht mehr verfügbar/i.test(html)
      || /Pagina archiviata/i.test(html)
      || /plus disponible/i.test(html);
    allPages.push({ rel, html, ldBlocks, jobPostings, isArchive });
  }
}

describe('JobPosting description guard', () => {
  it('should find job pages in dist', () => {
    expect(allPages.length).toBeGreaterThan(100);
  });

  it('every JobPosting schema must have a non-empty description', () => {
    const failures: string[] = [];
    for (const { rel, jobPostings } of allPages) {
      for (const jp of jobPostings) {
        const desc = String(jp.description || '');
        if (desc.length === 0) {
          failures.push(`${rel}: description is empty`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('active IT JobPosting descriptions must be at least 50 characters', () => {
    const tooShort: string[] = [];
    for (const { rel, jobPostings } of allPages) {
      if (rel.startsWith('en/') || rel.startsWith('de/') || rel.startsWith('fr/')) continue;
      for (const jp of jobPostings) {
        if (jp.validThrough && new Date(jp.validThrough) < new Date()) continue;
        const desc = String(jp.description || '');
        if (desc.length > 0 && desc.length < 50) {
          tooShort.push(`${rel}: description only ${desc.length} chars`);
        }
      }
    }
    expect(tooShort).toEqual([]);
  });

  it('archive/bridge pages must NOT contain active JobPosting schema (IT only)', () => {
    const archiveWithJobPosting: string[] = [];
    for (const { rel, isArchive, jobPostings } of allPages) {
      if (!isArchive) continue;
      if (rel.startsWith('en/') || rel.startsWith('de/') || rel.startsWith('fr/')) continue;
      const activeJPs = jobPostings.filter(jp => !jp.validThrough || new Date(jp.validThrough) > new Date());
      if (activeJPs.length > 0) archiveWithJobPosting.push(rel);
    }
    expect(archiveWithJobPosting).toEqual([]);
  });

  it('active IT JobPosting descriptions should use HTML format (>=50%)', () => {
    let htmlFormatCount = 0;
    let totalJobPostings = 0;
    for (const { rel, jobPostings } of allPages) {
      if (rel.startsWith('en/') || rel.startsWith('de/') || rel.startsWith('fr/')) continue;
      for (const jp of jobPostings) {
        totalJobPostings++;
        const desc = String(jp.description || '');
        if (/<(p|ul|li|h[1-6]|br|strong|em)\b/i.test(desc)) {
          htmlFormatCount++;
        }
      }
    }
    if (totalJobPostings === 0) return;
    const ratio = htmlFormatCount / totalJobPostings;
    expect(ratio).toBeGreaterThanOrEqual(0.5);
  });
});

describe('JobPosting streetAddress guard', () => {
  const STREET_KEYWORDS = /\b(via|piazza|piazzale|piazzetta|viale|strada|corso|vicolo|salita|sentiero|contrada|largo|riva|lungolago|rue|route|chemin|strasse|weg|gasse)\b/i;

  it('streetAddress must be a real street or omitted — never a city/region name', () => {
    const failures: string[] = [];
    for (const { rel, jobPostings } of allPages) {
      for (const jp of jobPostings) {
        const sa = jp.jobLocation?.address?.streetAddress;
        if (sa === undefined || sa === null) continue;
        const hasStreetKeyword = STREET_KEYWORDS.test(sa);
        const hasDigit = /\d/.test(sa);
        if (!hasStreetKeyword && !hasDigit) {
          failures.push(`${rel}: streetAddress="${sa}" is not a valid street`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('streetAddress must not be a pure year or number', () => {
    const failures: string[] = [];
    for (const { rel, jobPostings } of allPages) {
      for (const jp of jobPostings) {
        const sa = jp.jobLocation?.address?.streetAddress;
        if (!sa) continue;
        if (/^\d{4}$/.test(sa)) {
          failures.push(`${rel}: streetAddress="${sa}" looks like a year`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('>=50% of active IT job pages should have a streetAddress', () => {
    let total = 0;
    let withStreet = 0;
    for (const { rel, jobPostings } of allPages) {
      if (rel.startsWith('en/') || rel.startsWith('de/') || rel.startsWith('fr/')) continue;
      for (const jp of jobPostings) {
        if (jp.validThrough && new Date(jp.validThrough) < new Date()) continue;
        total++;
        if (jp.jobLocation?.address?.streetAddress) withStreet++;
      }
    }
    if (total === 0) return;
    const ratio = withStreet / total;
    // Many companies don't provide street addresses in their job listings.
    // The COMPANY_HQ_ADDRESSES lookup covers major employers but not all.
    expect(ratio).toBeGreaterThanOrEqual(0.50);
  });
});

describe('JobPosting postalCode guard', () => {
  it('active IT job pages must have a postalCode', () => {
    const missing: string[] = [];
    for (const { rel, jobPostings } of allPages) {
      if (rel.startsWith('en/') || rel.startsWith('de/') || rel.startsWith('fr/')) continue;
      for (const jp of jobPostings) {
        if (jp.validThrough && new Date(jp.validThrough) < new Date()) continue;
        const pc = jp.jobLocation?.address?.postalCode;
        if (!pc) {
          missing.push(`${rel}: postalCode missing (title="${jp.title}")`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('postalCode must be a valid Swiss 4-digit code, not a year', () => {
    const failures: string[] = [];
    for (const { rel, jobPostings } of allPages) {
      for (const jp of jobPostings) {
        const pc = jp.jobLocation?.address?.postalCode;
        if (!pc) continue;
        if (!/^[1-9]\d{3}$/.test(pc)) {
          failures.push(`${rel}: postalCode="${pc}" is not a valid 4-digit code`);
        }
        const n = Number(pc);
        if (n >= 2020 && n <= 2039) {
          failures.push(`${rel}: postalCode="${pc}" looks like a year`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('100% of active IT job pages should have a postalCode', () => {
    let total = 0;
    let withPostal = 0;
    for (const { rel, jobPostings } of allPages) {
      if (rel.startsWith('en/') || rel.startsWith('de/') || rel.startsWith('fr/')) continue;
      for (const jp of jobPostings) {
        if (jp.validThrough && new Date(jp.validThrough) < new Date()) continue;
        total++;
        if (jp.jobLocation?.address?.postalCode) withPostal++;
      }
    }
    if (total === 0) return;
    expect(withPostal / total).toBe(1);
  });
});
