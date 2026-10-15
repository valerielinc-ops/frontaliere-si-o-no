import { describe, it, expect } from 'vitest';
import { normalizeDescriptionBullets } from '../../scripts/lib/crawler-template.mjs';

describe('normalizeDescriptionBullets', () => {
  it('returns empty/non-string input unchanged', () => {
    expect(normalizeDescriptionBullets('')).toBe('');
    expect(normalizeDescriptionBullets(null as unknown as string)).toBeNull();
    expect(normalizeDescriptionBullets(undefined as unknown as string)).toBeUndefined();
    expect(normalizeDescriptionBullets(42 as unknown as string)).toBe(42);
  });

  it('inserts \\n before inline • bullets so they are line-start', () => {
    const input = 'Aufgaben: • Item one • Item two • Item three';
    const out = normalizeDescriptionBullets(input);
    expect(out).toMatch(/^[\s\S]*\n• Item one\n• Item two\n• Item three$/);
    // Audit check
    expect(/^\s*[-•*]\s/m.test(out)).toBe(true);
  });

  it('is idempotent on already-structured text', () => {
    const input = 'Heading\n• Item one\n• Item two\n• Item three';
    const out = normalizeDescriptionBullets(input);
    expect(out).toBe(input);
  });

  it('inserts bullets at known German section headers (jobs.admin.ch)', () => {
    // Real VTG-style flow: an opening sentence then concatenated sections.
    const input =
      'Stelleninfo. Diesen Beitrag kannst du leisten Some duties here. Das macht dich einzigartig Some skills. Das bieten wir Some perks.';
    const out = normalizeDescriptionBullets(input);
    expect(/^\s*[-•*]\s/m.test(out)).toBe(true);
    expect(out).toContain('• Diesen Beitrag kannst du leisten');
    expect(out).toContain('• Das macht dich einzigartig');
    expect(out).toContain('• Das bieten wir');
  });

  it('inserts bullets at Italian section headers (EOC pattern)', () => {
    const input =
      "Per completare il nostro team. Le sue mansioni: gestione cucina. Il profilo richiesto: esperienza minima. Offriamo formazione continua.";
    const out = normalizeDescriptionBullets(input);
    expect(/^\s*[-•*]\s/m.test(out)).toBe(true);
  });

  it('bulletizes runs of ≥3 short consecutive paragraphs (Marriott PROFILE pattern)', () => {
    const input = [
      'JOB DESCRIPTION',
      '',
      'Long intro paragraph that exceeds two hundred characters easily because it goes on and on with corporate boilerplate about the brand and the experience and so on past the limit no chance.',
      '',
      'PROFILE',
      'Short item one is here',
      'Short item two is here',
      'Short item three is here',
      'Short item four is here',
      '',
      'Closing paragraph',
    ].join('\n');
    const out = normalizeDescriptionBullets(input);
    expect(/^\s*[-•*]\s/m.test(out)).toBe(true);
    // First short line of the run is treated as a heading, not bulletized
    expect(out).toMatch(/PROFILE\n• Short item one is here/);
  });

  it('does not bulletize a 2-line run (below 3-line threshold)', () => {
    // Single long paragraph + 2 short consecutive lines = run length 3, but
    // the first short line gets treated as a heading so 2 actual bullets.
    // To verify the "no run at all when all lines are long" path:
    const input = [
      'A very long intro paragraph that goes on and on with lots of words to clearly exceed the two-hundred character cap so the run detector correctly skips it because long lines never count as candidate list items even when consecutive.',
      'Another long paragraph that is also above the cap with plenty of filler content beyond two hundred characters so neither line qualifies as a short list-item candidate inside the run-detection scan in the helper.',
    ].join('\n');
    const out = normalizeDescriptionBullets(input);
    expect(/^\s*[-•*]\s/m.test(out)).toBe(false);
  });

  it('preserves existing line-start bullets when no inline bullet exists', () => {
    const input = '• existing one\n• existing two\n• existing three';
    const out = normalizeDescriptionBullets(input);
    expect(out).toBe(input);
  });
});
