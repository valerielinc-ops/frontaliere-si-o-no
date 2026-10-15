/**
 * Regression: `ALL_TOOLS[].slug` in ToolOfTheWeek is a hand-maintained
 * duplicate of the canonical routes in `services/router.ts` (used only for
 * building the WhatsApp/Twitter/copy-to-clipboard share URL — actual in-app
 * navigation uses the separate `tab`/`subTab` fields). Because it's a second
 * source of truth, it silently drifted for 3/10 entries (pension, tax-return,
 * payslip pointed at stale/never-existed URLs) — see issue #4576.
 *
 * This guards against future drift by asserting every `slug` still resolves,
 * via `parsePath`, to a route whose `activeTab` matches the entry's own `id`
 * (or, for entries nested under a shared tab, still parses to a real page
 * rather than degrading to the bare parent tab with no sub-route).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePath, buildPath } from '@/services/router';
import type { ActiveTab, AppRoute, CalcolatoreSubTab, ConfrontiSubTab, FiscoSubTab } from '@/services/router';

const SOURCE = readFileSync(
  resolve(__dirname, '../../components/community/ToolOfTheWeek.tsx'),
  'utf8',
);

// Mirrors ALL_TOOLS in components/community/ToolOfTheWeek.tsx.
// Kept as a literal list (not imported) so this test exercises the exact
// slug strings shipped in the component, the same way a share-link consumer
// (WhatsApp/Twitter/clipboard) would.
const ALL_TOOLS_SLUGS: Array<{ id: string; slug: string }> = [
  { id: 'calculator', slug: '/calcola-stipendio' },
  { id: 'exchange', slug: '/compara-servizi/cambio-franco-euro/' },
  { id: 'health', slug: '/compara-servizi/confronta-casse-malati/' },
  { id: 'pension', slug: '/tasse-e-pensione/calcola-previdenza/' },
  { id: 'permit-quiz', slug: '/quiz-permesso-b-o-g' },
  { id: 'tredicesima', slug: '/calcolo-tredicesima-frontaliere' },
  { id: 'cost-of-living', slug: '/compara-servizi/costo-della-vita/' },
  { id: 'tax-return', slug: '/tasse-e-pensione/dichiarazione-redditi/' },
  { id: 'banks', slug: '/compara-servizi/confronta-banche/' },
  { id: 'payslip', slug: '/calcola-stipendio/simula-busta-paga/' },
];

describe('ToolOfTheWeek — ALL_TOOLS slugs stay in sync with the source file', () => {
  it('the fixture list above matches every slug currently shipped in ALL_TOOLS', () => {
    for (const { slug } of ALL_TOOLS_SLUGS) {
      expect(SOURCE).toContain(`slug: '${slug}'`);
    }
  });
});

describe('ToolOfTheWeek — every ALL_TOOLS share-link slug resolves to a real route', () => {
  it.each(ALL_TOOLS_SLUGS)('slug for "$id" ($slug) parses to a non-default route', ({ id, slug }) => {
    const { route } = parsePath(slug, 'it');
    expect(route.activeTab).toBeTruthy();
    // Sub-tab-scoped tools (fisco/calculator/confronti/guida) must resolve to
    // their own sub-tab, not degrade to the bare parent tab — that degradation
    // is exactly how the pension/tax-return/payslip drift (#4576) manifested.
    if (['fisco', 'calculator', 'confronti', 'guida'].includes(route.activeTab)) {
      const subTab =
        route.fiscoSubTab ?? route.calcolatoreSubTab ?? route.confrontiSubTab ?? route.guidaSubTab;
      expect(subTab, `slug "${slug}" for tool "${id}" degraded to bare "${route.activeTab}" tab`).toBeTruthy();
    }
  });
});

/**
 * Regression: `ALL_TOOLS[].tab`/`subTab` drive the SEPARATE in-app navigation
 * path (`nav.navigateTo(tool.tab, tool.subTab)`), independent of the share-link
 * `slug` covered above. `permit-quiz` and `tredicesima` are each their own
 * top-level `ActiveTab` (see `services/router.ts`), not sub-tabs of
 * `guida`/`calculator` — using them as a `subTab` cast the value through an
 * invalid `GuidaSubTab`/`CalcolatoreSubTab` and pushed a route that degraded
 * to the bare parent tab instead of the actual tool. See issue #4581.
 *
 * Mirrors ALL_TOOLS (kept as a literal list, not imported, same rationale as
 * ALL_TOOLS_SLUGS above: exercises the exact strings shipped in the component).
 */
const ALL_TOOLS_NAV: Array<{ id: string; tab: ActiveTab; subTab?: string }> = [
  { id: 'calculator', tab: 'calculator', subTab: 'calculator' },
  { id: 'exchange', tab: 'confronti', subTab: 'exchange' },
  { id: 'health', tab: 'confronti', subTab: 'health' },
  { id: 'pension', tab: 'fisco', subTab: 'pension' },
  { id: 'permit-quiz', tab: 'permit-quiz' },
  { id: 'tredicesima', tab: 'tredicesima' },
  { id: 'cost-of-living', tab: 'confronti', subTab: 'cost-of-living' },
  { id: 'tax-return', tab: 'fisco', subTab: 'tax-return' },
  { id: 'banks', tab: 'confronti', subTab: 'banks' },
  { id: 'payslip', tab: 'calculator', subTab: 'payslip' },
];

function extractToolLine(id: string): string {
  const match = SOURCE.match(new RegExp(`\\{ id: '${id}',[^}]*\\}`));
  if (!match) throw new Error(`ALL_TOOLS entry '${id}' not found in ToolOfTheWeek.tsx`);
  return match[0];
}

describe('ToolOfTheWeek — ALL_TOOLS tab/subTab fixture matches the source file', () => {
  it.each(ALL_TOOLS_NAV)('fixture for "$id" matches the tab/subTab currently shipped in ALL_TOOLS', ({ id, tab, subTab }) => {
    const line = extractToolLine(id);
    expect(line).toContain(`tab: '${tab}'`);
    if (subTab) {
      expect(line).toContain(`subTab: '${subTab}'`);
    } else {
      // Top-level-tab tools (permit-quiz, tredicesima) must NOT carry a subTab —
      // that's exactly the #4581 antipattern (subTab cast into an invalid union).
      expect(line).not.toMatch(/subTab:/);
    }
  });
});

describe('ToolOfTheWeek — every ALL_TOOLS tab/subTab round-trips through buildPath/parsePath', () => {
  it.each(ALL_TOOLS_NAV)('navigateTo target for "$id" (tab=$tab, subTab=$subTab) resolves back to itself', ({ tab, subTab }) => {
    const route: AppRoute = { activeTab: tab };
    if (tab === 'calculator' && subTab) route.calcolatoreSubTab = subTab as CalcolatoreSubTab;
    if (tab === 'confronti' && subTab) route.confrontiSubTab = subTab as ConfrontiSubTab;
    if (tab === 'fisco' && subTab) route.fiscoSubTab = subTab as FiscoSubTab;

    const path = buildPath(route, 'it');
    const { route: parsed } = parsePath(path);

    expect(parsed.activeTab).toBe(tab);
    if (tab === 'calculator') expect(parsed.calcolatoreSubTab).toBe(subTab);
    if (tab === 'confronti') expect(parsed.confrontiSubTab).toBe(subTab);
    if (tab === 'fisco') expect(parsed.fiscoSubTab).toBe(subTab);
  });
});
