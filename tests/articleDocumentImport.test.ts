import { describe, it, expect } from 'vitest';
import { extractArticleBodyFromFile, DOC_LEGACY_UNSUPPORTED, UNSUPPORTED_FORMAT } from '@/services/articleDocumentImport';

describe('extractArticleBodyFromFile', () => {
  it('reads .md files as plain text', async () => {
    const file = new File(['# Titolo\n\nTesto dell\'articolo.'], 'bozza.md', { type: 'text/markdown' });
    await expect(extractArticleBodyFromFile(file)).resolves.toBe("# Titolo\n\nTesto dell'articolo.");
  });

  it('reads .txt files as plain text and trims whitespace', async () => {
    const file = new File(['  ciao mondo  \n'], 'bozza.txt', { type: 'text/plain' });
    await expect(extractArticleBodyFromFile(file)).resolves.toBe('ciao mondo');
  });

  it('rejects legacy .doc files with a dedicated error', async () => {
    const file = new File(['binary'], 'bozza.doc', { type: 'application/msword' });
    await expect(extractArticleBodyFromFile(file)).rejects.toThrow(DOC_LEGACY_UNSUPPORTED);
  });

  it('rejects unsupported extensions', async () => {
    const file = new File(['data'], 'bozza.xlsx');
    await expect(extractArticleBodyFromFile(file)).rejects.toThrow(UNSUPPORTED_FORMAT);
  });
});
