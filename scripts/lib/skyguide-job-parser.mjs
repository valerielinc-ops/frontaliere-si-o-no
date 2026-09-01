import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
import { JSDOM } from 'jsdom';
import {  inferSwissTargetCanton, inferAnyCanton, isTargetSwissLocation  } from './target-swiss-locations.mjs';
import { isSuccessFactorsWidgetText, sanitizeSuccessFactorsField } from './successfactors-jobs2web-widget-guard.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
}

function htmlFragmentToMarkdown(html = '') {
  const dom = new JSDOM(`<body>${html}</body>`);
  const body = dom.window.document.body;
  const parts = [];

  for (const node of [...body.childNodes]) {
    const tag = node.nodeName?.toLowerCase?.() || '';
    if (tag === '#text') {
      const text = normalizeSpace(node.textContent || '');
      if (text) parts.push(text);
      continue;
    }
    if (!tag) continue;
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
      const text = normalizeSpace(node.textContent || '');
      if (text) parts.push(`## ${text.replace(/:$/, '')}`);
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = [...node.querySelectorAll('li')]
        .map((li) => normalizeSpace(li.textContent || ''))
        .filter(Boolean)
        .map((text) => `- ${text}`);
      if (items.length) parts.push(items.join('\n'));
      continue;
    }

    const text = normalizeSpace(
      (node.innerHTML || '')
        .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/(?:p|div|li)>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
    );
    if (text) parts.push(text);
  }

  return parts.join('\n\n').trim();
}

export function parseSkyguideListings(html = '') {
  const document = new JSDOM(html).window.document;
  const rows = [];
  let skippedMalformedRows = 0;
  let ignoredNonJobRows = 0;
  for (const row of document.querySelectorAll('#searchresults tr.data-row')) {
    const link = row.querySelector('a.jobTitle-link');
    const parsed = {
      href: String(link?.getAttribute('href') || '').trim(),
      title: normalizeSpace(link?.textContent || ''),
      location: normalizeSpace(row.querySelector('.colLocation .jobLocation, .jobdetail-phone .jobLocation')?.textContent || ''),
      department: normalizeSpace(row.querySelector('.colDepartment .jobDepartment, .jobdetail-phone .jobFacility')?.textContent || ''),
    };
    // A row whose title IS the j2w page chrome (cookie-consent widget,
    // keyword-search box, job-alert box) is not a posting. Count it separately
    // so known chrome cannot inflate the structural-drift ratio.
    if (isSuccessFactorsWidgetText(parsed.title)) {
      ignoredNonJobRows += 1;
      continue;
    }
    if (!parsed.href || !parsed.title) {
      skippedMalformedRows += 1;
      continue;
    }
    rows.push(parsed);
  }
  return { rows, skippedMalformedRows, ignoredNonJobRows };
}

export function isSkyguideTargetLocation(raw = '') {
  return isTargetSwissLocation(raw, { includeGrigioni: true });
}

export function inferSkyguideCanton(raw = '') {
  // No Ticino default — Skyguide's two area control centres are in Geneva (GE)
  // and Dübendorf (ZH), plus towers nationwide. Leave blank when unresolved;
  // the downstream hardening derives the canton from the city.
  return inferAnyCanton(raw) || '';
}

export function parseSkyguideJobDetail(html = '') {
  const document = new JSDOM(html).window.document;
  // Title: prefer the typed body <span> and exclude void <meta>/<link> microdata
  // nodes. An unscoped `[itemprop="title"]` returns the first match in document
  // order, so a `<meta itemprop="title">` shipped in <head> (whose textContent is
  // empty) would win → blank title (same void-node-wins class as #1885).
  const titleEl =
    document.querySelector('span[itemprop="title"]') ||
    document.querySelector('[itemprop="title"]:not(meta):not(link)');
  // Sanitized against j2w widget chrome: safe to blank out here because the
  // consumer (scripts/update-skyguide-jobs.mjs buildSkyguideJob) falls back
  // through `detail.title || listing.title` when this comes back empty.
  const title = sanitizeSuccessFactorsField(normalizeSpace(titleEl?.textContent || ''));
  // streetAddress/datePosted are read from the `content=` attribute, so scope to
  // `meta[itemprop]` (same idiom as damiani/ariston) — this rejects a non-meta
  // or a void node in <head> winning the unscoped first-match.
  const location = normalizeSpace(document.querySelector('meta[itemprop="streetAddress"]')?.getAttribute('content') || '');
  const datePostedRaw = normalizeSpace(document.querySelector('meta[itemprop="datePosted"]')?.getAttribute('content') || '');
  const applyPath = normalizeSpace(document.querySelector('a.apply.dialogApplyBtn')?.getAttribute('href') || '');
  const intro = htmlFragmentToMarkdown(document.querySelector('.customPlugin .inner')?.innerHTML || '');
  const descriptionHtml = document.querySelector('span.jobdescription')?.innerHTML || '';
  let description = htmlFragmentToMarkdown(descriptionHtml);
  description = description
    .replace(/\bDescrizione:\s*/i, '## Descrizione\n\n')
    .replace(/\bRequisiti:\s*/i, '\n\n## Requisiti\n\n')
    .replace(/\bLuogo di lavoro:\s*/i, '\n\n## Luogo di lavoro\n\n')
    .replace(/\bGrado di occupazione:\s*/i, '\n\n## Grado di occupazione\n\n')
    .replace(/\bInizio della formazione:\s*/i, '\n\n## Inizio della formazione\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Widget chrome bleeding into the description block (same class as the
  // title bleed) — blank it out so a widget-only block doesn't ship as body
  // text; `intro` alone still survives the join below.
  description = sanitizeSuccessFactorsField(description);
  const fullDescription = [intro, description].filter(Boolean).join('\n\n');
  return {
    title,
    location,
    datePostedRaw,
    applyPath,
    intro,
    description: fullDescription,
  };
}

export function buildSkyguideLocalizedContent(detail = {}, companyName = 'Skyguide') {
  const title = String(detail.title || '').trim();
  const location = String(detail.location || '').trim() || 'Svizzera';
  const description = String(detail.description || '').trim();
  return {
    titleByLocale: {
      it: title,
    },
    descriptionByLocale: {
      it: description,
    },
    slugByLocale: {
      it: slugify(`${title} ${companyName} ${location}`),
    },
  };
}
