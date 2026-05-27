function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/?(ul|ol|div|section|span|strong|b)[^>]*>/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&uuml;/gi, 'ü')
    .replace(/&Uuml;/gi, 'Ü')
    .replace(/&ouml;/gi, 'ö')
    .replace(/&Ouml;/gi, 'Ö')
    .replace(/&auml;/gi, 'ä')
    .replace(/&Auml;/gi, 'Ä')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function splitSections(text = '') {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const sections = [];
  let current = { heading: 'Overview', lines: [] };
  const headingPattern = /^(WAS DICH ERWARTET|ÜBER DICH|UNSERE WERTE|BENEFITS)$/i;

  for (const line of lines) {
    if (headingPattern.test(line)) {
      if (current.lines.length) sections.push(current);
      current = { heading: line, lines: [] };
      continue;
    }
    current.lines.push(line);
  }

  if (current.lines.length) sections.push(current);
  return sections;
}

function translateHeading(locale, heading) {
  const norm = String(heading || '').toUpperCase();
  const map = {
    it: {
      OVERVIEW: 'Panoramica',
      'WAS DICH ERWARTET': 'Cosa ti aspetta',
      'ÜBER DICH': 'Il tuo profilo',
      'UNSERE WERTE': 'I nostri valori',
      BENEFITS: 'Benefit',
    },
    en: {
      OVERVIEW: 'Overview',
      'WAS DICH ERWARTET': 'What to expect',
      'ÜBER DICH': 'About you',
      'UNSERE WERTE': 'Our values',
      BENEFITS: 'Benefits',
    },
    de: {
      OVERVIEW: 'Überblick',
      'WAS DICH ERWARTET': 'Was dich erwartet',
      'ÜBER DICH': 'Über dich',
      'UNSERE WERTE': 'Unsere Werte',
      BENEFITS: 'Benefits',
    },
    fr: {
      OVERVIEW: 'Aperçu',
      'WAS DICH ERWARTET': "Ce qui t'attend",
      'ÜBER DICH': 'Ton profil',
      'UNSERE WERTE': 'Nos valeurs',
      BENEFITS: 'Avantages',
    },
  };
  return map[locale]?.[norm] || heading;
}

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

export function parseLivingCircleFeed(feed) {
  const rawItems = Array.isArray(feed?.dataFeedElement) ? feed.dataFeedElement : [];
  return rawItems
    .map((entry) => entry?.item)
    .filter(Boolean)
    .map((item) => {
      const address = item?.jobLocation?.address || {};
      return {
        title: item.title || '',
        url: item.url || '',
        company: item?.hiringOrganization?.name || 'The Living Circle',
        location: address.addressLocality || '',
        region: address.addressRegion || '',
        country: address.addressCountry || '',
        descriptionHtml: item.description || '',
        descriptionText: stripHtml(item.description || ''),
        postedDate: item.datePosted || '',
        employmentType: item.employmentType || '',
      };
    });
}

function sectionMarkdown(locale, sections) {
  return sections
    .map((section) => {
      const heading = translateHeading(locale, section.heading);
      const lines = section.lines.map((line) => (line.startsWith('- ') ? line : `- ${line}`)).join('\n');
      return `## ${heading}\n${lines}`;
    })
    .join('\n\n')
    .trim();
}

export function buildLivingCircleLocalizedContent(role) {
  const sections = splitSections(role.descriptionText || '');
  const title = role.title || '';
  const loc = role.location || 'Ascona';

  const introIt = `The Living Circle cerca per la sede di ${loc} una nuova risorsa. Scopri i dettagli della posizione e candidati online.`;
  const introEn = `The Living Circle is hiring in ${loc}. Discover the details of this position and apply online.`;
  const introDe = `The Living Circle sucht am Standort ${loc} eine neue Fachkraft. Entdecken Sie die Details der Stelle und bewerben Sie sich online.`;
  const introFr = `The Living Circle recrute à ${loc}. Découvrez les détails du poste et postulez en ligne.`;

  return {
    it: {
      title,
      slug: slugify(`${title} the-living-circle ${loc}`),
      description: `${introIt}\n\n${sectionMarkdown('it', sections)}`.trim(),
    },
    en: {
      title,
      slug: slugify(`${title} the-living-circle ${loc}`),
      description: `${introEn}\n\n${sectionMarkdown('en', sections)}`.trim(),
    },
    de: {
      title,
      slug: slugify(`${title} the-living-circle ${loc}`),
      description: `${introDe}\n\n${sectionMarkdown('de', sections)}`.trim(),
    },
    fr: {
      title,
      slug: slugify(`${title} the-living-circle ${loc}`),
      description: `${introFr}\n\n${sectionMarkdown('fr', sections)}`.trim(),
    },
  };
}
