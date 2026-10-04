import { describe, expect, it } from 'vitest';
import {
  detectTruncation,
  runFactualityGates,
} from '../scripts/lib/article-factuality-gates.mjs';

describe('translation semantic completeness', () => {
  it('flags an omitted paragraph even when the remaining text ends cleanly', () => {
    const referenceText = [
      'Il Comune pubblica il calendario annuale e spiega dove i residenti possono richiedere la versione stampata prima dell’inizio del servizio estivo.',
      'Il secondo paragrafo descrive le eccezioni per le festività, il termine per presentare la domanda e il canale digitale usato per ricevere la conferma della richiesta.',
    ].join('\n\n');
    const issues = detectTruncation(
      'The municipality publishes the annual timetable and explains where residents can request the printed version before the summer service begins.',
      { label: 'en/body1', locale: 'en', referenceText },
    );

    const found = issues.find((issue) => issue.code === 'translation-semantic-truncation');
    expect(found?.severity).toBe('critical');
    expect(found?.message).toMatch(/paragrafo omesso/);
    expect(found?.evidence).toContain('paragrafi: 2 → 1');
  });

  it('does not flag a shorter translation that only merges paragraphs', () => {
    const result = runFactualityGates({
      sections: {
        body1: 'The municipality publishes the annual timetable and explains where residents can request the printed version before the summer service begins. The document describes holiday exceptions, the deadline for submitting an application, and the digital channel used to receive confirmation of the request.',
      },
      locale: 'en',
      italianSections: {
        body1: [
          'Il Comune pubblica il calendario annuale e spiega dove i residenti possono richiedere la versione stampata prima dell’inizio del servizio estivo.',
          'Il documento descrive le eccezioni per le festività, il termine per presentare la domanda e il canale digitale usato per ricevere la conferma della richiesta.',
        ].join('\n\n'),
      },
    });

    expect(result.issues.map((issue) => issue.code)).not.toContain('translation-semantic-truncation');
  });

  // Il floor di 40 parole protegge le sezioni brevi dalla varianza naturale fra
  // lingue, non un body che non contiene alcuna parola: «...» o «—» al posto di
  // una sezione italiana breve e' una traduzione assente, e uscita con un punto
  // passava ogni controllo di punteggiatura.
  it.each(['...', '…', ' — ', '**...**'])('flags a short section translated as the placeholder %j', (placeholder) => {
    const result = runFactualityGates({
      sections: { body1: placeholder },
      locale: 'en',
      italianSections: { body1: 'La sezione breve spiega dove ritirare il modulo.' },
    });
    const found = result.issues.find((issue) => issue.code === 'translation-semantic-truncation');
    expect(found?.severity).toBe('critical');
    expect(result.blocking.map((issue) => issue.code)).toContain('translation-semantic-truncation');
  });

  it('keeps the 40-word floor for a short section that is actually translated', () => {
    const issues = detectTruncation('The short section explains where to collect the form.', {
      label: 'en/body1', locale: 'en', referenceText: 'La sezione breve spiega dove ritirare il modulo.',
    });
    expect(issues.map((issue) => issue.code)).not.toContain('translation-semantic-truncation');
  });

  it('reports a whole body section missing from the translation', () => {
    const result = runFactualityGates({
      sections: { body1: 'The first section remains available and ends correctly.' },
      locale: 'en',
      italianSections: {
        body1: 'La prima sezione resta disponibile e termina correttamente.',
        body2: 'La seconda sezione contiene le istruzioni operative che il lettore deve seguire per completare la procedura senza errori.',
      },
    });

    const found = result.issues.find((issue) => issue.code === 'translation-section-missing');
    expect(found?.severity).toBe('critical');
    expect(result.blocking.map((issue) => issue.code)).toContain('translation-section-missing');
  });
});
