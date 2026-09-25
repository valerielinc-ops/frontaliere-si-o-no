/**
 * resolveLocalePromptContext — regression: AI description prompts hardcoded Italian.
 *
 * Root cause: structureJobDescription()/aiEnrichThinDescription() always prompted
 * the LLM to output "well-formatted Italian markdown" / "in italiano", regardless
 * of the job's actual sourceLang. For a de/fr/en-sourceLang job (e.g. a Roche or
 * EPFL listing), the source-language description got reformatted/composed INTO
 * Italian by the AI step, corrupting the sourceLang slot's language.
 *
 * Fix: both functions now resolve language name + section headings from the
 * job's sourceLang via this shared, pure helper instead of hardcoding Italian.
 */
import { describe, it, expect } from 'vitest';
import { resolveLocalePromptContext } from '../../scripts/lib/shared-jobs-crawler.mjs';

describe('resolveLocalePromptContext()', () => {
  it('resolves German for a de-sourceLang job (not Italian)', () => {
    const { langName, headings } = resolveLocalePromptContext('de');
    expect(langName).toBe('German');
    expect(headings.tasks).toBe('Aufgaben');
    expect(headings.fallback).toBe('Beschreibung');
  });

  it('resolves French and English distinctly', () => {
    expect(resolveLocalePromptContext('fr').langName).toBe('French');
    expect(resolveLocalePromptContext('en').langName).toBe('English');
    expect(resolveLocalePromptContext('fr').headings.contact).toBe('Contact');
    expect(resolveLocalePromptContext('en').headings.contact).toBe('Contact');
  });

  it('defaults to Italian for the it locale and for unknown/missing locales', () => {
    expect(resolveLocalePromptContext('it').langName).toBe('Italian');
    expect(resolveLocalePromptContext(undefined).langName).toBe('Italian');
    expect(resolveLocalePromptContext('xx').langName).toBe('Italian');
  });
});
