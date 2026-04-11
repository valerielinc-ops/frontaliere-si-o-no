/**
 * ContactPage — Contact form with reCAPTCHA protection
 * Saves submissions to Firestore collection 'contact_submissions'
 */

import React, { useState, useEffect } from 'react';
import { Mail, Send, CheckCircle, AlertTriangle, ArrowLeft, Shield } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { recaptchaService } from '@/services/recaptchaService';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import { Analytics } from '@/services/analytics';
import { reportCaughtError } from '@/services/errorReporter';
import {
  getFirestore,
  collection,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { getApp } from '@/services/firebase';

interface ContactFormData {
  name: string;
  email: string;
  topic: string;
  message: string;
}

export interface ContactPrefill {
  topic?: string;
  message?: string;
}

interface ContactPageProps {
  prefill?: ContactPrefill | null;
  onPrefillConsumed?: () => void;
}

const TOPICS = [
  'contact.topic.taxes',
  'contact.topic.pension',
  'contact.topic.simulator',
  'contact.topic.suggestion',
  'contact.topic.bug',
  'contact.topic.jobPost',
  'contact.topic.other',
] as const;

const ContactPage: React.FC<ContactPageProps> = ({ prefill, onPrefillConsumed }) => {
  const { t } = useTranslation();
  const [form, setForm] = useState<ContactFormData>({
    name: '',
    email: '',
    topic: prefill?.topic || '',
    message: prefill?.message || '',
  });
  const [status, setStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  // Apply prefill when navigating from another page
  useEffect(() => {
    Analytics.trackPageView('/contatti', 'Contact Page');
    Analytics.trackUIInteraction('contact', 'page', 'contact_page', 'view');
  }, []);

  useEffect(() => {
    if (prefill) {
      setForm(prev => ({
        ...prev,
        topic: prefill.topic || prev.topic,
        message: prefill.message || prev.message,
      }));
      onPrefillConsumed?.();
    }
  }, [prefill]);

  const isValid = form.name.trim() && form.email.trim() && validateEmailStrict(form.email).valid && form.topic && form.message.trim().length >= 10;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid || status === 'sending') return;

    setStatus('sending');
    setErrorMessage('');

    try {
      Analytics.trackUIInteraction('contact', 'form', 'submit', 'start');
      // Verify with reCAPTCHA
      const token = await recaptchaService.getTokenForApi('CONTACT_FORM');
      
      // Save to Firestore as backup record
      const firebaseApp = await getApp();
      const db = getFirestore(firebaseApp);
      await addDoc(collection(db, 'contact_submissions'), {
        name: form.name.trim(),
        email: form.email.trim(),
        topic: form.topic,
        message: form.message.trim(),
        recaptchaToken: token,
        recipientEmail: 'valerielinc@gmail.com',
        createdAt: serverTimestamp(),
        status: 'new',
        locale: document.documentElement.lang || 'it',
      });

      // Open mailto: to actually send the email
      const topicLabel = t(form.topic) || form.topic;
      const subject = encodeURIComponent(`[Frontaliere Ticino] ${topicLabel}`);
      const body = encodeURIComponent(
        `Nome: ${form.name.trim()}\nEmail: ${form.email.trim()}\nArgomento: ${topicLabel}\n\n${form.message.trim()}`
      );
      window.open(`mailto:valerielinc@gmail.com?subject=${subject}&body=${body}`, '_self');

      setStatus('success');
      Analytics.trackUIInteraction('contact', 'form', 'submit', 'success');
      setForm({ name: '', email: '', topic: '', message: '' });
    } catch (error) {
      console.error('Error submitting contact form:', error);
      setStatus('error');
      setErrorMessage(t('contact.error'));
      Analytics.trackUIInteraction('contact', 'form', 'submit', 'error');
      reportCaughtError(error, 'contact.formSubmit');
    }
  };

  if (status === 'success') {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="text-center space-y-4">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30">
            <CheckCircle className="w-8 h-8 text-green-600 dark:text-green-400" />
          </div>
          <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100">
            {t('contact.successTitle')}
          </h2>
          <p className="text-subtle max-w-md mx-auto">
            {t('contact.successMessage')}
          </p>
          <button
            onClick={() => setStatus('idle')}
            className="mt-6 inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-stripe-600 hover:bg-stripe-700 rounded-xl transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('contact.sendAnother')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-stripe-100 dark:bg-stripe-900/30 mb-4">
          <Mail className="w-7 h-7 text-link" />
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-slate-800 dark:text-slate-100 mb-2">
          {t('contact.title')}
        </h1>
        <p className="text-subtle max-w-lg mx-auto">
          {t('contact.subtitle')}
        </p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Name */}
        <div>
          <label htmlFor="contact-name" className="block text-sm font-medium text-body mb-1.5">
            {t('contact.name')} *
          </label>
          <input
            id="contact-name"
            type="text"
            required
            value={form.name}
            onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
            autoComplete="name"
            className="w-full px-4 py-2.5 rounded-xl border border-edge bg-surface-alt text-slate-800 dark:text-slate-100 focus-visible:ring-2 focus-visible:ring-stripe-500 focus-visible:border-transparent outline-none transition-[color,background-color,border-color,box-shadow]"
            placeholder={t('contact.namePlaceholder')}
          />
        </div>

        {/* Email */}
        <div>
          <label htmlFor="contact-email" className="block text-sm font-medium text-body mb-1.5">
            {t('contact.email')} *
          </label>
          <EmailInput
            id="contact-email"
            value={form.email}
            onChange={val => setForm(prev => ({ ...prev, email: val }))}
            autoComplete="email"
            className="w-full px-4 py-2.5 rounded-xl border border-edge bg-surface-alt text-slate-800 dark:text-slate-100 focus-visible:ring-2 focus-visible:ring-stripe-500 focus-visible:border-transparent outline-none transition-[color,background-color,border-color,box-shadow]"
            placeholder={t('contact.emailPlaceholder')}
          />
        </div>

        {/* Topic dropdown */}
        <div>
          <label htmlFor="contact-topic" className="block text-sm font-medium text-body mb-1.5">
            {t('contact.topicLabel')} *
          </label>
          <select
            id="contact-topic"
            required
            value={form.topic}
            onChange={e => {
              const topic = e.target.value;
              setForm(prev => ({ ...prev, topic }));
              if (topic) Analytics.trackUIInteraction('contact', 'form', 'topic_select', topic);
            }}
            className="w-full px-4 py-2.5 rounded-xl border border-edge bg-surface-alt text-slate-800 dark:text-slate-100 focus-visible:ring-2 focus-visible:ring-stripe-500 focus-visible:border-transparent outline-none transition-[color,background-color,border-color,box-shadow]"
          >
            <option value="">{t('contact.topicPlaceholder')}</option>
            {TOPICS.map(topicKey => (
              <option key={topicKey} value={topicKey}>
                {t(topicKey)}
              </option>
            ))}
          </select>
        </div>

        {/* Message */}
        <div>
          <label htmlFor="contact-message" className="block text-sm font-medium text-body mb-1.5">
            {t('contact.messageLabel')} *
          </label>
          <textarea
            id="contact-message"
            required
            rows={5}
            minLength={10}
            value={form.message}
            onChange={e => setForm(prev => ({ ...prev, message: e.target.value }))}
            spellCheck={true}
            className="w-full px-4 py-2.5 rounded-xl border border-edge bg-surface-alt text-slate-800 dark:text-slate-100 focus-visible:ring-2 focus-visible:ring-stripe-500 focus-visible:border-transparent outline-none transition-[color,background-color,border-color,box-shadow] resize-y min-h-[120px]"
            placeholder={t('contact.messagePlaceholder')}
          />
          <p className="mt-1 text-xs text-muted">
            {t('contact.messageHint')}
          </p>
        </div>

        {/* Error message */}
        {status === 'error' && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
            <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0" />
            <p className="text-sm text-red-700 dark:text-red-300">
              {errorMessage || t('contact.error')}
            </p>
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={!isValid || status === 'sending'}
          className="w-full flex items-center justify-center gap-2 px-6 py-3 text-sm font-semibold text-white bg-stripe-600 hover:bg-stripe-700 disabled:bg-slate-400 disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm"
        >
          {status === 'sending' ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
              {t('contact.sending')}
            </>
          ) : (
            <>
              <Send className="w-4 h-4" />
              {t('contact.submit')}
            </>
          )}
        </button>

        {/* reCAPTCHA notice */}
        <p className="text-xs text-center text-muted">
          {t('contact.recaptchaNotice')}
        </p>
        <div className="flex items-center justify-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
          <Shield className="w-3 h-3" />
          <span>{t('contact.dataPrivacy')}</span>
        </div>
      </form>
    </div>
  );
};

export default ContactPage;
