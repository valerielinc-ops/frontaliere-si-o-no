function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function attrSource(name: string, value: string): string {
  const attr = escapeRegExp(name);
  const expected = escapeRegExp(value);
  return `\\b${attr}=(?:"${expected}"|'${expected}'|${expected})(?=[\\s>])`;
}

export function htmlAttr(name: string, value: string): RegExp {
  return new RegExp(attrSource(name, value));
}

export function htmlTagWithAttrs(tagName: string, attrs: Record<string, string>): RegExp {
  const tag = escapeRegExp(tagName);
  const assertions = Object.entries(attrs)
    .map(([name, value]) => `(?=[^>]*${attrSource(name, value)})`)
    .join('');
  return new RegExp(`<${tag}\\b${assertions}[^>]*>`);
}

export function htmlTagWithClass(tagName: string, className: string): RegExp {
  const tag = escapeRegExp(tagName);
  const klass = escapeRegExp(className);
  return new RegExp(
    `<${tag}\\b[^>]*\\bclass=(?:"[^"]*\\b${klass}\\b[^"]*"|'[^']*\\b${klass}\\b[^']*'|${klass})(?=[\\s>])[^>]*>`,
  );
}
