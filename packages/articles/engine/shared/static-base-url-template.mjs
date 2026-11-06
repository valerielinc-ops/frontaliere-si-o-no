const STATIC_BASE_URL_TEMPLATE_RE = /^`\$\{BASE_URL\}((?:(?:\\(?:\r\n|[\s\S]))|(?!\$\{)[^`\\])*)`$/u;
const STATIC_BASE_URL_TEMPLATE_GLOBAL_RE = /`\$\{BASE_URL\}((?:(?:\\(?:\r\n|[\s\S]))|(?!\$\{)[^`\\])*)`/gu;

function templateSuffix(value) {
  return STATIC_BASE_URL_TEMPLATE_RE.exec(value)?.[1];
}

/** Return whether a template contains only the static BASE_URL interpolation. */
export function isStaticBaseUrlTemplate(value) {
  return typeof value === 'string' && templateSuffix(value) !== undefined;
}

/** Replace every static BASE_URL template without accepting a second interpolation. */
export function replaceStaticBaseUrlTemplates(source, replacer) {
  return source.replace(STATIC_BASE_URL_TEMPLATE_GLOBAL_RE, (match) => replacer(match));
}

function codePoint(value, index) {
  const rest = value.slice(index + 1);
  const match = /^u\{([0-9a-fA-F]+)\}/u.exec(rest);
  if (!match) return undefined;
  const point = Number.parseInt(match[1], 16);
  if (!Number.isSafeInteger(point) || point > 0x10ffff) return undefined;
  return { value: String.fromCodePoint(point), consumed: match[0].length };
}

function codeUnit(value, index) {
  const match = /^u([0-9a-fA-F]{4})/u.exec(value.slice(index + 1));
  if (!match) return undefined;
  return { value: String.fromCharCode(Number.parseInt(match[1], 16)), consumed: match[0].length };
}

function hexByte(value, index) {
  const match = /^x([0-9a-fA-F]{2})/u.exec(value.slice(index + 1));
  if (!match) return undefined;
  return { value: String.fromCharCode(Number.parseInt(match[1], 16)), consumed: match[0].length };
}

/** Decode the cooked value of the source text inside a JavaScript template literal. */
function decodeTemplateSuffix(value) {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') {
      result += value[index];
      continue;
    }

    if (index + 1 >= value.length) {
      result += '\\';
      continue;
    }

    const next = value[index + 1];
    if (next === '\r' || next === '\n' || next === '\u2028' || next === '\u2029') {
      index += next === '\r' && value[index + 2] === '\n' ? 2 : 1;
      continue;
    }

    const point = next === 'u' ? codePoint(value, index) : undefined;
    if (point) {
      result += point.value;
      index += point.consumed;
      continue;
    }

    const unit = next === 'u' ? codeUnit(value, index) : undefined;
    if (unit) {
      result += unit.value;
      index += unit.consumed;
      continue;
    }

    const byte = next === 'x' ? hexByte(value, index) : undefined;
    if (byte) {
      result += byte.value;
      index += byte.consumed;
      continue;
    }

    const controls = {
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      '0': '\0',
    };
    if (Object.prototype.hasOwnProperty.call(controls, next)) {
      result += controls[next];
      index += 1;
      continue;
    }

    // `\${` and escaped delimiters are literal characters in a cooked template.
    // JavaScript also treats an identity escape such as `\/` as the character.
    result += next;
    index += 1;
  }
  return result;
}

/** Resolve a static `${BASE_URL}` template with JavaScript template semantics. */
export function resolveStaticBaseUrlTemplate(value, baseUrl) {
  const suffix = typeof value === 'string' ? templateSuffix(value) : undefined;
  return suffix === undefined ? value : `${baseUrl}${decodeTemplateSuffix(suffix)}`;
}
