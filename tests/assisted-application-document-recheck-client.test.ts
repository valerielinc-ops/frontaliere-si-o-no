import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { File } from 'node:buffer';
import { recheckReviewDocument, type ReviewDocument } from '../services/assistedApplicationReviewService';

vi.mock('../services/assistedApplicationDocumentCheck', () => ({ DOCUMENT_CHECK_VERSION: 5, checkDocumentFile: vi.fn(async () => ({ verdict: 'match', matched: 'esame di laurea', version: 5 })) }));
const bytes = Buffer.from('%PDF-1.7 existing retained degree certificate');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const file = { id: 'degree.pdf', name: 'degree.pdf', detectedType: 'pdf', size: bytes.length, uploadedAt: Date.now(), clientCheck: { verdict: 'mismatch', matched: '' } } as ReviewDocument['files'][number];
const document: ReviewDocument = { id: 'degree', kind: 'diploma', label: 'degree certificates', keywords: ['degree certificates'], required: true, quote: '', files: [file] };
const check = { verdict: 'match', matched: 'esame di laurea', version: 5 };
const ready = { document: { label: 'Current employment reference', kind: 'reference', keywords: ['Arbeitszeugnis'] }, ok: true, state: 'ready', url: 'https://signed.example/degree.pdf?generation=123', descriptor: 'signed-metadata', size: bytes.length, sha256, version: 5 };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('browser rechecks of retained files', () => {
  it('downloads the existing file, verifies its hash and posts only the versioned advisory result', async () => {
    vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('File', File);
    const fetch = vi.fn().mockResolvedValueOnce(json(ready)).mockResolvedValueOnce(new Response(bytes)).mockResolvedValueOnce(json({ ok: true, state: 'checked', clientCheck: check }));
    vi.stubGlobal('fetch', fetch);
    expect(await recheckReviewDocument('private-token', document, file, new AbortController().signal)).toEqual(check);
    expect(fetch).toHaveBeenCalledTimes(3);
    const { checkDocumentFile } = await import('../services/assistedApplicationDocumentCheck');
    expect(checkDocumentFile).toHaveBeenCalledWith(expect.anything(), ready.document);
    const begin = JSON.parse(fetch.mock.calls[0][1].body);
    const completion = JSON.parse(fetch.mock.calls[2][1].body);
    expect(begin).toEqual({ t: 'private-token', action: 'document_recheck', documentId: 'degree', fileId: 'degree.pdf' });
    expect(completion).toEqual({ ...begin, descriptor: 'signed-metadata', sha256, clientCheck: check });
    expect(fetch.mock.calls[1][1]).toMatchObject({ credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    for (const payload of [begin, completion]) {
      expect(payload).not.toHaveProperty('contentBase64');
      expect(payload).not.toHaveProperty('extractedText');
    }
  });

  it('preserves unsupported documents without downloading or posting a replacement check', async () => {
    const fetch = vi.fn(async () => json({ ok: true, state: 'unsupported' })); vi.stubGlobal('fetch', fetch);
    expect(await recheckReviewDocument('token', document, file, new AbortController().signal)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed document context before reading the retained file', async () => {
    const fetch = vi.fn(async () => json({ ...ready, document: { kind: 'diploma', label: 'degree', keywords: {} } })); vi.stubGlobal('fetch', fetch);
    await expect(recheckReviewDocument('token', document, file, new AbortController().signal)).rejects.toThrow('invalid_check');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses altered bytes before classifying or completing a recheck', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const fetch = vi.fn().mockResolvedValueOnce(json({ ...ready, sha256: '0'.repeat(64) })).mockResolvedValueOnce(new Response(bytes)); vi.stubGlobal('fetch', fetch);
    await expect(recheckReviewDocument('token', document, file, new AbortController().signal)).rejects.toThrow('file_changed');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not post a result after the owning token or page was cancelled', async () => {
    vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('File', File);
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValueOnce(json(ready)).mockImplementationOnce(async () => { controller.abort(); return new Response(bytes); }); vi.stubGlobal('fetch', fetch);
    expect(await recheckReviewDocument('token', document, file, controller.signal)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
