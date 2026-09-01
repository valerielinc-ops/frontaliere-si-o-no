// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const ACTIVE_FILE = resolve(ROOT, 'data/jobs/by-crawler/ipersonal.json');
const EXPIRED_FILE = resolve(ROOT, 'data/jobs/expired/by-crawler/ipersonal.json');

const CURRENT_ACTIVE_IDS = [
  'ipersonal-17aee01ae30f',
  'ipersonal-2740b2ce2219',
  'ipersonal-276fa7244d51',
  'ipersonal-2b777a3703ff',
  'ipersonal-593b9add46fd',
  'ipersonal-674247d1cfdf',
  'ipersonal-6b041082e3bf',
  'ipersonal-760d8358e1b0',
  'ipersonal-867b69d934a8',
  'ipersonal-9f54e33da384',
  'ipersonal-b0236bd8b9fc',
  'ipersonal-c1bcf0b3ebd3',
  'ipersonal-c26f49fcea6e',
  'ipersonal-d2563d885f73',
].sort();

const LOST_ROUTES = [
  'dipl-expertin-experte-anasthesiepflege-nds-80-100-in-rebstein-gesucht-8211-deine-expertise',
  'dipl-expertin-experte-anasthesiepflege-nds-80-100-in-rebstein-gesucht-deine-expertise-fur-hochste-patientensicherheit',
  'dipl-expertin-experte-anasthesiepflege-nds-80-100-in-rebstein-gesucht-deine-expertise-per-hochste-patientensicherheit-ipersonal-ag-rebstein',
  'dipl-expertin-experte-fur-notfallpflege-nds-80-100-in-goldach-gesucht-dein-fachwissen',
  'dipl-expertin-experte-intensivpflege-nds-80-100-fur-binningen-gesucht-dein-wissen-fur-eine',
  'dipl-expertin-experte-intensivpflege-nds-80-100-fur-neuenhof-gesucht-hochste-qualitat-in',
  'dipl-expertin-experte-intensivpflege-nds-80-100-fur-zofingen-gesucht-hochste-qualitat-in',
  'dipl-expertin-experte-intensivpflege-nds-80-100-in-olten-gesucht-hochste-pflegekompetenz',
  'dipl-expertin-experte-intensivpflege-nds-80-100-per-binningen-gesucht-dein-wissen-per-eine-optimale-patientenversorgung-ipersonal-ag-binningen',
  'dipl-expertin-experte-intensivpflege-nds-80-100-per-neuenhof-gesucht-hochste-qualitat-in-der-intensivpflege-ipersonal-ag-neuenhof',
  'dipl-expertin-experte-intensivpflege-nds-80-100-per-zofingen-gesucht-hochste-qualitat-in-der-intensivpflege-ipersonal-ag-zofingen',
  'dipl-expertin-experte-nds-notfallpflege-80-100-fur-samedan-gesucht-dein-fachwissen-fur',
  'dipl-expertin-experte-nds-notfallpflege-80-100-per-samedan-gesucht-dein-fachwissen-per-eine-schnelle-e-professionelle-versorgung-ipersonal-ag-samedan',
  'dipl-expertin-experte-per-notfallpflege-nds-80-100-in-goldach-gesucht-dein-fachwissen-rettet-leben-ipersonal-ag-goldach',
  'dipl-fachfrau-fachmann-operationstechnik-hf-80-100-in-aadorf-gesucht-deine-expertise-fur',
  'dipl-fachfrau-fachmann-operationstechnik-hf-80-100-in-aadorf-gesucht-deine-expertise-per-einen-reibungslosen-op-ablauf-ipersonal-ag-aadorf',
  'dipl-fachfrau-fachmann-operationstechnik-hf-80-100-in-bellikon-gesucht-deine-expertise-fur',
  'dipl-fachfrau-fachmann-operationstechnik-hf-80-100-in-bellikon-gesucht-deine-expertise-per-einen-reibungslosen-op-ablauf-ipersonal-ag-bellikon',
  'dipl-fachfrau-mann-operationstechnik-hf-80-100-fur-zurich-gesucht-spezialisiere-dich-auf',
  'dipl-fachfrau-mann-operationstechnik-hf-80-100-per-zurich-gesucht-spezialisiere-dich-auf-prazision-e-sicherheit-im-op-ipersonal-ag-zurich',
  'dipl-pflegefachfrau-pflegefachmann-uberwachungspflege-ndk-80-100-in-schinznach-gesucht',
  'dipl-pflegefachfrau-pflegefachmann-uberwachungspflege-ndk-80-100-in-st-moritz-gesucht',
].sort();

type Job = {
  id?: string;
  url?: string;
  slug?: string;
  slugByLocale?: Record<string, string>;
  previousSlugs?: string[];
  previousSlugsByLocale?: Record<string, string[]>;
};

function routeSet(job: Job) {
  return new Set([
    job.slug,
    ...Object.values(job.slugByLocale ?? {}),
    ...(job.previousSlugs ?? []),
    ...Object.values(job.previousSlugsByLocale ?? {}).flat(),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0));
}

function duplicateCount(values: Array<string | undefined>) {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.values()].filter((count) => count > 1).length;
}

function routeIdentityHash(jobs: Job[]) {
  const projection = jobs.map((job) => ({
    id: job.id,
    url: job.url,
    routes: [...routeSet(job)].sort(),
  })).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex');
}

function targetFirstBySlug(current: Job[], recovered: Job[]) {
  const bySlug = new Map(current.map((job) => [job.slug, structuredClone(job)]));
  for (const job of recovered) {
    if (!bySlug.has(job.slug)) bySlug.set(job.slug, structuredClone(job));
  }
  return [...bySlug.values()];
}

describe('iPersonal route recovery for issue 7045', () => {
  const active = (JSON.parse(readFileSync(ACTIVE_FILE, 'utf8')) as { jobs: Job[] }).jobs;
  const expired = JSON.parse(readFileSync(EXPIRED_FILE, 'utf8')) as Job[];

  it('restores every one of the 22 lost routes with one unambiguous owner', () => {
    const owners = new Map<string, number>();
    for (const job of [...active, ...expired]) {
      for (const route of routeSet(job)) owners.set(route, (owners.get(route) ?? 0) + 1);
    }
    expect(LOST_ROUTES).toHaveLength(22);
    expect(LOST_ROUTES.filter((route) => !owners.has(route))).toEqual([]);
    expect(LOST_ROUTES.filter((route) => owners.get(route) !== 1)).toEqual([]);
  });

  it('keeps every post-loss active vacancy and introduces no identity collision', () => {
    expect(active.map(({ id }) => id).sort()).toEqual(CURRENT_ACTIVE_IDS);
    expect(duplicateCount(active.map(({ id }) => id))).toBe(0);
    expect(duplicateCount(active.map(({ url }) => url))).toBe(0);
    expect(duplicateCount([...active, ...expired].map(({ slug }) => slug))).toBe(0);
    expect(expired).toHaveLength(110);
  });

  it('is idempotent under the same target-first recovery input', () => {
    const recovered = expired.filter((job) => (
      [...routeSet(job)].some((route) => LOST_ROUTES.includes(route))
    ));
    const postLoss = expired.filter((job) => !recovered.includes(job));
    expect(postLoss).toHaveLength(98);
    expect(routeIdentityHash(postLoss)).toBe(
      'd103f86f975a51c48d085303cbc58c41235475b5e0bf7fc2d288b8ce6652fffa',
    );
    const once = targetFirstBySlug(postLoss, recovered);
    const twice = targetFirstBySlug(once, recovered);
    expect(recovered).toHaveLength(12);
    expect(once.toSorted((left, right) => String(left.slug).localeCompare(String(right.slug)))).toEqual(
      expired.toSorted((left, right) => String(left.slug).localeCompare(String(right.slug))),
    );
    expect(twice).toEqual(once);
  });
});
