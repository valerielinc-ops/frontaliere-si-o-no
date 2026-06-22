/**
 * PublisherApplyForm — in-house candidate application for publisher ads whose
 * apply mode is 'in_house' or 'forward_email'.
 *
 * Writes an `applications` doc (firestore.rules requires consentGiven == true);
 * a Cloud Function (forwardPublisherApplication) emails the data to the
 * publisher's address server-side. The candidate's PII is forwarded to a third
 * party (the employer) ONLY under the explicit, logged consent captured here —
 * this is a transactional consent on a form the user actively submits, distinct
 * from the site's silent analytics/ads consent (no cookie banner involved).
 */

import React, { useEffect, useState } from 'react';
import { Send, CheckCircle, AlertTriangle, FileText } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { recaptchaService } from '@/services/recaptchaService';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import { Analytics } from '@/services/analytics';
import { reportCaughtError } from '@/services/errorReporter';
import { getFirestore, collection, addDoc, serverTimestamp, query, where, limit, getDocs } from 'firebase/firestore';
import { getApp } from '@/services/firebase';
import { useAuth, getAuthEmail, getUserDisplayName } from '@/services/authService';
import { trackPublisherApplyClick } from '@/services/publisherAnalyticsService';

interface PublisherApplyFormProps {
  jobId: string;
  publisherUid: string;
  jobTitle: string;
  /** Job-board slug of the target ad, denormalised onto the application so the
   *  candidate's profile can deep-link back to the offer without loading the
   *  full jobs dataset (and even after the ad later expires). */
  jobSlug?: string;
}

const inputClass =
  'w-full px-4 py-2.5 rounded-xl border border-edge bg-surface-alt text-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-transparent outline-none transition-[color,background-color,border-color,box-shadow]';
const labelClass = 'block text-sm font-medium text-body mb-1.5';

const PublisherApplyForm: React.FC<PublisherApplyFormProps> = ({ jobId, publisherUid, jobTitle, jobSlug }) => {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [cvUrl, setCvUrl] = useState('');
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  // CV file upload (optional, either-or with the manual URL field above).
  const [cvUploading, setCvUploading] = useState(false);
  const [cvUploadError, setCvUploadError] = useState(false);
  // Storage object path of an uploaded CV (e.g. `cv-uploads/<jobId>/…`). Kept
  // separate from the pasted-link `cvUrl` field: at submit we prefer the upload.
  // The forward Cloud Function signs this path into a time-limited read URL —
  // the client never reads the object (storage.rules denies client reads), so
  // getDownloadURL() would 403 here; we store the path and let the server sign.
  const [cvPath, setCvPath] = useState('');
  const [cvFileName, setCvFileName] = useState('');
  // Whether the signed-in user has already applied to this job. A prior
  // `applications` doc (denormalised candidateUid + jobId) means we suppress the
  // form and show a "you already applied" notice instead of letting them
  // re-submit. 'checking' avoids flashing the form before the lookup resolves;
  // logged-out users stay 'none' (no uid to match → form always shown).
  const [alreadyApplied, setAlreadyApplied] = useState<'checking' | 'applied' | 'none'>('none');

  // Look up an existing application for (this user, this job). firestore.rules
  // allow a candidate to read their own applications (candidateUid == uid); the
  // two equality filters are served by single-field indexes (zigzag merge), so
  // no composite index is needed. Best-effort: any failure leaves the form open.
  useEffect(() => {
    const uid = user?.uid;
    if (!uid || !jobId) { setAlreadyApplied('none'); return; }
    let cancelled = false;
    setAlreadyApplied('checking');
    (async () => {
      try {
        const db = getFirestore(await getApp());
        const snap = await getDocs(
          query(
            collection(db, 'applications'),
            where('candidateUid', '==', uid),
            where('jobId', '==', jobId),
            limit(1),
          ),
        );
        if (!cancelled) setAlreadyApplied(snap.empty ? 'none' : 'applied');
      } catch {
        if (!cancelled) setAlreadyApplied('none');
      }
    })();
    return () => { cancelled = true; };
  }, [user, jobId]);

  // Prefill name/email for a logged-in user (no clobber once they start typing).
  // Email is always reliable; name only from a real display name (never the
  // email-prefix fallback getUserDisplayName() returns for nameless accounts).
  useEffect(() => {
    if (!user) return;
    const authEmail = getAuthEmail(user);
    if (authEmail) setEmail((prev) => prev || authEmail);
    const display = getUserDisplayName(user);
    const emailLocalPart = authEmail ? authEmail.split('@')[0] : '';
    if (display && display !== 'Utente' && display !== emailLocalPart) {
      setName((prev) => prev || display);
    }
  }, [user]);

  // Validate type/size, upload to Firebase Storage, then set cvUrl to the
  // download URL so the existing applications-doc write carries it through.
  const handleCvFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const okType =
      file.type === 'application/pdf' ||
      /\.(pdf|docx?)$/i.test(file.name) ||
      /^application\/(pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/.test(file.type);
    const okSize = file.size < 5 * 1024 * 1024; // align with storage.rules (rejects exactly 5 MB)
    if (!okType || !okSize) {
      setCvUploadError(true);
      return;
    }
    setCvUploadError(false);
    setCvUploading(true);
    try {
      const { getStorage, ref, uploadBytes } = await import('firebase/storage');
      const storage = getStorage(await getApp());
      const safeName = file.name.replace(/[^\w.\-]+/g, '_').slice(-100);
      const path = `cv-uploads/${jobId}/${Date.now()}-${safeName}`;
      // Reliable content-type: fall back to the extension when the browser
      // reports none, so the upload still satisfies the storage.rules
      // `application/.*|text/.*` content-type guard.
      const contentType =
        file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : 'application/octet-stream');
      const snap = await uploadBytes(ref(storage, path), file, { contentType });
      // Store the object path, NOT a download URL: storage.rules denies client
      // reads, so getDownloadURL() would 403 (the old bug that failed every
      // upload). The forward Cloud Function signs this path server-side.
      setCvPath(snap.ref.fullPath);
      setCvFileName(file.name);
      // Keep any pasted link intact: `cvPath || cvUrl.trim()` at submit already
      // prefers the upload, and "Rimuovi" should restore the text field as typed.
    } catch (error) {
      setCvUploadError(true);
      reportCaughtError(error, 'publisherApply.cvUpload');
    } finally {
      setCvUploading(false);
    }
  };

  const clearUploadedCv = () => {
    setCvPath('');
    setCvFileName('');
  };

  const valid =
    name.trim() && validateEmailStrict(email).valid && consent && jobId && publisherUid;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || status === 'sending') return;
    setStatus('sending');
    try {
      const token = await recaptchaService.getTokenForApi('PUBLISHER_APPLY');
      if (!token) throw new Error('recaptcha_token_missing');
      const verification = await recaptchaService.verifyToken(token, 'PUBLISHER_APPLY');
      if (!verification.passed) throw new Error('recaptcha_blocked');

      const consentText = t('publisherApply.consent');
      const db = getFirestore(await getApp());
      await addDoc(collection(db, 'applications'), {
        jobId,
        publisherUid,
        // Denormalised so the candidate's profile can list the offer (title +
        // deep-link) without resolving the live jobs dataset, and survives the
        // ad later expiring. Optional — anonymous (logged-out) applicants write
        // candidateUid: null; firestore.rules forbids spoofing another's uid.
        candidateUid: user?.uid || null,
        jobTitle: jobTitle || null,
        jobSlug: jobSlug || null,
        candidateName: name.trim(),
        candidateEmail: email.trim(),
        message: message.trim() || null,
        // Prefer an uploaded file (a Storage object path the CF will sign) over a
        // pasted public link; either is fine, both optional.
        cvUrl: cvPath || cvUrl.trim() || null,
        consentGiven: true,
        consentText,
        createdAt: serverTimestamp(),
      });
      Analytics.trackUIInteraction('publisher', 'apply', 'submit', 'success');
      // A submitted application is the strongest apply signal — count it as an
      // apply click so the publisher's conversion rate reflects direct-scroll
      // applicants too (session-debounced: no double-count with the page CTAs).
      void trackPublisherApplyClick(jobId);
      setStatus('success');
    } catch (error) {
      setStatus('error');
      Analytics.trackUIInteraction('publisher', 'apply', 'submit', 'error');
      reportCaughtError(error, 'publisherApply.submit');
    }
  };

  if (status === 'success') {
    return (
      <div className="flex items-start gap-2 p-4 rounded-xl bg-success-subtle border border-success-border">
        <CheckCircle className="w-5 h-5 text-success flex-shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold text-strong">{t('publisherApply.successTitle')}</p>
          <p className="text-sm text-subtle">{t('publisherApply.successMessage')}</p>
        </div>
      </div>
    );
  }

  // The signed-in user already applied to this job: suppress the form and show a
  // notice instead so they don't submit a duplicate.
  if (alreadyApplied === 'applied') {
    return (
      <div className="flex items-start gap-2 p-4 rounded-xl bg-success-subtle border border-success-border">
        <CheckCircle className="w-5 h-5 text-success flex-shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold text-strong">{t('publisherApply.alreadyTitle')}</p>
          <p className="text-sm text-subtle">{t('publisherApply.alreadyMessage')}</p>
        </div>
      </div>
    );
  }

  // While the lookup is in flight, reserve the form's footprint so we never
  // flash the full form and then collapse it to the notice ([contain:layout]
  // + matching min-height keep CLS at zero).
  if (alreadyApplied === 'checking') {
    return <div className="mt-4 min-h-[420px] [contain:layout]" aria-hidden="true" />;
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-4 rounded-2xl border border-edge bg-surface-alt p-4 sm:p-5 min-h-[420px] [contain:layout]">
      <h3 className="text-base font-semibold font-display text-strong">{t('publisherApply.title')}</h3>
      <div>
        <label htmlFor="apply-name" className={labelClass}>{t('publisherApply.name')} *</label>
        <input id="apply-name" type="text" required value={name} onChange={e => setName(e.target.value)} autoComplete="name" className={inputClass} />
      </div>
      <div>
        <label htmlFor="apply-email" className={labelClass}>{t('publisherApply.email')} *</label>
        <EmailInput id="apply-email" value={email} onChange={setEmail} autoComplete="email" className={inputClass} />
      </div>
      <div>
        <label htmlFor="apply-cv" className={labelClass}>{t('publisherApply.cv')}</label>
        <input id="apply-cv" type="url" value={cvUrl} onChange={e => setCvUrl(e.target.value)} placeholder={t('publisherApply.cvPlaceholder')} className={inputClass} />
        <div className="mt-2">
          {cvFileName ? (
            <div className="inline-flex items-center gap-2 rounded-xl border border-edge bg-surface px-3 py-1.5 text-sm text-strong">
              <FileText className="w-4 h-4 text-link flex-shrink-0" />
              <span className="truncate max-w-[200px]">{cvFileName}</span>
              <button
                type="button"
                onClick={clearUploadedCv}
                className="text-xs text-subtle hover:text-danger underline underline-offset-2"
              >
                {t('publisherApply.cvRemove')}
              </button>
            </div>
          ) : (
            <label htmlFor="apply-cv-file" className="inline-flex items-center gap-2 text-sm text-link cursor-pointer">
              <input
                id="apply-cv-file"
                type="file"
                accept=".pdf,.doc,.docx,application/pdf"
                onChange={e => { void handleCvFile(e); }}
                disabled={cvUploading}
                className="block text-sm text-body file:mr-3 file:rounded-xl file:border file:border-edge file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-link hover:file:bg-surface-alt file:cursor-pointer disabled:opacity-60"
              />
              {cvUploading && (
                <span className="inline-flex items-center gap-1.5 text-xs text-subtle" role="status" aria-live="polite">
                  <span className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-edge border-t-accent" />
                  {t('publisherApply.cvUploading')}
                </span>
              )}
            </label>
          )}
          <p className="mt-1 text-xs text-muted">{t('publisherApply.cvUpload')}</p>
          {cvUploadError && (
            <p className="mt-1 text-xs text-danger">{t('publisherApply.cvError')}</p>
          )}
        </div>
      </div>
      <div>
        <label htmlFor="apply-message" className={labelClass}>{t('publisherApply.message')}</label>
        <textarea id="apply-message" rows={4} value={message} onChange={e => setMessage(e.target.value)} className={`${inputClass} resize-y min-h-[100px]`} />
      </div>
      <label className="flex items-start gap-2 text-sm text-body cursor-pointer">
        <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} className="mt-1 flex-shrink-0" />
        <span>{t('publisherApply.consent')}</span>
      </label>
      {status === 'error' && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-danger-subtle border border-danger-border">
          <AlertTriangle className="w-4 h-4 text-danger flex-shrink-0" />
          <p className="text-sm text-danger">{t('publisherApply.error')}</p>
        </div>
      )}
      <button
        type="submit"
        disabled={!valid || status === 'sending'}
        className="w-full flex items-center justify-center gap-2 px-6 py-3 text-sm font-semibold text-on-accent bg-accent hover:bg-accent-hover disabled:bg-surface-muted disabled:cursor-not-allowed rounded-xl transition-colors"
      >
        {status === 'sending' ? (
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
        ) : (
          <Send className="w-4 h-4" />
        )}
        {t('publisherApply.submit')}
      </button>
    </form>
  );
};

export default PublisherApplyForm;
