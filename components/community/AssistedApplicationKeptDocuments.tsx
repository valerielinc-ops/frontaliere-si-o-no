import { Download, FileText } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { reviewWordUrl, type ReviewKeptDocuments, type ReviewWordFile } from '@/services/assistedApplicationReviewService';

const WORD_COPY_LABELS = {
  'letter.docx': 'jobBoard.assisted.review.wordCopyLetter',
  'cv.docx': 'jobBoard.assisted.review.wordCopyCv',
} as const;

const KEPT_LABELS = {
  letter: 'jobBoard.assisted.review.kept.letter',
  cvTailored: 'jobBoard.assisted.review.kept.cvTailored',
  cvOriginal: 'jobBoard.assisted.review.kept.cvOriginal',
  cvInplace: 'jobBoard.assisted.review.kept.cvInplace',
  dossier: 'jobBoard.assisted.review.kept.dossier',
  documents: 'jobBoard.assisted.review.kept.documents',
  document: 'jobBoard.assisted.review.kept.document',
} as const;

/**
 * The editable Word copy, built by the server on request: never the file that leaves. A new tab, as the PDF
 * links: the server answers with an attachment, and an error never replaces the review page.
 */
export function WordCopyLink({ token, file }: { token: string; file: ReviewWordFile }) {
  const { t } = useTranslation();
  return (
    <a href={reviewWordUrl(token, file)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 py-1 text-sm font-semibold text-link hover:underline">
      <Download className="h-4 w-4 shrink-0" aria-hidden="true" /> {t(WORD_COPY_LABELS[file])}
    </a>
  );
}

/**
 * After the sending: what left (or, for an older order and a WhatsApp application, what was prepared), to
 * keep. A WhatsApp application lists the tailored CV, highlighted, and the candidate's own: they choose
 * which one to send in the chat (owner decision 2026-10-03), and the page stores nothing about it.
 */
export function AssistedApplicationKeptDocuments({ kept, token, cvPhotoPrinted }: { kept: ReviewKeptDocuments; token: string; cvPhotoPrinted: boolean }) {
  const { t } = useTranslation();
  const choosing = kept.files.some((file) => file.suggested);
  const intro = kept.whatsapp
    ? (choosing ? 'jobBoard.assisted.review.kept.introWhatsappChoice' : 'jobBoard.assisted.review.kept.introWhatsapp')
    : kept.source === 'sent' ? 'jobBoard.assisted.review.kept.introSent' : 'jobBoard.assisted.review.kept.introPrepared';
  const copies = kept.files.some((file) => file.word.length > 0);
  return (
    <section aria-labelledby="assisted-kept-documents-title" className="space-y-3 rounded-xl border border-edge p-4 text-sm">
      <h2 id="assisted-kept-documents-title" className="text-base font-bold text-heading">{t('jobBoard.assisted.review.kept.title')}</h2>
      <p className="leading-relaxed text-body">{t(intro)}</p>
      <ul className="space-y-2">
        {kept.files.map((file, index) => (
          <li
            key={`${file.kind}-${index}`}
            className={`space-y-1 rounded-lg border p-3 ${file.suggested ? 'border-accent-border bg-accent-subtle/40' : 'border-edge'}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <a href={file.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 py-1 font-semibold text-link hover:underline">
                <FileText className="h-4 w-4 shrink-0" aria-hidden="true" /> {t(KEPT_LABELS[file.kind])}
              </a>
              {file.suggested && (
                <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-on-accent">{t('jobBoard.assisted.review.kept.suggested')}</span>
              )}
            </div>
            <p className="break-all text-xs text-subtle">{file.name}</p>
            {file.word.length > 0 && (
              <div className="flex flex-wrap gap-x-3">{file.word.map((word) => <WordCopyLink key={word} token={token} file={word} />)}</div>
            )}
          </li>
        ))}
      </ul>
      {copies && <p className="text-xs text-subtle">{t('jobBoard.assisted.review.wordCopyNote')}</p>}
      {cvPhotoPrinted && kept.files.some((file) => file.word.includes('cv.docx')) && <p className="text-xs text-subtle">{t('jobBoard.assisted.review.wordCopyNoPhoto')}</p>}
      <p className="text-xs text-subtle">{t('jobBoard.assisted.review.kept.retention')}</p>
    </section>
  );
}
