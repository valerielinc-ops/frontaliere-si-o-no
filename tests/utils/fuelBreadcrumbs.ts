const SITE_ORIGIN = 'https://frontaliereticino.ch';

function toPath(href: string): string {
  return new URL(href, SITE_ORIGIN).pathname;
}

export function extractFuelBreadcrumbTargets(html: string): {
  jsonLd: string[];
  visible: string[];
} {
  const jsonLd: string[] = [];
  const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  for (const match of ldBlocks) {
    const parsed = JSON.parse(match[1]) as {
      '@type'?: string;
      itemListElement?: Array<{ item?: string }>;
    };
    if (parsed['@type'] !== 'BreadcrumbList') continue;
    for (const item of parsed.itemListElement ?? []) {
      if (item.item) jsonLd.push(toPath(item.item));
    }
  }

  const visible: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\bs-bcl\b/.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href) visible.push(toPath(href));
  }

  return { jsonLd, visible };
}
