import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  STANDARD_ARTICLE_AD_DENSITY,
  LONGFORM_ARTICLE_AD_DENSITY,
  LONGFORM_MIN_H2_SECTIONS,
} from '../services/articleAdDensity';

/**
 * Guardrail for issue #7359.
 *
 * `docs/ads-placement-longform.md` and `docs/editorial-longform-audit.md`
 * describe the inline-ad renderer, and both drifted into describing a placer
 * that no longer exists: "un ad per ogni paragrafo", `MAX_INLINE_ADS =
 * Number.MAX_SAFE_INTEGER`, no per-article cap, no map library in the repo.
 * That is not a cosmetic staleness — two fixer runs on the parent (#7028)
 * reasoned on those sentences as if they were the state of the code before
 * touching it.
 *
 * So the invariant is not "the prose is nice", it is: every quantity and every
 * absence these two documents assert must still hold in the code. When the cap,
 * the gap, the longform threshold or the map dependency moves, the build fails
 * here instead of letting the next reader inherit a false premise.
 */

const ROOT = process.cwd();
const ADS_DOC = 'docs/ads-placement-longform.md';
const AUDIT_DOC = 'docs/editorial-longform-audit.md';
const RENDERER = 'components/community/BlogArticles.tsx';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** The abolished max-density vocabulary — see the issue's own metric command. */
const MAX_DENSITY_CLAIMS = [
  'MAX_SAFE_INTEGER',
  'MAX_INLINE_ADS',
  'max-density',
  'Nessun tetto',
];

describe('longform docs vs renderer', () => {
  const adsDoc = read(ADS_DOC);
  const auditDoc = read(AUDIT_DOC);
  const renderer = read(RENDERER);

  it.each([
    [ADS_DOC, adsDoc],
    [AUDIT_DOC, auditDoc],
  ])('%s does not describe the uncapped max-density placer', (_name, doc) => {
    for (const claim of MAX_DENSITY_CLAIMS) {
      expect(doc).not.toContain(claim);
    }
  });

  it('the renderer still has the capped, gapped placement the docs describe', () => {
    // If any of these is renamed away, the prose above stops being checkable.
    expect(renderer).toContain('ARTICLE_INLINE_AD_CAP');
    expect(renderer).toContain('resolveArticleAdDensity');
    expect(renderer).toContain('tryEmitAd');
  });

  it('the placement module the docs call removed is in fact absent', () => {
    // Both docs state `services/articleAdSlots.ts` no longer exists (#7338).
    expect(existsSync(join(ROOT, 'services/articleAdSlots.ts'))).toBe(false);
  });

  it('the cap, gap and longform threshold cited in the docs are the real ones', () => {
    expect(adsDoc).toContain(`ARTICLE_INLINE_AD_CAP = ${STANDARD_ARTICLE_AD_DENSITY.inlineCap}`);
    expect(adsDoc).toContain(`AD_MIN_WORD_GAP = ${STANDARD_ARTICLE_AD_DENSITY.minWordGap}`);
    expect(adsDoc).toContain(`gap longform è ${LONGFORM_ARTICLE_AD_DENSITY.minWordGap} parole`);
    expect(adsDoc).toContain(`≥${LONGFORM_MIN_H2_SECTIONS} sezioni \`## \``);

    expect(auditDoc).toContain(`ARTICLE_INLINE_AD_CAP = ${STANDARD_ARTICLE_AD_DENSITY.inlineCap}`);
    expect(auditDoc).toContain(
      `standard ${STANDARD_ARTICLE_AD_DENSITY.inlineCap}/${STANDARD_ARTICLE_AD_DENSITY.minWordGap}`,
    );
    expect(auditDoc).toContain(`≥${LONGFORM_MIN_H2_SECTIONS} sezioni \`## \``);
    expect(auditDoc).toContain(
      `${LONGFORM_ARTICLE_AD_DENSITY.inlineCap} ad in-content, gap ${LONGFORM_ARTICLE_AD_DENSITY.minWordGap} parole`,
    );
  });

  it('the audit does not claim the repo has no map component while leaflet is installed', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const hasLeaflet = Boolean(pkg.dependencies?.['react-leaflet'] ?? pkg.devDependencies?.['react-leaflet']);
    expect(hasLeaflet).toBe(true);
    expect(auditDoc).not.toContain('Non risultano, in questo repository, componenti di mappa');

    // The audit names every consumer by file; the set must stay complete.
    const consumers = mapConsumers();
    expect(consumers.length).toBeGreaterThan(0);
    for (const component of consumers) {
      expect(auditDoc).toContain(component);
    }
  });
});

/** Component basenames (no extension) that import `react-leaflet`. */
function mapConsumers(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.tsx') && read(rel).includes("from 'react-leaflet'")) {
        found.push(entry.name.replace(/\.tsx$/, ''));
      }
    }
  };
  walk('components');
  return found;
}
