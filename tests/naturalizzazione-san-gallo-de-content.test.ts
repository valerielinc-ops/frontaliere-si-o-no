import { describe, expect, it } from 'vitest';
import bodyNaturalizzazioneCantonSanGalloProcedura from '../packages/articles/content/blog-body-ch/de/naturalizzazione-canton-san-gallo-procedura';

const BODY_KEYS = [
  'blog.article.naturalizzazione-canton-san-gallo-procedura.body1',
  'blog.article.naturalizzazione-canton-san-gallo-procedura.body2',
  'blog.article.naturalizzazione-canton-san-gallo-procedura.body3',
] as const;
const FAQ_KEY = 'blog.article.naturalizzazione-canton-san-gallo-procedura.faq';

describe('German St. Gallen naturalisation article', () => {
  it('keeps every body section in German', () => {
    const body = BODY_KEYS.map((key) => bodyNaturalizzazioneCantonSanGalloProcedura[key]).join('\n');

    expect(body).toContain('## Kurz zusammengefasst');
    expect(body).toContain('## Praktische Analyse');
    expect(body).toContain('## Schritt-für-Schritt-Anleitung');
    expect(body).not.toMatch(/## (In breve|Fatti chiave|Analisi pratica|Azione passo)/);
    expect(body).not.toMatch(/\b(Naturalizzazione|cittadinanza|permesso|soggiorno|cantone|comune|richiedente|procedura|tassa|Attenzione|Consiglio)\b/i);
  });

  it('keeps the German FAQ complete and parseable', () => {
    const faq = JSON.parse(bodyNaturalizzazioneCantonSanGalloProcedura[FAQ_KEY]) as Array<{ q: string; a: string }>;

    expect(faq).toHaveLength(3);
    expect(faq[0].a).toContain('doppelt angerechnet');
    expect(faq[0].a).toMatch(/[.!?]$/);
    expect(faq.every(({ q, a }) => q.length > 0 && a.length > 0)).toBe(true);
  });
});
