// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  extractGeminiImageData,
  formatProviderHttpError,
  imageProviderSequence,
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

  it('uses one broker Codex attempt before Gemini, while local execution retains retry', () => {
    expect(imageProviderSequence({ broker: true })).toEqual(['openai-codex', 'gemini']);
    expect(imageProviderSequence({ broker: false })).toEqual(['openai-codex', 'openai-codex', 'gemini']);
  });
});
