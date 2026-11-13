import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Edit3, FileDown, FileText, Loader2, Target, Trash2, Upload } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import { loadUserCvProfile, type UserCvProfileRecord } from '@/services/profileFirestore';
import {
  cvSkillsFromProfile,
  deleteCandidateProfileCv,
  loadCandidateJobSkills,
  saveCandidateJobSkills,
  setCandidateCvJobAlertPersonalization,
  uploadCandidateProfileCv,
} from '@/services/candidateJobProfile';
import { computeCvMatch, type CvMatchResult } from '../../services/cvmatch';

const SKILLS_STORAGE_PREFIX = 'frontaliere_job_affinity_skills';
const MAX_SKILLS_LENGTH = 1000;
const MAX_CV_FILE_BYTES = 5 * 1024 * 1024;
const ANONYMOUS_PROFILE_KEY = 'anonymous';

export interface JobCvFitMatcherProps {
  requirements?: string[];
  preferredSkills?: string[];
  userId?: string | null;
  locale?: Locale;
  onRequireAuth?: () => void;
  onDownloadBilingualCv?: () => void;
  className?: string;
}

function storageKey(userId?: string | null): string {
  return `${SKILLS_STORAGE_PREFIX}:${userId?.trim() ? encodeURIComponent(userId.trim()) : ANONYMOUS_PROFILE_KEY}`;
}

function loadCandidateSkills(userId?: string | null): string {
  try {
    return (localStorage.getItem(storageKey(userId)) || '').slice(0, MAX_SKILLS_LENGTH);
  } catch {
    return '';
  }
}

function saveCandidateSkillsLocally(userId: string | null | undefined, skills: string): void {
  try {
    const key = storageKey(userId);
    if (skills.trim()) localStorage.setItem(key, skills.slice(0, MAX_SKILLS_LENGTH));
    else localStorage.removeItem(key);
  } catch {
    // The current comparison still works when browser storage is unavailable.
  }
}

function skillEntries(value: string): string[] {
  return value.split(/[,;\n•·]+/)
    .map((skill) => skill.trim().replace(/^[-–—]+\s*/, ''))
    .filter(Boolean)
    .filter((skill, index, list) => list.findIndex((candidate) => candidate.toLocaleLowerCase() === skill.toLocaleLowerCase()) === index)
    .slice(0, 40);
}

function mergeSkills(...groups: string[][]): string[] {
  return groups.flat()
    .map((skill) => skill.trim())
    .filter(Boolean)
    .filter((skill, index, list) => list.findIndex((candidate) => candidate.toLocaleLowerCase() === skill.toLocaleLowerCase()) === index)
    .slice(0, 40);
}

function supportedCvFile(file: File): 'too-large' | 'unsupported' | null {
  if (file.size <= 0 || file.size > MAX_CV_FILE_BYTES) return 'too-large';
  return /\.(?:pdf|docx?)$/i.test(file.name) ? null : 'unsupported';
}

export const JobCvFitMatcher: React.FC<JobCvFitMatcherProps> = ({
  requirements = [],
  preferredSkills = [],
  userId,
  locale = 'it',
  onRequireAuth,
  onDownloadBilingualCv,
  className = '',
}) => {
  const { t } = useTranslation();
  const [candidateSkillsText, setCandidateSkillsText] = useState(() => loadCandidateSkills(userId));
  const manuallyEditedSkillsRef = useRef(false);
  const [skillsLoadedFor, setSkillsLoadedFor] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [cvProfile, setCvProfile] = useState<UserCvProfileRecord | null>(null);
  const [isUploadingCv, setIsUploadingCv] = useState(false);
  const [isRemovingCv, setIsRemovingCv] = useState(false);
  const [confirmRemoveCv, setConfirmRemoveCv] = useState(false);
  const [cvError, setCvError] = useState('');
  const [cvStatus, setCvStatus] = useState('');
  const [cvStatusTone, setCvStatusTone] = useState<'success' | 'warning'>('success');
  const [skillsSaveError, setSkillsSaveError] = useState(false);
  const [isSavingSkills, setIsSavingSkills] = useState(false);
  const [isSavingAlertPreference, setIsSavingAlertPreference] = useState(false);
  const [alertPreferenceError, setAlertPreferenceError] = useState(false);
  const [alertPreferenceSaved, setAlertPreferenceSaved] = useState(false);

  const candidateSkills = useMemo(() => skillEntries(candidateSkillsText), [candidateSkillsText]);
  const isLoadingProfileSkills = Boolean(userId && skillsLoadedFor !== userId);

  useEffect(() => {
    let cancelled = false;
    setCvProfile(null);
    setSkillsLoadedFor(null);
    setIsEditing(false);
    manuallyEditedSkillsRef.current = false;
    setCvError('');
    setCvStatus('');
    if (!userId) {
      setCandidateSkillsText(loadCandidateSkills(null));
      setSkillsLoadedFor(ANONYMOUS_PROFILE_KEY);
      return () => { cancelled = true; };
    }

    setCandidateSkillsText(loadCandidateSkills(userId));
    Promise.all([loadUserCvProfile(userId), loadCandidateJobSkills(userId)])
      .then(([profile, savedSkills]) => {
        if (cancelled) return;
        const initialSkills = savedSkills ?? (profile ? cvSkillsFromProfile(profile) : skillEntries(loadCandidateSkills(userId)));
        setCvProfile(profile?.userId === userId ? profile : null);
        if (!manuallyEditedSkillsRef.current) setCandidateSkillsText(initialSkills.join(', '));
        setSkillsLoadedFor(userId);
      })
      .catch(() => {
        if (cancelled) return;
        setSkillsLoadedFor(userId);
      });
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    saveCandidateSkillsLocally(userId, candidateSkillsText);
    const expectedProfile = userId?.trim() || ANONYMOUS_PROFILE_KEY;
    if (skillsLoadedFor !== expectedProfile || !userId) return;
    const timeout = window.setTimeout(() => {
      setIsSavingSkills(true);
      setSkillsSaveError(false);
      void saveCandidateJobSkills(userId, candidateSkills)
        .then(() => setIsSavingSkills(false))
        .catch(() => {
          setIsSavingSkills(false);
          setSkillsSaveError(true);
        });
    }, 650);
    return () => window.clearTimeout(timeout);
  }, [candidateSkills, candidateSkillsText, skillsLoadedFor, userId]);

  const matchResult: CvMatchResult = useMemo(() => computeCvMatch({
    candidateSkills,
    jobRequirements: requirements,
    preferredSkills,
    locale,
  }), [candidateSkills, locale, preferredSkills, requirements]);

  const score = matchResult.overall;
  const statusCopy: Record<CvMatchResult['status'], string> = {
    ready: '',
    'missing-profile': t('jobBoard.affinity.empty'),
    'no-job-skills': t('jobBoard.affinity.noJobSkills'),
    'unrecognized-profile': t('jobBoard.affinity.unrecognized'),
  };
  const rawRequirements = requirements
    .map((requirement) => requirement.trim())
    .filter(Boolean)
    .filter((requirement, index, list) => list.indexOf(requirement) === index)
    .slice(0, 10);
  const knownCvSkills = cvSkillsFromProfile(cvProfile);
  const canUseCvForJobAlerts = Boolean(
    userId && cvProfile?.status === 'ready' && knownCvSkills.length > 0,
  );
  const cvOwnedByCandidate = cvProfile?.cvDocument?.sourceType === 'candidate_profile';

  const skillGroups = [
    {
      key: 'matched',
      title: t('jobBoard.affinity.matched', { count: matchResult.matchedSkills.length }),
      skills: matchResult.matchedSkills,
      icon: <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />,
      chipClass: 'bg-success-subtle text-success border-success-border',
    },
    {
      key: 'job-only',
      title: t('jobBoard.affinity.jobOnly', { count: matchResult.missingSkills.length }),
      skills: matchResult.missingSkills,
      icon: <AlertCircle className="h-3.5 w-3.5 text-warning" aria-hidden="true" />,
      chipClass: 'bg-warning-subtle text-warning border-warning-border',
    },
    {
      key: 'profile-only',
      title: t('jobBoard.affinity.profileOnly', { count: matchResult.candidateOnlySkills.length }),
      skills: matchResult.candidateOnlySkills,
      icon: null,
      chipClass: 'bg-surface-raised text-subtle border-edge',
    },
  ].filter((group) => group.skills.length > 0);

  const handleCvUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!userId) {
      onRequireAuth?.();
      return;
    }
    const validation = supportedCvFile(file);
    if (validation) {
      setCvError(t(validation === 'too-large' ? 'jobBoard.affinity.cvFileTooLarge' : 'jobBoard.affinity.cvUnsupportedType'));
      return;
    }

    setCvError('');
    setCvStatus('');
    setIsUploadingCv(true);
    try {
      await uploadCandidateProfileCv(userId, file);
      const profile = await loadUserCvProfile(userId);
      const verifiedProfile = profile?.userId === userId ? profile : null;
      setCvProfile(verifiedProfile);
      setCvStatusTone(verifiedProfile?.status === 'ready' ? 'success' : 'warning');
      setCvStatus(t(verifiedProfile?.status === 'ready' ? 'jobBoard.affinity.cvUploaded' : 'jobBoard.affinity.cvNeedsReview'));
      if (verifiedProfile) {
        const nextSkills = mergeSkills(candidateSkills, cvSkillsFromProfile(verifiedProfile));
        setCandidateSkillsText(nextSkills.join(', '));
        setIsEditing(true);
      }
    } catch {
      setCvError(t('jobBoard.affinity.cvUploadFailed'));
    } finally {
      setIsUploadingCv(false);
    }
  };

  const handleCvRemove = async () => {
    if (!userId) return;
    setIsRemovingCv(true);
    setCvError('');
    setCvStatus('');
    try {
      await deleteCandidateProfileCv(userId);
      setCvProfile(null);
      setCandidateSkillsText('');
      saveCandidateSkillsLocally(userId, '');
      setConfirmRemoveCv(false);
      setCvStatusTone('success');
      setCvStatus(t('jobBoard.affinity.cvRemoved'));
    } catch {
      setCvError(t('jobBoard.affinity.cvRemoveFailed'));
    } finally {
      setIsRemovingCv(false);
    }
  };

  const handleCvAlertPreference = async (enabled: boolean) => {
    if (!userId || (!canUseCvForJobAlerts && enabled)) return;
    setIsSavingAlertPreference(true);
    setAlertPreferenceError(false);
    setAlertPreferenceSaved(false);
    try {
      await setCandidateCvJobAlertPersonalization(userId, enabled);
      setCvProfile((current) => current ? { ...current, jobAlertPersonalizationEnabled: enabled } : current);
      setAlertPreferenceSaved(true);
    } catch {
      setAlertPreferenceError(true);
    } finally {
      setIsSavingAlertPreference(false);
    }
  };

  return (
    <section
      data-testid="job-cv-fit-matcher"
      className={`space-y-4 rounded-md border border-edge bg-surface p-4 sm:p-5 ${className}`}
      aria-label={t('jobBoard.affinity.ariaLabel')}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-edge/60 pb-3">
        <h2 className="flex items-center gap-2 text-base font-semibold font-display text-heading">
          <Target className="h-5 w-5 text-accent" aria-hidden="true" />
          {t('jobBoard.affinity.title')}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {onDownloadBilingualCv && (
            <button
              type="button"
              onClick={onDownloadBilingualCv}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-edge px-3 py-2 text-sm font-semibold text-body hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <FileDown className="h-4 w-4" aria-hidden="true" />
              {t('jobBoard.cvDownload.downloadBilingual')}
            </button>
          )}
          <button
            type="button"
            onClick={() => setIsEditing((previous) => !previous)}
            aria-expanded={isEditing}
            aria-controls="job-affinity-skills-editor"
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-2 text-sm font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Edit3 className="h-4 w-4" aria-hidden="true" />
            {isEditing
              ? t('jobBoard.affinity.closeEdit')
              : t(candidateSkills.length ? 'jobBoard.affinity.edit' : 'jobBoard.affinity.add')}
          </button>
        </div>
      </header>

      <p className="max-w-3xl text-sm leading-relaxed text-subtle">
        {t('jobBoard.affinity.methodology')}
      </p>

      <div role="status" aria-live="polite" className="space-y-2">
        <p className="text-sm leading-relaxed text-body">
          {score !== null ? (
            <>
              <strong className="font-semibold tabular-nums text-heading">{score}%</strong>
              {' · '}
              {t('jobBoard.affinity.coverageCount', {
                matched: matchResult.matchedSkills.length,
                total: matchResult.jobSkills.length,
              })}
            </>
          ) : statusCopy[matchResult.status]}
        </p>
        {score !== null && (
          <div
            role="progressbar"
            aria-label={t('jobBoard.affinity.coverageLabel')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={score}
            className="h-2 overflow-hidden rounded-full bg-surface-raised"
          >
            <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${score}%` }} />
          </div>
        )}
      </div>

      {matchResult.jobSkills.length > 0 && skillGroups.length === 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-heading">{t('jobBoard.affinity.requestedSkills')}</h3>
          <ul className="flex flex-wrap gap-2" aria-label={t('jobBoard.affinity.requestedSkills')}>
            {matchResult.jobSkills.map((skill) => (
              <li key={skill} className="inline-flex items-center rounded-full border border-edge bg-surface-raised px-2.5 py-1 text-sm font-medium text-body">
                {skill}
              </li>
            ))}
          </ul>
        </div>
      ) : rawRequirements.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-heading">{t('jobBoard.affinity.jobRequirements')}</h3>
          <ul className="space-y-1.5 pl-4 list-disc marker:text-accent">
            {rawRequirements.map((requirement) => <li key={requirement} className="text-sm leading-relaxed text-body">{requirement}</li>)}
          </ul>
        </div>
      ) : null}

      {skillGroups.length > 0 && (
        <div className="space-y-3 border-t border-edge/60 pt-3">
          {skillGroups.map((group) => (
            <div key={group.key}>
              <h3 className="mb-1.5 text-sm font-semibold text-heading">{group.title}</h3>
              <ul className="flex flex-wrap gap-2" aria-label={group.title}>
                {group.skills.map((skill) => (
                  <li key={skill} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm font-medium ${group.chipClass}`}>
                    {group.icon}
                    {skill}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {matchResult.jobSkills.length > 0 && rawRequirements.length > 0 && (
        <details className="border-t border-edge/60 pt-3">
          <summary className="min-h-[44px] cursor-pointer py-2 text-sm font-semibold text-accent underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            {t('jobBoard.affinity.allRequirements', { count: rawRequirements.length })}
          </summary>
          <ul className="space-y-1.5 pl-4 list-disc marker:text-accent">
            {rawRequirements.map((requirement) => <li key={requirement} className="text-sm leading-relaxed text-body">{requirement}</li>)}
          </ul>
        </details>
      )}

      <div id="job-affinity-skills-editor" hidden={!isEditing} className="space-y-2 border-t border-edge/60 pt-3">
        <label htmlFor="job-affinity-skills" className="block text-sm font-semibold text-heading">
          {t('jobBoard.affinity.skillsLabel')}
        </label>
        <textarea
          id="job-affinity-skills"
          value={candidateSkillsText}
          onChange={(event) => {
            manuallyEditedSkillsRef.current = true;
            setCandidateSkillsText(event.target.value.slice(0, MAX_SKILLS_LENGTH));
          }}
          placeholder={t('jobBoard.affinity.skillsPlaceholder')}
          maxLength={MAX_SKILLS_LENGTH}
          className="min-h-24 w-full rounded-md border border-edge bg-surface px-3 py-2 text-sm text-body caret-accent selection:bg-accent-subtle selection:text-heading placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          rows={3}
        />
        <p role="status" aria-live="polite" className="text-xs text-muted">
          {userId
            ? t(isLoadingProfileSkills
              ? 'jobBoard.affinity.loadingSkills'
              : isSavingSkills ? 'jobBoard.affinity.savingSkills' : 'jobBoard.affinity.savedProfile')
            : t('jobBoard.affinity.savedLocally')}
        </p>
        {skillsSaveError && <p role="alert" className="text-xs text-danger">{t('jobBoard.affinity.saveSkillsError')}</p>}
      </div>

      <div className="space-y-2 border-t border-edge/60 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-heading">{t('jobBoard.affinity.uploadCv')}</h3>
              {cvProfile?.cvDocument?.fileName && (
                <p className="mt-1 break-all text-xs text-body">{cvProfile.cvDocument.fileName}</p>
              )}
            </div>
          </div>
          {userId ? (
            <label
              htmlFor="job-affinity-cv-file"
              className={`inline-flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-md border border-edge px-3 py-2 text-sm font-semibold text-body hover:bg-surface-raised focus-within:outline-none focus-within:ring-2 focus-within:ring-accent ${isUploadingCv || isLoadingProfileSkills ? 'pointer-events-none opacity-60' : ''}`}
            >
              {isUploadingCv ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Upload className="h-4 w-4" aria-hidden="true" />}
              {isUploadingCv ? t('jobBoard.affinity.uploadingCv') : t(cvProfile ? 'jobBoard.affinity.replaceCv' : 'jobBoard.affinity.uploadCv')}
            </label>
          ) : (
            <button
              type="button"
              onClick={onRequireAuth}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-edge px-3 py-2 text-sm font-semibold text-body hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {t('jobBoard.affinity.signInForCv')}
            </button>
          )}
          {userId && (
            <input
              id="job-affinity-cv-file"
              type="file"
              accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="sr-only"
              disabled={isUploadingCv || isLoadingProfileSkills}
              onChange={(event) => { void handleCvUpload(event); }}
              aria-label={t('jobBoard.affinity.uploadCv')}
            />
          )}
        </div>

        <p className="text-xs leading-relaxed text-subtle">{t('jobBoard.affinity.cvPrivacy')}</p>
        {cvStatus && <p role="status" aria-live="polite" className={`text-sm ${cvStatusTone === 'success' ? 'text-success' : 'text-warning'}`}>{cvStatus}</p>}
        {cvError && <p role="alert" className="text-sm text-danger">{cvError}</p>}

        {cvOwnedByCandidate && !confirmRemoveCv && (
          <button
            type="button"
            onClick={() => setConfirmRemoveCv(true)}
            disabled={isUploadingCv || isRemovingCv}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-2 text-sm font-medium text-danger hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            {t('jobBoard.affinity.removeCv')}
          </button>
        )}
        {cvOwnedByCandidate && confirmRemoveCv && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('jobBoard.affinity.confirmRemoveCv')}>
            <span className="text-sm text-body">{t('jobBoard.affinity.confirmRemoveCv')}</span>
            <button
              type="button"
              onClick={() => { void handleCvRemove(); }}
              disabled={isRemovingCv}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-danger-border px-3 py-2 text-sm font-semibold text-danger hover:bg-danger-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
            >
              {isRemovingCv && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {isRemovingCv ? t('jobBoard.affinity.removingCv') : t('jobBoard.affinity.confirmRemoveCv')}
            </button>
            <button
              type="button"
              onClick={() => setConfirmRemoveCv(false)}
              disabled={isRemovingCv}
              className="inline-flex min-h-[44px] items-center rounded-md px-2 py-2 text-sm font-semibold text-body underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
            >
              {t('jobBoard.affinity.cancelRemoveCv')}
            </button>
          </div>
        )}

        {userId && (canUseCvForJobAlerts || cvProfile?.jobAlertPersonalizationEnabled === true) && (
          <div className="space-y-1 border-t border-edge/60 pt-3">
            <label className="flex min-h-[44px] cursor-pointer items-start gap-2.5 py-2 text-sm font-medium text-body">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                checked={cvProfile?.jobAlertPersonalizationEnabled === true}
                disabled={isSavingAlertPreference}
                onChange={(event) => { void handleCvAlertPreference(event.target.checked); }}
              />
              <span>{t('jobBoard.affinity.enableCvJobAlert')}</span>
            </label>
            <p className="pl-6 text-xs leading-relaxed text-subtle">{t('jobBoard.affinity.cvJobAlertHint')}</p>
            {isSavingAlertPreference && <p role="status" className="pl-6 text-xs text-subtle">{t('jobBoard.affinity.savingPreference')}</p>}
            {alertPreferenceSaved && <p role="status" className="pl-6 text-xs text-success">{t('jobBoard.affinity.preferenceSaved')}</p>}
            {alertPreferenceError && <p role="alert" className="pl-6 text-xs text-danger">{t('jobBoard.affinity.preferenceSaveFailed')}</p>}
          </div>
        )}
      </div>
    </section>
  );
};
