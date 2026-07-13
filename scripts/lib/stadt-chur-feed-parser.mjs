/**
 * Stadt Chur (jobs.chur.ch, Rexx Systems ATS) feed parsers.
 *
 * The live feed is RSS 2.0 (`<item>`, textual `<link>`, `<description>`,
 * `<pubDate>`) — NOT Atom, despite the `rss_generator-rss0.php` endpoint and
 * the historical "Atom" naming. Both dialects are handled so the crawler works
 * whether the direct fetch or the morss open-source proxy passthrough served
 * the bytes.
 *
 * Extracted from update-stadt-chur-jobs.mjs so the pure parsing logic is unit
 * testable without running the crawler's main() (which fetches + writes files).
 */

export function decodeHtmlEntities(str = '') {
  return String(str)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/g, "'");
}

/** Parse Atom `<entry>` elements (link via href attr, `<summary>`, `<updated>`). */
export function parseAtomEntries(xmlText = '') {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xmlText)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? decodeHtmlEntities(m[1].trim()) : '';
    };
    const getAttr = (tag, attr) => {
      const m = block.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`));
      return m ? decodeHtmlEntities(m[1].trim()) : '';
    };
    entries.push({
      title: get('title'),
      link: getAttr('link', 'href') || get('link'),
      id: get('id'),
      summary: get('summary'),
      updated: get('updated'),
      category: getAttr('category', 'term'),
    });
  }
  return entries;
}

/** Parse RSS 2.0 `<item>` elements (textual `<link>`, `<description>`, `<pubDate>`). */
export function parseRssItems(xmlText = '') {
  const entries = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xmlText)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? decodeHtmlEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()) : '';
    };
    const link = get('link') || get('guid');
    // Only keep real job-detail links (Rexx emits `...-de-jNNNN.html`) hosted
    // on jobs.chur.ch itself; skip channel/self rows, malformed items, or
    // (when served via the untrusted morss proxy) links pointing off-domain.
    if (!/j\d+\.html/i.test(link) || !link.startsWith('https://jobs.chur.ch/')) continue;
    entries.push({
      title: get('title'),
      link,
      id: get('guid') || link,
      summary: get('description'),
      updated: get('pubDate'),
      category: get('category'),
    });
  }
  return entries;
}

/**
 * Dispatch on the actual feed dialect so the crawler works whether the direct
 * fetch (Atom) or the morss proxy (RSS 2.0) served the bytes.
 */
export function parseFeed(xmlText = '') {
  if (/<entry[\s>]/.test(xmlText)) {
    const atom = parseAtomEntries(xmlText);
    if (atom.length) return atom;
  }
  return parseRssItems(xmlText);
}
