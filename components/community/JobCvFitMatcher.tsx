import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Edit3, FileDown, Target } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import { computeCvMatch, type CvMatchResult } from '../../services/cvmatch';

const SKILLS_STORAGE_PREFIX = 'frontaliere_job_affinity_skills';
const MAX_SKILLS_LENGTH = 1000;

export interface JobCvFitMatcherProps {
  requirements?: string[];
  preferredSkills?: string[];
  userId?: string | null;
  locale?: Locale;
  onDownloadBilingualCv?: () => void;
  className?: string;
}

function storageKey(userId?: string | null): string {
  return `${SKILLS_STORAGE_PREFIX}:${userId?.trim() ? encodeURIComponent(userId.trim()) : 'anonymous'}`;
}

function loadCandidateSkills(userId?: string | null): string {
  try {
    return (localStorage.getItem(storageKey(userId)) || '').slice(0, MAX_SKILLS_LENGTH);
  } catch {
    return '';
  }
}

function saveCandidateSkills(userId: string | null | undefined, skills: string): void {
  try {
    const key = storageKey(userId);
    if (skills.trim()) localStorage.setItem(key, skills.slice(0, MAX_SKILLS_LENGTH));
    else localStorage.removeItem(key);
  } catch {
    // The comparison still works for this visit when browser storage is unavailable.
  }
}

export const JobCvFitMatcher: React.FC<JobCvFitMatcherProps> = ({
  requirements = [],
  preferredSkills = [],
  userId,
  locale = 'it',
  onDownloadBilingualCv,
  className = '',
}) => {
  const { t } = useTranslation();
  const [candidateSkillsText, setCandidateSkillsText] = useState(() => loadCandidateSkills(userId));
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    saveCandidateSkills(userId, candidateSkillsText);
  }, [candidateSkillsText, userId]);

  const matchResult: CvMatchResult = useMemo(() => computeCvMatch({
    candidateSkills: candidateSkillsText.split(/[,;\n]/).map((skill) => skill.trim()).filter(Boolean),
    jobRequirements: requirements,
    preferredSkills,
    locale,
  }), [candidateSkillsText, locale, preferredSkills, requirements]);

  const score = matchResult.overall;
  const statusCopy: Record<CvMatchResult['status'], string> = {
    ready: '',
    'missing-profile': t('jobBoard.affinity.empty'),
    'no-job-skills': t('jobBoard.affinity.noJobSkills'),
    'unrecognized-profile': t('jobBoard.affinity.unrecognized'),
  };

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

  return (
    <section
      data-testid="job-cv-fit-matcher"
      className={`rounded-md border border-edge bg-surface p-4 sm:p-5 space-y-4 ${className}`}
      aria-label={t('jobBoard.affinity.ariaLabel')}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-edge/60 pb-3">
        <h2 className="flex items-center gap-2 text-base font-semibold font-display text-heading">
          <Target className="h-5 w-5 text-accent" aria-hidden="true" />
          {t('jobBoard.affinity.title')}
        </h2>
        <div className="flex flex-wrap items-center gap-3">
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
              : t(candidateSkillsText.trim() ? 'jobBoard.affinity.edit' : 'jobBoard.affinity.add')}
          </button>
        </div>
      </header>

      <p className="max-w-3xl text-sm leading-relaxed text-subtle">
        {t('jobBoard.affinity.methodology')}
      </p>

      {score !== null ? (
        <div role="status" aria-live="polite" className="space-y-2">
          <p className="text-sm leading-relaxed text-body">
            <strong className="font-semibold tabular-nums text-heading">{score}%</strong>
            {' · '}
            {t('jobBoard.affinity.coverageCount', {
              matched: matchResult.matchedSkills.length,
              total: matchResult.jobSkills.length,
            })}
          </p>
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
        </div>
      ) : (
        <p role="status" aria-live="polite" className="text-sm leading-relaxed text-subtle">
          {statusCopy[matchResult.status]}
        </p>
      )}

      {matchResult.status === 'ready' && skillGroups.length > 0 && (
        <div className="space-y-3">
          {skillGroups.map((group) => (
            <div key={group.key}>
              <h3 className="mb-1.5 text-sm font-semibold text-heading">{group.title}</h3>
              <ul className="flex flex-wrap gap-2" aria-label={group.title}>
                {group.skills.map((skill) => (
                  <li
                    key={skill}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm font-medium ${group.chipClass}`}
                  >
                    {group.icon}
                    {skill}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <div id="job-affinity-skills-editor" hidden={!isEditing} className="space-y-2 border-t border-edge/60 pt-3">
          <label htmlFor="job-affinity-skills" className="block text-sm font-semibold text-heading">
            {t('jobBoard.affinity.skillsLabel')}
          </label>
          <textarea
            id="job-affinity-skills"
            value={candidateSkillsText}
            onChange={(event) => setCandidateSkillsText(event.target.value.slice(0, MAX_SKILLS_LENGTH))}
            placeholder={t('jobBoard.affinity.skillsPlaceholder')}
            maxLength={MAX_SKILLS_LENGTH}
            className="min-h-24 w-full rounded-md border border-edge bg-surface px-3 py-2 text-sm text-body placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            rows={3}
          />
          <p className="text-xs text-muted">{t('jobBoard.affinity.savedLocally')}</p>
      </div>
    </section>
  );
};
