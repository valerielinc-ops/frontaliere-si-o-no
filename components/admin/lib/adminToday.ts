export interface TodaySummaryInput {
  planned?: number | null;
  completed?: number | null;
  running?: number | null;
  failed?: number | null;
  crawlerCount?: number | null;
  crawlerGroups?: number | null;
  activeJobs?: number | null;
  activeJobsDelta?: number | null;
}

export function formatTodayDate(date = new Date()): string {
  return new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Zurich', weekday: 'long', day: 'numeric', month: 'long' }).format(date).toLocaleLowerCase('it-IT');
}

export function buildTodaySummary({ planned, completed, running, failed, crawlerCount, crawlerGroups, activeJobs, activeJobsDelta }: TodaySummaryInput): string {
  const sentences: string[] = [];
  const hasNumber = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
  const noun = (value: number, singular: string, plural: string): string => value === 1 ? singular : plural;

  if (hasNumber(planned)) {
    const statuses = [
      hasNumber(completed) && completed > 0 ? `${completed.toLocaleString('it-IT')} ${noun(completed, 'completata', 'completate')}` : null,
      hasNumber(running) && running > 0 ? `${running.toLocaleString('it-IT')} in corso` : null,
      hasNumber(failed) && failed > 0 ? `${failed.toLocaleString('it-IT')} da verificare` : null,
    ].filter((value): value is string => Boolean(value));
    if (planned === 0) sentences.push('Oggi nessuna esecuzione prevista.');
    else sentences.push(`Oggi ${planned.toLocaleString('it-IT')} ${noun(planned, 'esecuzione prevista', 'esecuzioni previste')}${statuses.length > 0 ? `: ${statuses.join(', ')}` : ''}.`);
  }

  const hasCrawlerCount = hasNumber(crawlerCount);
  const hasCrawlerGroups = hasNumber(crawlerGroups);
  if (hasCrawlerCount && hasCrawlerGroups) sentences.push(`${crawlerCount.toLocaleString('it-IT')} crawler in ${crawlerGroups.toLocaleString('it-IT')} gruppi.`);
  else if (hasCrawlerCount) sentences.push(`${crawlerCount.toLocaleString('it-IT')} crawler.`);
  else if (hasCrawlerGroups) sentences.push(`${crawlerGroups.toLocaleString('it-IT')} gruppi crawler.`);

  if (hasNumber(activeJobs)) {
    const delta = hasNumber(activeJobsDelta) ? `, ${activeJobsDelta >= 0 ? '+' : ''}${activeJobsDelta.toLocaleString('it-IT')} rispetto a ieri` : '';
    sentences.push(`Annunci attivi ${activeJobs.toLocaleString('it-IT')}${delta}.`);
  }

  return sentences.join(' ');
}
