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
 *   5. Stamps the Firestore doc `published`/`failed` and sends a best-effort
 *      "your article is live" email.
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
  sanitizeBoldFormatting,
  validateAndEnforceCTA,
  optimizeSeoMetadata,
  normalizeTitleCasing,
  splitBodyIntoSections,
  generateExcerpt,
} from './create-article.mjs';
import { generateFaqIT } from './batch-add-faq-to-articles.mjs';
import { appendCatalogEntry } from './generate-journalist-image-catalog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BASE_URL = 'https://frontaliereticino.ch';

// Mirrors ARTICLE_SECTION_CONFIGS.frontaliere.hubSlug in create-article.mjs
// (journalist articles are always registered into the default 'frontaliere'
// section — this script never passes --section, so create-article.mjs's own
// module-scope SECTION resolves to 'frontaliere' too).
const HUB_SLUG = {
  it: 'articoli-frontaliere',
  en: 'cross-border-articles',
  de: 'grenzgaenger-artikel',
  fr: 'articles-frontalier',
};

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
      it: doc.imageAlt || `Immagine editoriale relativa a: ${title}`,
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

  console.log('  ❓ generating FAQ (generateFaqIT)...');
  data.content.it.faq = await generateFaqIT(data.id, rawBody);
}

/** After translateArticle() has filled content.en/de/fr, derive + sanitize
 * per-locale slugs — mirrors create-article.mjs's validate() (not exported),
 * lines ~4897-4976: translated-title fallback, diacritics/non-ASCII strip,
 * 80-char cap. IT slug is fixed to the article id (pipeline convention). */
function deriveLocaleSlugs(data) {
  data.slugs.it = data.id;
  for (const locale of ['en', 'de', 'fr']) {
    const title = String(data.content[locale]?.title || data.content.it.title || '');
    const fallback = title ? slugify(title) : data.slugs.it;
    data.slugs[locale] = fallback || data.slugs.it;
  }
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

function buildPublishedUrls(data) {
  const out = {};
  for (const locale of ['it', 'en', 'de', 'fr']) {
    if (data.slugs[locale]) out[locale] = `${BASE_URL}/${HUB_SLUG[locale]}/${data.slugs[locale]}/`;
  }
  return out;
}

/** Best-effort "your article is live" email — never throws. */
async function sendPublishedEmail(doc, publishedUrls) {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn('  ⚠️  RESEND_API_KEY not set — skipping publish notification email.');
      return;
    }
    const to = doc.authorEmail;
    if (!to) return;
    const linkList = Object.entries(publishedUrls)
      .map(([locale, url]) => `<li>${locale.toUpperCase()}: <a href="${url}">${url}</a></li>`)
      .join('');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: 'Frontaliere Ticino <redazione@frontaliereticino.ch>',
        to,
        subject: 'Il tuo articolo è online',
        html:
          `<h2>Il tuo articolo è stato pubblicato</h2>` +
          `<p>Ciao ${doc.authorName || ''},</p>` +
          `<p>Il tuo articolo "${doc.content?.it?.title || ''}" è ora online nelle 4 lingue del sito:</p>` +
          `<ul>${linkList}</ul>` +
          `<p>Puoi seguire statistiche e stato pubblicazione dalla tua dashboard.</p>`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`  ⚠️  publish notification email failed: Resend ${res.status}: ${errText.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`  ⚠️  publish notification email failed (non-fatal): ${err.message}`);
  }
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

    data.author = pickAuthorForTopic(
      [data.category, data.seo.keywords, data.seo.headline, data.content.it.title, data.id].join(' '),
      data.id,
    );

    const imageResolution = await resolveHeroImage(data, doc);
    console.log(`  🖼️  hero image: ${imageResolution.source}`);

    console.log('  🌍 translating (translateArticle)...');
    await translateArticle(data);

    deriveLocaleSlugs(data);

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
    await registerArticleFiles(data);

    const publishedUrls = buildPublishedUrls(data);
    await docSnap.ref.update({
      status: 'published',
      publishedAt: FieldValue.serverTimestamp(),
      slugs: data.slugs,
      publishedUrls,
      errorMessage: null,
    });
    console.log(`  ✅ published: ${publishedUrls.it}`);

    await sendPublishedEmail(doc, publishedUrls);

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
  for (const docSnap of snap.docs) {
    // Sequential on purpose — registerArticleFiles() mutates shared source
    // files (router.ts/blog-articles-data.ts/sitemaps/...) in-process; running
    // two docs concurrently would race on the same file writes.
    const result = await processDoc(db, FieldValue, docSnap);
    if (result.ok) published += 1;
    else failed += 1;
  }

  console.log(`[publish-journalist-article] done — published=${published} failed=${failed}`);
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

export { buildPipelineData, deriveLocaleSlugs, buildPublishedUrls, slugify };
