import { describe, it, expect } from 'vitest';
import { localizeArticlePageIdentity } from '../services/seo/article-page-identity';
const sourceUrl = 'https://frontaliereticino.ch/guida-tassazione/';
describe('localized editorial page identity', () => {
  it.each(['en','de','fr'])('uses the rendered page metadata in %s', locale => {
    const canonicalUrl = `https://frontaliereticino.ch/${locale}/tax-guide/`;
    const page = { sourceUrl, canonicalUrl, headline: `Title ${locale}`, description: `Description ${locale}`, locale };
    const node = { '@type': ['Article'], '@id': sourceUrl+'#article', url:sourceUrl, headline:'Italiano', mainEntityOfPage:{'@type':'WebPage','@id':sourceUrl}, citation: {'@type':'Article',url:sourceUrl,headline:'Quoted title'} };
    localizeArticlePageIdentity(node,page);
    expect(node).toMatchObject({url:canonicalUrl,headline:page.headline,description:page.description,inLanguage:locale,'@id':canonicalUrl+'#article',mainEntityOfPage:{'@type':'WebPage','@id':canonicalUrl}});
    expect(node.citation.headline).toBe('Quoted title');
  });
  it('preserves unrelated articles and supports primary graph nodes', () => {
    const other = {'@type':'Article', url:'https://example.com/other',headline:'Other'};
    const article = {'@type':'Article',url:sourceUrl,headline:'Original'};
    localizeArticlePageIdentity({'@graph':[other,article]}, {sourceUrl,canonicalUrl:sourceUrl+'en/',headline:'English',description:'English description',locale:'en'});
    expect(other.headline).toBe('Other');
    expect(article.headline).toBe('English');
  });
});
