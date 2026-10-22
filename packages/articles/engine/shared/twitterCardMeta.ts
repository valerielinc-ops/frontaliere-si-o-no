import { getSiteShell, type ArticleLocale } from '../siteShell';

export interface TwitterCardMetaOptions {
  title: string;
  description: string;
  image: string;
  locale: ArticleLocale;
}

/**
 * Emit the complete X Card shared by every HTML template owned by the
 * articles engine. The engine cannot import the site's build-plugin helper:
 * `SiteShellContract` is the package boundary, so escaping and description
 * clamping are deliberately supplied by the host through that contract.
 */
export function buildTwitterCardMetaTags(opts: TwitterCardMetaOptions): string {
  const shell = getSiteShell();
  const description = shell.clampMetaDescription(
    opts.description,
    shell.metaDescriptionMaxChars,
    opts.locale,
  );
  const image = /^https?:\/\//i.test(opts.image)
    ? opts.image
    : `${shell.baseUrl}${opts.image.startsWith('/') ? '' : '/'}${opts.image}`;

  return [
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${shell.esc(opts.title)}">`,
    `<meta name="twitter:description" content="${shell.esc(description)}">`,
    `<meta name="twitter:image" content="${shell.esc(image)}">`,
  ].join('\n');
}
