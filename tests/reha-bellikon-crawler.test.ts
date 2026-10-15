/**
 * Rehaklinik Bellikon (JobPublish.ch tenant `rkb`) — parser quality.
 *
 * Fixtures are minimized copies of the live feed and of one live detail page
 * (2026-09-29): the feed carries two standing "Spontanbewerbung" entries with
 * no detail page, and the Chur vacancy's subtitle nests one <div> per column.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractDetailCity,
  extractDetailJsonLdAddress,
  isJobpublishSpontaneousPlaceholder,
  parseJobpublishFeed,
} from '@/scripts/lib/jobpublish-ch-common.mjs';
import { fetchAllRehaBellikonJobs, isRehaBellikonJob } from '@/scripts/lib/reha-bellikon-job-parser.mjs';

const FIXTURES = path.join(__dirname, 'fixtures', 'reha-bellikon');
const FEED = fs.readFileSync(path.join(FIXTURES, 'feed-rkb.xml'), 'utf8');
const DETAIL_CHUR = fs.readFileSync(path.join(FIXTURES, 'detail-chur.html'), 'utf8');

describe('JobPublish spontaneous-application placeholders', () => {
  it('flags the standing Spontanbewerbung entries and keeps real vacancies', () => {
    const feed = parseJobpublishFeed(FEED);
    expect(feed.map((item) => isJobpublishSpontaneousPlaceholder(item))).toEqual([false, true, true]);
  });
});

describe('JobPublish detail location', () => {
  it('reads the map-marker line past the nested workload column', () => {
    expect(extractDetailCity(DETAIL_CHUR)).toBe('Chur GR');
  });

  it('reads the JobPosting address even with raw control characters in the JSON-LD', () => {
    expect(extractDetailJsonLdAddress(DETAIL_CHUR)).toEqual({ locality: 'Chur', postalCode: '7000' });
  });
});

describe('fetchAllRehaBellikonJobs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes only real vacancies, at their own city and postal code', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = String(url).includes('/feed/v2/website/rkb') ? FEED : DETAIL_CHUR;
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
    }));
    const jobs = await fetchAllRehaBellikonJobs();
    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    expect(isRehaBellikonJob(job)).toBe(true);
    expect(job.title).toBe('Gruppenleiter/in berufliche Eingliederung Chur');
    expect(job.location).toBe('Chur');
    expect(job.canton).toBe('GR');
    expect(job.postalCode).toBe('7000');
    // Section heading, then its bullets (the shared extractor leaves a blank
    // line between them, as on every published Reha Bellikon job).
    expect(job.description).toMatch(/Aufgaben\n+• Personelle und operative Führung des Standortes Chur\n• Steuerung/);
    expect(job.description).toMatch(/Profil\n+• Führungserfahrung/);
    expect(jobs.some((j) => /Spontanbewerbung/i.test(j.title))).toBe(false);
  });
});
