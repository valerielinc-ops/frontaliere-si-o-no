import { useState } from 'react';
import { AlertTriangle, CheckCircle2, FileText, Loader2, Trash2, Upload } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { checkDocumentFile, type DocumentCheck } from '@/services/assistedApplicationDocumentCheck';
import type { ReviewDocument } from '@/services/assistedApplicationReviewService';

/**
 * The documents the posting requires besides the CV and the letter (Rolex,
 * 2026-10-02: school reports, the EVA and GRI test results), on the
 * candidate's review page. Each file is checked in the browser first: a file
 * that does not look like the document asked for gets a warning, never a
 * block — the candidate may send it, or send without the document, and that
 * choice is theirs (owner decision 2026-10-02).
 */
export function AssistedApplicationDocuments({ documents, limits, disabled, onUpload, onRemove, onWaive }: {
  documents: ReviewDocument[];
  limits: { maxBytes: number; maxFiles: number };
  disabled: boolean;
  onUpload: (document: ReviewDocument, file: File, check: DocumentCheck) => Promise<boolean>;
  onRemove: (document: ReviewDocument, fileId: string) => Promise<boolean>;
  onWaive: (document: ReviewDocument, waive: boolean) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  // The document whose file is being checked and sent, and a file refused before sending.
  const [working, setWorking] = useState<string | null>(null);
  const [localError, setLocalError] = useState<Record<string, string>>({});
  const maxMb = Math.round(limits.maxBytes / (1024 * 1024));

  const pick = async (document: ReviewDocument, list: FileList | null) => {
    const room = Math.max(0, limits.maxFiles - document.files.length);
    const files = [...(list || [])].slice(0, room);
    if (!files.length) return;
    setLocalError((current) => ({ ...current, [document.id]: '' }));
    setWorking(document.id);
    try {
      for (const file of files) {
        if (file.size > limits.maxBytes) {
          setLocalError((current) => ({ ...current, [document.id]: t('jobBoard.assisted.review.documents.tooLarge', { name: file.name, mb: maxMb }) }));
          continue;
        }
        const check = await checkDocumentFile(file, document);
        if (!(await onUpload(document, file, check))) break;
      }
    } finally {
      setWorking(null);
    }
  };

  const checkMessage = (document: ReviewDocument, verdict: string) => ({
    match: t('jobBoard.assisted.review.documents.check.match'),
    mismatch: t('jobBoard.assisted.review.documents.check.mismatch', { label: document.label }),
    looks_like_cv: t('jobBoard.assisted.review.documents.check.looksLikeCv', { label: document.label }),
    unreadable: t('jobBoard.assisted.review.documents.check.unreadable', { label: document.label }),
  } as Record<string, string>)[verdict] || '';

  return (
    <section className="space-y-4 rounded-xl border border-edge bg-surface-alt p-4" aria-labelledby="assisted-documents-title">
      <div>
        <h2 id="assisted-documents-title" className="text-base font-bold text-heading">{t('jobBoard.assisted.review.documents.title')}</h2>
        <p className="mt-1 text-sm text-body">{t('jobBoard.assisted.review.documents.intro')}</p>
        <p className="mt-1 text-xs text-subtle">{t('jobBoard.assisted.review.documents.formats', { mb: maxMb, max: limits.maxFiles })}</p>
      </div>
      {documents.map((document) => {
        const inputId = `assisted-document-${document.id}`;
        const full = document.files.length >= limits.maxFiles;
        return (
          <div key={document.id} className="space-y-2 rounded-lg border border-edge bg-surface p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-heading">
                {document.label}
                {document.required ? <span className="text-warning"> *</span> : null}
              </h3>
              <span className="text-xs text-subtle">
                {document.required ? t('jobBoard.assisted.review.documents.required') : t('jobBoard.assisted.review.documents.optional')}
              </span>
            </div>
            {document.quote && <p className="text-xs italic text-subtle">{t('jobBoard.assisted.review.documents.askedBy', { quote: document.quote })}</p>}

            {document.files.length > 0 && (
              <ul className="space-y-2">
                {document.files.map((file) => {
                  const ok = file.clientCheck.verdict === 'match';
                  return (
                    <li key={file.id} className="rounded-md border border-edge p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex min-w-0 items-center gap-2 text-sm text-body">
                          <FileText className="h-4 w-4 shrink-0 text-subtle" aria-hidden="true" />
                          <span className="truncate">{file.name}</span>
                        </span>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => { void onRemove(document, file.id); }}
                          className="inline-flex min-h-[44px] items-center gap-1 rounded-lg px-2 text-xs font-semibold text-subtle hover:text-heading disabled:opacity-60"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                          {t('jobBoard.assisted.review.documents.remove')}
                        </button>
                      </div>
                      <p className={`mt-1 flex items-start gap-1.5 text-xs ${ok ? 'text-success' : 'text-warning'}`} role="status">
                        {ok
                          ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                        <span>{checkMessage(document, file.clientCheck.verdict)}</span>
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}

            {!full && !document.waived && (
              <div>
                <label
                  htmlFor={inputId}
                  className={`inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border border-accent px-4 text-sm font-semibold text-accent hover:bg-accent-subtle ${disabled || working ? 'pointer-events-none opacity-60' : ''}`}
                >
                  {working === document.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Upload className="h-4 w-4" aria-hidden="true" />}
                  {working === document.id ? t('jobBoard.assisted.review.documents.checking') : t('jobBoard.assisted.review.documents.upload')}
                </label>
                <input
                  id={inputId}
                  type="file"
                  multiple
                  className="sr-only"
                  accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                  disabled={disabled || Boolean(working)}
                  onChange={(event) => { const { files } = event.target; void pick(document, files).finally(() => { event.target.value = ''; }); }}
                />
              </div>
            )}
            {localError[document.id] && <p className="text-xs text-danger" role="alert">{localError[document.id]}</p>}

            {document.required && document.files.length === 0 && (
              document.waived ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning-border bg-warning-subtle/60 p-2 text-xs text-body">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
                  <span>{t('jobBoard.assisted.review.documents.waived', { label: document.label })}</span>
                  <button type="button" disabled={disabled} onClick={() => { void onWaive(document, false); }} className="min-h-[44px] font-semibold text-accent underline disabled:opacity-60">
                    {t('jobBoard.assisted.review.documents.unwaive')}
                  </button>
                </div>
              ) : (
                <div className="space-y-1">
                  <p className="text-xs text-subtle">{t('jobBoard.assisted.review.documents.waiveWarning', { label: document.label })}</p>
                  <button type="button" disabled={disabled} onClick={() => { void onWaive(document, true); }} className="min-h-[44px] text-xs font-semibold text-subtle underline hover:text-heading disabled:opacity-60">
                    {t('jobBoard.assisted.review.documents.waive')}
                  </button>
                </div>
              )
            )}
          </div>
        );
      })}
    </section>
  );
}
