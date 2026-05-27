/**
 * GSC "Migliora l'aspetto degli elementi" gate — ImageObject license fields.
 *
 * Google Search Console flags every `ImageObject` JSON-LD that does not
 * include the five licensable-image fields:
 *
 *   - acquireLicensePage  (URL where one can request a license)
 *   - copyrightNotice     (e.g. "© 2024–2026 Frontaliere Ticino")
 *   - license             (URL of the license terms)
 *   - creator             (Organization or Person who created the image)
 *   - creditText          (human-readable photo credit shown next to the image)
 *
 * The fields are technically *recommended* by schema.org but their absence
 * disqualifies the image from licensable-image rich results and shows up as
 * an "Improve appearance" item in GSC. Per CLAUDE.md non-negotiable rule #1
 * (zero tolerance on quality) this gate treats the warning as a hard error:
 * a single offending ImageObject in `dist/` fails the build.
 *
 * The canonical builder is `services/seo/imageObjectLd.ts` — every
 * ImageObject in user-facing JSON-LD must be produced by `imageObjectLd()` /
 * `imageObjectLdDocument()` (or hand-rolled with the same four fields, e.g.
 * inside auto-generated `services/seo/seo-blog*.ts` and `seo-pages.ts`).
 *
 * Dist-driven gate: skips silently when `dist/` does not exist or
 * `RUN_DIST_GATES=1` is not set, so `npx vitest run` continues to work
 * without a build. CI builds `dist/` first and sets the env var.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIST_DIR = resolve(__dirname, '..', '..', 'dist');

const REQUIRED_FIELDS = [
  'acquireLicensePage',
  'copyrightNotice',
  'license',
  'creator',
  'creditText',
] as const;

type RequiredField = (typeof REQUIRED_FIELDS)[number];

interface Offender {
  file: string;
  missing: RequiredField[];
  keys: string[];
}

function walkHtml(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkHtml(full, out);
    else if (entry.endsWith('.html')) out.push(full);
  }
  return out;
}

function extractLdJsonBlocks(html: string): string[] {
  const blocks: string[] = [];
  const re = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  return blocks;
}

/**
 * Recursively walk a JSON-LD node tree, invoking `visit` on every nested
 * object whose `@type` is exactly `"ImageObject"`.
 */
function walkImageObjects(
  node: unknown,
  visit: (img: Record<string, unknown>) => void,
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkImageObjects(child, visit);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj['@type'] === 'ImageObject') visit(obj);
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') walkImageObjects(v, visit);
  }
}

function findOffenders(html: string, file: string): Offender[] {
  const blocks = extractLdJsonBlocks(html);
  const offenders: Offender[] = [];
  for (const body of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue; // Malformed JSON-LD is a separate concern.
    }
    walkImageObjects(parsed, (img) => {
      const missing = REQUIRED_FIELDS.filter((f) => !(f in img));
      if (missing.length > 0) {
        offenders.push({
          file: file.replace(DIST_DIR, ''),
          missing,
          keys: Object.keys(img),
        });
      }
    });
  }
  return offenders;
}

describe('dist HTML — ImageObject license-fields gate (GSC licensable-image)', () => {
  if (process.env.RUN_DIST_GATES !== '1' || !existsSync(DIST_DIR)) {
    it.skip('set RUN_DIST_GATES=1 after `npx vite build` to enable this gate', () => {});
    return;
  }

  it(
    'every ImageObject in dist JSON-LD has acquireLicensePage, copyrightNotice, license, creator, creditText',
    { timeout: 120_000 },
    () => {
      const files = walkHtml(DIST_DIR);
      const allOffenders: Offender[] = [];
      const fileSet = new Set<string>();

      for (const file of files) {
        const html = readFileSync(file, 'utf-8');
        const offs = findOffenders(html, file);
        for (const o of offs) {
          allOffenders.push(o);
          fileSet.add(o.file);
        }
      }

      if (allOffenders.length === 0) {
        expect(allOffenders.length).toBe(0);
        return;
      }

      // Aggregate by file directory bucket so the message stays scannable.
      const byBucket = new Map<string, number>();
      for (const o of allOffenders) {
        const bucket = bucketOf(o.file);
        byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + 1);
      }

      const bucketReport = [...byBucket.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n');

      const exampleReport = allOffenders
        .slice(0, 10)
        .map(
          (o) =>
            `  - ${o.file}\n      missing: ${o.missing.join(', ')}\n      keys: ${o.keys.join(', ')}`,
        )
        .join('\n');

      throw new Error(
        `Found ${allOffenders.length} ImageObject(s) across ${fileSet.size} page(s) missing one or more of: ${REQUIRED_FIELDS.join(', ')}.\n\n` +
          `By bucket:\n${bucketReport}\n\n` +
          `First 10 examples:\n${exampleReport}\n\n` +
          `Fix: route the emission through services/seo/imageObjectLd.ts (or, for auto-generated files, through scripts/create-article.mjs which already injects the 4 fields). All ImageObject literals must include the GSC licensable-image quartet.`,
      );
    },
  );
});

function bucketOf(file: string): string {
  const p = file.replace(/^\//, '');
  if (p.startsWith('confine/') || p.startsWith('frontiere/') || p.startsWith('border/')) return 'border-wait';
  if (p.includes('articoli-frontaliere/') || p.includes('articles-frontaliere/') || p.includes('articles-frontalier/') || p.includes('artikel-grenzgaenger/') || p.includes('cross-border-articles/') || p.includes('grenzgaenger-artikel/')) return 'blog';
  if (p.startsWith('cerca-lavoro-ticino/') || p.startsWith('lavoro-')) return 'jobs';
  if (p.includes('settori/') || p.includes('sectors/') || p.includes('berufsfelder/') || p.includes('secteurs/')) return 'job-sector';
  if (p.includes('mercato-lavoro') || p.includes('job-market') || p.includes('arbeitsmarkt') || p.includes('marche-travail')) return 'job-market-snapshot';
  if (p.includes('aziende-che-assumono') || p.includes('weekly-employers') || p.includes('arbeitgeber-die-einstellen') || p.includes('entreprises-qui-recrutent')) return 'weekly-employers';
  if (p.includes('costo-vita') || p.includes('cost-of-living') || p.includes('lebenshaltungskosten') || p.includes('cout-de-la-vie')) return 'cost-of-living';
  if (p.includes('professione/') || p.includes('profession/') || p.includes('beruf/') || p.includes('metier/')) return 'profession-landings';
  if (p.includes('carriera/') || p.includes('careers/') || p.includes('karriere/') || p.includes('carriere/')) return 'career-landings';
  if (p.includes('infermier') || p.includes('nurs') || p.includes('krankenpfleg') || p.includes('infirmier')) return 'nursing-landings';
  if (p.startsWith('faq/') || p.includes('/faq/')) return 'faq-hub';
  if (p.includes('relazione-annuale') || p.includes('annual-report') || p.includes('jahresbericht') || p.includes('rapport-annuel')) return 'annual-report';
  if (p.includes('confronti/') || p.includes('comparisons/') || p.includes('vergleiche/') || p.includes('comparaisons/')) return 'comparisons-hub';
  if (p.startsWith('en/')) return 'spa-shell-en';
  if (p.startsWith('de/')) return 'spa-shell-de';
  if (p.startsWith('fr/')) return 'spa-shell-fr';
  return 'other';
}
