/**
 * useNewsletterState — Manages newsletter subscription state extracted from App.tsx
 *
 * Handles:
 * - Newsletter unsubscribe/resubscribe via URL parameters
 * - upsertNewsletterSubscriber (Firestore)
 * - State: unsubscribeMsg, newsletterActionEmail, newsletterActionType
 */
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from '@/services/i18n';
import { reportCaughtError } from '@/services/errorReporter';

export interface NewsletterState {
 unsubscribeMsg: string | null;
 newsletterActionEmail: string | null;
 newsletterActionType: 'unsubscribe' | 'resubscribe' | null;
 setUnsubscribeMsg: (msg: string | null) => void;
 upsertNewsletterSubscriber: (
 email: string,
 source: 'signup' | 'chatbot_google' | 'chatbot_facebook' | 'chatbot_email',
 displayName?: string | null,
 ) => Promise<boolean>;
}

export function useNewsletterState(): NewsletterState {
 const { t } = useTranslation();
 const [unsubscribeMsg, setUnsubscribeMsg] = useState<string | null>(null);
 const [newsletterActionEmail, setNewsletterActionEmail] = useState<string | null>(null);
 const [newsletterActionType, setNewsletterActionType] = useState<'unsubscribe' | 'resubscribe' | null>(null);

 const upsertNewsletterSubscriber = useCallback(async (
 email: string,
 source: 'signup' | 'chatbot_google' | 'chatbot_facebook' | 'chatbot_email',
 displayName?: string | null,
 ): Promise<boolean> => {
 try {
 const normalizedEmail = email.trim().toLowerCase();
 if (!normalizedEmail) return false;
 const { getFirestore, collection, addDoc, query, where, getDocs, updateDoc } = await import('firebase/firestore');
 const { app } = await import('@/services/firebase');
 const db = getFirestore(app);
 const q = query(collection(db, 'newsletter_subscribers'), where('email', '==', normalizedEmail));
 const existing = await getDocs(q);
 if (existing.empty) {
 await addDoc(collection(db, 'newsletter_subscribers'), {
 email: normalizedEmail,
 name: displayName || null,
 preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: false },
 subscribedAt: new Date().toISOString(),
 source,
 locale: navigator.language || 'it-IT',
 isActive: true,
 });
 } else {
 for (const d of existing.docs) {
 await updateDoc(d.ref, {
 isActive: true,
 reSubscribedAt: new Date().toISOString(),
 source,
 });
 }
 }
 localStorage.setItem('newsletter_subscribed', 'true');
 return true;
 } catch (e) {
 reportCaughtError(e, 'newsletter.upsert');
 return false;
 }
 }, []);

 // Handle newsletter unsubscribe/resubscribe/confirm via URL parameter
 useEffect(() => {
 const urlParams = new URLSearchParams(window.location.search);
 const action = urlParams.get('action');
 if (action !== 'unsubscribe' && action !== 'resubscribe' && action !== 'confirm_newsletter') return;
 const email = urlParams.get('email');
 if (!email) return;

 // FRO-24: Handle confirmation link
 if (action === 'confirm_newsletter') {
 const token = urlParams.get('token');
 if (!token) return;
 (async () => {
 try {
 const { confirmNewsletterSubscription, clearNewsletterPendingLocally, markNewsletterSubscribedLocally } =
 await import('@/services/newsletterSubscribers');
 const result = await confirmNewsletterSubscription(email, token);
 if (result.success) {
 clearNewsletterPendingLocally();
 markNewsletterSubscribedLocally();
 localStorage.setItem('newsletter_subscribed', 'true');
 setUnsubscribeMsg(
 result.alreadyConfirmed
 ? t('newsletter.alreadyConfirmed')
 : t('newsletter.confirmationSuccess'),
 );
 } else if (result.error === 'invalid_token') {
 setUnsubscribeMsg(t('newsletter.confirmationInvalidToken'));
 } else {
 setUnsubscribeMsg(t('newsletter.confirmationError'));
 }
 } catch {
 setUnsubscribeMsg(t('newsletter.confirmationError'));
 }
 window.history.replaceState({}, '', window.location.pathname);
 })();
 return;
 }

 setNewsletterActionEmail(email.toLowerCase());
 setNewsletterActionType(action);
 (async () => {
 try {
 const { getFirestore, collection, query, where, getDocs, updateDoc, addDoc } = await import('firebase/firestore');
 const { app } = await import('@/services/firebase');
 const db = getFirestore(app);
 const q = query(collection(db, 'newsletter_subscribers'), where('email', '==', email.toLowerCase()));
 const snap = await getDocs(q);
 if (action === 'unsubscribe') {
 if (!snap.empty) {
 for (const d of snap.docs) await updateDoc(d.ref, { isActive: false });
 }
 setUnsubscribeMsg(t('newsletter.unsubscribed'));
 localStorage.removeItem('newsletter_subscribed');
 } else {
 if (!snap.empty) {
 for (const d of snap.docs) await updateDoc(d.ref, { isActive: true, reSubscribedAt: new Date().toISOString() });
 } else {
 await addDoc(collection(db, 'newsletter_subscribers'), {
 email: email.toLowerCase(),
 name: null,
 preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: false },
 subscribedAt: new Date().toISOString(),
 source: 'resubscribe',
 locale: navigator.language || 'it-IT',
 isActive: true,
 });
 }
 localStorage.setItem('newsletter_subscribed', 'true');
 setUnsubscribeMsg('Iscrizione riattivata con successo. Riceverai di nuovo la newsletter.');
 }
 // Clean URL
 window.history.replaceState({}, '', window.location.pathname);
 } catch {
 setUnsubscribeMsg(action === 'unsubscribe'
 ? t('newsletter.unsubscribeError')
 : 'Errore durante la riattivazione. Riprova più tardi.');
 }
 })();
 }, []);

 return {
 unsubscribeMsg,
 newsletterActionEmail,
 newsletterActionType,
 setUnsubscribeMsg,
 upsertNewsletterSubscriber,
 };
}
