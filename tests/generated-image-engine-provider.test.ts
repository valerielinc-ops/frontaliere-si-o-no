// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  extractGeminiImageData,
  extractFalImageData,
  extractPexelsPhoto,
  extractPixabayPhoto,
  extractTogetherImageData,
  formatProviderHttpError,
  imageProviderSequence,
  providerConfiguration,
  verifyWikimediaExtmetadata,
} from '../packages/articles/engine/shared/generatedImageEngine.mjs';

describe('generated image provider contracts', () => {
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
    expect(extractPixabayPhoto({
      hits: [{
        user: 'Ada Pixabay',
        pageURL: 'https://pixabay.com/photos/lake-123/',
        imageWidth: 1600,
        imageHeight: 900,
        largeImageURL: 'https://cdn.pixabay.com/photo.jpg',
      }],
    })?.license).toBe('Pixabay Content License');
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

  it('derives the Commons file page URL when the search response omits fullurl', () => {
    const page = {
      title: 'File:Lugano panorama.jpg',
      imageinfo: [{
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
