/**
 * Static salary/profession landing ad contract.
 *
 * These indexable SSG families share the same data-first page shape: the
 * drive-by display follows the primary metrics, the in-article unit follows
 * the data/CTA block, and the multiplex remains at the end of the content.
 * Bridges and noindex pages are intentionally outside this contract.
 */
import { describe, expect, it } from 'vitest';

import { AD_SLOTS } from '../../services/adsenseSlots';
import {
  __renderAgePageForTest,
  __renderEducationPageForTest,
} from '../../build-plugins/bfsSalaryLandingsPlugin';
import { renderSalaryProfessionCantonPage } from '../../build-plugins/salaryProfessionCantonPages';
import { renderProfessionCantonPage } from '../../build-plugins/professionCantonLandings';
import { renderProfessionCityPage } from '../../build-plugins/professionCityLandings';
import { __renderFrSalaireNetPageForTest } from '../../build-plugins/frSalaireNetLandingPlugin';

const SNAPSHOT = {
  liveCount: 12,
  fresh30Count: 5,
  medianSalaryChf: 84_000,
  featured: [],
  topEmployers: [{ name: 'Ospedale Regionale', count: 6 }],
};

const SALARY_PRESET = {
  id: 'infermiere',
  label: { it: 'Infermiere', en: 'Nurse', de: 'Pflegefachperson', fr: 'Infirmier·ère' },
  medianSalaryChf: 75_250,
};

function renderedSlots(html: string): string[] {
  return [...html.matchAll(/<ins\b[^>]*class=["']?adsbygoogle[^>]*>/g)].map((match) => {
    const slot = /data-ad-slot=["']?([^\s"'>]+)/.exec(match[0]);
    return slot?.[1] ?? '';
  });
}

function expectDataFirstAdContract(html: string): void {
  expect(renderedSlots(html)).toEqual([
    AD_SLOTS.FT_DRIVEBY_ATF_DISPLAY.slot,
    AD_SLOTS.ARTICLE_INLINE_MOBILE.slot,
    AD_SLOTS.SSG_END_MULTIPLEX.slot,
  ]);
}

describe('salary/profession SSG landing ad slots', () => {
  it('keeps the three slots in order on every audited renderer', () => {
    expectDataFirstAdContract(__renderAgePageForTest({ locale: 'it', age: 30, dateStamp: '2026-09-27' }).html);
    expectDataFirstAdContract(__renderEducationPageForTest({ locale: 'fr', eduId: 'universita', dateStamp: '2026-09-27' }).html);
    expectDataFirstAdContract(
      renderSalaryProfessionCantonPage({
        locale: 'it', cantonKey: 'ZH', id: 'infermiere', preset: SALARY_PRESET, snapshot: SNAPSHOT, distDir: '',
      }).html,
    );
    expectDataFirstAdContract(
      renderProfessionCantonPage({
        locale: 'it', cantonKey: 'ZH', id: 'infermiere', snapshot: SNAPSHOT, distDir: '',
      }).html,
    );
    expectDataFirstAdContract(
      renderProfessionCityPage({
        locale: 'it', cityKey: 'lugano', id: 'infermiere', snapshot: SNAPSHOT, distDir: '',
      }).html,
    );
    expectDataFirstAdContract(
      __renderFrSalaireNetPageForTest({ distDir: '', dateStamp: '2026-09-27' }).html,
    );
  });
});
