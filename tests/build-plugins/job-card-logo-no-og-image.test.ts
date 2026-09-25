/**
 * Regression guard: a job card must NEVER render the site's generic OG image
 * (`/og-image.png`) as a company logo.
 *
 * The bug (live on every company hub of an uncurated employer, e.g.
 * /cerca-lavoro-ticino/azienda-hotel-international-au-lac/): a LOCAL constant in
 * `build-plugins/jobsSeoPagesPlugin.ts` named `COMPANY_LOGO_PLACEHOLDER` — same
 * name as the canonical one in `services/logoService.ts`, different value
 * (`${BASE_URL}/og-image.png`) — is a JSON-LD-only filler for
 * `hiringOrganization.logo`. It was passed as the `logoUrl` override to
 * `renderJobCardHtml`, which treats any non-nullish `opts.logoUrl` as
 * authoritative and skips its own `resolveJobCardLogo` chain. `renderLogoSlot`
 * knows nothing about that local constant, so it emitted it verbatim as
 * `<img src>`, replacing the deterministic coloured-initials badge on every
 * card of every company lacking a `CRAWLED_COMPANY_LOGOS` entry.
 *
 * Two layers, because each alone would have missed the defect:
 *  1. behavioural — the shared renderer, left to resolve on its own, produces
 *     the initials badge and never the OG image;
 *  2. source-scan — no `renderJobCardHtml` call site in `jobsSeoPagesPlugin.ts`
 *     re-introduces a `logoUrl` fed by the JSON-LD filler. The plugin is
 *     scanned, not imported, because importing a build plugin pulls ~12 files
 *     under `data/` and `public/assets/` at module scope and is red in a sparse
 *     worktree (CLAUDE.md, «Stato macchina»).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  renderJobCardHtml,
  type JobCardJob,
} from '../../build-plugins/shared/jobCardHtml';
import { CRAWLED_COMPANY_LOGOS } from '../../services/jobDataNormalization';
import { generateInitialsLogo } from '../../services/logoService';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

// The employer the defect was first observed on. Asserting it is genuinely
// uncurated keeps the fixture honest: if someone later adds a curated asset for
// it, this fails loudly instead of silently testing the wrong branch.
const UNCURATED_KEY = 'hotel-international-au-lac';

const uncuratedJob: JobCardJob = {
  title: 'Receptionist',
  company: 'Hotel International au Lac',
  companyKey: UNCURATED_KEY,
  location: 'Lugano',
  canton: 'TI',
  contract: 'full-time',
  postedDate: '2026-03-07',
};

describe('job card logo — never the site OG image', () => {
  it('the fixture company really has no curated logo entry', () => {
    expect(CRAWLED_COMPANY_LOGOS[UNCURATED_KEY]).toBeUndefined();
  });

  it('renders the deterministic initials badge, not og-image.png', () => {
    const html = renderJobCardHtml(uncuratedJob, { href: '/x/', locale: 'it' });

    expect(html).not.toContain('og-image.png');
    // The canonical fallback for a company with a name is the coloured-initials
    // data URI from `resolveJobLogoSrc` — byte-identical to the SPA badge.
    expect(html).toContain(
      `src="${generateInitialsLogo(uncuratedJob.company as string)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')}"`,
    );
  });

  it('never emits og-image.png for any uncurated company', () => {
    for (const company of ['Studio Legale Rossi', 'Garage Bianchi SA', 'Café Milano']) {
      const html = renderJobCardHtml(
        { ...uncuratedJob, company, companyKey: 'not-in-the-curated-map' },
        { href: '/x/', locale: 'it' },
      );
      expect(html, `og image leaked for ${company}`).not.toContain('og-image.png');
      expect(html, `no initials badge for ${company}`).toContain('src="data:image/svg+xml');
    }
  });
});

describe('jobsSeoPagesPlugin — no logoUrl override on job cards', () => {
  const source = readFileSync(
    path.join(REPO_ROOT, 'build-plugins/jobsSeoPagesPlugin.ts'),
    'utf8',
  );

  it('no renderJobCardHtml call site passes a logoUrl', () => {
    // Grab the options-object literal of every `renderJobCardHtml(x, { … })`
    // call and assert none of them carries a `logoUrl` key. A future caller
    // with a genuinely curated URL would have to update this guard on purpose.
    const calls = [...source.matchAll(/renderJobCardHtml\([^,]+,\s*\{/g)];
    expect(calls.length, 'expected renderJobCardHtml call sites').toBeGreaterThan(0);

    for (const match of calls) {
      const start = (match.index ?? 0) + match[0].length - 1;
      let depth = 0;
      let end = start;
      for (let i = start; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const optsLiteral = source.slice(start, end + 1);
      expect(
        optsLiteral,
        'renderJobCardHtml must resolve the logo itself (resolveJobCardLogo); ' +
          'passing logoUrl re-opens the og-image.png regression',
      ).not.toMatch(/\blogoUrl\b/);
    }
  });

  it('the JSON-LD-only filler is not named like the canonical placeholder', () => {
    // The name collision with `services/logoService.ts`'s
    // `COMPANY_LOGO_PLACEHOLDER` is what made the misuse look correct.
    expect(source).not.toMatch(/const\s+COMPANY_LOGO_PLACEHOLDER\s*=/);
    expect(source).toMatch(/const\s+COMPANY_LOGO_JSONLD_FALLBACK\s*=/);
  });

  it('the JSON-LD filler is still used for hiringOrganization.logo', () => {
    // Guard the other direction: the fix must not have removed the legitimate
    // schema.org usage, only the visible-rendering one.
    expect(source).toMatch(/COMPANY_LOGO_JSONLD_FALLBACK/);
  });
});
