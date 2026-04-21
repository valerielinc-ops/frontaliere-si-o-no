// Hard-failing coverage test for FAQ structured data localization.
//
// Enumerates every Italian FAQ question statically declared in the SEO source
// files (seo-pages.ts, seo-landing.ts, seo-blog*.ts) and asserts that every
// question has a corresponding entry in FAQ_TRANSLATIONS with non-empty
// translations for en/de/fr on both the question (`q`) and the answer (`a`).
//
// This test intentionally does NOT import the SEO metadata modules at runtime;
// it reads the files from disk and extracts the Italian "name" field from each
// `"@type": "Question"` block via regex. That keeps the test robust against
// TypeScript aliases / helpers and makes the coverage intent explicit.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAQ_TRANSLATIONS } from '@/services/seo/faq-translations';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const SEO_SOURCE_FILES: readonly string[] = [
 'services/seo/seo-pages.ts',
 'services/seo/seo-landing.ts',
 'services/seo/seo-blog.ts',
 'services/seo/seo-blog-2.ts',
 'services/seo/seo-blog-3.ts',
 'services/seo/seo-blog-4.ts',
];

interface SourceQuestion {
 question: string;
 source: string;
}

function unescapeJsonString(raw: string): string {
 return raw
 .replace(/\\"/g, '"')
 .replace(/\\\\/g, '\\')
 .replace(/\\n/g, '\n')
 .replace(/\\'/g, "'");
}

// Matches a double-quoted JSON property block of shape:
//   "@type": "Question" ... "name": "..."
// within a single FAQ entry. We match non-greedily up to the first "name"
// field because each Question entry declares its own name.
const QUESTION_NAME_RE = /"@type":\s*"Question"[^{]*?"name":\s*"((?:[^"\\]|\\.)*)"/g;

function extractQuestionsFromFile(absPath: string, rel: string): SourceQuestion[] {
 const content = fs.readFileSync(absPath, 'utf8');
 const results: SourceQuestion[] = [];
 QUESTION_NAME_RE.lastIndex = 0;
 let m: RegExpExecArray | null;
 while ((m = QUESTION_NAME_RE.exec(content)) !== null) {
 results.push({ question: unescapeJsonString(m[1]), source: rel });
 }
 return results;
}

function collectAllSourceQuestions(): SourceQuestion[] {
 const out: SourceQuestion[] = [];
 for (const rel of SEO_SOURCE_FILES) {
 const abs = path.join(REPO_ROOT, rel);
 if (!fs.existsSync(abs)) {
 throw new Error(`Expected SEO source file missing: ${rel}`);
 }
 out.push(...extractQuestionsFromFile(abs, rel));
 }
 return out;
}

describe('FAQ structured-data localization coverage', () => {
 const allSourceQuestions = collectAllSourceQuestions();
 const uniqueQuestions = new Map<string, string[]>();
 for (const { question, source } of allSourceQuestions) {
 const sources = uniqueQuestions.get(question);
 if (sources) {
 if (!sources.includes(source)) sources.push(source);
 } else {
 uniqueQuestions.set(question, [source]);
 }
 }

 it('discovers a meaningful number of source questions (regression canary)', () => {
 // Current inventory (Apr 2026): 230 unique questions across 4 files.
 // If this count drops drastically the regex broke; if it grows, coverage
 // must keep up — that is what the next test enforces.
 expect(allSourceQuestions.length).toBeGreaterThanOrEqual(200);
 expect(uniqueQuestions.size).toBeGreaterThanOrEqual(200);
 });

 it('every source question has an entry in FAQ_TRANSLATIONS', () => {
 const missing: string[] = [];
 for (const [question, sources] of uniqueQuestions) {
 if (!(question in FAQ_TRANSLATIONS)) {
 missing.push(`[${sources.join(', ')}] ${question}`);
 }
 }
 expect(
 missing,
 `Missing FAQ_TRANSLATIONS entries for ${missing.length} question(s):\n` +
 missing.map((m) => ` - ${m}`).join('\n'),
 ).toEqual([]);
 });

 it('every FAQ_TRANSLATIONS entry has non-empty en/de/fr q and a fields', () => {
 const failures: string[] = [];
 const locales = ['en', 'de', 'fr'] as const;
 for (const [question, entry] of Object.entries(FAQ_TRANSLATIONS)) {
 for (const locale of locales) {
 const trans = entry[locale];
 if (!trans) {
 failures.push(`[${locale}] missing locale block: ${question}`);
 continue;
 }
 if (typeof trans.q !== 'string' || trans.q.trim().length === 0) {
 failures.push(`[${locale}] empty q: ${question}`);
 }
 if (typeof trans.a !== 'string' || trans.a.trim().length === 0) {
 failures.push(`[${locale}] empty a: ${question}`);
 }
 }
 }
 expect(
 failures,
 `FAQ_TRANSLATIONS has ${failures.length} empty/missing translation field(s):\n` +
 failures.map((f) => ` - ${f}`).join('\n'),
 ).toEqual([]);
 });

 it('each FAQ_TRANSLATIONS answer has at least 20 characters per locale (quality gate)', () => {
 const shortAnswers: string[] = [];
 const locales = ['en', 'de', 'fr'] as const;
 for (const [question, entry] of Object.entries(FAQ_TRANSLATIONS)) {
 for (const locale of locales) {
 const trans = entry[locale];
 if (trans && trans.a.trim().length < 20) {
 shortAnswers.push(`[${locale}] ${trans.a.length} chars: ${question}`);
 }
 }
 }
 expect(
 shortAnswers,
 `FAQ_TRANSLATIONS has ${shortAnswers.length} suspiciously short answer(s):\n` +
 shortAnswers.map((s) => ` - ${s}`).join('\n'),
 ).toEqual([]);
 });

 it('covers 100% of source questions (explicit percentage check)', () => {
 let covered = 0;
 for (const question of uniqueQuestions.keys()) {
 if (question in FAQ_TRANSLATIONS) covered++;
 }
 const coveragePct = (covered / uniqueQuestions.size) * 100;
 expect(coveragePct).toBe(100);
 });
});
