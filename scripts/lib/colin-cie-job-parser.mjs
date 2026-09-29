/**
 * Colin&Cie detail page → job description.
 *
 * The page is a column of `contentBlock` divs: an intro `<h4>` (mediumStyle),
 * three `<h3 class="pinkStyle">` sections with a list («Das bieten wir Ihnen»,
 * «Ihre Hauptaufgaben bei uns», «Das bringen Sie mit»), then `<h4>` pink
 * blocks with paragraphs: the group («Die Colin&Cie-Gruppe»), the office the
 * vacancy belongs to («Colin&Cie in Luxemburg» / «… in Zürich») and the
 * closing call. The contact card with the recruiter's name and phone follows
 * and is not part of the description.
 *
 * Reading only the intro and the three lists dropped the office paragraph:
 * the Luxembourg and the Zürich wealth-manager postings published the same
 * body although the ads describe two different offices (issue 5253).
 */

export function decodeColinCieEntities(text = '') {
  return String(text || '')
    .replace(/&#038;/g, '&')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

export function stripColinCieHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const clean = (html) => decodeColinCieEntities(stripColinCieHtml(html)).trim();

export function parseColinCieJobDescription(html = '') {
  const source = String(html || '');
  const parts = [];

  const intro = source.match(/<h4><strong><span[^>]*class="mediumStyle"[^>]*>([\s\S]*?)<\/span><\/strong><\/h4>/i);
  if (intro) {
    const text = clean(intro[1]);
    if (text) parts.push({ index: intro.index, text });
  }

  const listSection = /<h3[^>]*><span[^>]*class="pinkStyle"[^>]*>([\s\S]*?)<\/span><\/h3>\s*<ul[^>]*>([\s\S]*?)<\/ul>/gi;
  for (const match of source.matchAll(listSection)) {
    const heading = clean(match[1]);
    const items = [...match[2].matchAll(/<li>([\s\S]*?)<\/li>/gi)].map((item) => clean(item[1])).filter(Boolean);
    if (items.length > 0) parts.push({ index: match.index, text: `## ${heading}\n${items.map((item) => `• ${item}`).join('\n')}` });
  }

  const paragraphSection = /<h4[^>]*><span[^>]*class="pinkStyle"[^>]*>([\s\S]*?)<\/span><\/h4>\s*((?:<p[^>]*>[\s\S]*?<\/p>\s*)+)/gi;
  for (const match of source.matchAll(paragraphSection)) {
    const heading = clean(match[1]);
    const body = clean(match[2]).replace(/\n{2,}/g, '\n');
    if (body) parts.push({ index: match.index, text: `## ${heading}\n${body}` });
  }

  return parts.sort((a, b) => a.index - b.index).map((part) => part.text).join('\n\n');
}
