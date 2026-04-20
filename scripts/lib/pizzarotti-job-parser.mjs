import { JSDOM } from 'jsdom';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

function htmlFragmentToMarkdown(html = '') {
  const dom = new JSDOM(`<body>${html}</body>`);
  const body = dom.window.document.body;
  const parts = [];

  for (const node of [...body.children]) {
    const tag = node.tagName?.toLowerCase() || '';
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
      const text = normalizeSpace(node.textContent || '');
      if (text) parts.push(`## ${text}`);
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
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
    );
    if (text) parts.push(text);
  }

  return parts.join('\n\n').trim();
}

/**
 * Parse InRecruiting "large" view listing page (Pizzarotti theme).
 * Each card is a `div.vacancy__render`.
 */
export function parsePizzarottiListings(html = '') {
  const document = new JSDOM(html).window.document;
  return [...document.querySelectorAll('div.vacancy__render')]
    .map((card) => {
      const titleAnchor = card.querySelector('.vacancy__title h3 a') || card.querySelector('.vacancy__title a');
      const href = String(titleAnchor?.getAttribute('href') || '').trim();
      const title = normalizeSpace(titleAnchor?.textContent || '');

      const locationSpan = card.querySelector('.subtitle__informations[title="Sede"]');
      const categorySpan = card.querySelector('.subtitle__informations[title="Professione/Funzione"]')
        || card.querySelector('.subtitle__informations[title="Profession/Fonction"]')
        || card.querySelector('.subtitle__informations[title="Profession/Function"]');

      const location = normalizeSpace(locationSpan?.textContent || '');
      const category = normalizeSpace(categorySpan?.textContent || '');
      const teaser = normalizeSpace(card.querySelector('.vacancy__description')?.textContent || '');

      return { href, title, teaser, location, category };
    })
    .filter((row) => row.href && row.title);
}

/**
 * Extract total page count from InRecruiting pagination text "Pagina X di N".
 */
export function parsePizzarottiPageCount(html = '') {
  const match = html.match(/Pagina\s+\d+\s+di\s+(\d+)/);
  return match ? parseInt(match[1], 10) : 1;
}

/**
 * Check if a location text indicates a Swiss position (any canton).
 * Broader than isTargetSwissLocation which only matches Ticino/Grigioni.
 */
export function isPizzarottiSwissLocation(raw = '') {
  const lower = normalizeSpace(raw).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /svizzera|suisse|schweiz|switzerland|swiss/.test(lower);
}

/**
 * Infer canton from Pizzarotti location text.
 * Falls back to 'OTHER' if no known canton is matched.
 */
export function inferPizzarottiCanton(raw = '') {
  const lower = normalizeSpace(raw).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const cantonMap = {
    ticino: 'TI', tessin: 'TI',
    grigioni: 'GR', graubunden: 'GR', grisons: 'GR',
    neuchatel: 'NE',
    bern: 'BE', berna: 'BE', berne: 'BE',
    zurich: 'ZH', zurigo: 'ZH',
    geneva: 'GE', geneve: 'GE', ginevra: 'GE', genf: 'GE',
    basel: 'BS', basilea: 'BS',
    vaud: 'VD', waadt: 'VD',
    valais: 'VS', vallese: 'VS', wallis: 'VS',
    lucerna: 'LU', luzern: 'LU', lucerne: 'LU',
    solothurn: 'SO', soletta: 'SO', soleure: 'SO',
    fribourg: 'FR', friborgo: 'FR', freiburg: 'FR',
    aargau: 'AG', argovia: 'AG', argovie: 'AG',
    thurgau: 'TG', turgovia: 'TG', thurgovie: 'TG',
    'san gallo': 'SG', 'st. gallen': 'SG', 'saint-gall': 'SG',
    schwyz: 'SZ', svitto: 'SZ',
    jura: 'JU',
  };

  for (const [token, canton] of Object.entries(cantonMap)) {
    if (lower.includes(token)) return canton;
  }

  // Known Swiss cities
  const cityMap = {
    'le locle': 'NE', 'la chaux-de-fonds': 'NE',
    lugano: 'TI', mendrisio: 'TI', chiasso: 'TI', bellinzona: 'TI', locarno: 'TI',
    chur: 'GR', davos: 'GR',
  };
  for (const [city, canton] of Object.entries(cityMap)) {
    if (lower.includes(city)) return canton;
  }

  return 'CH';
}

/**
 * Parse InRecruiting detail page (same structure as Zucchetti detail).
 */
export function parsePizzarottiJobDetail(html = '') {
  const document = new JSDOM(html).window.document;
  const title = normalizeSpace(document.querySelector('#description__vacancy-title')?.textContent || '');
  const subtitleInfos = [...document.querySelectorAll('#description__subtitle .subtitle__informations')].map((node) =>
    normalizeSpace(node.textContent || '')
  );
  const location = subtitleInfos[0] || '';
  const category = subtitleInfos[1] || '';

  const sections = [];
  const headings = [...document.querySelectorAll('#description__body .body__headings')];
  for (const heading of headings) {
    const next = heading.nextElementSibling;
    if (!next || !next.classList.contains('body__text')) continue;
    const sectionTitle = normalizeSpace(heading.textContent || '');
    const sectionBody = htmlFragmentToMarkdown(next.innerHTML || '');
    if (!sectionBody) continue;
    sections.push(`## ${sectionTitle}\n\n${sectionBody}`);
  }

  const shareUrl = normalizeSpace(document.querySelector('.share__hidden')?.textContent || '');
  return {
    title,
    location,
    category,
    shareUrl,
    description: sections.join('\n\n').trim(),
  };
}

export function buildPizzarottiLocalizedContent(detail = {}, companyName = 'Impresa Pizzarotti & C. S.p.A.') {
  const title = String(detail.title || '').trim();
  const location = String(detail.location || '').trim() || 'Svizzera';
  return {
    titleByLocale: {
      it: title,
    },
    descriptionByLocale: {
      it: detail.description || '',
    },
    slugByLocale: {
      it: slugify(`${title} ${companyName} ${location}`),
    },
  };
}
