import { BASE_URL } from '../constants';
import { clampMetaDescription } from './titleSuffix';
import { readAttr, scanMarkupStartTags } from '../../scripts/lib/html-attr.mjs';

export interface TwitterCardMetaOptions {
  title: string;
  description: string;
  locale: string;
  image?: string;
  existingHead?: string;
}

function escapeMetaAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function hasMetaName(html: string, name: string): boolean {
  const target = name.toLowerCase();
  return scanMarkupStartTags(html, 'meta')
    .some(({ raw }) => readAttr(raw, 'name').toLowerCase() === target);
}

function absoluteCardImage(image?: string): string {
  try {
    const url = new URL(image || `${BASE_URL}/og-image.png`, `${BASE_URL}/`);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : `${BASE_URL}/og-image.png`;
  } catch {
    return `${BASE_URL}/og-image.png`;
  }
}

/** Build complete X Card tags while retaining any page-specific overrides. */
export function buildTwitterCardMetaTags(opts: TwitterCardMetaOptions): string {
  const existing = opts.existingHead ?? '';
  const title = opts.title;
  const description = clampMetaDescription(opts.description, undefined, opts.locale);
  const image = absoluteCardImage(opts.image);
  const tags: string[] = [];

  if (!hasMetaName(existing, 'twitter:card')) tags.push('<meta name="twitter:card" content="summary_large_image">');
  if (!hasMetaName(existing, 'twitter:title')) tags.push(`<meta name="twitter:title" content="${escapeMetaAttribute(title)}">`);
  if (!hasMetaName(existing, 'twitter:description')) tags.push(`<meta name="twitter:description" content="${escapeMetaAttribute(description)}">`);
  if (!hasMetaName(existing, 'twitter:image')) tags.push(`<meta name="twitter:image" content="${escapeMetaAttribute(image)}">`);

  return tags.join('\n');
}
