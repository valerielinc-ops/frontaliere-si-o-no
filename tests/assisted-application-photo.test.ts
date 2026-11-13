import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { extractCvPortraitFromPdf, MAX_PORTAL_PHOTO_BYTES, prepareCvPortraitDocument } from '../functions/src/assistedApplicationPhoto.js';
import { syntheticImagePdf, syntheticJpeg } from './helpers/syntheticImagePdf.mjs';

describe('CV portrait extraction', () => {
  it('extracts a sole square-ish raster image as a bounded JPEG', async () => {
    const portrait = await syntheticJpeg(564, 581);
    const output = await extractCvPortraitFromPdf(syntheticImagePdf([[portrait]]));

    expect(output).not.toBeNull();
    expect(output!.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(output!.length).toBeLessThanOrEqual(MAX_PORTAL_PHOTO_BYTES);
    await expect(sharp(output!).metadata()).resolves.toMatchObject({ format: 'jpeg', width: 564, height: 581 });
  }, 30_000);

  it('does not select a small logo repeated across pages', async () => {
    const logo = await syntheticJpeg(72, 64, '#224466');

    await expect(extractCvPortraitFromPdf(syntheticImagePdf([[logo], [logo]]))).resolves.toBeNull();
  });

  it('keeps the photo unknown when two large images are plausible', async () => {
    const first = await syntheticJpeg(520, 560, '#32678a');
    const second = await syntheticJpeg(600, 540, '#9a634a');

    await expect(extractCvPortraitFromPdf(syntheticImagePdf([[first, second]]))).resolves.toBeNull();
  });

  it('returns no portrait when the PDF contains no images', async () => {
    await expect(extractCvPortraitFromPdf(syntheticImagePdf([[]]))).resolves.toBeNull();
  });

  it('keeps an acceptable candidate photo ahead of the CV source', async () => {
    const orderId = 'order_photo_preferred';
    const prepared = await prepareCvPortraitDocument({
      orderId,
      order: { cvStorageKey: `assisted-application-uploads/${orderId}/candidate-cv.pdf` },
      draft: { requiredDocuments: [{ id: 'portrait', label: 'Photo', accept: 'image/jpeg', required: true }] },
      flow: { photo: {
        key: `assisted-application-uploads/${orderId}/photo-1234-abcd.jpg`, detectedType: 'jpg', size: 1000,
      } },
    });

    expect(prepared).toBeNull();
  });

  it('reads the original uploaded CV when submission selected a tailored CV', async () => {
    const orderId = 'order_photo_source';
    const cvKey = `assisted-application-uploads/${orderId}/candidate-cv.pdf`;
    const outgoingKey = `assisted-application-uploads/${orderId}/tailored-cv.pdf`;
    const originalPortrait = await syntheticJpeg(564, 581);
    const objects = new Map([[cvKey, syntheticImagePdf([[originalPortrait]])]]);
    const bucket = {
      file(key: string) {
        return {
          async download() {
            const value = objects.get(key);
            if (!value) throw new Error('missing synthetic object');
            return [value];
          },
          async exists() { return [objects.has(key)]; },
          async save(value: Buffer) { objects.set(key, Buffer.from(value)); },
        };
      },
    };
    const prepared = await prepareCvPortraitDocument({
      bucket,
      orderId,
      order: { cvStorageKey: cvKey },
      draft: { requiredDocuments: [{ id: 'portrait', label: 'Photo', required: true }] },
      cvBuffer: syntheticImagePdf([[]]),
      cvType: 'pdf',
      cvKey: outgoingKey,
    });

    expect(prepared).toMatchObject({ documentId: 'portrait', file: { detectedType: 'jpg', name: 'photo.jpg' } });
  });

  it('uses the CV portrait when an existing candidate image does not match the field accept', async () => {
    const orderId = 'order_photo_accept';
    const cvKey = `assisted-application-uploads/${orderId}/candidate-cv.pdf`;
    const portrait = await syntheticJpeg(564, 581);
    const objects = new Map([[cvKey, syntheticImagePdf([[portrait]])]]);
    const bucket = {
      file(key: string) {
        return {
          async download() {
            const value = objects.get(key);
            if (!value) throw new Error('missing synthetic object');
            return [value];
          },
          async exists() { return [objects.has(key)]; },
          async save(value: Buffer) { objects.set(key, Buffer.from(value)); },
        };
      },
    };
    const prepared = await prepareCvPortraitDocument({
      bucket,
      orderId,
      order: { cvStorageKey: cvKey },
      draft: { requiredDocuments: [{ id: 'portrait', label: 'Photo', accept: 'image/jpeg', required: true }] },
      flow: { documents: { portrait: { files: [{
        key: `assisted-application-uploads/${orderId}/doc-portrait-0-1234abcd.png`, detectedType: 'png', size: 1000,
      }] } } },
    });

    expect(prepared).toMatchObject({ documentId: 'portrait', file: { detectedType: 'jpg', name: 'photo.jpg' } });
  }, 30_000);
});
