/**
 * SocialProofBadge — Shows total simulation count from Firestore
 * Displays as a subtle badge:"👥 12,300+ simulazioni effettuate"
 */

import React, { useState, useEffect } from 'react';
import { Users } from 'lucide-react';
import { useTranslation } from '@/services/i18n';

let cachedCount: number | null = null;

interface SocialProofBadgeProps {
 fullWidth?: boolean;
}

const SocialProofBadge: React.FC<SocialProofBadgeProps> = ({ fullWidth = false }) => {
 const { t } = useTranslation();
 const [count, setCount] = useState<number | null>(cachedCount);

 useEffect(() => {
 if (cachedCount !== null) return;

 const fetchCount = async () => {
 try {
 const { getFirestore, doc, getDoc } = await import('firebase/firestore');
 const { getApp } = await import('@/services/firebase');
 const db = getFirestore(await getApp());
 const snap = await getDoc(doc(db, 'counters', 'simulations'));
 if (snap.exists()) {
 const total = snap.data()?.total || 0;
 cachedCount = total;
 setCount(total);
 }
 } catch {
 // Silently fail — badge just won't show
 }
 };
 fetchCount();
 }, []);

 if (!count || count < 100) return null;

 // Round down to nearest hundred for social proof
 const displayed = Math.floor(count / 100) * 100;

 return (
 <div
 className={`inline-flex items-center gap-2 h-[34px] px-3 rounded-xl bg-emerald-50/80 dark:bg-emerald-900/20 border border-success-border text-xs font-semibold text-success ${
 fullWidth ? 'w-full justify-center' : 'whitespace-nowrap'
 }`}
 >
 <Users size={13} className="flex-shrink-0" />
 <span className="truncate">{displayed.toLocaleString('it-IT')}+ {t('socialProof.simulations')}</span>
 </div>
 );
};

export default SocialProofBadge;
