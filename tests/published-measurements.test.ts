import { expect, it } from 'vitest';
import { countItalianFrontaliereArticleDetails } from '../build-plugins/shared/publishedMeasurements.mjs';

it('excludes the reserved Frontaliere archive routes from the article-detail count', () => {
  expect(countItalianFrontaliereArticleDetails([
    '/articoli-frontaliere/tutti/',
    '/articoli-frontaliere/guida/',
    '/articoli-frontaliere/una-guida-pratica/',
  ])).toBe(1);
});
