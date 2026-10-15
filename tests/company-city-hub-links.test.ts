/**
 * Ogni hub azienda × città (Phase 3.4 di jobsSeoPagesPlugin) ha un link dalle
 * sue pagine madri: l'hub città e l'hub azienda del cantone.
 *
 * Root cause misurata sul build f3659686 (deploy run 36965808597): i 3 112 hub
 * azienda × città erano in `sitemap-jobs.xml` (priority 0.65) ma nessuna
 * pagina li linkava, perché l'insieme degli hub emessi esisteva solo dentro
 * il loop dell'emettitore. Nella sezione Zurigo 587 hub su 587 avevano zero
 * link in ingresso: erano 587 delle 718 URL che `audit:max-bfs-depth` conta
 * come sepolte. Ricalcolando la BFS dello stesso dist con i link aggiunti da
 * questa correzione, Zurigo scende da 718 a 45.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  MIN_JOBS_PER_CANTON_COMPANY_CITY,
  buildCompanyCityPlan,
  companyCityLinksForCompany,
  companyCityLinksForJobs,
  companyCityRawLocation,
  isEmittedCompanyCityHub,
  renderCompanyCityLinks,
  type CompanyCityKeyDeps,
} from '../build-plugins/shared/companyCityHubPlan';

type Job = { company: string; location: string; canton: string };

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const deps: CompanyCityKeyDeps<Job> = {
  resolveCanton: (j) => j.canton,
  companySlug: (j) => slug(j.company),
  location: (j) => j.location,
  company: (j) => j.company,
  citySlug: (raw) => slug(raw),
};

const JOBS: Job[] = [
  { company: 'Coop Genossenschaft', location: 'Zürich', canton: 'ZH' },
  { company: 'Coop Genossenschaft', location: 'Zürich, ZH', canton: 'ZH' },
  { company: 'Coop Genossenschaft', location: 'Winterthur (ZH)', canton: 'ZH' },
  { company: 'Coop Genossenschaft', location: 'Winterthur', canton: 'ZH' },
  { company: 'Coop Genossenschaft', location: 'Winterthur', canton: 'ZH' },
  { company: 'Stellentreff AG', location: 'Zürich', canton: 'ZH' },
  { company: 'Stellentreff AG', location: 'Zürich', canton: 'ZH' },
  { company: 'Solo SA', location: 'Zürich', canton: 'ZH' },
  { company: 'Coop', location: 'Lugano', canton: 'TI' },
  { company: 'Coop', location: 'Lugano', canton: 'TI' },
  { company: 'Senza Città', location: '', canton: 'ZH' },
  { company: 'Senza Città', location: '', canton: 'ZH' },
];

describe('buildCompanyCityPlan', () => {
  const plan = buildCompanyCityPlan(JOBS, deps);

  it('raggruppa per (cantone, azienda, città) con la chiave dell\'emettitore', () => {
    const zh = plan.get('ZH')!;
    expect([...zh.keys()].sort()).toEqual(['coop-genossenschaft', 'solo-sa', 'stellentreff-ag']);
    expect(zh.get('coop-genossenschaft')!.get('zurich')!.jobs).toHaveLength(2);
    expect(zh.get('coop-genossenschaft')!.get('winterthur')!.jobs).toHaveLength(3);
  });

  it('esclude il Ticino e i job senza località', () => {
    expect(plan.has('TI')).toBe(false);
    expect(plan.get('ZH')!.has('senza-citta')).toBe(false);
  });

  it('emette un hub solo dalla soglia in su', () => {
    expect(MIN_JOBS_PER_CANTON_COMPANY_CITY).toBe(2);
    expect(isEmittedCompanyCityHub(plan.get('ZH')!.get('solo-sa')!.get('zurich'))).toBe(false);
    expect(isEmittedCompanyCityHub(plan.get('ZH')!.get('stellentreff-ag')!.get('zurich'))).toBe(true);
  });

  it('usa il testo prima di "," o "(" come località', () => {
    expect(companyCityRawLocation('Winterthur (ZH)')).toBe('Winterthur');
    expect(companyCityRawLocation('Zürich, ZH')).toBe('Zürich');
  });
});

describe('ogni hub emesso è linkato da una pagina madre', () => {
  const plan = buildCompanyCityPlan(JOBS, deps);
  const emitted = new Set<string>();
  for (const [canton, byCompany] of plan) {
    for (const [company, byCity] of byCompany) {
      for (const [city, bucket] of byCity) if (isEmittedCompanyCityHub(bucket)) emitted.add(`${canton}|${company}|${city}`);
    }
  }

  it('l\'hub città linka gli hub azienda × città dei suoi job (tutti, non solo le card)', () => {
    const zurichJobs = JOBS.filter((j) => j.canton === 'ZH' && slug(companyCityRawLocation(j.location)) === 'zurich');
    const links = companyCityLinksForJobs(plan, zurichJobs, deps);
    expect(links.map((l) => `${l.companySlug}|${l.citySlug}|${l.count}`)).toEqual([
      'coop-genossenschaft|zurich|2',
      'stellentreff-ag|zurich|2',
    ]);
  });

  it('l\'hub azienda linka tutte le sue sedi emesse, la più grande per prima', () => {
    expect(companyCityLinksForCompany(plan, 'ZH', 'coop-genossenschaft').map((l) => `${l.citySlug}|${l.count}`))
      .toEqual(['winterthur|3', 'zurich|2']);
    expect(companyCityLinksForCompany(plan, 'ZH', 'solo-sa')).toEqual([]);
    expect(companyCityLinksForCompany(plan, 'TI', 'coop')).toEqual([]);
  });

  it('l\'unione dei link copre ogni hub emesso e nient\'altro', () => {
    const linked = new Set<string>();
    for (const canton of plan.keys()) {
      for (const company of plan.get(canton)!.keys()) {
        for (const l of companyCityLinksForCompany(plan, canton, company)) linked.add(`${canton}|${l.companySlug}|${l.citySlug}`);
      }
    }
    const byCity = new Map<string, Job[]>();
    for (const j of JOBS) {
      const k = `${j.canton}|${slug(companyCityRawLocation(j.location))}`;
      byCity.set(k, [...(byCity.get(k) ?? []), j]);
    }
    for (const jobs of byCity.values()) {
      for (const l of companyCityLinksForJobs(plan, jobs, deps)) linked.add(`${jobs[0].canton}|${l.companySlug}|${l.citySlug}`);
    }
    expect([...linked].sort()).toEqual([...emitted].sort());
  });
});

describe('renderCompanyCityLinks', () => {
  const plan = buildCompanyCityPlan(JOBS, deps);
  const links = companyCityLinksForCompany(plan, 'ZH', 'coop-genossenschaft');
  const href = (l: { companySlug: string; citySlug: string }) => `https://frontaliereticino.ch/cerca-lavoro-zurigo/azienda-${l.companySlug}-${l.citySlug}/`;

  it('una voce per hub, con anchor descrittivo e conteggio', () => {
    const html = renderCompanyCityLinks(links, 'it', 'Sedi di Coop Genossenschaft con offerte attive', (l) => l.cityDisplay, href);
    expect(html).toBe(
      '<section class="s-7uP4UM"><h2>Sedi di Coop Genossenschaft con offerte attive</h2><ul>'
      + '<li><a href="https://frontaliereticino.ch/cerca-lavoro-zurigo/azienda-coop-genossenschaft-winterthur/">Winterthur</a> — 3 offerte</li>'
      + '<li><a href="https://frontaliereticino.ch/cerca-lavoro-zurigo/azienda-coop-genossenschaft-zurich/">Zürich</a> — 2 offerte</li>'
      + '</ul></section>',
    );
  });

  it('nessun blocco vuoto, e il testo è escapato', () => {
    expect(renderCompanyCityLinks([], 'it', 'x', () => 'x', () => '/x/')).toBe('');
    const html = renderCompanyCityLinks(links.slice(0, 1), 'en', 'A & B', () => '<b>x</b>', () => '/a?b="c"');
    expect(html).toContain('<h2>A &amp; B</h2>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('href="/a?b=&quot;c&quot;"');
  });
});

describe('cablaggio in jobsSeoPagesPlugin', () => {
  const src = readFileSync(path.resolve(import.meta.dirname, '..', 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf8');
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    expect(i, needle).toBeGreaterThan(-1);
    return i;
  };

  it('il piano è costruito prima degli hub città, degli hub azienda e dell\'emettitore', () => {
    const plan = at('const companyCityPlan = buildCompanyCityPlan(validJobs, companyCityDeps);');
    expect(plan).toBeLessThan(at('/* ── Per-canton city hubs (Phase 3.1)'));
    expect(plan).toBeLessThan(at('/* ── Per-canton company hubs (Phase 3.3)'));
    expect(plan).toBeLessThan(at('/* ── Per-canton company × city hubs (Phase 3.4)'));
  });

  it('l\'emettitore usa il piano e lo stesso builder di path dei link', () => {
    const phase34 = src.slice(at('/* ── Per-canton company × city hubs (Phase 3.4)'));
    expect(phase34).toContain('const buckets = companyCityPlan;');
    expect(phase34).toContain('const canonicalPath = companyCityHubPath(locale, canton, cSlug, citySlug);');
    expect(phase34.slice(0, 4000)).not.toMatch(/for \(const job of validJobs\)/);
  });

  it('l\'hub città linka gli hub dei suoi job, l\'hub azienda le sue sedi', () => {
    const phase31 = src.slice(at('/* ── Per-canton city hubs (Phase 3.1)'), at('Per-canton paginated listing pages (Phase 3.5)'));
    expect(phase31).toContain('companyCityLinksForJobs(companyCityPlan, cityJobs, companyCityDeps)');
    expect(phase31).toMatch(/renderCompanyCityLinks\(cityCompanyCityLinks, locale, companyCityCityHubHeading\(locale, cityDisplay\), \(l\) => l\.companyName, \(l\) => `\$\{BASE_URL\}\$\{companyCityHubPath\(locale, canton, l\.companySlug, l\.citySlug\)\}`\)/);
    const phase33 = src.slice(at('/* ── Per-canton company hubs (Phase 3.3)'), at('/* ── Per-canton company × city hubs (Phase 3.4)'));
    expect(phase33).toContain('companyCityLinksForCompany(companyCityPlan, canton, cSlug)');
    expect(phase33).toContain('${companyLocationsHtml}');
  });
});
