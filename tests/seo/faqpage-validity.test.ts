/**
 * GSC "Risultati avanzati" gate — FAQPage validity.
 *
 * Google Search Console flags three FAQPage defects as invalid structured
 * data (the element is ineligible for FAQ rich results):
 *
 *   1. Campo duplicato "FAQPage"
 *      → more than one `FAQPage` JSON-LD on the same page.
 *   2. Campo mancante "name" (in "mainEntity")
 *      → a `mainEntity` Question without a non-empty `name`.
 *   3. Campo mancante "text" (in "mainEntity.acceptedAnswer")
 *      → a Question's `acceptedAnswer` without a non-empty `text`.
 *
 * Per CLAUDE.md non-negotiable rule #1 (zero tolerance on quality) this gate
 * treats every defect as a hard error: a single offender in `dist/` fails the
 * build.
 *
 * Mirror of `scripts/audit-faqpage-validity.mjs`. Dist-driven gate: skips
 * silently when `dist/` does not exist or `RUN_DIST_GATES=1` is not set, so
 * `npx vitest run` works without a build.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIST_DIR = resolve(__dirname, '..', '..', 'dist');

type Defect =
  | 'duplicate-faqpage'
  | 'missing-name'
  | 'missing-text'
  | 'empty-main-entity'
  | 'missing-accepted-answer'
  | 'invalid-question';

interface Offender {
  file: string;
  defect: Defect;
  faqIndex?: number;
  questionIndex?: number;
  count?: number;
}

function walkHtml(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
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

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function findFaqPages(node: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findFaqPages(child, out);
    return out;
  }
  const obj = node as Record<string, unknown>;
  if (obj['@type'] === 'FAQPage') {
    out.push(obj);
    return out;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') findFaqPages(v, out);
  }
  return out;
}

function validateFaqPage(faq: Record<string, unknown>): Array<{ code: Exclude<Defect, 'duplicate-faqpage'>; index?: number }> {
  const errors: Array<{ code: Exclude<Defect, 'duplicate-faqpage'>; index?: number }> = [];
  const raw = faq.mainEntity;
  const mainEntity: unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (mainEntity.length === 0) {
    errors.push({ code: 'empty-main-entity' });
    return errors;
  }
  mainEntity.forEach((q, i) => {
    if (!q || typeof q !== 'object') {
      errors.push({ code: 'invalid-question', index: i });
      return;
    }
    const question = q as Record<string, unknown>;
    if (!isNonEmptyString(question.name)) {
      errors.push({ code: 'missing-name', index: i });
    }
    const answer = question.acceptedAnswer;
    if (!answer || typeof answer !== 'object') {
      errors.push({ code: 'missing-accepted-answer', index: i });
      return;
    }
    if (!isNonEmptyString((answer as Record<string, unknown>).text)) {
      errors.push({ code: 'missing-text', index: i });
    }
  });
  return errors;
}

function findOffenders(html: string, file: string): Offender[] {
  if (!html.includes('FAQPage')) return [];
  const blocks = extractLdJsonBlocks(html);
  const faqPages: Array<Record<string, unknown>> = [];
  for (const body of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    findFaqPages(parsed, faqPages);
  }
  if (faqPages.length === 0) return [];
  const rel = file.replace(DIST_DIR, '');
  const offenders: Offender[] = [];
  if (faqPages.length > 1) {
    offenders.push({ file: rel, defect: 'duplicate-faqpage', count: faqPages.length });
  }
  faqPages.forEach((faq, fi) => {
    for (const iss of validateFaqPage(faq)) {
      offenders.push({ file: rel, defect: iss.code, faqIndex: fi, questionIndex: iss.index });
    }
  });
  return offenders;
}

describe('dist HTML — FAQPage validity gate (GSC duplicate/missing-fields)', () => {
  if (process.env.RUN_DIST_GATES !== '1' || !existsSync(DIST_DIR)) {
    it.skip('set RUN_DIST_GATES=1 after `npx vite build` to enable this gate', () => {});
    return;
  }

  it(
    'every page emits at most one FAQPage with non-empty name + text on every Question/Answer',
    { timeout: 180_000 },
    () => {
      const files = walkHtml(DIST_DIR);
      const offenders: Offender[] = [];
      const filesByDefect = new Map<Defect, Set<string>>();

      for (const file of files) {
        const html = readFileSync(file, 'utf-8');
        for (const o of findOffenders(html, file)) {
          offenders.push(o);
          const s = filesByDefect.get(o.defect) ?? new Set<string>();
          s.add(o.file);
          filesByDefect.set(o.defect, s);
        }
      }

      if (offenders.length === 0) {
        expect(offenders.length).toBe(0);
        return;
      }

      const summary = [...filesByDefect.entries()]
        .map(([k, v]) => `  ${k}: ${v.size} file(s)`)
        .join('\n');
      const examples = offenders
        .slice(0, 15)
        .map((o) => {
          const loc =
            o.questionIndex !== undefined
              ? ` (faq#${o.faqIndex}.question#${o.questionIndex})`
              : o.count
                ? ` (${o.count} FAQPage scripts)`
                : '';
          return `  - ${o.file} — ${o.defect}${loc}`;
        })
        .join('\n');

      throw new Error(
        `Found ${offenders.length} FAQPage defect(s) in dist HTML.\n\n` +
          `By defect:\n${summary}\n\n` +
          `First 15 examples:\n${examples}\n\n` +
          `Fix: emit a single FAQPage per page with non-empty name + text on every Question/Answer. ` +
          `See build-plugins/relatedSearchClustersPlugin.ts buildJsonLd() for the canonical merge pattern (AI FAQs + commuter-context FAQs in one mainEntity array).`,
      );
    },
  );
});
