export type InlineFuelPriceVariant = 'diesel' | 'fuel';

/** Explicit article context avoids choosing a fuel from translated title copy. */
export const FUEL_PRICE_ARTICLE_VARIANTS: Readonly<Record<string, InlineFuelPriceVariant | undefined>> = {
  'diesel-aumento-prezzi-svizzera-2026': 'diesel',
  'carburanti-ticino-aumento-prezzi': 'fuel',
};

export function fuelPriceVariantForArticle(articleId: string): InlineFuelPriceVariant | undefined {
  if (!Object.prototype.hasOwnProperty.call(FUEL_PRICE_ARTICLE_VARIANTS, articleId)) return undefined;
  return FUEL_PRICE_ARTICLE_VARIANTS[articleId];
}

export function shouldShowFuelTableAfterSingleSegment(segmentCount: number, segmentIndex: number): boolean {
  return segmentCount === 1 && segmentIndex === 0;
}
