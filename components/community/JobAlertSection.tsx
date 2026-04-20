import { Suspense, useEffect, useState } from 'react';
import { lazyRetry } from '@/services/lazyRetry';
import { useAuth } from '@/services/authService';

const JobAlertForm = lazyRetry(() => import('@/components/community/JobAlertForm'));

interface JobAlertSectionProps {
 initialKeyword?: string;
 onRequireAuth?: () => void;
}

export default function JobAlertSection({ initialKeyword = '', onRequireAuth }: JobAlertSectionProps) {
 const { user } = useAuth();
 const [enabled, setEnabled] = useState<boolean | null>(null);

 useEffect(() => {
 import('@/services/firebase')
 .then(({ getConfigValue }) => getConfigValue('ENABLE_JOB_ALERTS'))
 .then((v) => setEnabled(v === 'true'))
 .catch(() => setEnabled(false));
 }, []);

 if (!enabled) return null;

 const authUser = user ? { uid: user.uid, email: user.email } : null;

 return (
 <Suspense fallback={<div className="h-[100px] rounded-xl bg-surface-raised animate-pulse" />}>
 <JobAlertForm
 authUser={authUser}
 onRequireAuth={onRequireAuth}
 initialKeyword={initialKeyword}
 />
 </Suspense>
 );
}
