import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import itCore from '@/services/locales/it-core';
import { AssistedApplicationKeptDocuments } from '@/components/community/AssistedApplicationKeptDocuments';
import { reviewWordUrl, type ReviewKeptDocument, type ReviewKeptDocuments } from '@/services/assistedApplicationReviewService';

// The page's Italian strings as they are, without the article chunks the full i18n loads.
vi.mock('@/services/i18n', async () => {
  const { default: strings } = await import('@/services/locales/it-core');
  return { useTranslation: () => ({ t: (key: string) => strings[key] ?? key, locale: 'it' }) };
});

// Close-out P8 (owner decisions of 2026-10-03): the review page's block «I tuoi documenti» after the sending.
const TOKEN = 'ar1.order_REV123.1.tz5ch8.0123456789abcdef0123456789abcdef';
const R = 'jobBoard.assisted.review.';
const letter: ReviewKeptDocument = { kind: 'letter', name: 'Lettera_di_presentazione_Maria_Rossi.pdf', url: 'https://signed.example/letter.pdf', word: ['letter.docx'], suggested: false };
const tailored: ReviewKeptDocument = { kind: 'cvTailored', name: 'CV_Maria_Rossi.pdf', url: 'https://signed.example/cv.pdf', word: ['cv.docx'], suggested: false };
const original: ReviewKeptDocument = { kind: 'cvOriginal', name: 'CV_Maria_Rossi.docx', url: 'https://signed.example/original.docx', word: [], suggested: false };
const block = () => screen.getByRole('region', { name: itCore[`${R}kept.title`] });

describe('the documents the candidate keeps, on the review page', () => {
  afterEach(cleanup);

  it('lists each file that left under its label and the name it left with, the Word copies beside the letter and the tailored CV', () => {
    const kept: ReviewKeptDocuments = { source: 'sent', whatsapp: false, files: [letter, tailored, { kind: 'documents', name: 'Allegati_Maria_Rossi.pdf', url: 'https://signed.example/documents.pdf', word: [], suggested: false }] };
    render(<AssistedApplicationKeptDocuments kept={kept} token={TOKEN} cvPhotoPrinted />);
    const section = within(block());
    expect(section.getByText(itCore[`${R}kept.introSent`])).toBeTruthy();
    for (const [label, url] of [[`${R}kept.letter`, letter.url], [`${R}kept.cvTailored`, tailored.url], [`${R}kept.documents`, 'https://signed.example/documents.pdf']]) {
      const link = section.getByRole('link', { name: itCore[label] });
      expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]).toEqual([url, '_blank', 'noreferrer']);
    }
    for (const name of [letter.name, tailored.name, 'Allegati_Maria_Rossi.pdf']) expect(section.getByText(name)).toBeTruthy();
    // The Word copies: built by the server on the page's own link, opened in a new tab like the PDFs.
    expect(section.getByRole('link', { name: itCore[`${R}wordCopyLetter`] }).getAttribute('href')).toBe(reviewWordUrl(TOKEN, 'letter.docx'));
    expect(section.getByRole('link', { name: itCore[`${R}wordCopyCv`] }).getAttribute('href')).toBe(reviewWordUrl(TOKEN, 'cv.docx'));
    expect(new URL(reviewWordUrl(TOKEN, 'cv.docx')).searchParams.get('file')).toBe('cv.docx');
    expect(section.getAllByRole('link')).toHaveLength(5);
    for (const note of [`${R}wordCopyNote`, `${R}wordCopyNoPhoto`, `${R}kept.retention`]) expect(section.getByText(itCore[note])).toBeTruthy();
    // Nothing to choose between: no CV is highlighted.
    expect(section.queryByText(itCore[`${R}kept.suggested`])).toBeNull();
  });

  it('says the files were prepared when it cannot say they left, and leaves out the photo note when the PDF had none', () => {
    render(<AssistedApplicationKeptDocuments kept={{ source: 'prepared', whatsapp: false, files: [letter, tailored] }} token={TOKEN} cvPhotoPrinted={false} />);
    const section = within(block());
    expect(section.getByText(itCore[`${R}kept.introPrepared`])).toBeTruthy();
    expect(section.queryByText(itCore[`${R}wordCopyNoPhoto`])).toBeNull();
  });

  // Owner decision 2026-10-03: in a WhatsApp application the candidate chooses the CV they send in the chat.
  it('lets a WhatsApp candidate choose the CV: the tailored one highlighted and labelled, their own beside it', () => {
    render(<AssistedApplicationKeptDocuments kept={{ source: 'prepared', whatsapp: true, files: [letter, { ...tailored, suggested: true }, original] }} token={TOKEN} cvPhotoPrinted={false} />);
    const section = within(block());
    expect(section.getByText(itCore[`${R}kept.introWhatsappChoice`])).toBeTruthy();
    const items = section.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    // The suggestion says so in words, not only in colour.
    expect(within(items[1]).getByText(itCore[`${R}kept.suggested`])).toBeTruthy();
    expect(items[1].className).toContain('border-accent-border');
    expect(items[2].className).not.toContain('border-accent-border');
    expect(within(items[2]).getByRole('link', { name: itCore[`${R}kept.cvOriginal`] }).getAttribute('href')).toBe(original.url);
    // Choosing stores nothing: there is no control to press, only the files to download.
    expect(section.queryAllByRole('radio')).toHaveLength(0);
    expect(section.queryAllByRole('button')).toHaveLength(0);
  });

  it('gives a WhatsApp candidate without a tailored CV the letter and their own CV, nothing to choose', () => {
    render(<AssistedApplicationKeptDocuments kept={{ source: 'prepared', whatsapp: true, files: [letter, original] }} token={TOKEN} cvPhotoPrinted={false} />);
    const section = within(block());
    expect(section.getByText(itCore[`${R}kept.introWhatsapp`])).toBeTruthy();
    expect(section.queryByText(itCore[`${R}kept.suggested`])).toBeNull();
  });
});
