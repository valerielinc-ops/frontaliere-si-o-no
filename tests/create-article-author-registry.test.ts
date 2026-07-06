// tests/create-article-author-registry.test.ts
//
// Live incident: the guest author "Samuele Valente" (data/authors.ts, added
// 2026-06-30 with expertise squarely about the Italia-Svizzera cross-border
// tax treaty) was never added to scripts/create-article.mjs's own AUTHORS
// mirror (a Node-ESM-can't-import-.ts copy, documented at that array's
// definition). pickAuthorForTopic() there could therefore never select them
// — a redazione article titled "L'Accordo Italia-Svizzera del 2020 sulla
// tassazione dei lavoratori frontalieri" fell through to marco-ferrari
// instead of the specialist it was clearly written for.
//
// These tests lock in the fix and guard against the two registries drifting
// out of sync again (same slug set, matching name/linkedin per slug).

import { describe, expect, it } from 'vitest';
import { AUTHORS as CANONICAL_AUTHORS } from '@/data/authors';
import { pickAuthorForTopic } from '../scripts/create-article.mjs';

describe('scripts/create-article.mjs AUTHORS mirror — stays in sync with data/authors.ts', () => {
  it('mirrors every canonical author slug (no guest author invisible to auto-assign)', () => {
    // Probing pickAuthorForTopic with each canonical author's own expertise
    // keywords should select that SAME author back — if a slug is missing
    // from the create-article.mjs mirror, the match falls through to a
    // different author (or round-robin) and this equality fails, catching
    // future drift the same way it silently broke for samuele-valente.
    for (const canonical of CANONICAL_AUTHORS) {
      const picked = pickAuthorForTopic(canonical.expertise.join(' ').toLowerCase(), `probe-${canonical.slug}`);
      expect(picked.slug, `expected ${canonical.slug} to be selected by its own expertise keywords`).toBe(canonical.slug);
    }
  });

  it("picks Samuele Valente for the article that caused the live incident", () => {
    const title = "L'Accordo Italia-Svizzera del 2020 sulla tassazione dei lavoratori frontalieri";
    const id = 'laccordo-italia-svizzera-del-2020-sulla-tassazione-dei-lavoratori-frontalieri';
    const haystack = ['fiscale', title, id].join(' ');
    const picked = pickAuthorForTopic(haystack, id);
    expect(picked.slug).toBe('samuele-valente');
    expect(picked.name).toBe('Samuele Valente');
  });

  it("Samuele Valente's mirrored name/linkedin match the canonical registry", () => {
    const canonical = CANONICAL_AUTHORS.find((a) => a.slug === 'samuele-valente');
    expect(canonical).toBeTruthy();
    const picked = pickAuthorForTopic(canonical!.expertise.join(' ').toLowerCase(), 'probe-samuele-valente');
    expect(picked.name).toBe(canonical!.name);
    expect(picked.linkedinUrl).toBe(canonical!.social.linkedin);
  });

  // Review finding on this PR: optimizeSeoMetadata()'s baseKeywords appends
  // 'frontalieri' to every article's seo.keywords, which feeds into this
  // scorer's haystack — an unrelated pensions/customs/wage article (laura-
  // bianchi's/redazione's domain) must NOT tie-break to the fiscal-treaty
  // guest specialist just because 'frontalieri' is universally present.
  it('does not misassign an unrelated pensions article to samuele-valente via the universal "frontalieri" keyword', () => {
    const title = 'AVS e LPP per i frontalieri: guida alla previdenza in Svizzera 2026';
    const id = 'avs-lpp-frontalieri-previdenza-svizzera-2026';
    // Mirrors optimizeSeoMetadata()'s baseKeywords + a couple of real terms.
    const seoKeywords = 'frontalieri, ticino, svizzera, italia, avs, lpp';
    const haystack = ['pensione', title, id, seoKeywords].join(' ');
    const picked = pickAuthorForTopic(haystack, id);
    expect(picked.slug).toBe('laura-bianchi');
  });

  it('does not misassign an unrelated customs/wage article to samuele-valente via the universal "frontalieri" keyword', () => {
    const title = 'Dogana e trasporti per i lavoratori frontalieri: cosa sapere';
    const id = 'dogana-trasporti-lavoratori-frontalieri';
    const seoKeywords = 'frontalieri, ticino, svizzera, italia, dogana';
    const haystack = ['pratico', title, id, seoKeywords].join(' ');
    const picked = pickAuthorForTopic(haystack, id);
    expect(picked.slug).toBe('redazione');
  });
});
