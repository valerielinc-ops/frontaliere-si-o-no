// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import {
  extractGeminiImageData,
  extractFalImageData,
  extractPexelsPhoto,
  extractPixabayPhoto,
  extractTogetherImageData,
  articleHeroPhotoSearchQueries,
  formatProviderHttpError,
  generateImageFromSpec,
  imageVisionRejectionError,
  imageProviderSequence,
  imageVisionRejected,
  isCompleteArticleHeroVisionVerdict,
  isPhotoCandidateRelevantToSpec,
  isPhotographicMetadata,
  isSuitableArticlePhotoCandidate,
  isSuitablePhotoCandidate,
  photoQuery,
  photoRecordCollision,
  photoSearchQueries,
  pixabayAuthorProfileUrl,
  selectDeterministicPhotoCandidate,
  providerConfiguration,
  verifyGeneratedImage,
  verifyWikimediaExtmetadata,
} from '../packages/articles/engine/shared/generatedImageEngine.mjs';
import {
  imageVisionRejectionError as pureImageVisionRejectionError,
  imageVisionRejected as pureImageVisionRejected,
  isCompleteArticleHeroVisionVerdict as pureIsCompleteArticleHeroVisionVerdict,
  VISION_SCHEMA,
} from '../packages/articles/engine/shared/generatedImageVision.mjs';
import { LICENSED_PHOTO_KIND } from '../packages/articles/engine/shared/generatedImageRegistry.mjs';

describe('generated image provider contracts', () => {
  it('re-exports the shared pure article-hero vision contract', () => {
    expect(imageVisionRejectionError).toBe(pureImageVisionRejectionError);
    expect(imageVisionRejected).toBe(pureImageVisionRejected);
    expect(isCompleteArticleHeroVisionVerdict).toBe(pureIsCompleteArticleHeroVisionVerdict);
  });

  it('keeps the shared vision policy immutable', () => {
    expect(Object.isFrozen(VISION_SCHEMA)).toBe(true);
    expect(Object.isFrozen(VISION_SCHEMA.required)).toBe(true);
    expect(Object.isFrozen(VISION_SCHEMA.properties)).toBe(true);
    expect(Object.isFrozen(VISION_SCHEMA.properties.ok)).toBe(true);
    expect(() => { VISION_SCHEMA.required.length = 0; }).toThrow(TypeError);
    expect(isCompleteArticleHeroVisionVerdict({})).toBe(false);
  });

  it('requires a complete article-hero vision verdict for both generated and licensed photos', () => {
    const verdict = {
      ok: true,
      contains_text: false,
      contains_logo: false,
      contains_recognizable_face: false,
      contains_recognizable_foreground_person: false,
      looks_like_specific_real_event: false,
      is_photograph: false,
      is_topic_relevant: true,
      notes: 'Complete safe generated-image verdict.',
    };
    expect(imageVisionRejected(verdict, { scope: 'article-hero' })).toBe(false);
    expect(isCompleteArticleHeroVisionVerdict(verdict)).toBe(true);
    expect(imageVisionRejected({ ...verdict, is_topic_relevant: false }, { scope: 'article-hero' })).toBe(true);
    expect(imageVisionRejected({ ok: true }, { scope: 'article-hero' })).toBe(true);
    expect(imageVisionRejected({ ...verdict, looks_like_specific_real_event: true }, { scope: 'article-hero' })).toBe(true);
    expect(imageVisionRejected(null, { scope: 'article-hero' })).toBe(true);

    for (const field of [
      'ok',
      'contains_text',
      'contains_logo',
      'contains_recognizable_face',
      'contains_recognizable_foreground_person',
      'looks_like_specific_real_event',
      'is_photograph',
      'is_topic_relevant',
      'notes',
    ]) {
      const partial = { ...verdict };
      delete partial[field];
      expect(isCompleteArticleHeroVisionVerdict(partial), `missing ${field}`).toBe(false);
      expect(imageVisionRejected(partial, { scope: 'article-hero' }), `missing ${field}`).toBe(true);
    }

    const licensedPhoto = {
      ...verdict,
      is_photograph: true,
      looks_like_specific_real_event: true,
      notes: 'The image is a licensed documentary photograph of the relevant real event.',
    };
    expect(imageVisionRejected(licensedPhoto, {
      kind: LICENSED_PHOTO_KIND,
      scope: 'article-hero',
    }), 'an authorized photo may truthfully show a specific real event').toBe(false);
    const incompleteLicensedPhoto = { ...licensedPhoto };
    delete incompleteLicensedPhoto.contains_text;
    expect(imageVisionRejected(incompleteLicensedPhoto, {
      kind: LICENSED_PHOTO_KIND,
      scope: 'article-hero',
    }), 'a partial photo verdict cannot bypass the text safety rule').toBe(true);
  });
  it('classifies a missing safety field from the verifier as retryable, not as an image rejection', async () => {
    const tempDir = mkdtempSync(path.join(process.cwd(), '.tmp-incomplete-image-verdict-'));
    const imagePath = path.join(tempDir, 'candidate.webp');
    const socketPath = path.join(os.tmpdir(), `frontaliere-vision-verdict-${process.pid}-${Date.now()}.sock`);
    const originalSocket = process.env.CODEX_AUTH_BROKER_SOCKET;
    const partialVerdict = {
      ok: true,
      // Missing contains_logo is a missing safety signal, not proof that the image itself is unsafe.
      contains_text: false,
      contains_recognizable_face: false,
      contains_recognizable_foreground_person: false,
      looks_like_specific_real_event: false,
      is_photograph: false,
      is_topic_relevant: true,
      notes: 'Verifier response omitted a required safety field.',
    };
    const rejectedVerdict = {
      ok: true,
      contains_text: false,
      contains_logo: true,
      contains_recognizable_face: false,
      contains_recognizable_foreground_person: false,
      looks_like_specific_real_event: false,
      is_photograph: false,
      is_topic_relevant: true,
      notes: 'The image contains a logo.',
    };
    let responseVerdict = partialVerdict;
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.once('data', () => {
        socket.end(`${JSON.stringify({ ok: true, result: JSON.stringify(responseVerdict) })}\n`);
      });
    });

    try {
      writeFileSync(imagePath, 'fixture image bytes');
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      process.env.CODEX_AUTH_BROKER_SOCKET = socketPath;

      const error = await verifyGeneratedImage(imagePath, {
        scope: 'article-hero',
        subject: 'test article',
      }).then(() => null, (caught: unknown) => caught as Error & { code?: string; retryable?: boolean });

      expect(error?.code).toBe('IMAGE_VISION_VERDICT_INCOMPLETE');
      expect(error?.retryable).toBe(true);
      expect(error?.message).toContain('incomplete article-hero verdict');

      responseVerdict = rejectedVerdict;
      const rejected = await verifyGeneratedImage(imagePath, {
        scope: 'article-hero',
        subject: 'test article',
      }).then(() => null, (caught: unknown) => caught as Error & { code?: string; vision?: Record<string, unknown> });
      expect(rejected?.code).toBe('IMAGE_VISION_REJECTED');
      expect(rejected?.vision?.contains_logo).toBe(true);
      expect(rejected?.vision?.ok).toBeUndefined();
      expect(rejected?.vision?.notes).toBeUndefined();
    } finally {
      if (originalSocket === undefined) delete process.env.CODEX_AUTH_BROKER_SOCKET;
      else process.env.CODEX_AUTH_BROKER_SOCKET = originalSocket;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  it('recognizes nested transport causes and Gemini request aborts as vision-provider outages', async () => {
    const tempDir = mkdtempSync(path.join(process.cwd(), '.tmp-vision-provider-outage-'));
    const imagePath = path.join(tempDir, 'candidate.webp');
    const socketPath = path.join(os.tmpdir(), `frontaliere-vision-outage-${process.pid}-${Date.now()}.sock`);
    const originalSocket = process.env.CODEX_AUTH_BROKER_SOCKET;
    const originalGeminiKey = process.env.GEMINI_API_KEY;
    const originalFetch = globalThis.fetch;
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.once('data', () => socket.end(`${JSON.stringify({ ok: false, error: 'service unavailable' })}\n`));
    });

    try {
      writeFileSync(imagePath, 'fixture image bytes');
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      process.env.CODEX_AUTH_BROKER_SOCKET = socketPath;
      process.env.GEMINI_API_KEY = 'fixture-provider-key';

      const verifyWithFetchFailure = async (fetchFailure: Error) => {
        vi.stubGlobal('fetch', async () => { throw fetchFailure; });
        return verifyGeneratedImage(imagePath, {
          scope: 'article-hero',
          subject: 'test article',
        }).then(() => null, (caught: unknown) => caught as Error & {
          code?: string;
          sharedProviderUnavailable?: boolean;
          cause?: unknown;
        });
      };

      const socketFailure = Object.assign(new Error('connection timed out'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
      const nestedTransport = await verifyWithFetchFailure(new TypeError('fetch failed', { cause: socketFailure }));
      expect(nestedTransport?.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(nestedTransport?.sharedProviderUnavailable).toBe(true);

      const abort = new Error('The operation was aborted');
      abort.name = 'AbortError';
      const abortedRequest = await verifyWithFetchFailure(abort);
      expect(abortedRequest?.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(abortedRequest?.sharedProviderUnavailable).toBe(true);
    } finally {
      if (originalSocket === undefined) delete process.env.CODEX_AUTH_BROKER_SOCKET;
      else process.env.CODEX_AUTH_BROKER_SOCKET = originalSocket;
      if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalGeminiKey;
      vi.unstubAllGlobals();
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  it('does not classify a malformed vision response as provider unavailability', async () => {
    const tempDir = mkdtempSync(path.join(process.cwd(), '.tmp-malformed-vision-response-'));
    const imagePath = path.join(tempDir, 'candidate.webp');
    const socketPath = path.join(os.tmpdir(), `frontaliere-malformed-vision-${process.pid}-${Date.now()}.sock`);
    const originalSocket = process.env.CODEX_AUTH_BROKER_SOCKET;
    const originalGeminiKey = process.env.GEMINI_API_KEY;
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.once('data', () => socket.end(`${JSON.stringify({ ok: true, result: 'not a JSON verdict' })}\n`));
    });

    try {
      writeFileSync(imagePath, 'fixture image bytes');
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      process.env.CODEX_AUTH_BROKER_SOCKET = socketPath;
      delete process.env.GEMINI_API_KEY;

      const error = await verifyGeneratedImage(imagePath, {
        scope: 'article-hero',
        subject: 'test article',
      }).then(() => null, (caught: unknown) => caught as Error & {
        code?: string;
        sharedProviderUnavailable?: boolean;
      });

      expect(error?.code).toBe('IMAGE_VISION_VERDICT_INCOMPLETE');
      expect(error?.sharedProviderUnavailable).not.toBe(true);
    } finally {
      if (originalSocket === undefined) delete process.env.CODEX_AUTH_BROKER_SOCKET;
      else process.env.CODEX_AUTH_BROKER_SOCKET = originalSocket;
      if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalGeminiKey;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
  it('stops the image-provider chain and preserves a shared vision outage marker', async () => {
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'generated-image-vision-outage-'));
    const imageBytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 25, g: 80, b: 120 } },
    }).jpeg().toBuffer();
    const originalGeminiKey = process.env.GEMINI_API_KEY;
    const originalFalKey = process.env.FAL_KEY;
    const originalFetch = globalThis.fetch;
    const providerAttempts: Array<{ provider: string; status: string }> = [];
    process.env.GEMINI_API_KEY = 'fixture-provider-key';
    delete process.env.FAL_KEY;
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        output_image: { type: 'image', mime_type: 'image/jpeg', data: imageBytes.toString('base64') },
      }),
      text: async () => '',
    }));
    const verifierFailure = new Error('all shared image-vision providers are unavailable');
    Object.assign(verifierFailure, { code: 'AI_PROVIDER_UNAVAILABLE', sharedProviderUnavailable: true });

    try {
      const error = await generateImageFromSpec({
        scope: 'article-hero',
        subject: 'a contemporary workplace',
        assetId: 'vision-provider-outage-test',
      }, {
        outputDir,
        chain: ['gemini', 'fal'],
        onProviderAttempt: ({ provider, status }) => providerAttempts.push({ provider, status }),
        verifyImage: async () => { throw verifierFailure; },
      }).then(() => null, (caught: unknown) => caught as Error & {
        sharedProviderUnavailable?: boolean;
        imageProviderLedger?: { complete: boolean; expectedProviders: string[]; attemptedProviders: string[] };
      });

      expect(error?.sharedProviderUnavailable).toBe(true);
      expect(error?.imageProviderLedger).toEqual({
        schema: 1,
        complete: false,
        expectedProviders: ['gemini', 'fal'],
        attemptedProviders: ['gemini'],
      });
      expect(providerAttempts.filter(({ status }) => status === 'started')).toEqual([
        { provider: 'gemini', status: 'started' },
      ]);
    } finally {
      if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalGeminiKey;
      if (originalFalKey === undefined) delete process.env.FAL_KEY;
      else process.env.FAL_KEY = originalFalKey;
      vi.unstubAllGlobals();
      globalThis.fetch = originalFetch;
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
  it('records whether the full selected provider chain was actually attempted', async () => {
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'generated-image-provider-ledger-'));
    const previousGeminiKey = process.env.GEMINI_API_KEY;
    const previousFalKey = process.env.FAL_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.FAL_KEY;

    const request = (maxAttempts?: number) => generateImageFromSpec({
      scope: 'article-hero',
      subject: 'a contemporary workplace',
      assetId: 'provider-ledger-test',
    }, {
      outputDir,
      chain: ['gemini', 'fal'],
      maxAttempts,
    }).then(() => null, (error: unknown) => error as Error & {
      imageProviderLedger?: {
        complete: boolean;
        expectedProviders: string[];
        attemptedProviders: string[];
      };
    });

    try {
      const exhausted = await request();
      expect(exhausted?.imageProviderLedger).toEqual({
        schema: 1,
        complete: true,
        expectedProviders: ['gemini', 'fal'],
        attemptedProviders: ['gemini', 'fal'],
      });

      const capped = await request(1);
      expect(capped?.imageProviderLedger).toEqual({
        schema: 1,
        complete: false,
        expectedProviders: ['gemini', 'fal'],
        attemptedProviders: ['gemini'],
      });
    } finally {
      if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGeminiKey;
      if (previousFalKey === undefined) delete process.env.FAL_KEY;
      else process.env.FAL_KEY = previousFalKey;
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
  it('keeps structured vision evidence in a failed provider ledger entry', async () => {
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'generated-image-vision-ledger-'));
    const imageBytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 25, g: 80, b: 120 } },
    }).jpeg().toBuffer();
    const previousGeminiKey = process.env.GEMINI_API_KEY;
    const previousFalKey = process.env.FAL_KEY;
    const previousFetch = globalThis.fetch;
    process.env.GEMINI_API_KEY = 'fixture-provider-key';
    delete process.env.FAL_KEY;
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        output_image: {
          type: 'image',
          mime_type: 'image/jpeg',
          data: imageBytes.toString('base64'),
        },
      }),
      text: async () => '',
    }));
    const vision = {
      ok: true,
      contains_text: false,
      contains_logo: true,
      contains_recognizable_face: false,
      contains_recognizable_foreground_person: false,
      looks_like_specific_real_event: false,
      is_photograph: false,
      is_topic_relevant: true,
      notes: 'The image contains a logo.',
    };

    try {
      const error = await generateImageFromSpec({
        scope: 'article-hero',
        subject: 'a contemporary workplace',
        assetId: 'vision-provider-ledger-test',
      }, {
        outputDir,
        chain: ['gemini', 'fal'],
        verifyImage: async () => { throw imageVisionRejectionError(vision); },
      }).then(() => null, (caught: unknown) => caught as Error & {
        failures?: Array<{ provider: string; vision?: Record<string, unknown> }>;
        imageProviderLedger?: { complete: boolean; attemptedProviders: string[] };
      });

      expect(error?.imageProviderLedger).toEqual({
        schema: 1,
        complete: true,
        expectedProviders: ['gemini', 'fal'],
        attemptedProviders: ['gemini', 'fal'],
      });
      expect(error?.failures?.[0]).toMatchObject({
        provider: 'gemini',
        vision: {
          contains_text: false,
          contains_logo: true,
          contains_recognizable_face: false,
          contains_recognizable_foreground_person: false,
          looks_like_specific_real_event: false,
          is_photograph: false,
          is_topic_relevant: true,
        },
      });
      expect(error?.failures?.[0]?.vision).not.toHaveProperty('notes');
      expect(error?.failures?.[1]).toMatchObject({
        provider: 'fal',
        reason: 'missing-key:FAL_KEY',
      });
    } finally {
      if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGeminiKey;
      if (previousFalKey === undefined) delete process.env.FAL_KEY;
      else process.env.FAL_KEY = previousFalKey;
      vi.unstubAllGlobals();
      globalThis.fetch = previousFetch;
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
  it('reads the image block from a completed Gemini Interactions response', () => {
    const encoded = Buffer.from('fake-jpeg-bytes').toString('base64');

    expect(extractGeminiImageData({
      id: 'interaction-1',
      status: 'completed',
      output_image: {
        type: 'image',
        mime_type: 'image/jpeg',
        data: encoded,
      },
    })).toBe(encoded);
  });

  it('keeps the step-content image shape as a compatible fallback', () => {
    const encoded = Buffer.from('step-image').toString('base64');

    expect(extractGeminiImageData({
      status: 'completed',
      steps: [{
        type: 'model_output',
        content: [{ type: 'image', mime_type: 'image/jpeg', data: encoded }],
      }],
    })).toBe(encoded);
  });

  it('includes a bounded, redacted provider body in HTTP diagnostics', () => {
    const message = formatProviderHttpError(
      'Gemini',
      400,
      '{"error":{"message":"image/png is not supported","api_key":"AIza-secret-value"}}',
    );

    expect(message).toContain('Gemini image request failed with HTTP 400');
    expect(message).toContain('image/png is not supported');
    expect(message).not.toContain('AIza-secret-value');
    expect(message.length).toBeLessThanOrEqual(650);
  });

  it('uses the governed generation chain with Codex first', () => {
    expect(imageProviderSequence()).toEqual(['openai-codex', 'gemini', 'fal', 'together', 'pollinations']);
    expect(imageProviderSequence({ scope: 'event-library' })).toEqual([
      'openai-codex', 'gemini', 'fal', 'together', 'pollinations', 'wikimedia', 'pexels', 'pixabay',
    ]);
    expect(imageProviderSequence({ scope: 'article-hero' })).toEqual([
      'openai-codex', 'gemini', 'fal', 'together', 'pollinations', 'wikimedia', 'pexels', 'pixabay',
    ]);
    expect(imageProviderSequence({ scope: 'editorial-profile' })).toEqual([
      'openai-codex', 'gemini', 'fal', 'together', 'pollinations',
    ]);
    expect(imageProviderSequence({ kind: 'photo' })).toEqual([
      'wikimedia', 'pexels', 'pixabay', 'openai-codex', 'gemini', 'fal', 'together', 'pollinations',
    ]);
    expect(imageProviderSequence({ chain: 'together, pollinations' })).toEqual(['together', 'pollinations']);
  });

  it('adapts the legacy article provider response shapes', () => {
    const encoded = Buffer.from('fake-image').toString('base64');
    expect(extractTogetherImageData({ data: [{ b64_json: encoded }] })).toBe(encoded);
    expect(extractFalImageData({ images: [{ url: 'https://fal.example/image.png' }] })).toBe('https://fal.example/image.png');
    expect(extractFalImageData({ images: [{ url: `data:image/png;base64,${encoded}` }] })).toBe(encoded);
    expect(extractPexelsPhoto({
      photos: [{
        photographer: 'Ada Foto',
        photographer_url: 'https://pexels.com/@ada',
        url: 'https://www.pexels.com/photo/lake-123/',
        width: 1600,
        height: 900,
        src: { large2x: 'https://images.pexels.com/photo.jpg' },
      }],
    })?.license).toBe('Pexels License');
    const pixabayPhoto = extractPixabayPhoto({
      hits: [{
        user: 'Ada Pixabay',
        user_id: 42,
        userImageURL: 'https://cdn.pixabay.com/user/avatar.jpeg',
        pageURL: 'https://pixabay.com/photos/lake-123/',
        imageWidth: 1600,
        imageHeight: 900,
        largeImageURL: 'https://cdn.pixabay.com/photo.jpg',
      }],
    });
    expect(pixabayPhoto?.license).toBe('Pixabay Content License');
    expect(pixabayPhoto?.author).toEqual({
      name: 'Ada Pixabay',
      url: 'https://pixabay.com/users/Ada%20Pixabay-42/',
    });
  });

  it('builds a Pixabay profile URL only when both API identity fields exist', () => {
    expect(pixabayAuthorProfileUrl({ user: 'GPhotography', user_id: 19753942 })).toBe(
      'https://pixabay.com/users/GPhotography-19753942/',
    );
    expect(pixabayAuthorProfileUrl({ user: 'GPhotography' })).toBeUndefined();
    expect(pixabayAuthorProfileUrl({ user_id: 19753942 })).toBeUndefined();
  });

  it('accepts only a Wikimedia file with verified allowed extmetadata', () => {
    const page = {
      fullurl: 'https://commons.wikimedia.org/wiki/File:Lago.jpg',
      imageinfo: [{
        mime: 'image/jpeg',
        width: 1600,
        height: 900,
        thumburl: 'https://upload.wikimedia.org/lake.jpg',
        extmetadata: {
          LicenseShortName: { value: 'CC BY-SA 4.0' },
          LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' },
          Artist: { value: 'Ada Wikimedia' },
        },
      }],
    };
    expect(verifyWikimediaExtmetadata(page)?.licenseFamily).toBe('cc-by-sa');
    expect(verifyWikimediaExtmetadata({ ...page, imageinfo: [{ ...page.imageinfo[0], extmetadata: {} }] })).toBeNull();
    expect(verifyWikimediaExtmetadata({ ...page, imageinfo: [{ ...page.imageinfo[0], extmetadata: { LicenseShortName: { value: 'CC BY-NC' }, Artist: { value: 'Ada' } } }] })).toBeNull();
  });

  it('composes category, Swiss place and season queries from the slot taxonomy', () => {
    const queries = photoSearchQueries({
      category: 'musica',
      area: 'svizzera-urbana',
      season: 'autunno-inverno',
    });

    expect(queries[0]).toContain('live music concert');
    expect(queries[0]).toContain('Zurich Switzerland');
    expect(queries[0]).toContain('autumn winter');
    expect(queries.some((query) => query.includes('Bern Switzerland'))).toBe(true);
    expect(queries).not.toContain('Lugano city view');
    expect(photoQuery({ category: 'musica', area: 'svizzera-urbana', season: 'autunno-inverno' })).toBe(queries[0]);
  });

  it('builds article-hero queries from topic, place and keywords in English', () => {
    const spec = {
      scope: 'article-hero',
      title: 'Tasse e lavoro a Zurigo',
      topic: 'tassazione e occupazione',
      place: 'Zurigo, Svizzera',
      keywords: ['credito fiscale'],
    };
    const queries = articleHeroPhotoSearchQueries(spec);
    expect(queries[0]).toContain('taxation');
    expect(queries[0]).toContain('Zurich');
    expect(queries[0]).toContain('Switzerland');
    expect(queries.some((query) => query.includes('employment'))).toBe(true);
    expect(photoSearchQueries(spec)).toEqual(queries);
  });

  it('selects a stable candidate while excluding used source pages and hashes', () => {
    const spec = {
      scope: 'event-library',
      assetId: 'event-musica-laghi-primavera-estate-v02',
      category: 'musica',
      area: 'laghi',
      season: 'primavera-estate',
      variant: '02',
    };
    const candidates = [
      { type: 'photo', title: 'Lake Zurich', sourcePageUrl: 'https://photos.example/used-hash', width: 2400, height: 1600, sha256: 'a'.repeat(64) },
      { type: 'photo', title: 'Lake Zurich', sourcePageUrl: 'https://photos.example/used-page', width: 2400, height: 1600, sha256: 'b'.repeat(64) },
      { type: 'photo', title: 'Lake Zurich', sourcePageUrl: 'https://photos.example/keep-a', width: 2400, height: 1600, sha256: 'c'.repeat(64) },
      { type: 'photo', title: 'Lake Zurich', sourcePageUrl: 'https://photos.example/keep-b', width: 2400, height: 1600, sha256: 'd'.repeat(64) },
    ];
    const usedRecords = [{
      scope: 'event-library',
      sourcePageUrl: 'https://photos.example/used-page',
      sha256: 'a'.repeat(64),
      assetId: 'event-used',
    }];

    const first = selectDeterministicPhotoCandidate(spec, candidates, { usedRecords });
    const second = selectDeterministicPhotoCandidate(spec, [...candidates].reverse(), { usedRecords });
    expect(first).toEqual(second);
    expect(['https://photos.example/keep-a', 'https://photos.example/keep-b']).toContain(first?.sourcePageUrl);
    expect(isSuitablePhotoCandidate(first)).toBe(true);
  });

  it('rejects non-photographs and unsuitable source dimensions before download', () => {
    expect(isPhotographicMetadata('William Callow painting of Lake Lugano')).toBe(false);
    expect(isSuitablePhotoCandidate({ type: 'illustration', sourcePageUrl: 'https://example/illustration', width: 3000, height: 2000 })).toBe(false);
    expect(isSuitablePhotoCandidate({ type: 'photo', sourcePageUrl: 'https://example/small', width: 1599, height: 1200 })).toBe(false);
    expect(isSuitablePhotoCandidate({ type: 'photo', sourcePageUrl: 'https://example/portrait', width: 1600, height: 2000 })).toBe(false);
    expect(isSuitablePhotoCandidate({ type: 'photo', sourcePageUrl: 'https://example/painting', title: 'oil painting', width: 2400, height: 1600 })).toBe(false);
    expect(isSuitablePhotoCandidate({ type: 'photo', sourcePageUrl: 'https://example/photo', width: 2400, height: 1600 })).toBe(true);
  });

  it('keeps photo candidates geographically relevant to the slot area', () => {
    expect(isPhotoCandidateRelevantToSpec(
      { area: 'svizzera-urbana' },
      { title: 'Zurich live concert, Switzerland', width: 2400, height: 1600 },
    )).toBe(true);
    expect(isPhotoCandidateRelevantToSpec(
      { area: 'svizzera-urbana' },
      { title: 'Mykonos finale live set, Greece', width: 6240, height: 4160 },
    )).toBe(false);
    expect(isPhotoCandidateRelevantToSpec(
      { area: 'laghi' },
      { title: 'Lake Tahoe', width: 2400, height: 1600 },
    )).toBe(false);
    expect(isPhotoCandidateRelevantToSpec(
      { area: 'laghi' },
      { title: '', width: 2400, height: 1600 },
    )).toBe(false);
  });

  it('requires article photos to match the topic and rejects branded or written candidates', () => {
    const spec = {
      scope: 'article-hero',
      title: 'Tasse e lavoro a Zurigo',
      topic: 'tassazione e occupazione',
      place: 'Zurigo, Svizzera',
    };
    expect(isPhotoCandidateRelevantToSpec(spec, {
      title: 'Tax and employment office in Zurich Switzerland',
      width: 2400,
      height: 1600,
    })).toBe(true);
    expect(isPhotoCandidateRelevantToSpec(spec, {
      title: 'Swiss Alps landscape',
      width: 6240,
      height: 4160,
    })).toBe(false);
    expect(isPhotoCandidateRelevantToSpec({
      scope: 'article-hero',
      title: 'Guida per frontalieri in Ticino',
      place: 'Ticino, Svizzera',
      keywords: ['Ticino', 'Svizzera'],
    }, {
      title: 'Ticino mountain landscape Switzerland',
      width: 6240,
      height: 4160,
    })).toBe(false);
    expect(isPhotoCandidateRelevantToSpec({
      scope: 'article-hero',
      title: 'Turismo in Valposchiavo',
      topic: 'turismo',
      place: 'Valposchiavo, Svizzera',
    }, {
      title: 'Cevio village in Ticino Switzerland',
      width: 6240,
      height: 4160,
    })).toBe(false);
    expect(isSuitableArticlePhotoCandidate(spec, {
      type: 'photo',
      title: 'Zurich employment brand logo with text overlay',
      width: 2400,
      height: 1600,
    })).toBe(false);
  });

  it('exposes the persistence collision guard for an existing photo scope', () => {
    const record = { kind: 'photo', scope: 'event-library', sourcePageUrl: 'https://example/photo', sha256: 'c'.repeat(64) };
    expect(photoRecordCollision(record, [{ ...record, assetId: 'already-used' }])).toMatchObject({
      type: 'sourcePageUrl',
      assetId: 'already-used',
    });
    expect(photoRecordCollision({ ...record, sourcePageUrl: 'https://example/other' }, [{ ...record, assetId: 'already-used' }])).toMatchObject({
      type: 'sha256',
      assetId: 'already-used',
    });
  });

  it('rejects Wikimedia paintings and source images below the landscape floor', () => {
    const base = {
      fullurl: 'https://commons.wikimedia.org/wiki/File:Lago.jpg',
      imageinfo: [{
        mime: 'image/jpeg',
        width: 2400,
        height: 1600,
        thumburl: 'https://upload.wikimedia.org/lake.jpg',
        extmetadata: {
          LicenseShortName: { value: 'CC BY-SA 4.0' },
          LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' },
          Artist: { value: 'Ada Wikimedia' },
        },
      }],
    };
    expect(verifyWikimediaExtmetadata({ ...base, title: 'File:Lake painting.jpg' })).toBeNull();
    expect(verifyWikimediaExtmetadata({
      ...base,
      imageinfo: [{ ...base.imageinfo[0], width: 1200, height: 900 }],
    })).toBeNull();
  });

  it('derives the Commons file page URL when the search response omits fullurl', () => {
    const page = {
      title: 'File:Lugano panorama.jpg',
      imageinfo: [{
        width: 1600,
        height: 900,
        mime: 'image/jpeg',
        thumburl: 'https://upload.wikimedia.org/lugano.jpg',
        extmetadata: {
          LicenseShortName: { value: 'CC BY-SA 4.0' },
          Artist: { value: 'Ada Wikimedia' },
        },
      }],
    };

    expect(verifyWikimediaExtmetadata(page)?.sourcePageUrl).toBe(
      'https://commons.wikimedia.org/wiki/File:Lugano_panorama.jpg',
    );
  });

  it('reports missing credentials without exposing values', () => {
    expect(providerConfiguration('fal', {})).toEqual({ configured: false, reason: 'missing-key:FAL_KEY' });
    expect(providerConfiguration('pollinations', {})).toEqual({ configured: false, reason: 'missing-key:POLLINATIONS_API_KEY' });
  });
});
