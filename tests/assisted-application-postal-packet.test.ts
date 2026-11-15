import { File } from 'node:buffer';
import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JPEG_2X2 } from './helpers/pdfImages';
import { buildPostalApplicationPacket, postalPacketReadiness, postalPacketSources } from '../functions/src/assistedApplicationPostalPacket.js';
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

async function signedPdfWithPages(count: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  for (let index = 0; index < count; index += 1) pdf.addPage();
  const page = pdf.getPage(0);
  const signature = pdf.context.obj({
    Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, 0, 0, 0], Contents: PDFHexString.of('00'.repeat(64)),
  });
  const field = pdf.context.register(pdf.context.obj({
    FT: 'Sig', T: PDFString.of('Signature1'), V: pdf.context.register(signature),
    Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 0, 0], F: 132, P: page.ref,
  }));
  page.node.set(PDFName.of('Annots'), pdf.context.obj([field]));
  pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields: [field], SigFlags: 3 }));
  return pdf.save({ useObjectStreams: false });
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

  it('keeps a photo requirement missing when its uploaded image violates the portal field', () => {
    const input: any = postalSources();
    input.draft.requiredDocuments.push({
      id: 'portal_photo', label: 'Foto', kind: 'photo', required: true, accept: 'image/jpeg', maxBytes: 1024,
    });
    input.flow.documents.portal_photo = { files: [{
      key: `${folder}/doc-portal_photo-0-1234abcd.png`, name: 'photo.png', size: 512, detectedType: 'png',
    }] };

    const packet = postalPacketSources(input);

    expect(packet.documents.map((file: any) => file.documentId)).not.toContain('portal_photo');
    expect(packet.missingDocuments).toContain('Foto');
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

  it('includes printable pages from a digitally signed local PDF', async () => {
    const signed = new File([await signedPdfWithPages(2)], 'signed-certificate.pdf', { type: 'application/pdf' });
    const regular = new File([await pdfWithPages(1)], 'health-scan.pdf', { type: 'application/pdf' });
    const merged = await mergeLocalPostalDocuments({
      basePdf: await pdfWithPages(1),
      documents: [
        { id: 'signed_record', label: 'Certificato firmato', files: [signed] },
        { id: 'health_questionnaire', label: 'Questionario salute', files: [regular] },
      ],
      sourceBytes: 0,
      maxBytes: 1024 * 1024,
    });
    const result = await PDFDocument.load(merged);
    expect(result.getPageCount()).toBe(5); // base + local index + signed two-page copy + unsigned scan
  });

  it('includes printable pages from digitally signed server PDFs', async () => {
    const signed = Buffer.from(await signedPdfWithPages(2));
    const postalSubmission = {
      recipient: 'Ufficio candidature', address: 'Via Esempio 1\n6900 Lugano', deadline: '30 giugno 2026',
      envelopeMarking: 'Candidatura', instructions: 'Spedisci entro la scadenza.',
    };
    const common = { locale: 'it', jobTitle: 'Assistente', companyName: 'Comune', postalSubmission, includeHandwrittenLetter: false };
    const withoutAttachment = await buildPostalApplicationPacket({ ...common, checklist: [], files: [] });
    const withSignedAttachment = await buildPostalApplicationPacket({
      ...common,
      checklist: [{ documentId: 'civil_status', label: 'Certificato di stato civile', status: 'incluso' }],
      files: [{ type: 'pdf', buffer: signed, name: 'certificato-firmato.pdf', label: 'Certificato di stato civile', documentId: 'civil_status' }],
    });
    expect((await PDFDocument.load(withSignedAttachment)).getPageCount()).toBe((await PDFDocument.load(withoutAttachment)).getPageCount() + 2);
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
