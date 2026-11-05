import { File } from 'node:buffer';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JPEG_2X2 } from './helpers/pdfImages';
import { postalPacketReadiness, postalPacketSources } from '../functions/src/assistedApplicationPostalPacket.js';
import { mergeLocalPostalDocuments } from '../services/assistedApplicationPostalPacket';
import { downloadPostalPacket } from '../services/assistedApplicationReviewService';

const ORDER = 'order_POSTAL1';
const folder = `assisted-application-uploads/${ORDER}`;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function pdfWithPages(count: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < count; index += 1) pdf.addPage();
  return pdf.save();
}

function postalSources(studyFiles: unknown[] = []) {
  const cvKey = `${folder}/cv.pdf`;
  return {
    order: { cvStorageKey: cvKey, cvFileCheck: { key: cvKey, detectedType: 'pdf', size: 1200 } },
    orderId: ORDER,
    draft: { requiredDocuments: [
      { id: 'curriculum_vitae', label: 'CV', required: true, delivery: 'service' },
      { id: 'handwritten_letter', label: 'Lettera manoscritta', required: true, delivery: 'offline', localOnly: true },
      { id: 'health_questionnaire', label: 'Questionario sullo stato di salute', required: true, delivery: 'offline', localOnly: true },
      { id: 'study_work_certificates', label: 'Certificati di studio e di lavoro', required: true },
    ] },
    flow: { postalSubmission: { enabled: true }, documents: {
      study_work_certificates: { files: studyFiles },
    } },
  };
}

describe('paper application packet readiness', () => {
  it('accepts local-only required scans while requiring regular scans to be uploaded', () => {
    const studyFile = { key: `${folder}/doc-study_work_certificates-1.pdf`, name: 'certificati.pdf', size: 2000, detectedType: 'pdf' };
    const ready = postalPacketReadiness(postalSources([studyFile]));
    expect(ready).toMatchObject({ ready: true, missingDocuments: [], localDocuments: [
      { id: 'handwritten_letter', required: true },
      { id: 'health_questionnaire', required: true },
    ] });
    expect(postalPacketSources(postalSources([studyFile])).includeHandwrittenLetter).toBe(true);

    const missing = postalPacketReadiness(postalSources());
    expect(missing).toMatchObject({ ready: false, missingDocuments: ['Certificati di studio e di lavoro'] });
  });

  it('merges local PDF and passport-photo scans into the server packet in the browser', async () => {
    const basePdf = await pdfWithPages(1);
    const localPdf = new File([await pdfWithPages(2)], 'health-scan.pdf', { type: 'application/pdf' });
    const localPhoto = new File([JPEG_2X2], 'photo.jpg', { type: 'image/jpeg' });
    const merged = await mergeLocalPostalDocuments({
      basePdf,
      documents: [
        { id: 'health_questionnaire', label: 'Questionario salute', files: [localPdf] },
        { id: 'passport_photo', label: 'Fotografia formato passaporto', files: [localPhoto] },
      ],
      sourceBytes: 1200,
      maxBytes: 1024 * 1024,
      locale: 'it-CH',
    });
    const result = await PDFDocument.load(merged);
    expect(result.getPageCount()).toBe(5); // base + local index + two-page scan + photo frame
  });

  it('rejects local files when the combined source size exceeds the packet limit', async () => {
    const localPdf = new File([await pdfWithPages(1)], 'health-scan.pdf', { type: 'application/pdf' });
    await expect(mergeLocalPostalDocuments({
      basePdf: await pdfWithPages(1),
      documents: [{ id: 'health_questionnaire', label: 'Health questionnaire', files: [localPdf] }],
      sourceBytes: 8,
      maxBytes: 8,
    })).rejects.toMatchObject({ code: 'postal_packet_too_large' });
  });

  it('downloads the base packet without sending local scan bytes in a request', async () => {
    const basePdf = await pdfWithPages(1);
    const localPdf = new File([await pdfWithPages(1)], 'health-scan.pdf', { type: 'application/pdf' });
    const fetch = vi.fn(async () => new Response(new Blob([basePdf], { type: 'application/pdf' })));
    const link = { href: '', download: '', click: vi.fn() };
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('document', { createElement: vi.fn(() => link) });
    vi.stubGlobal('window', { setTimeout: vi.fn() });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:postal-packet');

    await downloadPostalPacket('review-token', [{ id: 'health', label: 'Health questionnaire', files: [localPdf] }], 500, 1024 * 1024);

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]).toEqual({ method: 'GET', cache: 'no-store' });
    expect(link.click).toHaveBeenCalledOnce();
  });
});
