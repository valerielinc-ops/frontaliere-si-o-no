/**
 * Guard for the employer-landing section matchers
 * (scripts/lib/employerLandingSections.mjs) and the two audit classifiers
 * that now share them (scripts/audit-title-length.mjs, re-exported to
 * audit-h1-title-duplicates; scripts/audit-text-html-ratio.mjs).
 *
 * Regression context (audit:all post-deploy failure, weekly-employers
 * 1360>12): audit-title-length's classifier lumped the evergreen
 * `cerca-lavoro-ticino/azienda-{slug}` company-landing pages into the
 * `weekly-employers` bucket instead of the separate `career-landings` bucket
 * audit-text-html-ratio already used — so the bucket's baseline (calibrated
 * on the small, genuine weekly-employers population) blew up once the
 * career-landings company set grew. Its weekly-employers-hub alternation
 * also carried a typo'd German slug (`unternehmen-die-einstellen`, which
 * nothing generates — the real slug is `unternehmen-einstellen`, see
 * build-plugins/weeklyEmployersData.ts) and was missing the French weekly
 * slug `entreprises-recrutent` entirely, so DE/FR weekly-employer pages fell
 * through to the generic `spa-locale` bucket (contributing to that bucket's
 * own 31>30 drift).
 */
import { describe, it, expect } from 'vitest';
import {
  classifyEmployerLandingFeature,
  CAREER_LANDINGS_RX,
  WEEKLY_EMPLOYERS_LEAF_RX,
  WEEKLY_EMPLOYERS_HUB_RX,
} from '../../scripts/lib/employerLandingSections.mjs';
import { classifyFeature as classifyFeatureTitleLength } from '../../scripts/audit-title-length.mjs';
import { classifyFeature as classifyFeatureTextRatio } from '../../scripts/audit-text-html-ratio.mjs';

// Both classifyFeature functions take a dist-relative path (with `dist/`
// prefix + index.html).
const rel = (p: string) => `dist${p}index.html`;

describe('employer-landing section matchers', () => {
  const careerLandingPaths = [
    '/cerca-lavoro-ticino/azienda-grichting-valterio-electro-sa/',
    '/find-jobs-ticino/company-medacta-international-sa/',
    '/de/jobs-im-tessin/unternehmen-oscam-ospedale-e-casa-anziani-malcantonese/',
    '/fr/trouver-emploi-tessin/entreprise-medacta-international-sa/',
  ];
  it.each(careerLandingPaths)('classifies %s as career-landings (not weekly-employers)', (p) => {
    expect(classifyEmployerLandingFeature(p)).toBe('career-landings');
    expect(classifyFeatureTitleLength(rel(p))).toBe('career-landings');
    expect(classifyFeatureTextRatio(rel(p))).toBe('career-landings');
  });

  // Every locale weekly-snapshot slug (build-plugins/weeklyEmployersData.ts) —
  // DE/FR use a DIFFERENT slug for the weekly leaf than for the all-companies
  // hub (see WEEKLY_EMPLOYERS_HUB_RX suite below).
  const weeklyEmployerLeafPaths = [
    '/aziende-che-assumono/lugano/acme-sa/settimana-corrente/',
    '/companies-hiring/lugano/acme-sa/current-week/',
    '/de/unternehmen-einstellen/lugano/acme-sa/aktuelle-woche/',
    '/fr/entreprises-recrutent/lugano/acme-sa/semaine-actuelle/',
  ];
  it.each(weeklyEmployerLeafPaths)('classifies %s as weekly-employers', (p) => {
    expect(classifyEmployerLandingFeature(p)).toBe('weekly-employers');
    expect(classifyFeatureTitleLength(rel(p))).toBe('weekly-employers');
    expect(classifyFeatureTextRatio(rel(p))).toBe('weekly-employers');
  });

  // The city/all-companies index hub — IT/EN reuse the weekly slug, DE/FR use
  // a distinct all-companies-hub slug (build-plugins/seoHubsData.ts).
  const weeklyEmployerHubPaths = [
    '/aziende-che-assumono/tutte/',
    '/companies-hiring/all/',
    '/de/firmen-die-einstellen/alle/',
    '/fr/entreprises-qui-recrutent/toutes/',
  ];
  it.each(weeklyEmployerHubPaths)('classifies %s as weekly-employers-hub', (p) => {
    expect(classifyEmployerLandingFeature(p)).toBe('weekly-employers-hub');
    expect(classifyFeatureTitleLength(rel(p))).toBe('weekly-employers-hub');
    expect(classifyFeatureTextRatio(rel(p))).toBe('weekly-employers-hub');
  });

  it('DE weekly-employer leaf slug (unternehmen-einstellen) is distinct from the DE hub slug (firmen-die-einstellen)', () => {
    expect(WEEKLY_EMPLOYERS_LEAF_RX.test('/de/unternehmen-einstellen/lugano/acme-sa/aktuelle-woche/')).toBe(true);
    expect(WEEKLY_EMPLOYERS_HUB_RX.test('/de/firmen-die-einstellen/alle/')).toBe(true);
  });

  it('FR weekly-employer leaf slug (entreprises-recrutent) is distinct from the FR hub slug (entreprises-qui-recrutent)', () => {
    expect(WEEKLY_EMPLOYERS_LEAF_RX.test('/fr/entreprises-recrutent/lugano/acme-sa/semaine-actuelle/')).toBe(true);
    expect(WEEKLY_EMPLOYERS_HUB_RX.test('/fr/entreprises-qui-recrutent/toutes/')).toBe(true);
  });

  it('the old typo\'d German slug (unternehmen-die-einstellen) matches nothing — regression guard', () => {
    expect(CAREER_LANDINGS_RX.test('/de/unternehmen-die-einstellen/lugano/')).toBe(false);
    expect(WEEKLY_EMPLOYERS_LEAF_RX.test('/de/unternehmen-die-einstellen/lugano/')).toBe(false);
    expect(WEEKLY_EMPLOYERS_HUB_RX.test('/de/unternehmen-die-einstellen/lugano/')).toBe(false);
  });

  const nonEmployerPaths = [
    '/blog/qualche-articolo/',
    '/en/tax/',
    '/de/grenzgaenger-ratgeber/versteckte-kosten-chf-eur-wechselkurs-nettogehalt/',
    '/fr/prix-gasoil-suisse/italie/como/aujourd-hui/',
  ];
  it.each(nonEmployerPaths)('does NOT classify %s as any employer-landing feature', (p) => {
    expect(classifyEmployerLandingFeature(p)).toBeNull();
  });

  it('regex is anchored on a path boundary (no mid-segment false match)', () => {
    expect(CAREER_LANDINGS_RX.test('/blog/come-trovare-azienda-ideale/')).toBe(false);
    expect(WEEKLY_EMPLOYERS_LEAF_RX.test('/blog/aziende-che-assumono-di-piu-nel-2026/')).toBe(false);
  });
});
