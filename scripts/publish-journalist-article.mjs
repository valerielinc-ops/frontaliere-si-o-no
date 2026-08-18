#!/usr/bin/env node
/**
 * publish-journalist-article.mjs — Server-side publish pipeline for the
 * journalist dashboard (issue #3174).
 *
 * A journalist authors an IT-only draft client-side (services/journalistArticleService.ts)
 * and flips it to Firestore status:'queued' via submitForPublish(). This script:
 *   1. Queries `journalist_articles` where status == 'queued' (sequential, one
 *      doc at a time — a poison doc must never block the rest of the queue).
 *   2. Builds the exact `data` shape scripts/create-article.mjs expects from the
 *      journalist's IT content.
 *   3. Resolves the hero image (journalist upload → repo convention, or the
 *      SAME keyword/fallback logic the AI pipeline uses).
 *   4. Runs the article through translateArticle() → enforceStrongInternalLinks()
 *      → registerArticleFiles() — the IDENTICAL multi-language registration
 *      pipeline automated content goes through (no parallel/duplicate system).
 *   5. Stamps the Firestore doc `published`/`failed` with `liveVerifiedAt: null`.
 *
 * `published` here means "files registered, awaiting the CALLING WORKFLOW's
 * commit + the deploy it triggers" — NOT yet live. The "your article is
 * online" email is intentionally NOT sent from this script: at this point
 * the commit/push/deploy haven't even started, so the URLs in that email
 * would 404 for minutes (deploy queues get backed up behind other commits —
 * see incident notes). scripts/notify-journalist-article-live.mjs, triggered
 * after "Deploy to GitHub Pages" actually succeeds, curls the published URLs
 * and only then stamps `liveVerifiedAt` + sends the email. The dashboard
 * (JournalistDashboardPage.tsx) mirrors this: status 'published' without
 * `liveVerifiedAt` shows an "in fase di pubblicazione" pending state, not
 * clickable links.
 *
 * Repo file writes (router/registry/i18n/SEO/sitemap/RSS) are committed to main
 * by the CALLING WORKFLOW (.github/workflows/publish-journalist-articles.yml),
 * mirroring build-publisher-jobs.mjs / publisher-jobs-sync.yml's split: the
 * script only touches Firestore + the working tree, git plumbing stays in YAML.
 *
 * Exit codes:
 *   0 — ran fine, including per-doc failures (expected/handled, recorded on
 *       the doc as status:'failed' so the journalist can fix + resubmit).
 *   1 — hard infra failure only (Firestore unreachable / query threw before
 *       any doc could be processed).
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node scripts/publish-journalist-article.mjs
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  registerArticleFiles,
  checkArticleIdExists,
  translateArticle,
  enforceStrongInternalLinks,
  findBestFallbackImage,
  pickAuthorForTopic,
  getAuthorByUid,
  sanitizeBoldFormatting,
  validateAndEnforceCTA,
  optimizeSeoMetadata,
  normalizeTitleCasing,
  collapseShoutingTitle,
  applyMicrocopyGuard,
  splitBodyIntoSections,
  generateExcerpt,
  checkTranslatedSlugCollisions,
  deriveAndSanitizeArticleSlugs,
  assertNoFabricatedReferences,
  assertNoFabricatedLaborOfficeCrossLocale,
} from './create-article.mjs';
import { assertNoFabricatedNormAcronyms } from './lib/article-factuality-gates.mjs';
import { generateFaqIT } from './batch-add-faq-to-articles.mjs';
import { appendCatalogEntry } from './generate-journalist-image-catalog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BASE_URL = 'https://frontaliereticino.ch';

// Mirrors the (unexported) CATEGORIES list in create-article.mjs. The client
// (services/journalistTypes.ts JOURNALIST_ARTICLE_CATEGORIES) already
// constrains submissions to this same set — this is a defensive re-check only.
const CATEGORIES = ['fiscale', 'pratico', 'novita', 'pensione'];

// Static fallback used when neither a custom upload nor findBestFallbackImage()
// yields a match — same catalog image used by the evergreen digest article
// (scripts/generate-events-digest-article.mjs's STATIC_META.image).
const STATIC_FALLBACK_IMAGE = 'lugano-view.webp';

const BLOG_IMAGE_HARD_MAX_BYTES = 320 * 1024; // matches create-article.mjs's BLOG_IMAGE_HARD_MAX_BYTES

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

async function initDb() {
  const admin = (await import('firebase-admin')).default;
  if (!admin.apps?.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  return { db: admin.firestore(), FieldValue: admin.firestore.FieldValue };
}

/** Build the `data` object create-article.mjs's exported functions expect,
 * from a journalist_articles Firestore doc (services/journalistTypes.ts shape).
 * The journalist only authors {title, body} — deriveJournalistContent() below
 * fills in body1/body2/body3/excerpt/faq before the rest of the shared
 * pipeline (which still expects that shape) runs. */
function buildPipelineData(docId, doc) {
  const it = doc.content?.it;
  for (const field of ['title', 'body']) {
    if (!it?.[field]) throw new Error(`content.it.${field} is required`);
  }
  const id = slugify(docId) || docId;
  const category = CATEGORIES.includes(doc.category) ? doc.category : 'novita';
  // Sentence-case normalization is authoritative here (issue #3174 redesign) —
  // whatever casing the journalist typed, this is the title that gets saved.
  const title = normalizeTitleCasing(it.title);

  return {
    id,
    category,
    hasCalculator: false,
    image: '', // resolved by resolveHeroImage() below
    imagePrompt: 'Professional editorial photo of Ticino Switzerland, Lake Lugano panorama, warm natural lighting',
    // Alt text: honor the journalist's own IT copy where given; other locales
    // fall back to the same generic pattern create-article.mjs's own
    // auto-generation uses (it never translates alt text either — see its
    // `data.imageAlt = { it/en/de/fr: ... itTitle ... }` fallback block).
    imageAlt: {
      it: doc.imageAlt ? collapseShoutingTitle(doc.imageAlt) : `Immagine editoriale relativa a: ${title}`,
      en: `Editorial image related to: ${title}`,
      de: `Redaktionelles Bild zu: ${title}`,
      fr: `Image éditoriale relative à: ${title}`,
    },
    slugs: { it: id },
    content: {
      it: {
        title,
        // excerpt/body1/body2/body3/faq are filled in by
        // deriveJournalistContent() before optimizeSeoMetadata() runs.
      },
    },
    // Fully computed by optimizeSeoMetadata() below (title/description/ogTitle/
    // headline/breadcrumbName/keywords) — identical to the automated pipeline,
    // including its title-collision guard (throws 'DUPLICATO: ...' when the
    // journalist's headline matches an existing article; caught by the
    // per-doc try/catch in processDoc() and stamped as a 'failed' status with
    // that message so the journalist can pick a different title).
    seo: {},
  };
}

/** Derive body1/body2/body3/excerpt/faq from the journalist's single
 * free-text body — mirrors what the automated generation pipeline produces
 * in one combined LLM call, but as separate lightweight steps since the
 * journalist supplies title+body only (issue #3174 redesign). Must run
 * before optimizeSeoMetadata()/translateArticle()/etc., which still consume
 * the body1/body2/body3/excerpt/faq shape. */
async function deriveJournalistContent(data, rawBody) {
  console.log('  ✂️  splitting body into sections (splitBodyIntoSections)...');
  const { body1, body2, body3 } = await splitBodyIntoSections(rawBody, data.content.it.title);
  data.content.it.body1 = body1;
  data.content.it.body2 = body2;
  data.content.it.body3 = body3;

  console.log('  📝 generating excerpt (generateExcerpt)...');
  data.content.it.excerpt = await generateExcerpt(data.content.it.title, body1, body2, body3);

  // First point in this pipeline where BOTH title and excerpt are final.
  // normalizeTitleCasing() already ran on the title back in buildArticleData(),
  // and it returns early on sentence-cased input — which is the majority of
  // journalist titles. The excerpt is LLM-written and had no deterministic pass
  // at all before this one, despite becoming the article's meta description.
  //
  // This pipeline is the one that actually runs: publish-journalist-articles.yml
  // is on a */15 cron, while the AI producer (generate-article.yml) has been
  // dispatch-only since the 2026-08-02 cutover.
  applyMicrocopyGuard(data.content.it, 'it');

  console.log('  ❓ generating FAQ (generateFaqIT)...');
  data.content.it.faq = await generateFaqIT(data.id, rawBody);
}

/** Resolve the hero image: a journalist's custom Storage upload wins; falls
 * back to the SAME keyword-match / static fallback the AI pipeline uses. */
async function resolveHeroImage(data, doc) {
  const rawImage = String(doc.image || '').trim();
  // A catalog pick from the local, non-AI cover-image picker: already an
  // optimized webp sitting in public/images/blog — reuse it as-is, exactly
  // like findBestFallbackImage()'s own results below (no download/reprocess).
  if (/^\/images\//.test(rawImage)) {
    data._generatedImagePath = rawImage;
    return { source: 'catalog-pick', path: rawImage };
  }
  if (/^https?:\/\//i.test(rawImage)) {
    try {
      const res = await fetch(rawImage, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const sharp = (await import('sharp')).default;
      const destDir = path.join(PROJECT_ROOT, 'public', 'images', 'blog');
      fs.mkdirSync(destDir, { recursive: true });
      const destPath = path.join(destDir, `${data.id}.webp`);

      const meta = await sharp(buf).rotate().metadata();
      const needsResize = (meta.width || 0) < 1200 || (meta.height || 0) < 675;
      let quality = 78;
      const render = async (q) => {
        let pipeline = sharp(buf).rotate();
        if (needsResize) pipeline = pipeline.resize({ width: 1200, height: 675, fit: 'cover' });
        await pipeline.webp({ quality: q }).toFile(destPath);
        return fs.statSync(destPath).size;
      };
      let size = await render(quality);
      while (size > BLOG_IMAGE_HARD_MAX_BYTES && quality > 40) {
        quality -= 10;
        size = await render(quality);
      }
      data._generatedImagePath = `/images/blog/${data.id}.webp`;
      appendCatalogEntry(data._generatedImagePath);
      return { source: 'journalist-upload', bytes: size };
    } catch (err) {
      console.warn(`  ⚠️  custom hero image download/processing failed (non-fatal): ${err.message}`);
    }
  }
  const matched = findBestFallbackImage(data);
  if (matched) {
    data._generatedImagePath = matched;
    return { source: 'keyword-fallback', path: matched };
  }
  data.image = STATIC_FALLBACK_IMAGE;
  return { source: 'static-fallback', path: data.image };
}

/**
 * Resolves the byline for a journalist submission from its own captured
 * identity (`doc.authorUid`, set at draft time in journalistArticleService.ts)
 * — never by guessing via article topic.
 *
 * Only returns non-null for a uid that matches a registered guest journalist
 * (e.g. samuele-valente in data/authors.ts / the AUTHORS mirror here), since
 * `slug` doubles as both the JSON-LD Person `@id`/`url` and the CSR byline
 * link target (components/community/BlogArticles.tsx) — pairing a real name
 * with a slug that resolves to a *different* declared Person (e.g. the
 * generic 'redazione' team page) would create an E-E-A-T entity mismatch:
 * same `@id`, two different names (review finding on this fix, PR #4325).
 *
 * An authenticated-but-not-yet-registered journalist (access granted via
 * AdminPanel.tsx "Giornalisti" but not yet added to data/authors.ts) is not
 * a regression introduced by this fix — falling through to
 * pickAuthorForTopic() here is the same pre-existing behavior as before,
 * for a case this incident never actually involved.
 *
 * @returns {{slug: string, name: string, linkedinUrl: string|null}|null}
 */
function resolveJournalistAuthor(doc) {
  return (doc?.authorUid ? getAuthorByUid(doc.authorUid) : undefined) || null;
}

async function processDoc(db, FieldValue, docSnap) {
  const docId = docSnap.id;
  const doc = docSnap.data();
  console.log(`\n📰 Processing journalist_articles/${docId}...`);

  try {
    const data = buildPipelineData(docId, doc);

    if (checkArticleIdExists(data.id)) {
      await docSnap.ref.update({ status: 'failed', errorMessage: 'id already registered' });
      console.warn(`  ⚠️  ${data.id}: id already registered — marked failed.`);
      return { ok: false };
    }

    await deriveJournalistContent(data, doc.content.it.body);

    console.log('  🪪 optimizing SEO metadata (optimizeSeoMetadata)...');
    optimizeSeoMetadata(data);

    console.log('  ✂️  sanitizing bold formatting (sanitizeBoldFormatting, pre-translation)...');
    sanitizeBoldFormatting(data);

    // Fabricated references check — BLOCKING (same guard the AI generation
    // path runs at create-article.mjs's "Step 3a.0b"). Journalist drafts were
    // never wired to this check (this import list didn't include it), so a
    // fabricated institution/acronym in a journalist submission would sail
    // straight through to publish with no regeneration loop to fall back on —
    // unlike the AI path, there's no automatic retry here; a hit just fails
    // the doc so the journalist can fix and resubmit (see the outer catch).
    console.log('  🔍 checking for fabricated references (assertNoFabricatedReferences)...');
    assertNoFabricatedReferences(data.content.it);
    // Journalist path never calls runFactualityGates() either — the same
    // wiring gap assertNoFabricatedReferences above closed for
    // FABRICATED_INSTITUTION_PATTERNS, but for FABRICATED_NORM_ACRONYMS
    // (LFW/LPS), which only the AI generation path's Step 3a.0b-bis covered.
    console.log('  🔍 checking for fabricated norm acronyms (assertNoFabricatedNormAcronyms)...');
    assertNoFabricatedNormAcronyms({ it: data.content.it });

    // Journalist submissions carry a real, authenticated identity captured at
    // draft time (JournalistDashboardPage.tsx -> journalistArticleService.ts:
    // doc.authorUid/authorName) — trust it instead of guessing a teammate by
    // topic-keyword overlap. pickAuthorForTopic() is for AI-generated content,
    // which has no real author; using it here previously misattributed every
    // journalist byline to whichever registry author's keywords happened to
    // match the article's topic (e.g. samuele-valente's articles landing on
    // marco-ferrari/laura-bianchi — see issue report 2026-07-16).
    data.author = resolveJournalistAuthor(doc)
      || pickAuthorForTopic(
        [data.category, data.seo.keywords, data.seo.headline, data.content.it.title, data.id].join(' '),
        data.id,
      );

    const imageResolution = await resolveHeroImage(data, doc);
    console.log(`  🖼️  hero image: ${imageResolution.source}`);

    console.log('  🌍 translating (translateArticle)...');
    await translateArticle(data);

    // Same cross-locale fabrication check the AI generation path runs after
    // its own translateArticle() (create-article.mjs's "Step 3b.1") —
    // assertNoFabricatedReferences() above only ever saw the IT draft,
    // before these EN/DE/FR translations existed.
    console.log('  🔍 checking for fabricated references in translations (assertNoFabricatedLaborOfficeCrossLocale)...');
    assertNoFabricatedLaborOfficeCrossLocale(data);
    assertNoFabricatedNormAcronyms({ en: data.content.en, de: data.content.de, fr: data.content.fr });

    // #3209: deriveAndSanitizeArticleSlugs() is the single-source slug
    // derivation (also called internally by registerArticleFiles() below,
    // idempotently) — call it explicitly here so #3010's collision guard can
    // validate en/de/fr before any file gets registered/written.
    deriveAndSanitizeArticleSlugs(data);

    // #3010: nothing validated the translated en/de/fr slugs against the
    // registry until this check. The IT slug is fixed to data.id and already
    // covered by checkArticleIdExists() above; this closes the EN/DE/FR gap
    // using the exact same collision guard as the AI generation path (reused,
    // not reimplemented) so a colliding translation fails this doc loudly
    // instead of silently poisoning the registry.
    checkTranslatedSlugCollisions(data);


    // Re-run after translation: sanitizes bold/`nav:` formatting the MT step
    // may have introduced into the newly-filled en/de/fr content (mirrors
    // create-article.mjs's own main(), which calls this both before AND
    // after translateArticle()).
    console.log('  ✂️  sanitizing bold formatting (sanitizeBoldFormatting, post-translation)...');
    sanitizeBoldFormatting(data);

    console.log('  📣 enforcing CTA presence (validateAndEnforceCTA)...');
    validateAndEnforceCTA(data);

    console.log('  🔗 enforcing internal links (enforceStrongInternalLinks)...');
    enforceStrongInternalLinks(data);

    console.log('  📂 registering article files (registerArticleFiles)...');
    // registerArticleFiles() derives + sanitizes data.slugs AND builds the
    // final publishedUrls itself — consume both directly instead of
    // re-deriving them here (issue #3209 item 1: a separate copy of either
    // would drift as registerArticleFiles()'s own logic evolves, producing
    // wrong canonicals/404s; the removed local buildPublishedUrls() copy had
    // in fact already drifted — it omitted the /en //de //fr locale prefix
    // the router actually uses, producing wrong links in this "article is
    // live" email/Firestore field).
    const { slugs, publishedUrls } = await registerArticleFiles(data);

    await docSnap.ref.update({
      status: 'published',
      publishedAt: FieldValue.serverTimestamp(),
      slugs,
      publishedUrls,
      errorMessage: null,
      // Explicit null (not omitted): makes "not yet live-verified" a real,
      // queryable field value from the moment a doc is published, instead of
      // relying on absence — scripts/notify-journalist-article-live.mjs and
      // check-journalist-article-links.mjs both filter on falsy
      // `liveVerifiedAt` in memory (Firestore equality-null wouldn't match
      // pre-existing docs where the field is absent rather than null).
      liveVerifiedAt: null,
    });
    console.log(`  ✅ registered (awaiting deploy): ${publishedUrls.it}`);

    return { ok: true, id: data.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ ${docId} failed: ${message}`);
    try {
      await docSnap.ref.update({ status: 'failed', errorMessage: message.slice(0, 2000) });
    } catch (updateErr) {
      console.error(`  ❌ could not stamp failure onto ${docId}: ${updateErr.message}`);
    }
    return { ok: false };
  }
}

async function main() {
  const { db, FieldValue } = await initDb();

  const snap = await db.collection('journalist_articles').where('status', '==', 'queued').get();
  console.log(`[publish-journalist-article] ${snap.size} queued article(s) to process.`);

  let published = 0;
  let failed = 0;
  const publishedIds = [];
  for (const docSnap of snap.docs) {
    // Sequential on purpose — registerArticleFiles() mutates shared source
    // files (router.ts/blog-articles-data.ts/sitemaps/...) in-process; running
    // two docs concurrently would race on the same file writes.
    const result = await processDoc(db, FieldValue, docSnap);
    if (result.ok) {
      published += 1;
      if (result.id) publishedIds.push(result.id);
    } else {
      failed += 1;
    }
  }

  console.log(`[publish-journalist-article] done — published=${published} failed=${failed}`);

  // Surface published article ids to the calling workflow (issue #4837
  // stream C): publish-journalist-articles.yml dispatches
  // fast-publish-article.yml once per id instead of waiting for the next
  // full deploy.yml build. processDoc() already returned `id` on success —
  // this loop was previously discarding it, only counting `published`.
  // GITHUB_OUTPUT values must be single-line, so the array is JSON-encoded.
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    fs.appendFileSync(githubOutput, `published_ids=${JSON.stringify(publishedIds)}\n`);
  }
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || '').href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[publish-journalist-article] FATAL:', err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
}

export { buildPipelineData, slugify, resolveHeroImage, resolveJournalistAuthor };
