/**
 * SocialProofBadge — Shows total simulation count from Firestore
 * Displays as a subtle badge:"👥 12,300+ simulazioni effettuate"
 */

import React, { useState, useEffect } from 'react';
import { Users } from 'lucide-react';
import { useTranslation } from '@/services/i18n';

const LS_KEY = 'simulations_count_cache';
const LS_TTL_MS = 60 * 60 * 1000; // 1 hour

function getLocalCount(): { total: number; timestamp: number } | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.total === 'number' && typeof parsed?.timestamp === 'number') return parsed;
  } catch { /* ignore */ }
  return null;
}

function setLocalCount(total: number): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ total, timestamp: Date.now() }));
  } catch { /* ignore */ }
}

let cachedCount: number | null = null;

interface SocialProofBadgeProps {
 fullWidth?: boolean;
}

const SocialProofBadge: React.FC<SocialProofBadgeProps> = ({ fullWidth = false }) => {
 const { t } = useTranslation();
 const [count, setCount] = useState<number | null>(cachedCount);

 useEffect(() => {
 if (cachedCount !== null) return;

 // 1. Fresh localStorage cache — skip Firestore on repeat page loads within TTL
 const local = getLocalCount();
 if (local && (Date.now() - local.timestamp) < LS_TTL_MS) {
 cachedCount = local.total;
 setCount(local.total);
 return;
 }

 const fetchCount = async () => {
 try {
 const { getFirestore, doc, getDoc } = await import('firebase/firestore');
 const { getApp } = await import('@/services/firebase');
 const db = getFirestore(await getApp());
 const snap = await getDoc(doc(db, 'counters', 'simulations'));
 if (snap.exists()) {
 const total = snap.data()?.total || 0;
 cachedCount = total;
 setLocalCount(total);
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
 className={`inline-flex items-center gap-2 h-[34px] px-3 rounded-xl bg-success-subtle border border-success-border text-xs font-semibold text-success ${
 fullWidth ? 'w-full justify-center' : 'whitespace-nowrap'
 }`}
 >
 <Users size={13} className="flex-shrink-0" />
 <span className="truncate">{displayed.toLocaleString('it-IT')}+ {t('socialProof.simulations')}</span>
 </div>
 );
};

export default SocialProofBadge;
