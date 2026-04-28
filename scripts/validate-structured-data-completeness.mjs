#!/usr/bin/env node
/**
 * Validate structured data completeness across ALL page types in dist/.
 *
 * Checks:
 *  - Every Dataset schema has `creator`, `description`, AND `license`
 *  - Every JobPosting schema has ALL mandatory fields with non-empty values
 *  - No page has a schema with empty/null mandatory fields
 *  - Samples pages across all types: active jobs, expired, company, statistics, blog
 *
 * Exit code 1 on any error → blocks deploy.
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const DIST = join(process.cwd(), 'dist');

// ── Config ──────────────────────────────────────────────────────────────────
const MAX_ERRORS_TO_PRINT = 60;
const SAMPLE_FRACTION = 0.1; // sample 10% of pages, minimum 50
const MIN_SAMPLE = 50;

// ── Helpers ─────────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) walk(full, out);
      else if (st.isFile() && full.endsWith('.html')) out.push(full);
    } catch { /* skip inaccessible */ }
  }
  return out;
}

function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch { /* skip unparseable */ }
  }
  return blocks;
}

/** Flatten @graph arrays and recursively discover nested schemas (e.g. Dataset inside isBasedOn) */
function flattenSchemas(blocks) {
  const out = [];
  const seen = new WeakSet();

  function collect(obj) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
    seen.add(obj);

    if (Array.isArray(obj)) {
      for (const item of obj) collect(item);
      return;
    }

    // Any object with @type is a schema worth validating
    if (obj['@type']) out.push(obj);

    // Recurse into @graph and all properties to find nested schemas
    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object') collect(val);
    }
  }

  for (const b of blocks) collect(b);
  return out;
}

function isNonEmpty(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return true;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

function classifyPage(filePath) {
  const rel = relative(DIST, filePath);
  if (/(^|\/)(prezzi-(diesel|benzina)|diesel-price-switzerland|gasoline-price-switzerland|dieselpreis-schweiz|benzinpreis-schweiz|prix-gasoil-suisse|prix-essence-suisse)\//.test(rel)) {
    return 'fuel';
  }
  if (/cerca-lavoro-ticino|find-jobs-ticino|jobs-im-tessin|trouver-emploi-tessin/.test(rel)) {
    // Check if it's an expired page by reading content
    return 'job'; // will refine below
  }
  if (/statistiche|statistics|statistiken|statistiques/.test(rel)) return 'statistics';
  if (/blog|articoli|articles/.test(rel)) return 'blog';
  if (/aziend|compan|unternehmen|entreprise/.test(rel)) return 'company';
  return 'other';
}

// ── Validators ──────────────────────────────────────────────────────────────

function validateDataset(schema, filePath) {
  const errors = [];
  const type = schema['@type'];
  if (type !== 'Dataset') return errors;

  if (!isNonEmpty(schema.description)) {
    errors.push({ file: filePath, type: 'Dataset', field: 'description', message: 'Dataset missing "description"' });
  }
  if (!schema.creator || !isNonEmpty(schema.creator?.name || schema.creator)) {
    errors.push({ file: filePath, type: 'Dataset', field: 'creator', message: 'Dataset missing "creator" or creator.name' });
  }
  if (!isNonEmpty(schema.license)) {
    errors.push({ file: filePath, type: 'Dataset', field: 'license', message: 'Dataset missing "license"' });
  }
  return errors;
}

function validateJobPosting(schema, filePath) {
  const errors = [];
  const type = schema['@type'];
  if (type !== 'JobPosting') return errors;

  // Mandatory Google fields
  const checks = [
    ['title', schema.title],
    ['datePosted', schema.datePosted],
    ['hiringOrganization.name', schema.hiringOrganization?.name],
    ['employmentType', schema.employmentType],
    // GSC quality issue: missing validThrough flagged as non-critical but counted
    // in the JobPosting "Issues" report — treat as deploy-blocking error.
    ['validThrough', schema.validThrough],
  ];
  for (const [field, value] of checks) {
    if (!isNonEmpty(value)) {
      errors.push({ file: filePath, type: 'JobPosting', field, message: `JobPosting missing "${field}"` });
    }
  }

  // validThrough must parse to a valid date. Past dates are allowed —
  // expired soft-landing pages legitimately use a past validThrough to
  // signal closure to Google.
  if (isNonEmpty(schema.validThrough)) {
    const vt = new Date(String(schema.validThrough));
    if (Number.isNaN(vt.getTime())) {
      errors.push({ file: filePath, type: 'JobPosting', field: 'validThrough', message: `JobPosting validThrough "${schema.validThrough}" is not a valid ISO date` });
    }
  }

  // Description must be >= 30 chars
  const desc = String(schema.description || '').trim();
  if (desc.length < 30) {
    errors.push({ file: filePath, type: 'JobPosting', field: 'description', message: `JobPosting description too short (${desc.length} chars, need >= 30)` });
  }

  // jobLocation.address must exist with addressLocality
  const address = schema.jobLocation?.address;
  if (!address) {
    errors.push({ file: filePath, type: 'JobPosting', field: 'jobLocation', message: 'JobPosting missing "jobLocation.address"' });
  } else {
    if (!isNonEmpty(address.addressLocality)) {
      errors.push({ file: filePath, type: 'JobPosting', field: 'jobLocation.address.addressLocality', message: 'JobPosting missing "addressLocality"' });
    }
    if (!isNonEmpty(address.postalCode)) {
      errors.push({ file: filePath, type: 'JobPosting', field: 'jobLocation.address.postalCode', message: 'JobPosting missing "postalCode"' });
    }
    if (!isNonEmpty(address.streetAddress)) {
      errors.push({ file: filePath, type: 'JobPosting', field: 'jobLocation.address.streetAddress', message: 'JobPosting missing "streetAddress"' });
    }
    // GSC quality issue: missing addressRegion flagged as non-critical but
    // counted in the JobPosting "Issues" report — treat as deploy-blocking.
    if (!isNonEmpty(address.addressRegion)) {
      errors.push({ file: filePath, type: 'JobPosting', field: 'jobLocation.address.addressRegion', message: 'JobPosting missing "addressRegion"' });
    } else if (!/^[A-Z]{2}$/.test(String(address.addressRegion).trim())) {
      errors.push({ file: filePath, type: 'JobPosting', field: 'jobLocation.address.addressRegion', message: `JobPosting addressRegion "${address.addressRegion}" is not a 2-letter Swiss canton code` });
    }
  }

  // baseSalary must be present and valid
  const bs = schema.baseSalary;
  if (!bs || typeof bs !== 'object') {
    errors.push({ file: filePath, type: 'JobPosting', field: 'baseSalary', message: 'JobPosting missing "baseSalary"' });
  } else {
    const val = bs.value;
    if (!val || typeof val !== 'object') {
      errors.push({ file: filePath, type: 'JobPosting', field: 'baseSalary.value', message: 'JobPosting baseSalary missing "value"' });
    } else {
      const minVal = Number(val.minValue);
      if (!Number.isFinite(minVal) || minVal <= 0) {
        errors.push({ file: filePath, type: 'JobPosting', field: 'baseSalary.value.minValue', message: 'JobPosting baseSalary.value.minValue missing or invalid' });
      }
      // FRO-maxValue: maxValue is now MANDATORY — GSC flags missing maxValue as quality issue.
      const maxVal = Number(val.maxValue);
      if (!Number.isFinite(maxVal) || maxVal <= 0) {
        errors.push({ file: filePath, type: 'JobPosting', field: 'baseSalary.value.maxValue', message: 'JobPosting baseSalary.value.maxValue missing or invalid' });
      } else if (Number.isFinite(minVal) && maxVal < minVal) {
        errors.push({ file: filePath, type: 'JobPosting', field: 'baseSalary.value.maxValue', message: 'JobPosting baseSalary.value.maxValue < minValue' });
      }
      if (!isNonEmpty(val.unitText)) {
        errors.push({ file: filePath, type: 'JobPosting', field: 'baseSalary.value.unitText', message: 'JobPosting baseSalary.value.unitText missing' });
      }
    }
    if (!isNonEmpty(bs.currency)) {
      errors.push({ file: filePath, type: 'JobPosting', field: 'baseSalary.currency', message: 'JobPosting baseSalary.currency missing' });
    }
  }

  return errors;
}

function validateEvent(schema, filePath) {
  const errors = [];
  if (schema['@type'] !== 'Event') return errors;

  // Mandatory fields for Event rich results (Google + deploy-blocking)
  const stringChecks = [
    ['name', schema.name],
    ['startDate', schema.startDate],
    ['endDate', schema.endDate],
    ['eventStatus', schema.eventStatus],
    ['eventAttendanceMode', schema.eventAttendanceMode],
  ];
  for (const [field, value] of stringChecks) {
    if (!isNonEmpty(value)) {
      errors.push({ file: filePath, type: 'Event', field, message: `Event missing "${field}"` });
    }
  }

  // description >= 30 chars
  const desc = String(schema.description || '').trim();
  if (desc.length < 30) {
    errors.push({ file: filePath, type: 'Event', field: 'description', message: `Event description too short (${desc.length} chars, need >= 30)` });
  }

  // location must exist with addressLocality
  if (!schema.location || typeof schema.location !== 'object') {
    errors.push({ file: filePath, type: 'Event', field: 'location', message: 'Event missing "location"' });
  } else {
    const addr = schema.location.address;
    if (!addr || !isNonEmpty(addr.addressLocality)) {
      errors.push({ file: filePath, type: 'Event', field: 'location.address.addressLocality', message: 'Event missing "location.address.addressLocality"' });
    }
  }

  // image — GSC flags missing Event.image as a non-critical quality issue,
  // but we treat it as blocking to keep rich-result eligibility stable.
  const hasImage = Array.isArray(schema.image)
    ? schema.image.some((img) => isNonEmpty(typeof img === 'string' ? img : img?.url))
    : isNonEmpty(typeof schema.image === 'string' ? schema.image : schema.image?.url);
  if (!hasImage) {
    errors.push({ file: filePath, type: 'Event', field: 'image', message: 'Event missing "image"' });
  }

  // organizer (must include name AND url — GSC quality issue otherwise)
  if (!schema.organizer || !isNonEmpty(schema.organizer.name)) {
    errors.push({ file: filePath, type: 'Event', field: 'organizer', message: 'Event missing "organizer" or organizer.name' });
  } else if (!isNonEmpty(schema.organizer.url)) {
    errors.push({ file: filePath, type: 'Event', field: 'organizer.url', message: 'Event missing "organizer.url"' });
  }

  // performer
  if (!schema.performer || !isNonEmpty(schema.performer.name)) {
    errors.push({ file: filePath, type: 'Event', field: 'performer', message: 'Event missing "performer" or performer.name' });
  }

  // offers (price, priceCurrency, availability, validFrom AND url)
  if (!schema.offers || typeof schema.offers !== 'object') {
    errors.push({ file: filePath, type: 'Event', field: 'offers', message: 'Event missing "offers"' });
  } else {
    if (schema.offers.price === undefined || schema.offers.price === null) {
      errors.push({ file: filePath, type: 'Event', field: 'offers.price', message: 'Event offers missing "price"' });
    }
    if (!isNonEmpty(schema.offers.priceCurrency)) {
      errors.push({ file: filePath, type: 'Event', field: 'offers.priceCurrency', message: 'Event offers missing "priceCurrency"' });
    }
    if (!isNonEmpty(schema.offers.availability)) {
      errors.push({ file: filePath, type: 'Event', field: 'offers.availability', message: 'Event offers missing "availability"' });
    }
    if (!isNonEmpty(schema.offers.validFrom)) {
      errors.push({ file: filePath, type: 'Event', field: 'offers.validFrom', message: 'Event offers missing "validFrom"' });
    }
    if (!isNonEmpty(schema.offers.url)) {
      errors.push({ file: filePath, type: 'Event', field: 'offers.url', message: 'Event offers missing "url"' });
    }
  }

  return errors;
}

function validateWebApplication(schema, filePath) {
  const errors = [];
  const type = schema['@type'];
  // Match both single string and array types
  const types = Array.isArray(type) ? type : [type];
  const isWebApp = types.includes('WebApplication') || types.includes('SoftwareApplication');
  if (!isWebApp) return errors;

  // aggregateRating is mandatory on the homepage WebApplication/SoftwareApplication
  const rel = relative(DIST, filePath);
  const isHomepage = rel === 'index.html' || rel === 'en/index.html' || rel === 'de/index.html' || rel === 'fr/index.html';
  if (isHomepage) {
    const rating = schema.aggregateRating;
    if (!rating || typeof rating !== 'object') {
      errors.push({ file: filePath, type: 'WebApplication', field: 'aggregateRating', message: 'WebApplication/SoftwareApplication on homepage missing "aggregateRating"' });
    } else {
      if (!isNonEmpty(rating.ratingValue)) {
        errors.push({ file: filePath, type: 'WebApplication', field: 'aggregateRating.ratingValue', message: 'aggregateRating missing "ratingValue"' });
      }
      if (!isNonEmpty(rating.ratingCount)) {
        errors.push({ file: filePath, type: 'WebApplication', field: 'aggregateRating.ratingCount', message: 'aggregateRating missing "ratingCount"' });
      }
      if (!isNonEmpty(rating.bestRating)) {
        errors.push({ file: filePath, type: 'WebApplication', field: 'aggregateRating.bestRating', message: 'aggregateRating missing "bestRating"' });
      }
      if (!isNonEmpty(rating.worstRating)) {
        errors.push({ file: filePath, type: 'WebApplication', field: 'aggregateRating.worstRating', message: 'aggregateRating missing "worstRating"' });
      }
    }
  }

  return errors;
}

// ── Schema.org @type whitelists ─────────────────────────────────────────────

// Types that MAY carry `inLanguage` per schema.org/inLanguage:
// CreativeWork (and ALL subclasses) + Event + LinkRole + WriteAction.
// Google's rich-results validator additionally accepts inLanguage on
// JobPosting and Product. Anything outside this set is rejected.
//
// Keep in sync with services/seo/inlanguage-whitelist.ts.
const INLANGUAGE_WHITELIST = new Set([
  // CreativeWork itself
  'CreativeWork',
  // WebPage subtree
  'WebPage',
  'CollectionPage',
  'AboutPage',
  'ContactPage',
  'FAQPage',
  'QAPage',
  'WebSite',
  // Article subtree
  'Article',
  'NewsArticle',
  'BlogPosting',
  'ScholarlyArticle',
  'TechArticle',
  'OpinionNewsArticle',
  'ReportageNewsArticle',
  // Software application subtree (extends CreativeWork)
  'SoftwareApplication',
  'WebApplication',
  'MobileApplication',
  // Other CreativeWork descendants
  'Dataset',
  'HowTo',
  'Recipe',
  'Course',
  'Book',
  'Map',
  'Message',
  'Review',
  'ClaimReview',
  'VideoObject',
  'ImageObject',
  'AudioObject',
  'MediaObject',
  // schema.org explicitly lists these as accepting inLanguage
  'Event',
  'LinkRole',
  'WriteAction',
  // Google rich-results validator also accepts inLanguage here
  'JobPosting',
  'Product',
]);

const WEBAPP_TYPES = new Set(['WebApplication', 'SoftwareApplication']);

/**
 * Recursively walk a schema tree, calling `visit(node)` for every object node
 * (objects nested inside arrays are descended transparently).
 */
function walkSchemaTree(node, visit) {
  if (Array.isArray(node)) {
    for (const item of node) walkSchemaTree(item, visit);
    return;
  }
  if (node && typeof node === 'object') {
    visit(node);
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') walkSchemaTree(v, visit);
    }
  }
}

/**
 * WebApplication / SoftwareApplication anywhere in the tree must carry
 * either an aggregateRating (with ratingValue + ratingCount/reviewCount) OR
 * a non-empty review with reviewRating.ratingValue + author.name. GSC and
 * Semrush both flag these as "missing field" warnings otherwise.
 */
function validateWebApplicationRatingOrReview(schema, filePath) {
  const errors = [];
  walkSchemaTree(schema, (obj) => {
    const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']];
    if (!types.some((t) => WEBAPP_TYPES.has(t))) return;

    const typeName = types.find((t) => WEBAPP_TYPES.has(t)) ?? 'WebApplication';

    const rating = obj.aggregateRating;
    const ratingOk =
      rating &&
      typeof rating === 'object' &&
      isNonEmpty(rating.ratingValue) &&
      (isNonEmpty(rating.ratingCount) || isNonEmpty(rating.reviewCount));

    const reviews = Array.isArray(obj.review)
      ? obj.review
      : (obj.review ? [obj.review] : []);
    const reviewOk = reviews.some((r) => {
      if (!r || typeof r !== 'object') return false;
      const rr = r.reviewRating;
      const author = r.author;
      const authorName = typeof author === 'string' ? author : author?.name;
      return (
        rr &&
        typeof rr === 'object' &&
        isNonEmpty(rr.ratingValue) &&
        isNonEmpty(authorName)
      );
    });

    if (!ratingOk && !reviewOk) {
      errors.push({
        file: filePath,
        type: typeName,
        field: 'aggregateRating|review',
        message: 'WebApplication/SoftwareApplication requires aggregateRating or review',
      });
    }
  });
  return errors;
}

/**
 * `LocalBusiness` (and subtypes) must NOT carry `serviceType` — schema.org
 * does not define that property on LocalBusiness; Semrush flags it as
 * "Invalid value for type". The valid replacements are `makesOffer`,
 * `hasOfferCatalog`, or `knowsAbout` depending on intent.
 */
function validateLocalBusinessNoServiceType(schema, filePath) {
  const errors = [];
  walkSchemaTree(schema, (obj) => {
    const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']];
    const isLB = types.some((t) => typeof t === 'string' && t.includes('LocalBusiness'));
    if (!isLB) return;
    if (Object.prototype.hasOwnProperty.call(obj, 'serviceType')) {
      errors.push({
        file: filePath,
        type: 'LocalBusiness',
        field: 'serviceType',
        message: 'LocalBusiness must not carry "serviceType" (use makesOffer/hasOfferCatalog/knowsAbout)',
      });
    }
  });
  return errors;
}

/**
 * `inLanguage` is only valid on CreativeWork-derived types. Any object whose
 * @type is outside the whitelist that carries `inLanguage` is rejected.
 */
function validateInLanguageWhitelist(schema, filePath) {
  const errors = [];
  walkSchemaTree(schema, (obj) => {
    if (!Object.prototype.hasOwnProperty.call(obj, 'inLanguage')) return;
    const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']];
    const hasAllowed = types.some((t) => typeof t === 'string' && INLANGUAGE_WHITELIST.has(t));
    if (hasAllowed) return;
    const typeName = (types.find((t) => typeof t === 'string') ?? 'unknown');
    errors.push({
      file: filePath,
      type: typeName,
      field: 'inLanguage',
      message: `inLanguage not allowed on @type "${typeName}" (CreativeWork descendants only)`,
    });
  });
  return errors;
}

function validateFuelMerchantProduct(schema, filePath) {
  const errors = [];
  const types = Array.isArray(schema['@type']) ? schema['@type'] : [schema['@type']];
  if (!types.includes('Product')) return errors;

  const rel = relative(DIST, filePath);
  if (!/(^|\/)(prezzi-(diesel|benzina)|diesel-price-switzerland|gasoline-price-switzerland|dieselpreis-schweiz|benzinpreis-schweiz|prix-gasoil-suisse|prix-essence-suisse)\//.test(rel)) {
    return errors;
  }

  const hasImage = Array.isArray(schema.image)
    ? schema.image.some((img) => isNonEmpty(img))
    : isNonEmpty(schema.image);
  if (!hasImage) {
    errors.push({ file: filePath, type: 'Product', field: 'image', message: 'Fuel Product missing "image"' });
  }

  if (!isNonEmpty(schema.description)) {
    errors.push({ file: filePath, type: 'Product', field: 'description', message: 'Fuel Product missing "description"' });
  }

  const brandName = typeof schema.brand === 'string' ? schema.brand : schema.brand?.name;
  const hasGlobalIdentifier =
    isNonEmpty(brandName) ||
    isNonEmpty(schema.gtin) ||
    isNonEmpty(schema.gtin8) ||
    isNonEmpty(schema.gtin12) ||
    isNonEmpty(schema.gtin13) ||
    isNonEmpty(schema.gtin14) ||
    isNonEmpty(schema.isbn) ||
    isNonEmpty(schema.mpn);
  if (!hasGlobalIdentifier) {
    errors.push({
      file: filePath,
      type: 'Product',
      field: 'brand_or_global_identifier',
      message: 'Fuel Product missing brand or global identifier (gtin/mpn/isbn)',
    });
  }

  const aggregateRating = schema.aggregateRating;
  if (!aggregateRating || typeof aggregateRating !== 'object') {
    errors.push({
      file: filePath,
      type: 'Product',
      field: 'aggregateRating',
      message: 'Fuel Product missing "aggregateRating"',
    });
  } else {
    if (!isNonEmpty(aggregateRating.ratingValue)) {
      errors.push({
        file: filePath,
        type: 'Product',
        field: 'aggregateRating.ratingValue',
        message: 'Fuel Product aggregateRating missing "ratingValue"',
      });
    }
    if (!isNonEmpty(aggregateRating.reviewCount) && !isNonEmpty(aggregateRating.ratingCount)) {
      errors.push({
        file: filePath,
        type: 'Product',
        field: 'aggregateRating.reviewCount',
        message: 'Fuel Product aggregateRating missing "reviewCount" or "ratingCount"',
      });
    }
    if (!isNonEmpty(aggregateRating.bestRating) || !isNonEmpty(aggregateRating.worstRating)) {
      errors.push({
        file: filePath,
        type: 'Product',
        field: 'aggregateRating.scale',
        message: 'Fuel Product aggregateRating missing "bestRating" or "worstRating"',
      });
    }
  }

  const review = Array.isArray(schema.review) ? schema.review[0] : schema.review;
  if (!review || typeof review !== 'object') {
    errors.push({
      file: filePath,
      type: 'Product',
      field: 'review',
      message: 'Fuel Product missing "review"',
    });
  } else {
    if (!isNonEmpty(review.reviewBody)) {
      errors.push({
        file: filePath,
        type: 'Product',
        field: 'review.reviewBody',
        message: 'Fuel Product review missing "reviewBody"',
      });
    }
    if (!isNonEmpty(review.author?.name || review.author)) {
      errors.push({
        file: filePath,
        type: 'Product',
        field: 'review.author',
        message: 'Fuel Product review missing "author"',
      });
    }
    if (!isNonEmpty(review.reviewRating?.ratingValue)) {
      errors.push({
        file: filePath,
        type: 'Product',
        field: 'review.reviewRating.ratingValue',
        message: 'Fuel Product review missing "reviewRating.ratingValue"',
      });
    }
  }

  const offer = schema.offers;
  if (!offer || typeof offer !== 'object') return errors;

  const returnPolicy = offer.hasMerchantReturnPolicy;
  if (!returnPolicy || typeof returnPolicy !== 'object') {
    errors.push({
      file: filePath,
      type: 'Offer',
      field: 'hasMerchantReturnPolicy',
      message: 'Fuel Offer missing "hasMerchantReturnPolicy"',
    });
  } else {
    if (!isNonEmpty(returnPolicy.applicableCountry)) {
      errors.push({
        file: filePath,
        type: 'Offer',
        field: 'hasMerchantReturnPolicy.applicableCountry',
        message: 'Fuel Offer return policy missing "applicableCountry"',
      });
    }
    if (!isNonEmpty(returnPolicy.returnPolicyCategory)) {
      errors.push({
        file: filePath,
        type: 'Offer',
        field: 'hasMerchantReturnPolicy.returnPolicyCategory',
        message: 'Fuel Offer return policy missing "returnPolicyCategory"',
      });
    }
  }

  const shipping = offer.shippingDetails;
  if (!shipping || typeof shipping !== 'object') {
    errors.push({
      file: filePath,
      type: 'Offer',
      field: 'shippingDetails',
      message: 'Fuel Offer missing "shippingDetails"',
    });
  } else {
    if (!isNonEmpty(shipping.shippingDestination?.addressCountry)) {
      errors.push({
        file: filePath,
        type: 'Offer',
        field: 'shippingDetails.shippingDestination.addressCountry',
        message: 'Fuel Offer shippingDetails missing "shippingDestination.addressCountry"',
      });
    }
    if (!isNonEmpty(shipping.shippingRate?.currency)) {
      errors.push({
        file: filePath,
        type: 'Offer',
        field: 'shippingDetails.shippingRate.currency',
        message: 'Fuel Offer shippingDetails missing "shippingRate.currency"',
      });
    }
    if (!isNonEmpty(shipping.shippingRate?.value) && !isNonEmpty(shipping.shippingRate?.maxValue)) {
      errors.push({
        file: filePath,
        type: 'Offer',
        field: 'shippingDetails.shippingRate.value',
        message: 'Fuel Offer shippingDetails missing shipping rate value/maxValue',
      });
    }

    const handling = shipping.deliveryTime?.handlingTime;
    const transit = shipping.deliveryTime?.transitTime;
    if (!handling || !transit) {
      errors.push({
        file: filePath,
        type: 'Offer',
        field: 'shippingDetails.deliveryTime',
        message: 'Fuel Offer shippingDetails missing "deliveryTime.handlingTime" or "deliveryTime.transitTime"',
      });
    } else {
      for (const [label, value] of [['handlingTime', handling], ['transitTime', transit]]) {
        if (!isNonEmpty(value.minValue) || !isNonEmpty(value.maxValue) || !isNonEmpty(value.unitCode)) {
          errors.push({
            file: filePath,
            type: 'Offer',
            field: `shippingDetails.deliveryTime.${label}`,
            message: `Fuel Offer ${label} missing minValue/maxValue/unitCode`,
          });
        }
      }
    }
  }

  return errors;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(DIST)) {
    console.error('dist/ directory not found — run build first');
    process.exit(1);
  }

  console.log('[structured-data-completeness] Scanning dist/ for HTML files...');
  const allFiles = walk(DIST);
  console.log(`[structured-data-completeness] Found ${allFiles.length} HTML files`);

  // Categorize files for targeted sampling
  const byCategory = { fuel: [], job: [], statistics: [], blog: [], company: [], other: [] };
  for (const f of allFiles) {
    const cat = classifyPage(f);
    (byCategory[cat] || byCategory.other).push(f);
  }

  // Sample: take all statistics + proportional sample of jobs, blog, company, other
  const sampled = new Set();

  // Always include ALL statistics pages (small count, critical for Dataset validation)
  for (const f of byCategory.statistics) sampled.add(f);

  // Always include ALL fuel pages. These pages emit Product merchant listing
  // markup and should hard-fail if a template drops required or warning-prone
  // fields such as image, brand, shipping or returns.
  for (const f of byCategory.fuel) sampled.add(f);

  // Always include ALL blog pages (Event schema validation requires checking every Event article)
  for (const f of byCategory.blog) sampled.add(f);

  // Always include homepage files (critical for WebApplication/SoftwareApplication aggregateRating)
  const homepageFiles = ['index.html', 'en/index.html', 'de/index.html', 'fr/index.html'];
  for (const hp of homepageFiles) {
    const full = join(DIST, hp);
    if (existsSync(full)) sampled.add(full);
  }

  // Always include Event-bearing pages (ItemList of Event schemas — must stay
  // valid because GSC flags organizer.url / image / offers.url as quality issues)
  const eventPages = [
    'tasse-e-pensione/festivita-ticino/index.html',
    'en/taxes-and-pension/ticino-public-holidays/index.html',
    'de/steuern-und-vorsorge/tessin-feiertage/index.html',
    'fr/impots-et-retraite/jours-feries-tessin/index.html',
  ];
  for (const ep of eventPages) {
    const full = join(DIST, ep);
    if (existsSync(full)) sampled.add(full);
  }

  // Sample from each category
  for (const cat of ['job', 'blog', 'company', 'other']) {
    const files = byCategory[cat];
    const sampleSize = Math.max(MIN_SAMPLE, Math.ceil(files.length * SAMPLE_FRACTION));
    // Deterministic sample: take evenly spaced entries
    const step = Math.max(1, Math.floor(files.length / sampleSize));
    let added = 0;
    for (let i = 0; i < files.length && added < sampleSize; i += step) {
      sampled.add(files[i]);
      added++;
    }
  }

  console.log(`[structured-data-completeness] Sampling ${sampled.size} pages (fuel: ${byCategory.fuel.length}, statistics: ${byCategory.statistics.length}, jobs: ${byCategory.job.length}, blog: ${byCategory.blog.length}, company: ${byCategory.company.length}, other: ${byCategory.other.length})`);

  let totalSchemas = 0;
  let datasetCount = 0;
  let jobPostingCount = 0;
  let eventCount = 0;

  // Process files in parallel batches for faster I/O
  const BATCH_SIZE = 200;
  const sampledArr = [...sampled];
  const allErrors = [];

  for (let batchStart = 0; batchStart < sampledArr.length; batchStart += BATCH_SIZE) {
    const batch = sampledArr.slice(batchStart, batchStart + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (file) => {
      let html;
      try { html = await readFile(file, 'utf-8'); } catch { return { errors: [], schemas: 0, datasets: 0, jobs: 0, events: 0 }; }

      const blocks = extractJsonLd(html);
      const schemas = flattenSchemas(blocks);
      const errors = [];
      let schemas_ = 0, datasets_ = 0, jobs_ = 0, events_ = 0;
      const isBridge = html.includes('__BRIDGE_TARGET_SLUG__');

      // Detect duplicate top-level schema types (e.g. two FAQPage blocks).
      // Only count top-level blocks (from extractJsonLd), not nested schemas.
      const topLevelTypeCounts = {};
      for (const block of blocks) {
        const t = block?.['@type'];
        if (t && typeof t === 'string') topLevelTypeCounts[t] = (topLevelTypeCounts[t] || 0) + 1;
      }
      const UNIQUE_TYPES = ['FAQPage', 'HowTo', 'Article', 'NewsArticle', 'BlogPosting'];
      for (const ut of UNIQUE_TYPES) {
        if ((topLevelTypeCounts[ut] || 0) > 1) {
          errors.push({ file, type: ut, field: 'duplicate', message: `Duplicate ${ut} schema (${topLevelTypeCounts[ut]} found, max 1)` });
        }
      }

      for (const schema of schemas) {
        if (!schema || typeof schema !== 'object' || !schema['@type']) continue;
        schemas_++;

        if (schema['@type'] === 'Dataset') {
          datasets_++;
          errors.push(...validateDataset(schema, file));
        }
        if (schema['@type'] === 'JobPosting') {
          jobs_++;
          if (!isBridge) errors.push(...validateJobPosting(schema, file));
        }
        if (schema['@type'] === 'Event') {
          events_++;
          errors.push(...validateEvent(schema, file));
        }
        const schemaTypes = Array.isArray(schema['@type']) ? schema['@type'] : [schema['@type']];
        if (schemaTypes.includes('WebApplication') || schemaTypes.includes('SoftwareApplication')) {
          errors.push(...validateWebApplication(schema, file));
        }
        if (schemaTypes.includes('Product')) {
          errors.push(...validateFuelMerchantProduct(schema, file));
        }
      }

      // Tree-walk validators (run once per top-level schema; recurse internally).
      // These three gates were added to catch Semrush regressions on
      // /calcola-stipendio (WebApplication missing aggregateRating/review),
      // /compara-servizi/confronta-banche (LocalBusiness with serviceType),
      // and /en/cost-of-living-* + /de/.../tessin-feiertage (inLanguage on
      // non-CreativeWork @types).
      for (const schema of schemas) {
        if (!schema || typeof schema !== 'object' || !schema['@type']) continue;
        errors.push(...validateWebApplicationRatingOrReview(schema, file));
        errors.push(...validateLocalBusinessNoServiceType(schema, file));
        errors.push(...validateInLanguageWhitelist(schema, file));
      }
      return { errors, schemas: schemas_, datasets: datasets_, jobs: jobs_, events: events_ };
    }));

    for (const r of results) {
      allErrors.push(...r.errors);
      totalSchemas += r.schemas;
      datasetCount += r.datasets;
      jobPostingCount += r.jobs;
      eventCount += r.events;
    }
  }

  // Deduplicate by file+field
  const seen = new Set();
  const uniqueErrors = [];
  for (const e of allErrors) {
    const key = `${e.file}|${e.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueErrors.push(e);
  }

  // Report
  console.log(`[structured-data-completeness] Checked ${totalSchemas} schemas (${datasetCount} Dataset, ${jobPostingCount} JobPosting, ${eventCount} Event)`);

  if (uniqueErrors.length > 0) {
    // Group by error type for summary
    const byField = {};
    for (const e of uniqueErrors) {
      const key = `${e.type}:${e.field}`;
      byField[key] = (byField[key] || 0) + 1;
    }

    console.error(`\n[structured-data-completeness] ${uniqueErrors.length} structured data errors found:\n`);
    console.error('Summary by field:');
    for (const [field, count] of Object.entries(byField).sort((a, b) => b[1] - a[1])) {
      console.error(`  ${field}: ${count} pages`);
    }

    console.error('\nDetails (first ' + MAX_ERRORS_TO_PRINT + '):');
    for (const e of uniqueErrors.slice(0, MAX_ERRORS_TO_PRINT)) {
      const rel = relative(DIST, e.file);
      console.error(`  ${rel} — ${e.message}`);
    }
    if (uniqueErrors.length > MAX_ERRORS_TO_PRINT) {
      console.error(`  ... and ${uniqueErrors.length - MAX_ERRORS_TO_PRINT} more`);
    }
    process.exit(1);
  }

  console.log(`[structured-data-completeness] All ${totalSchemas} schemas valid (${datasetCount} Dataset, ${jobPostingCount} JobPosting, ${eventCount} Event across ${sampled.size} pages)`);
}

main();
