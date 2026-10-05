/**
 * Company follow groups — «chi segue coop segue entrambi» (owner, 2026-10-05).
 *
 * The Coop crawler publishes the same employer as «Coop» and «Coop
 * Genossenschaft», two canonical profile slugs. A company alert pinned to one
 * of them used to match about half of Coop's jobs. These tests pin every point
 * where a follow is matched, deduplicated or looked up to the ONE group module
 * (build-plugins/shared/companyFollowGroups.mjs).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPANY_FOLLOW_GROUPS,
  companyFollowGroupKey,
  companyFollowGroupMembers,
  sameCompanyFollowGroup,
} from '../build-plugins/shared/companyFollowGroups.mjs';
import { canonicalCompanyProfileSlug } from '../build-plugins/shared/companyProfileSlug.mjs';
import { isBrandAlias, resolveBrandCanonical } from '../build-plugins/shared/brandCanonicalMap.mjs';
import { buildAlertProfile, scoreJobForAlert } from '@/services/jobAlertMatching.mjs';
import { buildRecipientSections } from '../scripts/send-company-alerts.mjs';
import { findCompanyAlertForKey } from '@/services/jobAlertService';
import { rankEmployerSuggestions } from '@/services/employerSuggestions';

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

const alertDoc = (id: string, slug: string, extra: Record<string, unknown> = {}) => ({
  id,
  ref: { id: `ref-${id}` },
  email: 'a@b.ch',
  locale: 'it',
  frequency: 'immediate',
  specificCompanyKey: slug,
  ...extra,
});
const jobDoc = (id: string, company: string, ageHours = 1) => ({
  id,
  title: `Verkäufer:in ${id}`,
  company,
  companyKey: 'coop-ticino',
  location: 'Lugano',
  canton: 'TI',
  firstSeenAt: hoursAgo(ageHours),
  url: `https://frontaliereticino.ch/lavoro/${id}/`,
});
const pinProfile = (slug: string) => buildAlertProfile(
  { keywords: [], locations: [], sectors: [], contractTypes: [], cantonFilter: null, specificCompanyKey: slug },
  {},
);

describe('the group module', () => {
  it('declares Coop as one group, keyed on `coop`', () => {
    expect(companyFollowGroupKey('coop-genossenschaft')).toBe('coop');
    expect(companyFollowGroupKey('coop')).toBe('coop');
    expect(companyFollowGroupMembers('coop-genossenschaft')).toEqual(['coop', 'coop-genossenschaft']);
    expect(sameCompanyFollowGroup('coop', 'coop-genossenschaft')).toBe(true);
  });

  it('leaves every other slug alone, including the other Coop formats', () => {
    for (const slug of ['coop-city', 'coop-ristorante', 'coop-pronto-ag', 'migros', 'lidl']) {
      expect(companyFollowGroupKey(slug)).toBe(slug);
      expect(companyFollowGroupMembers(slug)).toEqual([slug]);
      expect(sameCompanyFollowGroup(slug, 'coop')).toBe(false);
    }
    expect(sameCompanyFollowGroup('', '')).toBe(false);
  });

  it('members are the slugs the crawler display names really resolve to, and not brand aliases', () => {
    // If a member stopped being a canonical profile slug (a brandCanonicalMap
    // alias, a renamed display name) the group would silently stop matching.
    expect(canonicalCompanyProfileSlug('Coop', 'coop-ticino')).toBe('coop');
    expect(canonicalCompanyProfileSlug('Coop Genossenschaft', 'coop-ticino')).toBe('coop-genossenschaft');
    for (const group of COMPANY_FOLLOW_GROUPS) {
      for (const member of group) {
        expect(isBrandAlias(member), `${member} is a brand alias`).toBe(false);
        expect(resolveBrandCanonical(member) ?? member).toBe(member);
      }
    }
  });
});

describe('matcher: following either Coop slug matches both display names', () => {
  it.each(['coop', 'coop-genossenschaft'])('pin %s', (slug) => {
    const profile = pinProfile(slug);
    expect(scoreJobForAlert(jobDoc('j1', 'Coop'), profile)).toBeGreaterThan(0);
    expect(scoreJobForAlert(jobDoc('j2', 'Coop Genossenschaft'), profile)).toBeGreaterThan(0);
    // Same crawler key, different employer label: still not followed.
    expect(scoreJobForAlert(jobDoc('j3', 'Coop City'), profile)).toBe(0);
    expect(scoreJobForAlert({ ...jobDoc('j4', 'Migros Ticino'), companyKey: 'migros-ticino' }, profile)).toBe(0);
  });
});

describe('immediate sender: one recipient never gets the same job twice', () => {
  const jobs = [jobDoc('j-coop', 'Coop', 1), jobDoc('j-gen', 'Coop Genossenschaft', 2)];

  it('a single Coop follow delivers both display names', () => {
    const sections = buildRecipientSections([alertDoc('a1', 'coop-genossenschaft')], jobs, NOW);
    expect(sections).toHaveLength(1);
    expect(sections[0].jobs.map((j: { id: string }) => j.id).sort()).toEqual(['j-coop', 'j-gen']);
  });

  it('two members of the group followed by one address: each job once', () => {
    const sections = buildRecipientSections([alertDoc('a1', 'coop'), alertDoc('a2', 'coop-genossenschaft')], jobs, NOW);
    const ids = sections.flatMap((s: { jobs: Array<{ id: string }> }) => s.jobs.map((j) => j.id));
    expect(ids.sort()).toEqual(['j-coop', 'j-gen']);
  });

  it('a job one member already delivered is not mailed again by the other', () => {
    const sections = buildRecipientSections(
      [
        alertDoc('a1', 'coop', { sentJobIds: { 'j-coop': NOW - 1000, 'j-gen': NOW - 1000 } }),
        alertDoc('a2', 'coop-genossenschaft'),
      ],
      jobs,
      NOW,
    );
    expect(sections).toEqual([]);
  });

  it('two identical pins of one address (measured in production) send each job once', () => {
    const bellinzona = [
      { ...jobDoc('j-b1', 'Città di Bellinzona'), companyKey: 'citta-di-bellinzona' },
    ];
    const sections = buildRecipientSections(
      [alertDoc('a1', 'citta-di-bellinzona'), alertDoc('a2', 'citta-di-bellinzona')],
      bellinzona,
      NOW,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].jobs).toHaveLength(1);
  });

  it('keeps each section writing back its OWN sentJobIds map', () => {
    const sections = buildRecipientSections(
      [alertDoc('a1', 'coop', { sentJobIds: { 'j-old': NOW - 1000 } }), alertDoc('a2', 'coop-genossenschaft')],
      jobs,
      NOW,
    );
    const byId = new Map(sections.map((s: { alert: { id: string }; sentMap: object }) => [s.alert.id, s.sentMap]));
    expect(byId.get('a1')).toEqual({ 'j-old': NOW - 1000 });
    expect([...byId.keys()]).toEqual(['a1']);
  });
});

describe('one follow per group on the site', () => {
  const rows = [
    { id: 'r-city', specificCompanyKey: 'coop-city', active: true },
    { id: 'r-gen', specificCompanyKey: 'coop-genossenschaft', active: true },
  ];

  it('the Coop page sees the Coop Genossenschaft follow as «following»', () => {
    expect(findCompanyAlertForKey(rows, 'coop')?.id).toBe('r-gen');
  });

  it('prefers the exact pin and ignores inactive rows', () => {
    expect(findCompanyAlertForKey([...rows, { id: 'r-coop', specificCompanyKey: 'coop', active: true }], 'coop')?.id)
      .toBe('r-coop');
    expect(findCompanyAlertForKey([{ id: 'off', specificCompanyKey: 'coop-genossenschaft', active: false }], 'coop'))
      .toBeNull();
    expect(findCompanyAlertForKey(rows, 'migros')).toBeNull();
  });

  it('never suggests the other member of a followed group', () => {
    const counts = { coop: 800, 'coop-genossenschaft': 780, 'coop-city': 70, migros: 300 };
    const slugs = rankEmployerSuggestions(counts, ['coop'], { limit: 10, minActiveJobs: 1 }).map((s) => s.slug);
    expect(slugs).not.toContain('coop-genossenschaft');
    expect(slugs).not.toContain('coop');
    expect(slugs).toContain('migros');
  });
});

describe('Cloud Functions mirror of the groups (bundle cannot import outside functions/)', () => {
  it('maps exactly the same members to the same group key', () => {
    const cf = readFileSync(path.resolve(__dirname, '../functions/src/newsletterSubscriptionManagement.js'), 'utf-8');
    const block = /const COMPANY_FOLLOW_GROUP_KEY = Object\.freeze\(\{[\s\S]*?\n\}\);/.exec(cf)?.[0] || '';
    expect(block).toBeTruthy();
    // eslint-disable-next-line no-new-func
    const mirror = new Function(`${block}; return COMPANY_FOLLOW_GROUP_KEY;`)() as Record<string, string>;
    const source = Object.fromEntries(COMPANY_FOLLOW_GROUPS.flatMap((group) => group.map((m) => [m, group[0]])));
    expect(mirror).toEqual(source);
  });
});
