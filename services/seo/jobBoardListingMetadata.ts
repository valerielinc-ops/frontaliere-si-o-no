import { buildCantonLandingTitle } from './job-board-titles';
import { buildCantonHubMeta } from './meta-descriptions';
import type { CantonLocale } from '../cantonList';
import { getCantonDisplayName } from '../../build-plugins/shared/cantonDisplay';
import { buildJobBoardSeo } from '../../build-plugins/jobBoardSeoPure';

const countsByPath = new Map<string, number>();
export const getRenderedJobBoardCount = (pathname: string): number | undefined => countsByPath.get(pathname);

export function buildJobBoardListingMetadata(locale: CantonLocale, canton: string, count: number) {
  if (canton === 'TI') {
    const seo = buildJobBoardSeo(locale, count, new Date().getFullYear());
    return { title: seo.title, description: seo.desc };
  }
  const cantonDisplay = canton === '_AGGREGATE_'
    ? { it: 'Svizzera', en: 'Switzerland', de: 'Schweiz', fr: 'Suisse' }[locale]
    : getCantonDisplayName(canton, locale);
  return {
    title: buildCantonLandingTitle({ locale, cantonDisplay, count, year: new Date().getFullYear() }),
    description: buildCantonHubMeta({ locale, cantonDisplay, count, isAggregate: canton === '_AGGREGATE_' }),
  };
}

/** Use the final visible result set after loading/filtering, never a provisional slice. */
export function updateJobBoardListingMetadata(locale: CantonLocale, canton: string, count: number): void {
  countsByPath.set(window.location.pathname, count);
  const meta = buildJobBoardListingMetadata(locale, canton, count);
  document.title = meta.title;
  for (const [attribute, name, content] of [
    ['name', 'description', meta.description],
    ['property', 'og:title', meta.title],
    ['property', 'og:description', meta.description],
    ['name', 'twitter:title', meta.title],
    ['name', 'twitter:description', meta.description],
  ]) {
    let element = document.querySelector(`meta[${attribute}="${name}"]`);
    if (!element) {
      element = document.createElement('meta');
      element.setAttribute(attribute, name);
      document.head.appendChild(element);
    }
    element.setAttribute('content', content);
  }
}
