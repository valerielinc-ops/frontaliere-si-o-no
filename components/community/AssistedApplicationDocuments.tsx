import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, FileText, Loader2, Trash2, Upload } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { checkDocumentFile, DOCUMENT_CHECK_VERSION, type DocumentCheck } from '@/services/assistedApplicationDocumentCheck';
import type { ReviewDocument } from '@/services/assistedApplicationReviewService';

/**
 * The documents the posting requires besides the CV and the letter (Rolex,
 * 2026-10-02: school reports, the EVA and GRI test results), on the
 * candidate's review page. Each file is checked in the browser first: a file
 * identified as a different document gets a warning; unrecognized readable
 * text stays uncertain, never a block — which file to send is the candidate's choice (owner decision
 * 2026-10-02). Sending without a required document is not: the application
 * waits for it (owner decision 2026-10-08).
 */
export function AssistedApplicationDocuments({ documents, limits, disabled, onUpload, onRemove, onSetPrepared, onSetExemption }: {
  documents: ReviewDocument[];
  limits: { maxBytes: number; maxFiles: number };
  disabled: boolean;
  onUpload: (document: ReviewDocument, file: File, check: DocumentCheck) => Promise<boolean>;
  onRemove: (document: ReviewDocument, fileId: string) => Promise<boolean>;
  onSetPrepared: (document: ReviewDocument, prepared: boolean) => Promise<boolean>;
  onSetExemption: (document: ReviewDocument, exemption: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  // The document whose file is being checked and sent, and a file refused before sending.
  const [working, setWorking] = useState<string | null>(null);
  const [localError, setLocalError] = useState<Record<string, string>>({});
  const [exemptionChoice, setExemptionChoice] = useState<Record<string, string>>({});
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
    unknown: t('jobBoard.assisted.review.documents.check.unknown', { label: document.label }),
  } as Record<string, string>)[verdict] || '';

  return (
    <section className="space-y-4 rounded-xl border border-edge bg-surface-alt p-4" aria-labelledby="assisted-documents-title">
      <div>
        <h2 id="assisted-documents-title" className="text-base font-bold text-heading">{t('jobBoard.assisted.review.documents.title')}</h2>
        <p className="mt-1 text-sm text-body">{t('jobBoard.assisted.review.documents.intro')}</p>
        {documents.some((document) => document.delivery === 'upload') && <p className="mt-1 text-xs text-subtle">{t('jobBoard.assisted.review.documents.formats', { mb: maxMb, max: limits.maxFiles })}</p>}
      </div>
      {documents.map((document) => {
        const inputId = `assisted-document-${document.id}`;
        const full = document.files.length >= limits.maxFiles;
        const selectedExemption = exemptionChoice[document.id] || '';
        const hasExemption = Boolean(document.exemption && document.exemptions.includes(document.exemption));
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
            {document.instructions && <p className="rounded-md border border-info-border bg-info-subtle/40 px-3 py-2 text-sm text-body">{document.instructions}</p>}

            {document.delivery === 'offline' && (
              <p className="text-xs text-subtle">{t('jobBoard.assisted.review.documents.offlineNote')}</p>
            )}
            {document.delivery === 'service' && !hasExemption && (
              <p className="inline-flex items-center gap-2 text-xs text-success" role="status"><CheckCircle2 className="h-4 w-4" aria-hidden="true" />{t('jobBoard.assisted.review.documents.servicePreparedNote')}</p>
            )}

            {hasExemption ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-success-border bg-success-subtle/40 p-2 text-sm text-body" role="status">
                <span className="inline-flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />{t('jobBoard.assisted.review.documents.exemptionSaved', { reason: t(`jobBoard.assisted.review.documents.exemptions.${document.exemption}`) })}</span>
                <button type="button" disabled={disabled} onClick={() => { void onSetExemption(document, ''); }} className="inline-flex min-h-[40px] items-center rounded px-2 text-xs font-semibold text-subtle hover:text-heading disabled:opacity-60">{t('jobBoard.assisted.review.documents.exemptionRemove')}</button>
              </div>
            ) : document.exemptions.length > 0 ? (
              <div className="flex flex-col gap-2 rounded-md border border-edge p-3 sm:flex-row sm:items-end">
                <label className="block min-w-0 flex-1 text-xs font-medium text-body">
                  {t('jobBoard.assisted.review.documents.exemptionLabel')}
                  <select value={selectedExemption} onChange={(event) => setExemptionChoice((current) => ({ ...current, [document.id]: event.target.value }))} disabled={disabled} className="mt-1 block min-h-[40px] w-full rounded-lg border border-edge bg-surface px-2.5 py-2 text-sm text-heading">
                    <option value="">{t('jobBoard.assisted.review.documents.exemptionChoose')}</option>
                    {document.exemptions.map((reason) => <option key={reason} value={reason}>{t(`jobBoard.assisted.review.documents.exemptions.${reason}`)}</option>)}
                  </select>
                </label>
                <button type="button" disabled={disabled || !selectedExemption} onClick={() => { void onSetExemption(document, selectedExemption); }} className="inline-flex min-h-[40px] items-center justify-center rounded-lg border border-edge px-3 text-xs font-semibold text-subtle hover:border-accent hover:text-link disabled:opacity-60">{t('jobBoard.assisted.review.documents.exemptionConfirm')}</button>
              </div>
            ) : null}

            {document.delivery === 'upload' && document.files.length > 0 && (
              <ul className="space-y-2">
                {document.files.map((file) => {
                  const ok = file.clientCheck.verdict === 'match';
                  const legacy = !ok && (file.clientCheck.version || 1) < DOCUMENT_CHECK_VERSION;
                  const uncertain = file.clientCheck.verdict === 'unknown';
                  return (
                    <li key={file.id} className="rounded-md border border-edge p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex min-w-0 items-center gap-2 text-sm text-body">
                          <FileText className="h-4 w-4 shrink-0 text-subtle" aria-hidden="true" />
                          <span className="truncate">{file.name}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                        {file.url && <a href={file.url} target="_blank" rel="noreferrer" className="inline-flex min-h-[40px] items-center gap-1 rounded px-2 text-xs font-semibold text-link hover:bg-accent-subtle" aria-label={t('jobBoard.assisted.review.documents.download', { name: file.name })}><ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />{t('jobBoard.assisted.review.documents.downloadShort')}</a>}
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => { void onRemove(document, file.id); }}
                          className="inline-flex min-h-[44px] items-center gap-1 rounded-lg px-2 text-xs font-semibold text-subtle hover:text-heading disabled:opacity-60"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                          {t('jobBoard.assisted.review.documents.remove')}
                        </button>
                        </span>
                      </div>
                      <p className={`mt-1 flex items-start gap-1.5 text-xs ${ok ? 'text-success' : legacy || uncertain ? 'text-subtle' : 'text-warning'}`} role="status">
                        {ok
                          ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          : legacy || uncertain ? <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                        <span>{legacy ? t('jobBoard.assisted.review.documents.check.legacy') : checkMessage(document, file.clientCheck.verdict)}</span>
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}

            {document.delivery === 'upload' && !hasExemption && !full && (
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
            {document.delivery === 'offline' && !hasExemption && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-edge p-2">
                <span className={`inline-flex items-center gap-2 text-sm ${document.preparedAt ? 'text-success' : 'text-subtle'}`} role="status">
                  {document.preparedAt ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : <FileText className="h-4 w-4" aria-hidden="true" />}
                  {document.preparedAt ? t('jobBoard.assisted.review.documents.prepared') : t('jobBoard.assisted.review.documents.notPrepared')}
                </span>
                <button type="button" disabled={disabled} onClick={() => { void onSetPrepared(document, !document.preparedAt); }} className="inline-flex min-h-[40px] items-center gap-1 rounded-lg border border-edge px-3 text-xs font-semibold text-subtle hover:border-accent hover:text-link disabled:opacity-60">
                  {document.preparedAt ? t('jobBoard.assisted.review.documents.undoPrepared') : t('jobBoard.assisted.review.documents.markPrepared')}
                </button>
              </div>
            )}
            {localError[document.id] && <p className="text-xs text-danger" role="alert">{localError[document.id]}</p>}

            {document.required && !hasExemption && !(document.delivery === 'service' || (document.delivery === 'offline' ? document.preparedAt : document.files.length > 0)) && (
              <p className="text-xs text-subtle">{t('jobBoard.assisted.review.documents.requiredNote', { label: document.label })}</p>
            )}
          </div>
        );
      })}
    </section>
  );
}
