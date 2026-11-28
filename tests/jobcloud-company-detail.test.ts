import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractJobCloudApplyUrl,
  extractJobCloudDescriptionHtml,
  extractJobCloudKeyInfo,
  parseJobCloudDate,
} from '../scripts/lib/jobcloud-company-detail.mjs';
import { fetchAllCicJobs, LISTING_URL as CIC_LISTING_URL } from '../scripts/lib/clinique-cic-job-parser.mjs';
import { fetchAllCroixRougeFribourgeoiseJobs } from '../scripts/lib/croix-rouge-fribourgeoise-job-parser.mjs';
import { meetsSourceBodyFloor } from '../scripts/lib/source-body-floor.mjs';

// Invented text on the real (Next.js) JobCloud detail structure: nested divs
// inside the body, utility classes with brackets, dt/dd key info, plain apply <a>.
const PARA = 'Vous accompagnez des personnes dans leur quotidien, organisez les interventions, documentez les suivis et collaborez avec les équipes partenaires pour garantir une prise en charge attentive et coordonnée. ';
const BODY_HTML = `<p>${PARA}</p><div class="callout"><div><ul><li>${PARA}</li></ul></div></div><p>${PARA}</p>`;
const APPLY = 'https://www.jobs.ch/de/application/create/11111111-2222-4333-8444-555555555555?utm_source=relationship&amp;utm_medium=referral';

function nextDetail({ title = 'Infirmier/ère', body = BODY_HTML, date = '25 novembre 2026', location = 'Clarens' } = {}) {
  return `<!doctype html><html><body><main>
<h1 class="mb-6 text-3xl">${title}</h1>
<div class="job-description max-w-none [&amp;_h1]:mb-4 [&amp;_a]:text-primary">${body}</div>
<aside><a href="${APPLY}" target="_blank" class="inline-flex">Postuler</a>
<div><h2>Détails</h2><dl class="space-y-5">
<div class="flex"><div><dt class="text-muted-foreground">Date de publication</dt><dd class="font-medium">${date}</dd></div></div>
<div class="flex"><dt class="text-muted-foreground">Taux d&#x27;activité</dt><dd class="font-medium">80–100%</dd></div>
<dt class="text-muted-foreground">Type de contrat</dt><dd class="font-medium">Durée indéterminée</dd>
<dt class="text-muted-foreground">Lieu de travail</dt><dd class="font-medium">${location}</dd>
</dl></div></aside></main></body></html>`;
}

const response = (body: string) => ({ ok: true, status: 200, text: async () => body });

describe('JobCloud company detail helper', () => {
  it('reads the whole nested body of div.job-description and stops at its closing div', () => {
    const body = extractJobCloudDescriptionHtml(nextDetail());
    expect(body).toContain('class="callout"');
    expect(body.match(/Vous accompagnez/g)).toHaveLength(3);
    expect(body).not.toContain('Détails');
    expect(meetsSourceBodyFloor(body.replace(/<[^>]+>/g, ' '))).toBe(true);
  });

  it('does not match a different class that merely contains the words', () => {
    expect(extractJobCloudDescriptionHtml('<div class="job-description-title">x</div><div class="not-job-description">y</div>')).toBe('');
  });

  it('reads dt/dd key info with entity-encoded labels and parses long French dates', () => {
    const html = nextDetail();
    expect(extractJobCloudKeyInfo(html, "Taux d[’']activité")).toBe('80–100%');
    expect(extractJobCloudKeyInfo(html, 'Type de contrat')).toBe('Durée indéterminée');
    expect(extractJobCloudKeyInfo(html, 'Lieu de travail')).toBe('Clarens');
    expect(parseJobCloudDate(extractJobCloudKeyInfo(html, 'Date de publication'))).toBe('2026-11-25');
    expect(parseJobCloudDate('25. September 2026')).toBe('2026-09-25');
    expect(parseJobCloudDate('3.7.2026')).toBe('2026-07-03');
    expect(parseJobCloudDate('soon')).toBe('');
  });

  it('finds the jobs.ch application link without an id, ignoring other anchors', () => {
    const html = `<a href="/fr/job-list/x">list</a><a href="https://example.com/application/create/1">no</a>${nextDetail()}`;
    expect(extractJobCloudApplyUrl(html, 'https://company.jobcloud.ch/fr/jobs/a/b')).toBe(APPLY.replace('&amp;', '&'));
    expect(extractJobCloudApplyUrl('<a href="https://example.com/application/create/1">no</a>')).toBe('');
  });

  it('keeps reading the legacy Webflow template', () => {
    const legacy = `<div class="text-rich-text w-richtext"><p>Corps ancien</p></div><div class="job_details_content-right"><a id="job-ad-apply-btn" href="https://www.jobup.ch/fr/application/create/1?a=b&amp;c=d">P</a><div><div>Lieu de travail</div><div class="text-size-small">Saxon</div></div></div>`;
    expect(extractJobCloudDescriptionHtml(legacy)).toContain('Corps ancien');
    expect(extractJobCloudKeyInfo(legacy, 'Lieu de travail')).toBe('Saxon');
    expect(extractJobCloudApplyUrl(legacy)).toBe('https://www.jobup.ch/fr/application/create/1?a=b&c=d');
  });

  it('returns nothing for an unrecognised page instead of guessing a text block', () => {
    expect(extractJobCloudDescriptionHtml('<main><p>Un long texte quelconque sans conteneur reconnu.</p></main>')).toBe('');
  });
});

describe('JobCloud Next.js detail through both crawlers', () => {
  beforeEach(() => {
    process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
    process.env.JOBS_JINA_RETRY_BASE_MS = '0';
  });
  afterEach(() => {
    delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
    delete process.env.JOBS_JINA_RETRY_BASE_MS;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('Clinique CIC keeps a job whose body lives in div.job-description', async () => {
    const detailUrl = 'https://company.jobcloud.ch/fr/jobs/clinique-cic-suisse/00000000-0000-0000-0000-0000000000a1/';
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const target = String(input);
      if (target === CIC_LISTING_URL) return response(`<html><body><a href="${detailUrl}?from=list">job</a></body></html>`);
      if (target === detailUrl) return response(nextDetail());
      throw new Error(`unexpected URL ${target}`);
    }));
    const jobs = await fetchAllCicJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ title: 'Infirmier/ère', location: 'Clarens', canton: 'VD', postedDate: '2026-11-25' });
    expect(meetsSourceBodyFloor(jobs[0].description)).toBe(true);
    expect(jobs[0].applyUrl).toBe(APPLY.replace('&amp;', '&'));
  });

  it('Croix-Rouge fribourgeoise shares the same reader', async () => {
    const href = '/fr/jobs/croix-rouge-fribourgeoise/00000000-0000-0000-0000-0000000000b1';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      const target = String(url);
      const body = target.includes('/job-list/')
        ? `<html><body><a href="${href}" class="job_list_item-link">c</a></body></html>`
        : nextDetail({ title: 'Collaborateur-trice social-e', location: '1700, Fribourg' });
      return { ok: true, status: 200, text: async () => body } as unknown as Response;
    });
    const jobs = await fetchAllCroixRougeFribourgeoiseJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('Collaborateur-trice social-e');
    expect(jobs[0].postedDate).toBe('2026-11-25');
    expect(meetsSourceBodyFloor(jobs[0].description)).toBe(true);
    expect(jobs[0].applyUrl).toBe(APPLY.replace('&amp;', '&'));
  });
});
