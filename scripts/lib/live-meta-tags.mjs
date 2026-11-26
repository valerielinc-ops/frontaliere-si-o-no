/**
 * Read live `<meta>` start tags without pulling the crawler HTML lexer into the
 * SEO render graph. The renderer uses this for already-built head fragments;
 * crawler-facing readers use `html-attr.mjs` instead. Keeping this helper
 * dependency-free is part of the jobs SEO fingerprint contract.
 */

const NON_LIVE_CONTAINER_CLOSE = {
  script: /<\/script\s*>/ig,
  style: /<\/style\s*>/ig,
  template: /<\/template\s*>/ig,
  textarea: /<\/textarea\s*>/ig,
  title: /<\/title\s*>/ig,
};

function findTagEnd(source, start) {
  let quote = '';
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index + 1;
    }
  }
  return -1;
}

/**
 * Skip one container whose contents are not live document markup. Template
 * contents can contain nested templates, comments and raw-text elements, so
 * its matching close must be found structurally instead of with a bare
 * `indexOf('</template>')`.
 *
 * @param {string} source
 * @param {string} name
 * @param {number} openEnd
 * @returns {number}
 */
function findNonLiveContainerEnd(source, name, openEnd) {
  if (name !== 'template') {
    const closePattern = NON_LIVE_CONTAINER_CLOSE[name];
    closePattern.lastIndex = openEnd;
    const close = closePattern.exec(source);
    return close ? close.index + close[0].length : source.length;
  }

  let depth = 1;
  let cursor = openEnd;
  while (cursor < source.length) {
    if (source.startsWith('<!--', cursor)) {
      const close = source.indexOf('-->', cursor + 4);
      cursor = close === -1 ? source.length : close + 3;
      continue;
    }
    if (source[cursor] !== '<') {
      cursor += 1;
      continue;
    }

    const templateTag = source.slice(cursor).match(/^<\/?template(?=[\s/>])/i);
    if (templateTag) {
      const tagEnd = findTagEnd(source, cursor);
      if (tagEnd === -1) return source.length;
      if (templateTag[0][1] === '/') {
        depth -= 1;
        if (depth === 0) return tagEnd;
      } else {
        depth += 1;
      }
      cursor = tagEnd;
      continue;
    }

    const nestedContainer = source.slice(cursor).match(/^<(script|style|textarea|title)(?=[\s/>])/i);
    if (nestedContainer) {
      const tagEnd = findTagEnd(source, cursor);
      if (tagEnd === -1) return source.length;
      cursor = findNonLiveContainerEnd(source, nestedContainer[1].toLowerCase(), tagEnd);
      continue;
    }

    const tagEnd = findTagEnd(source, cursor);
    if (tagEnd === -1) return source.length;
    cursor = tagEnd;
  }
  return source.length;
}

/**
 * Return live meta start tags in document order. Ordinary start tags are
 * consumed as a unit, so a tag-shaped value inside an attribute is skipped;
 * comments and inert/RCDATA/raw-text containers are skipped for the same
 * reason.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function scanLiveMetaTags(html = '') {
  const source = String(html || '');
  const tags = [];
  let cursor = 0;

  while (cursor < source.length) {
    if (source.startsWith('<!--', cursor)) {
      const close = source.indexOf('-->', cursor + 4);
      cursor = close === -1 ? source.length : close + 3;
      continue;
    }
    if (source[cursor] !== '<') {
      cursor += 1;
      continue;
    }

    const opening = source.slice(cursor).match(/^<([a-z][a-z0-9:-]*)(?=\s|\/?>)/i);
    if (!opening) {
      cursor += 1;
      continue;
    }
    const end = findTagEnd(source, cursor);
    if (end === -1) break;
    const name = opening[1].toLowerCase();
    const raw = source.slice(cursor, end);
    if (name === 'meta') tags.push(raw);

    if (name === 'script' || name === 'style' || name === 'template' || name === 'textarea' || name === 'title') {
      cursor = findNonLiveContainerEnd(source, name, end);
    } else {
      cursor = end;
    }
  }

  return tags;
}

/**
 * Read one attribute from a live meta start tag, preserving quoted values.
 *
 * @param {string} tag
 * @param {string} name
 * @returns {string}
 */
export function readLiveMetaAttr(tag = '', name = '') {
  const target = String(name).toLowerCase();
  const attributes = String(tag || '').match(/(?:^|\s)([a-z][a-z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gi) || [];
  for (const assignment of attributes) {
    const match = assignment.match(/(?:^|\s)([a-z][a-z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/i);
    if (match?.[1]?.toLowerCase() !== target) continue;
    return match[2] ?? match[3] ?? match[4] ?? '';
  }
  return '';
}
