import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import {
 extractJsonLdBlocks,
 flattenSchemas,
 listSitemapHtmlPages,
} from './seo-helpers';

const sitemapPages = listSitemapHtmlPages();

function faqSignature(schema: Record<string, any>): string {
 // Duplication is only harmful when BOTH question AND answer are identical
 // across pages — sibling pages (e.g. weekly employer company×city) can share
 // the same question wording but have locale/city-specific answers. Including
 // the accepted-answer text in the signature keeps the gate strict about real
 // duplicates without penalising legitimate template variation.
 const questions = Array.isArray(schema.mainEntity) ? schema.mainEntity : [];
 return questions
  .map((item) => {
   const name = String(item?.name || '').trim().toLowerCase();
   const answer = String(item?.acceptedAnswer?.text || '').trim().toLowerCase();
   return `${name}::${answer}`;
  })
  .filter((sig) => sig !== '::')
  .join(' | ');
}

/**
 * Templated page clusters that intentionally share FAQ payloads across sibling
 * URLs. These are scenario/long-tail variants with distinct canonical URLs and
 * distinct editorial bodies — the FAQ template is shared by design. Allowing
 * duplicates within a cluster is the "restringere a duplicati realmente
 * dannosi" decision documented in SPRINT-1-EXTENSION-1.
 *
 * A page belongs to a cluster when its path matches one of the prefixes below
 * for every locale. Two pages in the SAME cluster are allowed to share a FAQ
 * signature; duplicates across DIFFERENT clusters (or outside any cluster)
 * still fail the gate.
 */
const TEMPLATED_CLUSTERS: ReadonlyArray<{ id: string; match: RegExp }> = [
 // Weekly employer company × city (F5) + city + regional hub pages.
 {
  id: 'weekly-employers',
  match: /^\/(?:en\/|de\/|fr\/)?(?:aziende-che-assumono|companies-hiring|unternehmen-einstellen|entreprises-recrutent)\//,
 },
 // Salary-hub sub-pages: scenario long-tails, RAL, permit G/B comparisons,
 // what-if simulators. All share a canonical salary-calculator FAQ template.
 {
  id: 'salary-hub',
  match: /^\/(?:en\/|de\/|fr\/)?(?:calcola-stipendio|calculate-salary|gehalt-berechnen|calculer-salaire)\/[^/]+/,
 },
 // Job-market snapshot hub + weekly/monthly report pages (F4).
 {
  id: 'job-market-snapshot',
  match: /^\/(?:en\/|de\/|fr\/)?(?:mercato-lavoro-ticino|ticino-job-market|tessin-arbeitsmarkt|marche-travail-tessin)(?:\/|$)/,
 },
 // Crossborder guide: translated articles (IT/EN/DE/FR) on the same topic
 // emit the same FAQ structure by design — they are hreflang alternates.
 {
  id: 'crossborder-guide',
  match: /^\/(?:en\/|de\/|fr\/)?(?:guida-frontaliere|crossborder-guide|grenzgaenger-leitfaden|guide-frontalier)\//,
 },
];

function clusterIdForPath(relPath: string): string | null {
 const normalized = relPath.startsWith('/') ? relPath : `/${relPath}`;
 for (const cluster of TEMPLATED_CLUSTERS) {
  if (cluster.match.test(normalized)) return cluster.id;
 }
 return null;
}

describe('FAQPage uniqueness (post-build)', () => {
 it('does not ship duplicate FAQPage payloads across sitemap pages', () => {
  const seen = new Map<string, { relPath: string; clusterId: string | null }>();
  const failures = new Set<string>();

  for (const page of sitemapPages) {
   if (!existsSync(page.filePath)) continue;
   const html = readFileSync(page.filePath, 'utf-8');
   const schemas = flattenSchemas(extractJsonLdBlocks(html));

   for (const schema of schemas) {
    if (schema['@type'] !== 'FAQPage') continue;
    const signature = faqSignature(schema);
    if (!signature) continue;

    const pageClusterId = clusterIdForPath(page.relPath);
    const existing = seen.get(signature);
    if (existing && existing.relPath !== page.relPath) {
     // Duplicates within the same templated cluster are allowed by design.
     const sameCluster =
      pageClusterId !== null && pageClusterId === existing.clusterId;
     if (!sameCluster) {
      failures.add(`${existing.relPath} <-> ${page.relPath}`);
     }
    } else {
     seen.set(signature, { relPath: page.relPath, clusterId: pageClusterId });
    }
   }
  }

  expect([...failures]).toEqual([]);
 });
});
