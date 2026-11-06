import { describe, expect, it } from 'vitest';
// Guard for #1948: cantonSnapshotProse kept its OWN local calculator-path
// table that drifted from the canonical CALC_HREF — the DE cross-link pointed
// at a dead /de/lohnrechner/ (404, no page emitter, no redirect) and EN/FR at
// 301-redirect hops. The fix wires the snapshot prose to the shared leaf
// module shared/calcHref.ts (single source of truth). This test renders the
// actual prose so any future drift / re-introduced local table fails HERE,
// pre-merge.
import {
  buildSnapshotProseBlock,
  type SnapshotLocale,
} from '@/build-plugins/shared/cantonSnapshotProse';
import { CALC_HREF } from '@/build-plugins/shared/calcHref';

const LOCALES: SnapshotLocale[] = ['it', 'en', 'de', 'fr'];

describe('canton snapshot prose calculator cross-link (SSOT guard)', () => {
  it.each(LOCALES)(
    'renders the %s snapshot prose with the canonical calculator href',
    (locale) => {
      const html = buildSnapshotProseBlock({
        locale,
        cantonDisplay: 'Zurigo',
        totalJobs: 42,
        ctaHref: '/lavoro-frontalieri-zurigo/',
        ctaLabel: 'Offerte a Zurigo',
      });
      expect(html).toContain(`href="${CALC_HREF[locale]}"`);
      // The dead DE link and the EN/FR redirect hops must never reappear.
      expect(html).not.toContain('/de/lohnrechner/');
      expect(html).not.toContain('/en/salary-calculator/');
      expect(html).not.toContain('/fr/calculateur-salaire/');
      expect(html).not.toContain('undefined');
    },
  );
});
