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

import React, { useState } from 'react';
import { Send, CheckCircle, AlertTriangle } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { recaptchaService } from '@/services/recaptchaService';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import { Analytics } from '@/services/analytics';
import { reportCaughtError } from '@/services/errorReporter';
import { getFirestore, collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { getApp } from '@/services/firebase';

interface PublisherApplyFormProps {
  jobId: string;
  publisherUid: string;
  jobTitle: string;
}

const inputClass =
  'w-full px-4 py-2.5 rounded-xl border border-edge bg-surface-alt text-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-transparent outline-none transition-[color,background-color,border-color,box-shadow]';
const labelClass = 'block text-sm font-medium text-body mb-1.5';

const PublisherApplyForm: React.FC<PublisherApplyFormProps> = ({ jobId, publisherUid, jobTitle }) => {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [cvUrl, setCvUrl] = useState('');
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  // CV file upload (optional, either-or with the manual URL field above).
  const [cvUploading, setCvUploading] = useState(false);
  const [cvUploadError, setCvUploadError] = useState(false);

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
      const { getStorage, ref, uploadBytes, getDownloadURL } = await import('firebase/storage');
      const storage = getStorage(await getApp());
      const safeName = file.name.replace(/[^\w.\-]+/g, '_').slice(-100);
      const path = `cv-uploads/${jobId}/${Date.now()}-${safeName}`;
      const snap = await uploadBytes(ref(storage, path), file, { contentType: file.type || 'application/octet-stream' });
      const url = await getDownloadURL(snap.ref);
      setCvUrl(url);
    } catch (error) {
      setCvUploadError(true);
      reportCaughtError(error, 'publisherApply.cvUpload');
    } finally {
      setCvUploading(false);
    }
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
        candidateName: name.trim(),
        candidateEmail: email.trim(),
        message: message.trim() || null,
        cvUrl: cvUrl.trim() || null,
        consentGiven: true,
        consentText,
        createdAt: serverTimestamp(),
      });
      Analytics.trackUIInteraction('publisher', 'apply', 'submit', 'success');
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
