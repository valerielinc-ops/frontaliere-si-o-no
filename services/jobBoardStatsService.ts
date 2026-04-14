export interface JobBoardActionTotals {
 added: number;
 updated: number;
 removed: number;
}

export interface JobBoardHistoryPoint extends JobBoardActionTotals {
 date: string;
 totalJobs: number;
}

export interface JobBoardLeader {
 key: string;
 name: string;
 url: string;
 count?: number;
 added?: number;
 updated?: number;
 removed?: number;
}

export interface JobBoardSalaryLeader extends JobBoardLeader {
 avgMin?: number;
 avgMax?: number;
 avgMid?: number;
 weightedSalary?: number;
}

export interface JobBoardStatsData {
 generatedAt: string;
 links: {
 allJobs: string;
 };
 totals: {
 activeJobs: number;
 activeCompanies: number;
 activeLocations: number;
 todayAdded: number;
 todayUpdated: number;
 todayRemoved: number;
 last7d: JobBoardActionTotals;
 last30d: JobBoardActionTotals;
 };
 history: JobBoardHistoryPoint[];
 leaders: {
 topCompaniesActive: JobBoardLeader[];
 topLocationsActive: JobBoardLeader[];
 topCompaniesAddedToday: JobBoardLeader[];
 topCompaniesAdded30d: JobBoardLeader[];
 topLocationsAdded30d: JobBoardLeader[];
 topTitlesAdded30d: JobBoardLeader[];
 };
 salary: {
 coverage: {
 jobsWithSalary: number;
 coveragePct: number;
 avgMin: number;
 avgMax: number;
 avgMid: number;
 medianMid: number;
 };
 leaders: {
 topSalaryCompanies: JobBoardSalaryLeader[];
 topSalaryLocations: JobBoardSalaryLeader[];
 topSalaryTitles: JobBoardSalaryLeader[];
 };
 };
}

export async function fetchJobBoardStats(forceRefresh = false): Promise<JobBoardStatsData | null> {
 const suffix = forceRefresh ? `?fresh=${Date.now()}` : '';
 const response = await fetch(`/data/jobs-stats.json${suffix}`, {
 cache: forceRefresh ? 'no-store' : 'default',
 });
 if (!response.ok) {
 throw new Error(`Failed to load job board stats (${response.status})`);
 }
 const payload = await response.json();
 if (!payload || typeof payload !== 'object') return null;
 return payload as JobBoardStatsData;
}
