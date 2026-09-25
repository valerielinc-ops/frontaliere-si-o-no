import { describe, expect, it } from 'vitest';
// Guard for #1997 (IT subset): the canton-snapshot prose linked the IT comparator
// cross-links at paths that 404 on the live site —
//   health: /comparatori/casse-malati/      → canonical /compara-servizi/confronta-casse-malati/
//   fuel:   /prezzi-benzina-svizzera/        → canonical /prezzi-benzina/oggi/
// (FX /comparatori/cambio-valuta/ was already canonical.) These were dead internal
// links on indexed primary-locale pages (link-equity loss). This renders the actual
// IT prose and locks the canonical hrefs so the 404 variants can't reappear.
import {
  buildSnapshotProseBlock,
} from '@/build-plugins/shared/cantonSnapshotProse';

const IT_CANONICAL = {
  // IT FX now points at the DIRECT canonical (no 301-redirect hop via the
  // /comparatori/cambio-valuta/ bridge), sourced from the comparatorHref SSOT (#1997).
  fx: '/compara-servizi/cambio-franco-euro/',
  health: '/compara-servizi/confronta-casse-malati/',
  fuel: '/prezzi-benzina/oggi/',
};
const IT_DEAD = ['/comparatori/casse-malati/', '/prezzi-benzina-svizzera/', '/comparatori/cambio-valuta/'];

describe('canton snapshot prose IT comparator cross-links (#1997)', () => {
  const html = buildSnapshotProseBlock({
    locale: 'it',
    cantonDisplay: 'Zurigo',
    totalJobs: 42,
    ctaHref: '/cerca-lavoro-ticino/azienda-x/',
    ctaLabel: 'Offerte',
  });

  it('links the IT comparators at their canonical (live-200) paths', () => {
    expect(html).toContain(`href="${IT_CANONICAL.fx}"`);
    expect(html).toContain(`href="${IT_CANONICAL.health}"`);
    expect(html).toContain(`href="${IT_CANONICAL.fuel}"`);
  });

  it('never re-introduces the dead (404) IT comparator paths', () => {
    for (const dead of IT_DEAD) expect(html).not.toContain(dead);
  });
});
