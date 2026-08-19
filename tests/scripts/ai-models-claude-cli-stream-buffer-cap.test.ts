import { describe, expect, it } from 'vitest';
import { createClaudeCliStreamTrace } from '../../scripts/lib/ai-models.mjs';

/**
 * follow-up(#6034) item 3: `feed()` in `createClaudeCliStreamTrace`
 * accumulava `buffer` senza cap fra due `\n` — una riga JSONL anomala che
 * non chiude mai con newline sarebbe cresciuta illimitatamente fino al
 * timeout. Il cap scarta il buffer come riga illeggibile invece di
 * lasciarlo accumulare senza limite.
 */
const CAP = 1_000_000;

describe('createClaudeCliStreamTrace — cap sul buffer di feed()', () => {
  it('non tronca una riga JSONL legittima sotto il cap', () => {
    const trace = createClaudeCliStreamTrace({ now: () => 0 });
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ciao' }] } });
    trace.feed(`${line}\n`);
    expect(trace.state.events).toBe(1);
    expect(trace.state.malformed).toBe(0);
    expect(trace.state.text).toBe('ciao');
  });

  it('resta in attesa (pendingBytes) per un residuo senza newline sotto il cap', () => {
    const trace = createClaudeCliStreamTrace({ now: () => 0 });
    trace.feed('{"type":"assistant"'); // riga incompleta, nessun \n
    expect(trace.pendingBytes).toBeGreaterThan(0);
    expect(trace.state.malformed).toBe(0);
  });

  it('scarta il buffer come illeggibile una volta superato il cap senza newline', () => {
    const trace = createClaudeCliStreamTrace({ now: () => 0 });
    // Una riga anomala che non chiude mai con \n, oltre il cap.
    trace.feed('x'.repeat(CAP + 1));
    expect(trace.pendingBytes).toBe(0);
    expect(trace.state.malformed).toBe(1);
    expect(trace.state.events).toBe(0);
  });

  it('continua a funzionare dopo lo scarto: una riga valida successiva viene assorbita', () => {
    const trace = createClaudeCliStreamTrace({ now: () => 0 });
    trace.feed('x'.repeat(CAP + 1));
    expect(trace.state.malformed).toBe(1);
    const line = JSON.stringify({ type: 'result' });
    trace.feed(`${line}\n`);
    expect(trace.state.events).toBe(1);
    expect(trace.result).toEqual({ type: 'result' });
  });

  it('non scarta una riga valida che arriva a chunk multipli restando sotto il cap', () => {
    const trace = createClaudeCliStreamTrace({ now: () => 0 });
    const line = JSON.stringify({ type: 'result' });
    trace.feed(line.slice(0, 5));
    trace.feed(line.slice(5));
    expect(trace.pendingBytes).toBe(line.length);
    trace.feed('\n');
    expect(trace.state.events).toBe(1);
    expect(trace.state.malformed).toBe(0);
  });
});
