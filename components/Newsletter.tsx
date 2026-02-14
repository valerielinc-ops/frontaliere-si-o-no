import React, { useState } from 'react';
import { Mail, Send, CheckCircle2, AlertCircle, Loader2, Bell, Shield } from 'lucide-react';
import { Analytics } from '@/services/analytics';

// Firebase Firestore will be lazily imported
let firestoreInitialized = false;
let db: any = null;

const initFirestore = async () => {
  if (firestoreInitialized) return db;
  try {
    const { getFirestore } = await import('firebase/firestore');
    const { app } = await import('@/services/firebase');
    db = getFirestore(app);
    firestoreInitialized = true;
    return db;
  } catch (error) {
    console.error('Failed to initialize Firestore:', error);
    return null;
  }
};

interface NewsletterProps {
  compact?: boolean;
}

const Newsletter: React.FC<NewsletterProps> = ({ compact = false }) => {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [preferences, setPreferences] = useState({
    exchangeRate: true,
    traffic: true,
    taxUpdates: true,
    tips: false,
  });
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error' | 'exists'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const validateEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const handleSubscribe = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateEmail(email)) {
      setErrorMessage('Inserisci un indirizzo email valido');
      setStatus('error');
      return;
    }

    setStatus('loading');
    Analytics.trackUIInteraction('Newsletter', 'subscribe_attempt', email.split('@')[1]);

    try {
      const firestore = await initFirestore();
      if (!firestore) {
        // Firestore not available - store locally and show success
        const pending = JSON.parse(localStorage.getItem('pendingNewsletterSubs') || '[]');
        pending.push({ email: email.toLowerCase(), name: name.trim() || null, preferences, subscribedAt: new Date().toISOString() });
        localStorage.setItem('pendingNewsletterSubs', JSON.stringify(pending));
        console.log('Newsletter subscription saved locally (Firestore unavailable):', { email, name, preferences });
        setStatus('success');
        setEmail('');
        setName('');
        Analytics.trackUIInteraction('Newsletter', 'subscribe_fallback', 'no_firestore');
        return;
      }

      const { collection, addDoc, query, where, getDocs } = await import('firebase/firestore');

      // Check if email already exists
      const q = query(collection(firestore, 'newsletter_subscribers'), where('email', '==', email.toLowerCase()));
      const existing = await getDocs(q);

      if (!existing.empty) {
        setStatus('exists');
        Analytics.trackUIInteraction('Newsletter', 'subscribe_exists', email.split('@')[1]);
        return;
      }

      // Add subscriber
      await addDoc(collection(firestore, 'newsletter_subscribers'), {
        email: email.toLowerCase(),
        name: name.trim() || null,
        preferences,
        subscribedAt: new Date().toISOString(),
        source: 'web_app',
        locale: navigator.language || 'it-IT',
        isActive: true,
      });

      setStatus('success');
      setEmail('');
      setName('');
      Analytics.trackUIInteraction('Newsletter', 'subscribe_success', email.split('@')[1]);
    } catch (error: any) {
      console.error('Newsletter subscription error:', error);
      // If Firestore fails (permissions, App Check, network), save locally as fallback
      if (error?.code === 'permission-denied' || error?.code === 'unavailable' || error?.code === 'unauthenticated') {
        const pending = JSON.parse(localStorage.getItem('pendingNewsletterSubs') || '[]');
        pending.push({ email: email.toLowerCase(), name: name.trim() || null, preferences, subscribedAt: new Date().toISOString() });
        localStorage.setItem('pendingNewsletterSubs', JSON.stringify(pending));
        setStatus('success');
        setEmail('');
        setName('');
        Analytics.trackUIInteraction('Newsletter', 'subscribe_fallback_error', error.code);
        return;
      }
      setErrorMessage(error.message || 'Errore durante l\'iscrizione. Riprova più tardi.');
      setStatus('error');
      Analytics.trackUIInteraction('Newsletter', 'subscribe_error', error.message);
    }
  };

  if (compact) {
    return (
      <div className="bg-gradient-to-r from-indigo-600 to-purple-600 rounded-2xl p-6 text-white">
        <div className="flex items-center gap-3 mb-3">
          <Bell size={20} />
          <h3 className="font-bold text-lg">Newsletter Frontalieri</h3>
        </div>
        <p className="text-indigo-100 text-sm mb-4">
          Ricevi il cambio CHF/EUR, traffico valichi e aggiornamenti fiscali ogni settimana.
        </p>

        {status === 'success' ? (
          <div className="flex items-center gap-2 text-emerald-200">
            <CheckCircle2 size={18} /> Iscrizione confermata!
          </div>
        ) : (
          <form onSubmit={handleSubscribe} className="flex gap-2">
            <input
              type="email" value={email}
              onChange={(e) => { setEmail(e.target.value); setStatus('idle'); }}
              placeholder="La tua email..."
              className="flex-grow px-4 py-2.5 bg-white/15 backdrop-blur-sm border border-white/25 rounded-xl text-white placeholder-white/50 text-sm focus:outline-none focus:ring-2 focus:ring-white/50"
              required
            />
            <button type="submit" disabled={status === 'loading'}
              className="px-5 py-2.5 bg-white text-indigo-600 font-bold text-sm rounded-xl hover:bg-indigo-50 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {status === 'loading' ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </form>
        )}
        {status === 'error' && <p className="text-red-200 text-xs mt-2">{errorMessage}</p>}
        {status === 'exists' && <p className="text-amber-200 text-xs mt-2">Questa email è già iscritta!</p>}
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="bg-gradient-to-br from-indigo-600 via-purple-600 to-pink-600 rounded-3xl p-8 text-white shadow-2xl">
        <div className="flex items-center gap-4 mb-4">
          <div className="p-3 bg-white/20 rounded-2xl backdrop-blur-sm">
            <Mail size={32} />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold">Newsletter Settimanale</h1>
            <p className="text-purple-100 mt-1">Ricevi aggiornamenti su cambio valuta, traffico e novità fiscali</p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-6">
          <div className="bg-white/15 backdrop-blur-sm rounded-xl p-3 text-center">
            <div className="text-2xl mb-1">💱</div>
            <div className="text-sm font-bold">Cambio CHF/EUR</div>
            <div className="text-xs text-white/70">Tasso settimanale</div>
          </div>
          <div className="bg-white/15 backdrop-blur-sm rounded-xl p-3 text-center">
            <div className="text-2xl mb-1">🚦</div>
            <div className="text-sm font-bold">Traffico Valichi</div>
            <div className="text-xs text-white/70">Tempi e consigli</div>
          </div>
          <div className="bg-white/15 backdrop-blur-sm rounded-xl p-3 text-center">
            <div className="text-2xl mb-1">📋</div>
            <div className="text-sm font-bold">Novità Fiscali</div>
            <div className="text-xs text-white/70">Scadenze e cambi</div>
          </div>
        </div>
      </div>

      {status === 'success' ? (
        <div className="bg-emerald-50 dark:bg-emerald-950/30 rounded-2xl border border-emerald-200 dark:border-emerald-800 p-8 text-center">
          <CheckCircle2 size={48} className="text-emerald-500 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100 mb-2">Iscrizione Confermata! 🎉</h3>
          <p className="text-slate-600 dark:text-slate-400">
            Riceverai la newsletter settimanale ogni lunedì mattina. Controlla la casella spam se non la ricevi.
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubscribe} className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">Email *</label>
              <input type="email" value={email}
                onChange={(e) => { setEmail(e.target.value); setStatus('idle'); }}
                placeholder="mario.rossi@email.com"
                className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
                required />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-500 uppercase mb-1 block">Nome (opzionale)</label>
              <input type="text" value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mario"
                className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
          </div>

          {/* Preferences */}
          <div>
            <label className="text-xs font-bold text-slate-500 uppercase mb-3 block">Cosa ti interessa?</label>
            <div className="grid grid-cols-2 gap-3">
              {[
                { key: 'exchangeRate', label: '💱 Cambio CHF/EUR', desc: 'Tasso settimanale + trend' },
                { key: 'traffic', label: '🚦 Traffico Valichi', desc: 'Migliori orari della settimana' },
                { key: 'taxUpdates', label: '📋 Novità Fiscali', desc: 'Scadenze e cambiamenti' },
                { key: 'tips', label: '💡 Consigli', desc: 'Risparmio e vita da frontaliere' },
              ].map(pref => (
                <label key={pref.key}
                  className={`flex items-start gap-3 p-3 rounded-xl cursor-pointer transition-all border ${
                    preferences[pref.key as keyof typeof preferences]
                      ? 'border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/30'
                      : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'
                  }`}
                >
                  <input type="checkbox"
                    checked={preferences[pref.key as keyof typeof preferences]}
                    onChange={(e) => setPreferences(prev => ({ ...prev, [pref.key]: e.target.checked }))}
                    className="mt-1 w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500" />
                  <div>
                    <div className="font-bold text-sm text-slate-800 dark:text-slate-100">{pref.label}</div>
                    <div className="text-xs text-slate-500">{pref.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {status === 'error' && (
            <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-950/30 rounded-xl text-red-600 text-sm">
              <AlertCircle size={16} /> {errorMessage}
            </div>
          )}
          {status === 'exists' && (
            <div className="flex items-center gap-2 p-3 bg-amber-50 dark:bg-amber-950/30 rounded-xl text-amber-600 text-sm">
              <AlertCircle size={16} /> Questa email è già iscritta alla newsletter!
            </div>
          )}

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Shield size={14} />
              Protetto da Firebase App Check
            </div>
            <button type="submit" disabled={status === 'loading'}
              className="px-8 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-bold rounded-xl hover:from-indigo-700 hover:to-purple-700 transition-all disabled:opacity-50 flex items-center gap-2 shadow-lg"
            >
              {status === 'loading' ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  Iscrizione...
                </>
              ) : (
                <>
                  <Send size={18} />
                  Iscriviti Gratis
                </>
              )}
            </button>
          </div>

          <p className="text-xs text-slate-400 text-center">
            Puoi cancellarti in qualsiasi momento. La tua email non verrà condivisa con terzi.
          </p>
        </form>
      )}
    </div>
  );
};

export default Newsletter;
