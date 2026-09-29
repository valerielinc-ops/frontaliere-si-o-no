/**
 * Caseificio del Gottardo — only the posting's own text is published (#5253).
 */
import { describe, it, expect } from 'vitest';
import { caseificioSourceBody, CASEIFICIO_INVENTED_RE } from '@/scripts/update-caseificio-gottardo-jobs.mjs';
import { dropFabricatedDescription } from '@/scripts/lib/drop-fabricated-description.mjs';

// Opening of the live apprenticeship posting (2026-09-29), repeated to pass the floor.
const BODY = Array(4).fill(
  'Il tecnologo e la tecnologa del latte si occupano prevalentemente della trasformazione del latte in specialità lattiero-casearie quali formaggi e latticini vari.',
).join(' ');

describe('caseificioSourceBody', () => {
  it('keeps the detail text over the word floor', () => {
    expect(caseificioSourceBody(BODY)).toBe(BODY);
  });

  it('publishes no invented text under the word floor', () => {
    expect(caseificioSourceBody('Tecnologo del latte AFC.')).toBe('');
    expect(caseificioSourceBody('')).toBe('');
  });
});

describe('CASEIFICIO_INVENTED_RE', () => {
  it('removes the former fallback text from a stored job', () => {
    const fossil = "Caseificio dimostrativo del Gottardo SA pubblica il seguente posto di tirocinio: Tecnologo/a del latte.\n\nPer i dettagli completi, consultare la pagina dell'offerta.";
    const job: any = { sourceLang: 'it', description: fossil, descriptionByLocale: { it: fossil, de: 'Die Schaukäserei …' } };
    expect(dropFabricatedDescription(job, CASEIFICIO_INVENTED_RE)).toBe(true);
    expect(job.description).toBe('');
    expect(job.descriptionByLocale).toEqual({});
  });

  it('leaves the source text alone', () => {
    expect(CASEIFICIO_INVENTED_RE.test(BODY)).toBe(false);
  });
});
