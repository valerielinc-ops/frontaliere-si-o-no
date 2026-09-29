/**
 * Company paragraphs written by the pipeline, not by the employer (issue 5253).
 *
 * hardenJobLocaleFields used to append a company paragraph from
 * COMPANY_BOILERPLATE_IT to every Italian slot under 300 characters, behind a
 * "## <title> / **<company>** — <place>" header, and
 * ensureMinimumDescriptionWordCount did the same below 50 words. Neither
 * pads any more: a posting publishes only its source text, and one without
 * text takes the thin-source path of validateDedicatedLocaleCoverage.
 *
 * The fixture holds four records of the origin/main slices of 2026-09-29
 * (manor ×2, pemsa, a-group), trimmed to the description fields: the
 * stored fossils that hardening now removes. The pemsa one was re-flowed into
 * a bullet ("…industriale. \n• Offriamo…") after it was written.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  dropCompanyBoilerplateFossils,
  ensureMinimumDescriptionWordCount,
  hardenJobLocaleFields,
  resetHardenCache,
} from '@/scripts/lib/dedicated-crawler-common.mjs';

type Job = {
  title: string;
  company: string;
  location?: string;
  canton?: string;
  sourceLang: string;
  description: string;
  descriptionByLocale: Record<string, string>;
  needsRetranslation?: boolean;
};

const FIXTURE = path.resolve(__dirname, 'fixtures/company-boilerplate-fossils.json');

function loadFixture(): Job[] {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
}

function byTitle(title: string): Job {
  const job = loadFixture().find((j) => j.title === title);
  if (!job) throw new Error(`fixture record missing: ${title}`);
  return job;
}

// Distinctive sentences of the four paragraphs involved.
const PADDING_RE = /catene di grandi magazzini in Svizzera|punto di riferimento nel mercato svizzero|studio di architettura, design e sostenibilità|Offriamo formazione sul posto|leading department stores in Switzerland/;
const HEADER_RE = /^## .*\n\s*\*\*[^*\n]+\*\* — /;

function allText(job: Job): string[] {
  return [job.description, ...Object.values(job.descriptionByLocale || {})];
}

describe('dropCompanyBoilerplateFossils — stored records of the 2026-09-29 slices', () => {
  it('manor, German source: the Italian slot keeps only the posting text and is re-translated', () => {
    const job = byTitle('Mitarbeiter*in Kasse 30%');
    const sourceText = job.descriptionByLocale.de;

    expect(dropCompanyBoilerplateFossils(job)).toBe(true);

    for (const text of allText(job)) {
      expect(text).not.toMatch(PADDING_RE);
      expect(text).not.toMatch(HEADER_RE);
    }
    expect(job.descriptionByLocale.it).toBe(sourceText);
    expect(job.descriptionByLocale.de).toBe(sourceText);
    expect(job.description).toBe(sourceText);
    // The German copy in the Italian slot is a placeholder, not a translation.
    expect(job.needsRetranslation).toBe(true);
  });

  it('manor, Italian source: the translations made from the padded text are dropped', () => {
    const job = byTitle('Apprendista Polydesigner 3D 100%');
    expect(job.descriptionByLocale.en).toMatch(/leading department stores in Switzerland/);

    expect(dropCompanyBoilerplateFossils(job)).toBe(true);

    expect(Object.keys(job.descriptionByLocale)).toEqual(['it']);
    expect(job.descriptionByLocale.it).toBe(job.description);
    expect(job.descriptionByLocale.it).toMatch(/^• Passione per le esposizioni merce nel negozio/);
    expect(job.descriptionByLocale.it).not.toMatch(PADDING_RE);
    expect(job.needsRetranslation).toBe(true);
  });

  it('pemsa: the paragraph is found even after it was re-flowed into a bullet', () => {
    const job = byTitle('Posatore di resina');
    expect(job.descriptionByLocale.it).toContain('meccanica industriale. \n• Offriamo contratti fissi');

    expect(dropCompanyBoilerplateFossils(job)).toBe(true);

    expect(job.descriptionByLocale.it).toBe(job.description);
    expect(job.descriptionByLocale.it).not.toMatch(/Vantaggi: consulenza personalizzata|Offriamo contratti fissi/);
    expect(Object.keys(job.descriptionByLocale)).toEqual(['it']);
  });

  it('a-group: only the source text is left, and its copy in the Italian slot is flagged', () => {
    const job = byTitle('Booking & Revenue Specialist – Luxury Hospitality');

    expect(dropCompanyBoilerplateFossils(job)).toBe(true);

    expect(job.descriptionByLocale.it).toBe('Booking & Revenue Specialist – Luxury Hospitality');
    expect(job.descriptionByLocale.en).toBe('Booking & Revenue Specialist – Luxury Hospitality');
    expect(job.needsRetranslation).toBe(true);
  });

  it('is idempotent and leaves a clean job alone', () => {
    const job = byTitle('Mitarbeiter*in Kasse 30%');
    dropCompanyBoilerplateFossils(job);
    const once = JSON.stringify(job);
    expect(dropCompanyBoilerplateFossils(job)).toBe(false);
    expect(JSON.stringify(job)).toBe(once);
  });

  it('leaves a header of the same shape alone when no paragraph is there (a runner\'s own format)', () => {
    const own = '## BI Specialist\n\n**ReleWant** — Bellinzona, Ticino, Svizzera\n\n### Chi siamo?\nTesto della fonte.';
    const job = {
      title: 'BI Specialist',
      company: 'ReleWant',
      sourceLang: 'it',
      description: own,
      descriptionByLocale: { it: own, en: '## BI Specialist\n\n**ReleWant** — Bellinzona\n\n### Who are we?\nSource text.' },
    };
    const before = JSON.stringify(job);
    expect(dropCompanyBoilerplateFossils(job)).toBe(false);
    expect(JSON.stringify(job)).toBe(before);
  });
});

describe('hardenJobLocaleFields — no padding, fossils removed', () => {
  const tmpFiles: string[] = [];
  afterEach(() => {
    resetHardenCache();
    for (const f of tmpFiles.splice(0)) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
  });

  function writeJobs(jobs: unknown[]): string {
    const p = path.join(os.tmpdir(), `company-boilerplate-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify(jobs), 'utf-8');
    tmpFiles.push(p);
    return p;
  }

  it('no longer appends a company paragraph to a thin Italian posting', () => {
    const text = 'Gestione della cassa e consulenza alla clientela nel reparto moda.';
    const p = writeJobs([{
      title: 'Collaboratore/trice di vendita 50%',
      company: 'Manor AG',
      location: 'Lugano',
      canton: 'TI',
      url: 'https://example.test/manor/1/',
      sourceLang: 'it',
      description: text,
      descriptionByLocale: { it: text },
    }]);

    hardenJobLocaleFields({ dataJobsPath: p });

    const [job] = JSON.parse(fs.readFileSync(p, 'utf-8'));
    for (const value of [job.description, ...Object.values(job.descriptionByLocale as Record<string, string>)]) {
      expect(value).not.toMatch(PADDING_RE);
      expect(value).not.toMatch(HEADER_RE);
    }
    expect(job.descriptionByLocale.it).toBe(text);
  });

  it('removes the stored fossil from description and slots', () => {
    const p = writeJobs([{ ...byTitle('Mitarbeiter*in Kasse 30%'), url: 'https://example.test/manor/2/' }]);

    hardenJobLocaleFields({ dataJobsPath: p });

    const [job] = JSON.parse(fs.readFileSync(p, 'utf-8'));
    for (const value of [job.description, ...Object.values(job.descriptionByLocale as Record<string, string>)]) {
      expect(value).not.toMatch(PADDING_RE);
      expect(value).not.toMatch(HEADER_RE);
    }
    expect(job.descriptionByLocale.de).toMatch(/^• Du bist flexibel nach Einsatzplan verfügbar\./);
    expect(job.needsRetranslation).toBe(true);
  });
});

describe('ensureMinimumDescriptionWordCount — no padding', () => {
  it('leaves a thin posting as the source wrote it', () => {
    const jobs = [{
      title: 'Verkäufer/in',
      company: 'VOLG',
      location: 'Zuoz',
      canton: 'GR',
      description: 'Kundenberatung und Kasse.',
      descriptionByLocale: { de: 'Kundenberatung und Kasse.' },
    }];

    expect(ensureMinimumDescriptionWordCount(jobs, 50)).toBe(0);
    expect(jobs[0].description).toBe('Kundenberatung und Kasse.');
    expect(jobs[0].descriptionByLocale).toEqual({ de: 'Kundenberatung und Kasse.' });
  });
});
