import { describe, expect, it } from 'vitest';
import { createClaudeCliStreamTrace } from '../../scripts/lib/ai-models.mjs';

/**
 * follow-up(#6077) item 3: `CLAUDE_CLI_TEXT_SALVAGE_COMPLETE_RE` copriva solo
 * la punteggiatura latina comune (`.!?…` + chiusure ASCII/tipografiche
 * standard). Terminazioni legittime — due punti, punto e virgola, em-dash
 * (liste/markdown) e le virgolette basse tedesche „…" / ‚…' — venivano
 * scartate come "troncato", forzando un fallback DeepL non necessario per i
 * locale non-IT invece di salvare il testo gia' arrivato.
 *
 * `salvage()` sceglie fra `state.structured` (tool_use, sempre intero) e
 * `state.text` (delta, potenzialmente tagliato): per esercitare il ramo
 * testuale qui non si manda mai un blocco `tool_use`.
 */
function traceWithText(text: string) {
  const trace = createClaudeCliStreamTrace({ now: () => 0 });
  trace.feed(
    `${JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    })}\n`,
  );
  trace.end();
  return trace;
}

describe('CLAUDE_CLI_TEXT_SALVAGE_COMPLETE_RE — punteggiatura non-latina', () => {
  it('salva un testo che termina con due punti', () => {
    const trace = traceWithText('Ecco i documenti richiesti:');
    expect(trace.salvage()).toEqual({ text: 'Ecco i documenti richiesti:', source: 'assistant/text', attempts: 0 });
  });

  it('salva un testo che termina con punto e virgola', () => {
    const trace = traceWithText('primo punto della lista;');
    expect(trace.salvage()?.text).toBe('primo punto della lista;');
  });

  it('salva un testo che termina con em-dash', () => {
    const trace = traceWithText('una pausa sospesa—');
    expect(trace.salvage()?.text).toBe('una pausa sospesa—');
  });

  it('salva una citazione con virgolette basse tedesche „…"', () => {
    const trace = traceWithText('Der Kommentar lautete: „Das ist korrekt.“');
    expect(trace.salvage()?.text).toBe('Der Kommentar lautete: „Das ist korrekt.“');
  });

  it('salva una citazione con virgolette basse singole tedesche ‚…‘', () => {
    const trace = traceWithText('er sagte ‚Alles klar.‘');
    expect(trace.salvage()?.text).toBe('er sagte ‚Alles klar.‘');
  });

  it('continua a scartare un frammento tagliato a meta parola', () => {
    const trace = traceWithText('il testo si interrompe a meta parol');
    expect(trace.salvage()).toBeNull();
  });

  it('continua a scartare un frammento che finisce su una virgola', () => {
    const trace = traceWithText('un elenco non ancora chiuso,');
    expect(trace.salvage()).toBeNull();
  });

  it('continua a salvare le terminazioni latine gia coperte prima del fix', () => {
    for (const text of ['Frase completa.', 'Domanda?', 'Esclamazione!', 'sospensione…', 'citazione chiusa”', 'parentesi chiusa).']) {
      const trace = traceWithText(text);
      expect(trace.salvage()?.text).toBe(text);
    }
  });
});
