import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode as decodeHtmlEntities } from 'html-entities';
import { parse as parseHtml } from 'parse5';

export const EXPIRED_ARCHIVE_EVIDENCE_VERSION = 1;
export const EXPIRED_ARCHIVE_EVIDENCE_VALIDATOR = 'expired-archive-publication-v1';
const LOCALES = ['it', 'en', 'de', 'fr'];
const DEFAULT_CANARIES_PER_LOCALE = 4;
const NOINDEX_ROBOTS_RE = /<meta\b(?=[^>]*\bname\s*=\s*["']?robots(?![a-z0-9_-])["']?)(?=[^>]*\bcontent\s*=\s*["']?[^"'>]*\bnoindex\b)[^>]*>/iu;
const TITLE_RE = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/iu;
const SECTION_SLUGS = JSON.parse(fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/lib/section-shard-slugs.json'),
  'utf8',
));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sectionForPath(locale, pathname) {
  const parts = pathname.replace(/^\/+|\/+$/gu, '').split('/');
  const sectionSlug = locale === 'it' ? parts[0] : parts[1];
  for (const [section, slugs] of Object.entries(SECTION_SLUGS)) {
    if (slugs?.[locale] === sectionSlug) return section;
  }
  return null;
}

function payloadFromHtml(html) {
  const startMarker = 'window.__EXPIRED_JOB_DATA__=';
  const start = html.indexOf(startMarker);
  if (start < 0) throw new Error('expired archive canary has no window.__EXPIRED_JOB_DATA__ payload');
  const valueStart = start + startMarker.length;
  const end = html.indexOf(';</script>', valueStart);
  if (end < 0) throw new Error('expired archive canary payload is unterminated');
  return html.slice(valueStart, end);
}

function payloadDescription(payload, locale) {
  return String(payload?.descriptionByLocale?.[locale] ?? payload?.description ?? '').trim();
}

function hasHtmlTagWithAttributes(html, tagName, expectedAttributes) {
  const pending = [parseHtml(html)];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node.tagName === tagName
      && expectedAttributes.every(([name, value]) => node.attrs?.some((attribute) => (
        attribute.name === name && attribute.value === value
      )))) {
      return true;
    }
    if (Array.isArray(node.childNodes)) pending.push(...node.childNodes);
  }
  return false;
}

export function createExpiredArchivePublicationEvidence({
  canariesPerLocale = DEFAULT_CANARIES_PER_LOCALE,
} = {}) {
  const candidates = new Map(LOCALES.map((locale) => [locale, []]));
  const renderedByLocale = new Map(LOCALES.map((locale) => [locale, 0]));

  return {
    record(candidate) {
      const locale = String(candidate?.locale ?? '');
      if (!candidates.has(locale)) throw new Error(`unsupported expired archive evidence locale ${JSON.stringify(locale)}`);
      renderedByLocale.set(locale, renderedByLocale.get(locale) + 1);
      // The publication contract requires noindex; recent expired pages may still be indexable by policy.
      if (candidate.expectedNoindex === false) return;
      const bucket = candidates.get(locale);
      if (bucket.length >= canariesPerLocale) return;

      const payloadJson = String(candidate.payloadJson ?? '');
      let payload;
      try { payload = JSON.parse(payloadJson); } catch { return; }
      const description = payloadDescription(payload, locale);
      const expiredAt = String(payload?.expiredAt ?? '').trim();
      const title = String(payload?.title ?? '').trim();
      const titleHtml = String(candidate.titleHtml ?? '').trim();
      const metaDescriptionHtml = String(candidate.metaDescriptionHtml ?? '').trim();
      if (!title || !description || !titleHtml || !metaDescriptionHtml || !Number.isFinite(Date.parse(expiredAt))) return;

      bucket.push({
        locale,
        path: String(candidate.path ?? '').replace(/^\/+/, ''),
        url: String(candidate.url ?? ''),
        payloadJson,
        description,
        expiredAt,
        titleHtml,
        metaDescriptionHtml,
        owner: candidate.owner ?? {},
      });
    },

    write({ distDir, indexedOverflowAliases, sourceRunId = '', sourceSha = '' }) {
      const manifests = [];
      for (const locale of LOCALES) {
        const renderedOverflowPages = renderedByLocale.get(locale);
        const localeCandidates = candidates.get(locale);
        if (indexedOverflowAliases > 0 && renderedOverflowPages > 0 && localeCandidates.length === 0) {
          throw new Error(`expired archive overflow rendered ${renderedOverflowPages} ${locale} page(s) but no complete canary`);
        }

        const entries = localeCandidates.map((candidate) => {
          const file = path.resolve(distDir, candidate.path);
          const relative = path.relative(distDir, file);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`expired archive canary path escapes dist: ${candidate.path}`);
          }
          const html = fs.readFileSync(file, 'utf8');
          if (!hasHtmlTagWithAttributes(html, 'main', [['data-expired-static-body', 'true']])) {
            throw new Error(`expired archive canary lost its static body marker: ${candidate.path}`);
          }
          if (!hasHtmlTagWithAttributes(html, 'link', [
            ['rel', 'canonical'],
            ['href', candidate.url],
          ])) {
            throw new Error(`expired archive canary canonical differs from ${candidate.url}`);
          }
          if (!NOINDEX_ROBOTS_RE.test(html)) {
            throw new Error(`expired archive canary must be noindex: ${candidate.path}`);
          }
          const publishedTitleHtml = TITLE_RE.exec(html)?.[1]?.trim() ?? '';
          if (publishedTitleHtml !== candidate.titleHtml) {
            throw new Error(`expired archive canary title differs from its rendered source: ${candidate.path}`);
          }
          if (!hasHtmlTagWithAttributes(html, 'meta', [
            ['name', 'description'],
            ['content', decodeHtmlEntities(candidate.metaDescriptionHtml)],
          ])) {
            throw new Error(`expired archive canary meta description differs from its rendered source: ${candidate.path}`);
          }
          const publishedPayloadJson = payloadFromHtml(html);
          if (publishedPayloadJson !== candidate.payloadJson) {
            throw new Error(`expired archive canary payload differs from its source owner: ${candidate.path}`);
          }
          const payload = JSON.parse(publishedPayloadJson);
          if (payloadDescription(payload, locale) !== candidate.description
            || String(payload.expiredAt ?? '') !== candidate.expiredAt) {
            throw new Error(`expired archive canary description or expiry differs from its source owner: ${candidate.path}`);
          }
          const pathname = new URL(candidate.url).pathname;
          const section = sectionForPath(locale, pathname);
          if (!section) throw new Error(`expired archive canary has no publisher section: ${candidate.url}`);
          return {
            evidenceKind: 'expired-archive',
            locale,
            section,
            path: candidate.path.split(path.sep).join('/'),
            url: candidate.url,
            sha256: sha256(html),
            payloadSha256: sha256(publishedPayloadJson),
            descriptionSha256: sha256(candidate.description),
            expiredAtSha256: sha256(candidate.expiredAt),
            ownerSha256: sha256(JSON.stringify(candidate.owner)),
          };
        });

        const manifest = {
          schemaVersion: EXPIRED_ARCHIVE_EVIDENCE_VERSION,
          kind: 'expired-archive-publication-evidence',
          validatorVersion: EXPIRED_ARCHIVE_EVIDENCE_VALIDATOR,
          sourceRunId: String(sourceRunId),
          sourceSha: String(sourceSha).toLowerCase(),
          locale,
          indexedOverflowAliases,
          renderedOverflowPages,
          sampleSize: entries.length,
          entries,
        };
        const output = path.join(distDir, 'assets', `expired-archive-evidence-${locale}.json`);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
        manifests.push(manifest);
      }
      return manifests;
    },
  };
}
