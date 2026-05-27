#!/usr/bin/env node
/**
 * Michel Gruppe AG — Jobalino umbrella tenant.
 *
 * Michel Gruppe AG is the parent organisation of Privatklinik Meiringen
 * (BE) and Klinik Aadorf (TG). The umbrella tenant `michel-gruppe-ag`
 * exposes corporate-HQ openings (HR, IT, Finanz) plus — when posted at
 * the group level — any sibling clinic openings that aren't attached to
 * the dedicated Meiringen tenant. Probe May 2026: 4 openings, all tagged
 * `Michel Gruppe AG`.
 *
 * Klinik Aadorf does NOT have a standalone Jobalino tenant (probed
 * `klinik-aadorf`, `privatklinik-aadorf` — both 404 "Firma nicht
 * gefunden"). Its career page only offers spontaneous applications.
 * Any Aadorf openings are expected to surface here when posted.
 *
 * Public career anchor: https://privatklinik-meiringen.ch/karriere/
 * (Michel Gruppe AG does not run its own consumer-facing career page.)
 *
 * See `scripts/lib/jobalino-common.mjs` for the shared factory.
 */
import { createJobalinoParser } from './jobalino-common.mjs';

export const MICHEL_GRUPPE_KEY = 'michel-gruppe-ag';
export const MICHEL_GRUPPE_COMPANY_NAME = 'Michel Gruppe AG';
export const MICHEL_GRUPPE_COMPANY_DOMAIN = 'michel-gruppe.ch';

const parser = createJobalinoParser({
  jobalinoCompanySlug: 'michel-gruppe-ag',
  locale: 'de',
  companyKey: MICHEL_GRUPPE_KEY,
  companyName: MICHEL_GRUPPE_COMPANY_NAME,
  companyDomain: MICHEL_GRUPPE_COMPANY_DOMAIN,
  publicCareerUrl: 'https://privatklinik-meiringen.ch/karriere/',
  defaultCanton: 'BE',
  defaultCity: 'Meiringen',
  defaultPostalCode: '3860',
  defaultSourceLang: 'de',
  sourceLabel: 'Michel Gruppe AG Dedicated Parser (Jobalino umbrella)',
});

export const fetchAllMichelGruppeJobs = parser.fetchAllJobs;
export const isMichelGruppeJob = parser.isCompanyJob;
export const isTrustedDomain = parser.isTrustedDomain;
