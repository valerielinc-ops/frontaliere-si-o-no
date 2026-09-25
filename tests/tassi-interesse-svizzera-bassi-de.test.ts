import { describe, expect, it } from 'vitest';
import articleBody from '../packages/articles/content/blog-body-ch/de/tassi-interesse-svizzera-bassi';

describe('German low-interest article content (#8663)', () => {
  it('does not publish the Italian body or visible placeholder links', () => {
    const body1 = articleBody['blog.article.tassi-interesse-svizzera-bassi.body1'];
    const body2 = articleBody['blog.article.tassi-interesse-svizzera-bassi.body2'];
    const body3 = articleBody['blog.article.tassi-interesse-svizzera-bassi.body3'];

    expect(body1).toContain('[Lebenshaltungskosten in der Schweiz](nav:cost-of-living)');
    expect(body1).not.toContain('Link to cost-of-living');
    expect(body2).toMatch(/^Praktische Analyse:/);
    expect(body2).not.toContain('Analisi pratica');
    expect(body2).not.toContain('Confronto con i paesi vicini');
    expect(body2).not.toMatch(/Link to (cost-of-living|banks)/);
    expect(body2).toContain('[Banken für Grenzgänger](nav:banks)');
    expect(body3).toContain('[Gehalts- und Steuerrechner](nav:calculator)');
    expect(body3).not.toContain('[calcolatore stipendio](nav:calculator)');
  });
});
