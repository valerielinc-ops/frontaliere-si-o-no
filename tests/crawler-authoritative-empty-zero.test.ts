import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { evaluateAuthoritativeSnapshot } from '../scripts/lib/crawler-template.mjs';
import { isAuthoritativeEmptySnapshot } from '../scripts/lib/authoritative-empty-snapshot.mjs';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';
import { parseVacancyCountTab } from '../scripts/lib/jobs-ch-company-pages.mjs';
import { umantisListingStatesEmpty } from '../scripts/lib/umantis-empty-listing.mjs';
import {
  fetchAllGimArchitektenJobs,
  GIM_ARCHITEKTEN_COMPANY_NAME,
} from '../scripts/lib/gim-architekten-job-parser.mjs';
import { fetchAllStrabagJobs, STRABAG_COMPANY_NAME } from '../scripts/lib/strabag-job-parser.mjs';
import {
  fetchAllFondationDomusJobs,
  parseVacancyBoardEvidence,
  FONDATION_DOMUS_COMPANY_NAME,
} from '../scripts/lib/fondation-domus-job-parser.mjs';
import {
  fetchAllRecruitingapp2563Jobs,
  RECRUITINGAPP_2563_COMPANY_NAME,
} from '../scripts/lib/recruitingapp-2563-job-parser.mjs';

/**
 * OBSERVER for issues #7458 (gim-architekten), #6660 (recruitingapp-2563) and
 * #7321 (fondation-domus).
 *
 * Those three crawlers are the "source is plausibly empty but cannot prove it"
 * class: they run, observe nothing, publish nothing, and `check-crawler-health`
 * can only read that as `unhealthy` — so the same issue reopens every week
 * forever. The repair is that each one now publishes a zero that carries its own
 * evidence, so the monitor can tell "I looked and there was nothing" from
 * "I never got to look".
 *
 * This file fails if either half of that regresses:
 *   1. the runner stops asking for the proof, or the proof stops being granted
 *      on the markup the live source actually serves (measured 2026-09-05);
 *   2. the proof starts being granted when the crawler did NOT observe the
 *      source — a swallowed fetch error, a page whose vacancy container never
 *      rendered, a listing that no longer states it is empty. That is the
 *      dangerous direction: it would retire live jobs and mask a dead crawler,
 *      which is exactly what an `EMPTY_OK_CRAWLERS` entry does and why these
 *      three must never get one.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepoFile = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** The pipeline's own verdict, with the options the runners declare. */
function pipelineVerdict(jobs: unknown, label: string) {
  return evaluateAuthoritativeSnapshot(jobs, {
    validateAuthoritativeSnapshot: (batch: unknown) => {
      if (!isAuthoritativeEmptySnapshot(batch)) throw new Error('not proven');
      return true;
    },
    allowAuthoritativeEmptySnapshot: true,
    authoritativeSnapshotScope: 'empty-only',
    companyLabel: label,
  });
}

/** `evaluateAuthoritativeSnapshot` throws on an unproven zero; that is the "keep the slice" path. */
function publishesProvenZero(jobs: unknown, label: string): boolean {
  try {
    return pipelineVerdict(jobs, label).authoritativeEmptySnapshot === true;
  } catch {
    return false;
  }
}

/* ── jobs.ch company profile (gim-architekten, #7458) ──────────────────── */

// Shape measured on the live profile 2026-09-05: the vacancy tab carries the
// server-rendered count, independent of the detail-link markup the parser walks.
const jobsChProfile = (employer: string, count: number, links: string[] = []) => `<!doctype html><html><body>
  <h1>${employer}</h1>
  <ul><li><a class="d_flex" href="/en/companies/49929-some-company/vacancies/" data-discover="true">Jobs (${count})</a></li></ul>
  ${links.map((id) => `<a href="/en/vacancies/detail/${id}/">a job</a>`).join('')}
</body></html>`;
const gimProfile = (count: number, links: string[] = []) => jobsChProfile(GIM_ARCHITEKTEN_COMPANY_NAME, count, links);

/* ── Umantis job market (recruitingapp-2563, #6660) ────────────────────── */

const UMANTIS_EMPTY_SENTENCE = 'Es wurden noch keine Einträge erfasst, die hier angezeigt werden könnten.';

// Measured on all five live tenants 2026-09-05: Umantis ships that same
// sentence HTML-escaped inside a client-side string table on EVERY page,
// including boards with 20 open vacancies. Every fixture carries it, so a
// fixture can never accidentally prove the check works when it does not.
const UMANTIS_STRING_TABLE = `<script>window.msg['wNoEntries'] = "&lt;i&gt; &lt;span class=&quot;color-grey-m&quot;&gt; ${UMANTIS_EMPTY_SENTENCE}&lt;/span&gt;&lt;/i&gt;";</script>`;
const umantisListing = (body: string) => `<!doctype html><html><head><title>Switch Bewerbermanagement Stellen</title>${UMANTIS_STRING_TABLE}</head><body>
  <div id="jobmarket">${body}</div>
</body></html>`;

function umantisRuntime(html: string) {
  return {
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    sleepImpl: async () => {},
    retries: 1,
    retryBaseMs: 0,
    timeoutMs: 2_000,
    fetchImpl: async (input: unknown) => {
      const url = String((input as { url?: string })?.url ?? input);
      const body = url.includes('/robots.txt') ? 'User-agent: *\nAllow: /\n' : html;
      return new Response(body, { status: 200, headers: { 'content-type': url.includes('robots') ? 'text/plain' : 'text/html' } });
    },
  };
}

/* ── Fondation Domus vacancy board (#7321) ─────────────────────────────── */

const domusPage = (board: string) => `<!doctype html><html><body>
  <h3 class="sppb-addon-title">Postes ouverts</h3>
  <div class="sppb-addon-content">${board}</div>
</body></html>`;
const domusCard = (title: string) => `<div class="job"><div class="title"><h3>${title}</h3></div>
  <div class="infos"><div class="info"><h5 class="info-title location">Lieu de travail</h5><div>Ardon</div></div></div>
  <a href="https://www.jobup.ch/fr/emplois/detail/1/">&gt; Voir cette offre d’emploi</a></div>`;
const domusBoard = (cards: string) => `<div id="mod-xml-loader" class="jobs">${cards}</div>`;

describe('authoritative empty zero — jobs.ch family, umantis and fondation-domus', () => {
  beforeEach(() => clearPoliteFetchStateForTests());

  /* ── 1. The wiring the runners must keep ───────────────────────────── */

  it.each([
    ['scripts/update-gim-architekten-jobs.mjs'],
    ['scripts/update-recruitingapp-2563-jobs.mjs'],
    ['scripts/update-fondation-domus-jobs.mjs'],
    ['scripts/update-saint-gobain-weber-isover-jobs.mjs'],
    ['scripts/update-strabag-jobs.mjs'],
    ['scripts/update-visionapartments-jobs.mjs'],
    ['scripts/update-recruitingapp-1154-jobs.mjs'],
    ['scripts/update-recruitingapp-2677-jobs.mjs'],
    ['scripts/update-jsafrasarasin-jobs.mjs'],
    ['scripts/update-apleona-schweiz-ag-jobs.mjs'],
    ['scripts/update-hofweissbad-jobs.mjs'],
  ])('%s asks the pipeline for a source-proven zero', (runner) => {
    const source = readRepoFile(runner);
    expect(source).toContain('validateAuthoritativeSnapshot: authoritativeEmptySnapshotValidator(');
    expect(source).toContain('allowAuthoritativeEmptySnapshot: true');
    expect(source).toContain("authoritativeSnapshotScope: 'empty-only'");
  });

  it('never masks these three with an EMPTY_OK_CRAWLERS entry', () => {
    // The allowlist silences a slug even after the source dies: it converts a
    // noisy defect into a silent one. The whole point of the proof above is to
    // make that shortcut unnecessary, so its absence is part of the contract.
    const monitor = readRepoFile('scripts/check-crawler-health.mjs');
    const allowlist = /const EMPTY_OK_CRAWLERS = new Set\(\[([\s\S]*?)\]\)/.exec(monitor);
    expect(allowlist, 'EMPTY_OK_CRAWLERS declaration not found in check-crawler-health.mjs').toBeTruthy();
    for (const slug of ['gim-architekten', 'recruitingapp-2563', 'fondation-domus']) {
      expect(allowlist![1]).not.toContain(slug);
    }
  });

  /* ── 2. The source-proven zero, on the markup the sources really serve ── */

  it('gim-architekten publishes a proven zero when every profile renders Jobs (0)', async () => {
    const jobs = await fetchAllGimArchitektenJobs({ fetchPage: async () => gimProfile(0) });
    expect(publishesProvenZero(jobs, GIM_ARCHITEKTEN_COMPANY_NAME)).toBe(true);
    expect(parseVacancyCountTab(gimProfile(0))).toBe(0);
  });

  it('recruitingapp-2563 publishes a proven zero on the Umantis empty-state marker', async () => {
    const jobs = await fetchAllRecruitingapp2563Jobs(
      umantisRuntime(umantisListing(`<p>${UMANTIS_EMPTY_SENTENCE}</p>`)),
    );
    expect(publishesProvenZero(jobs, RECRUITINGAPP_2563_COMPANY_NAME)).toBe(true);
  });

  it('fondation-domus publishes a proven zero when the board holds only the spontaneous card', async () => {
    const html = domusPage(domusBoard(domusCard('Postulation spontanée')));
    expect(parseVacancyBoardEvidence(html)).toEqual({
      boardRendered: true,
      cardTitles: ['Postulation spontanée'],
    });
    const jobs = await fetchAllFondationDomusJobs({ fetchPage: async () => html });
    expect(publishesProvenZero(jobs, FONDATION_DOMUS_COMPANY_NAME)).toBe(true);
  });

  /* ── 3. "Never got to look" must NOT be published as a proven zero ──── */

  it('gim-architekten refuses the proof when a profile page could not be fetched', async () => {
    let call = 0;
    const jobs = await fetchAllGimArchitektenJobs({
      fetchPage: async () => {
        call += 1;
        if (call === 1) throw new Error('HTTP 503 from jobs.ch');
        return gimProfile(0);
      },
    });
    expect(jobs).toEqual([]);
    expect(publishesProvenZero(jobs, GIM_ARCHITEKTEN_COMPANY_NAME)).toBe(false);
  });

  it('gim-architekten refuses the proof when the counter contradicts the (drifted) link markup', async () => {
    // The failure this guards against: jobs.ch renames the detail-link shape,
    // `parseVacancyLinks` returns nothing, and the crawler would happily retire
    // two live vacancies as "source is empty". The rendered counter still says 2.
    const jobs = await fetchAllGimArchitektenJobs({ fetchPage: async () => gimProfile(2) });
    expect(jobs).toEqual([]);
    expect(publishesProvenZero(jobs, GIM_ARCHITEKTEN_COMPANY_NAME)).toBe(false);
  });

  it('gim-architekten refuses the proof on a 200 that is not GIM’s profile', async () => {
    const foreign = gimProfile(0).replace(GIM_ARCHITEKTEN_COMPANY_NAME, 'Some Other AG');
    const jobs = await fetchAllGimArchitektenJobs({ fetchPage: async () => foreign });
    expect(publishesProvenZero(jobs, GIM_ARCHITEKTEN_COMPANY_NAME)).toBe(false);
  });

  it('recruitingapp-2563 refuses the proof when the listing does not state it is empty', async () => {
    const jobs = await fetchAllRecruitingapp2563Jobs(
      umantisRuntime(umantisListing('<p>Wartungsarbeiten. Bitte später erneut versuchen.</p>')),
    );
    expect(jobs).toEqual([]);
    expect(publishesProvenZero(jobs, RECRUITINGAPP_2563_COMPANY_NAME)).toBe(false);
  });

  it('fondation-domus refuses the proof when the vacancy board never rendered', async () => {
    const jobs = await fetchAllFondationDomusJobs({ fetchPage: async () => domusPage('') });
    expect(parseVacancyBoardEvidence(domusPage(''))).toEqual({ boardRendered: false, cardTitles: [] });
    expect(publishesProvenZero(jobs, FONDATION_DOMUS_COMPANY_NAME)).toBe(false);
  });

  it('fondation-domus refuses the proof when the board rendered but the feed produced no card', async () => {
    // A dead XML-feed loader renders the container with nothing inside it —
    // indistinguishable from a real zero without the standing card, so it is
    // deliberately not accepted as evidence.
    const jobs = await fetchAllFondationDomusJobs({ fetchPage: async () => domusPage(domusBoard('')) });
    expect(publishesProvenZero(jobs, FONDATION_DOMUS_COMPANY_NAME)).toBe(false);
  });

  /* ── 4. A bare [] is never authoritative, whoever produced it ───────── */

  it('a plain empty array is refused — that is the "aborted before looking" state', () => {
    expect(isAuthoritativeEmptySnapshot([])).toBe(false);
    expect(publishesProvenZero([], 'anything')).toBe(false);
  });
  /* ── 5. The same proof, on the jobs.ch siblings that shared the loop ──── */

  it('strabag never mistakes its paginated board for an empty one', async () => {
    // Live control 2026-09-05: the /vacancies/ sub-tab renders Jobs (22) while
    // page 1 carries only 12 detail links. A counter that disagrees with the
    // link count is normal on a paginated board — which is exactly why only a
    // counter that reads zero may ever be taken as proof of an empty source.
    const board = jobsChProfile('STRABAG AG', 22, ['aaaaaaaa-0000-0000-0000-000000000001']);
    expect(parseVacancyCountTab(board)).toBe(22);
    const jobs = await fetchAllStrabagJobs({
      fetchPage: async () => jobsChProfile('STRABAG AG', 4),
    });
    expect(jobs).toEqual([]);
    expect(publishesProvenZero(jobs, STRABAG_COMPANY_NAME)).toBe(false);
  });

  it('a jobs.ch sibling publishes a proven zero only when EVERY profile reads zero', async () => {
    // strabag has two profiles; each must be its own employer's page and read 0.
    const perProfile = async (url: string) => (url.includes('bmti')
      ? jobsChProfile('Strabag BMTI GmbH', 0)
      : jobsChProfile('STRABAG AG', 0));
    expect(publishesProvenZero(await fetchAllStrabagJobs({ fetchPage: perProfile }), STRABAG_COMPANY_NAME)).toBe(true);

    // One profile serving the wrong employer's page is enough to refuse it.
    const oneForeign = async (url: string) => (url.includes('bmti')
      ? jobsChProfile('Somebody Else GmbH', 0)
      : jobsChProfile('STRABAG AG', 0));
    expect(publishesProvenZero(await fetchAllStrabagJobs({ fetchPage: oneForeign }), STRABAG_COMPANY_NAME)).toBe(false);
  });
  it('the Umantis empty-state marker is read from rendered text, not the string table', () => {
    // The trap this guards: the platform's own string table carries the
    // sentence HTML-escaped on every page. A raw-HTML regex therefore matches
    // on a board with 20 vacancies, and the "proof" collapses into "the parser
    // found nothing" — which would retire live vacancies on any aborted run.
    // Measured 2026-09-05: raw match true on 5/5 tenants, rendered match true
    // only on recruitingapp-2563, the one board that is genuinely empty.
    expect(UMANTIS_STRING_TABLE).toContain('Einträge erfasst');
    expect(umantisListingStatesEmpty(umantisListing('<a href="/Vacancies/9/Description/1/">a job</a>'))).toBe(false);
    expect(umantisListingStatesEmpty(umantisListing(`<p>${UMANTIS_EMPTY_SENTENCE}</p>`))).toBe(true);
  });

  it('recruitingapp-2563 refuses the proof when only the string table carries the sentence', async () => {
    const jobs = await fetchAllRecruitingapp2563Jobs(
      umantisRuntime(umantisListing('<p>Wartungsarbeiten.</p>')),
    );
    expect(jobs).toEqual([]);
    expect(publishesProvenZero(jobs, RECRUITINGAPP_2563_COMPANY_NAME)).toBe(false);
  });
});
