export type MeasurementLocale = 'it' | 'en' | 'de' | 'fr';

export interface ArticleCountMeasurement {
  readonly count: number;
  readonly date: string;
}

export declare function countItalianFrontaliereArticleDetails(values: readonly string[]): number;
export declare function articleCountMeasurement(values: readonly string[], now?: Date): ArticleCountMeasurement;
export declare function formatArticleCountEvidence(count: number, date: string, locale?: MeasurementLocale): string;
export declare function formatExchangeRateAttribution(date: string, locale?: MeasurementLocale): string;
export declare function formatExchangeRateEvidence(rate: number, date: string, locale?: MeasurementLocale): string;
