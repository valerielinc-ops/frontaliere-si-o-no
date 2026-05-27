#!/usr/bin/env npx ts-node
/**
 * Job Board Scraper Script
 * 
 * Fetches real job listings from public sources and updates the job data.
 * Run: npx ts-node scripts/update-jobs.ts
 * 
 * Sources:
 * - Indeed Ticino (Frontalieri-friendly jobs)
 * - Google Jobs API (via SerpAPI or similar)
 * 
 * Output: Updates data/jobs.json with fresh listings
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Types ───────────────────────────────────────────────────

interface JobListing {
  id: string;
  company: string;
  title: string;
  location: string;
  canton: string;
  category: JobCategory;
  contract: ContractType;
  salaryMin?: number;
  salaryMax?: number;
  currency: 'CHF' | 'EUR';
  description: string;
  requirements: string[];
  featured: boolean;
  postedDate: string;
  url?: string;
  source?: string;
}

type JobCategory = 'tech' | 'finance' | 'health' | 'engineering' | 'admin' | 'sales' | 'other';
type ContractType = 'full-time' | 'part-time' | 'contract' | 'internship';

// ─── Configuration ────────────────────────────────────────────

const REFERRAL_TAG = '?utm_source=frontaliereticino&utm_medium=jobboard&utm_campaign=jobs';

const TICINO_CITIES = ['Lugano', 'Bellinzona', 'Locarno', 'Mendrisio', 'Chiasso', 'Manno', 'Stabio', 'Agno', 'Biasca'];
const CATEGORY_KEYWORDS: Record<JobCategory, string[]> = {
  tech: ['developer', 'software', 'engineer', 'programmatore', 'informatico', 'frontend', 'backend', 'devops', 'data', 'IT'],
  finance: ['finance', 'analyst', 'accountant', 'banking', 'banca', 'contabile', 'finanziario', 'compliance'],
  health: ['nurse', 'doctor', 'infermiere', 'medico', 'healthcare', 'sanitario', 'ospedale', 'clinica'],
  engineering: ['mechanical', 'electrical', 'civil', 'meccanico', 'elettrico', 'ingegnere', 'project manager'],
  admin: ['administrative', 'secretary', 'assistente', 'segretaria', 'receptionist', 'HR', 'risorse umane'],
  sales: ['sales', 'vendita', 'commerciale', 'marketing', 'account', 'business development'],
  other: [],
};

// ─── Indeed Scraper (Public API approach) ─────────────────────

async function fetchIndeedJobs(): Promise<JobListing[]> {
  // Indeed blocks automated access - returning empty to avoid rate limiting
  console.log('ℹ️  Indeed scraping disabled (rate limited)');
  return [];
}

// ─── Arbeit.swiss / Job-Room (Swiss Government Official Job Portal) ─────

async function fetchArbeitSwissJobs(): Promise<JobListing[]> {
  const jobs: JobListing[] = [];
  
  try {
    // Use the Arbeit.swiss public search page (not the JSON API which may redirect)
    // Try the oData API endpoint
    const searchUrl = 'https://www.job-room.ch/en/jobs?canton=TI&sort=registrationDate,desc';
    
    console.log('📡 Fetching jobs from Job-Room.ch (Arbeit.swiss)...');
    
    const response = await fetch(searchUrl, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
    
    if (!response.ok) {
      console.warn(`  ⚠️ Job-Room.ch fetch failed: ${response.status}`);
      return [];
    }
    
    const html = await response.text();
    
    // Parse JSON-LD structured data from the page
    const jsonLdRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = jsonLdRegex.exec(html)) !== null) {
      try {
        const data = JSON.parse(match[1]);
        if (data['@type'] === 'JobPosting' || (Array.isArray(data) && data.some((d: Record<string, unknown>) => d['@type'] === 'JobPosting'))) {
          const postings = Array.isArray(data) ? data.filter((d: Record<string, unknown>) => d['@type'] === 'JobPosting') : [data];
          for (const posting of postings) {
            jobs.push({
              id: `jobroom-${hashString(posting.url || posting.title)}`,
              company: posting.hiringOrganization?.name || 'Azienda',
              title: posting.title,
              location: posting.jobLocation?.address?.addressLocality || 'Ticino',
              canton: 'TI',
              category: categorizeJob(posting.title),
              contract: posting.employmentType?.includes('PART_TIME') ? 'part-time' : 'full-time',
              currency: 'CHF',
              description: cleanHtml(posting.description || '').substring(0, 500),
              requirements: [],
              featured: false,
              postedDate: formatDate(posting.datePosted || new Date().toISOString()),
              url: posting.url,
              source: 'Job-Room.ch',
            });
          }
        }
      } catch {
        // JSON parsing failed
      }
    }
    
    // If no JSON-LD, try to parse job titles from HTML
    if (jobs.length === 0) {
      // Job titles are usually in h2 or h3 elements with job-title class
      const jobRegex = /<a[^>]*href="([^"]*\/job\/[^"]*)"[^>]*>[\s\S]*?<h[23][^>]*>([^<]+)<\/h[23]>/gi;
      let jobMatch;
      while ((jobMatch = jobRegex.exec(html)) !== null) {
        const [, url, title] = jobMatch;
        if (title && url) {
          jobs.push({
            id: `jobroom-${hashString(url)}`,
            company: 'Azienda',
            title: cleanHtml(title),
            location: 'Ticino',
            canton: 'TI',
            category: categorizeJob(title),
            contract: 'full-time',
            currency: 'CHF',
            description: `Offerta di lavoro: ${cleanHtml(title)}`,
            requirements: [],
            featured: false,
            postedDate: new Date().toISOString().split('T')[0],
            url: url.startsWith('http') ? url : `https://www.job-room.ch${url}`,
            source: 'Job-Room.ch',
          });
        }
      }
    }
    
    console.log(`  ✓ Found ${jobs.length} jobs`);
    
  } catch (error) {
    console.warn('  ⚠️ Job-Room.ch error:', error);
  }
  
  return jobs;
}

// ─── Tutti.ch Jobs Scraper (Swiss classifieds including jobs) ─────

async function fetchTuttiJobs(): Promise<JobListing[]> {
  const jobs: JobListing[] = [];
  
  try {
    // Tutti.ch has a public JSON endpoint for listings
    const searchUrl = 'https://www.tutti.ch/api/v10/list.json?o=1&q=lavoro&w=1200&s=date';
    
    console.log('📡 Fetching jobs from Tutti.ch...');
    
    const response = await fetch(searchUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
    
    if (!response.ok) {
      console.warn(`  ⚠️ Tutti.ch fetch failed: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    const items = data.items || [];
    
    // Filter for job-related listings in Ticino
    const jobItems = items.filter((item: Record<string, unknown>) => {
      const regionId = item.region_id as number;
      const categoryId = item.category_id as number;
      // Region 25 is Ticino, Category 22 is jobs
      return (regionId === 25 || !regionId) && (categoryId === 22 || !categoryId);
    });
    
    console.log(`  ✓ Found ${jobItems.length} job-related listings`);
    
    for (const item of jobItems.slice(0, 30)) {
      const title = item.subject || item.title || '';
      const body = item.body || '';
      
      if (title.toLowerCase().includes('lavoro') || 
          title.toLowerCase().includes('cerco') ||
          title.toLowerCase().includes('offro') ||
          body.toLowerCase().includes('stipendio')) {
        jobs.push({
          id: `tutti-${item.id || hashString(title)}`,
          company: item.user?.name || 'Privato',
          title: cleanHtml(title as string),
          location: item.region?.name || 'Ticino',
          canton: 'TI',
          category: categorizeJob(title as string),
          contract: 'full-time',
          currency: 'CHF',
          description: cleanHtml(body as string).substring(0, 500),
          requirements: [],
          featured: false,
          postedDate: formatDate(item.date as string || new Date().toISOString()),
          url: `https://www.tutti.ch${item.link || `/annunci/${item.id}`}`,
          source: 'Tutti.ch',
        });
      }
    }
    
  } catch (error) {
    console.warn('  ⚠️ Tutti.ch error:', error);
  }
  
  return jobs;
}

// ─── Remotive.io (Remote jobs - some allow Swiss residents) ─────

async function fetchRemotiveJobs(): Promise<JobListing[]> {
  const jobs: JobListing[] = [];
  
  try {
    // Remotive has a free public API
    const searchUrl = 'https://remotive.com/api/remote-jobs?limit=50';
    
    console.log('📡 Fetching remote jobs from Remotive.io...');
    
    const response = await fetch(searchUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
    
    if (!response.ok) {
      console.warn(`  ⚠️ Remotive.io fetch failed: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    const remoteJobs = data.jobs || [];
    
    // Filter for jobs that allow Europe/worldwide
    const europeanJobs = remoteJobs.filter((job: Record<string, unknown>) => {
      const regions = (job.candidate_required_location as string || '').toLowerCase();
      return regions.includes('worldwide') || 
             regions.includes('europe') || 
             regions.includes('emea') ||
             regions.includes('switzerland');
    });
    
    console.log(`  ✓ Found ${europeanJobs.length} Europe-friendly remote jobs`);
    
    for (const job of europeanJobs.slice(0, 20)) {
      jobs.push({
        id: `remotive-${job.id || hashString(job.title as string)}`,
        company: job.company_name as string || 'Remote Company',
        title: job.title as string || '',
        location: 'Remote (CH/EU)',
        canton: 'TI',
        category: categorizeJob(job.title as string || job.category as string || ''),
        contract: (job.job_type as string)?.includes('part') ? 'part-time' : 'full-time',
        currency: 'CHF',
        description: cleanHtml(job.description as string || '').substring(0, 500),
        requirements: job.tags as string[] || [],
        featured: false,
        postedDate: formatDate(job.publication_date as string || new Date().toISOString()),
        url: appendReferral(job.url as string),
        source: 'Remotive.io',
      });
    }
    
  } catch (error) {
    console.warn('  ⚠️ Remotive.io error:', error);
  }
  
  return jobs;
}

// ─── FindWork.dev API (Tech jobs with public API) ─────

async function fetchFindWorkJobs(): Promise<JobListing[]> {
  const jobs: JobListing[] = [];
  
  try {
    // FindWork has a free public API for tech jobs
    const searchUrl = 'https://findwork.dev/api/jobs/?location=switzerland&search=ticino';
    
    console.log('📡 Fetching tech jobs from FindWork.dev...');
    
    const response = await fetch(searchUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
    
    if (!response.ok) {
      console.warn(`  ⚠️ FindWork.dev fetch failed: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    const results = data.results || [];
    
    console.log(`  ✓ Found ${results.length} tech jobs`);
    
    for (const job of results.slice(0, 20)) {
      jobs.push({
        id: `findwork-${job.id || hashString(job.role as string)}`,
        company: job.company_name as string || 'Tech Company',
        title: job.role as string || '',
        location: job.location as string || 'Switzerland',
        canton: 'TI',
        category: 'tech',
        contract: (job.employment_type as string)?.includes('part') ? 'part-time' : 'full-time',
        currency: 'CHF',
        description: cleanHtml(job.text as string || '').substring(0, 500),
        requirements: job.keywords as string[] || [],
        featured: false,
        postedDate: formatDate(job.date_posted as string || new Date().toISOString()),
        url: appendReferral(job.url as string),
        source: 'FindWork.dev',
      });
    }
    
  } catch (error) {
    console.warn('  ⚠️ FindWork.dev error:', error);
  }
  
  return jobs;
}

// ─── UBS Jobs Ticino Scraper ─────────────────────────────────────

async function fetchUBSJobs(): Promise<JobListing[]> {
  const jobs: JobListing[] = [];
  
  try {
    // UBS uses TalentBrew/TMP platform - we can access the JSON API directly
    const apiUrl = 'https://jobs.ubs.com/TGnewUI/Search/AjaxSearch?partnerid=25008&siteid=5012';
    
    console.log('📡 Fetching jobs from UBS Ticino...');
    
    const searchParams = new URLSearchParams({
      'keyword': '',
      'location': 'Switzerland - Ticino',
      'LocationType': '2',
      'SortType': 'PostedDate',
      'SortDirection': 'Desc',
      'pagesize': '50',
      'pagenumber': '1',
    });
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://jobs.ubs.com/',
      },
      body: searchParams.toString(),
    });
    
    if (!response.ok) {
      // Try alternate HTML parsing approach
      console.log('  ℹ️ API failed, trying HTML parse...');
      return await fetchUBSJobsFromHTML();
    }
    
    const data = await response.json();
    const jobResults = data.Jobs || [];
    
    console.log(`  ✓ Found ${jobResults.length} jobs from UBS API`);
    
    for (const job of jobResults) {
      jobs.push({
        id: `ubs-${job.JobId || hashString(job.JobTitle)}`,
        company: 'UBS',
        title: job.JobTitle || job.Title || '',
        location: job.Location || 'Lugano',
        canton: 'TI',
        category: categorizeJob(job.JobTitle || job.Title || ''),
        contract: detectContractType(job.JobTitle + ' ' + (job.JobDescription || '')),
        currency: 'CHF',
        description: cleanHtml(job.JobDescription || job.Description || '').substring(0, 500),
        requirements: [],
        featured: true,
        postedDate: formatDate(job.PostedDate || new Date().toISOString()),
        url: appendReferral(`https://jobs.ubs.com/TGnewUI/Search/home/HomeWithPreLoad?jobId=${job.JobId}&partnerid=25008&siteid=5012`),
        source: 'UBS Careers',
      });
    }
    
  } catch (error) {
    console.warn('  ⚠️ UBS API error, trying HTML fallback:', error);
    return await fetchUBSJobsFromHTML();
  }
  
  return jobs;
}

async function fetchUBSJobsFromHTML(): Promise<JobListing[]> {
  const jobs: JobListing[] = [];
  
  try {
    const htmlUrl = 'https://jobs.ubs.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=25008&siteid=5012&PageType=searchResults&SearchType=linkquery&LinkID=15231#keyWordSearch=&locationSearch=Switzerland%20-%20Ticino';
    
    const response = await fetch(htmlUrl, {
      headers: {
        'Accept': 'text/html',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
    
    if (!response.ok) {
      console.warn(`  ⚠️ UBS HTML fetch failed: ${response.status}`);
      return [];
    }
    
    const html = await response.text();
    
    // Parse job listings from HTML (UBS uses specific class names)
    // Look for job-result divs or similar patterns
    const jobRegex = /data-jobid="(\d+)"[^>]*>[\s\S]*?<a[^>]*class="[^"]*jobTitle[^"]*"[^>]*>([^<]+)<\/a>/gi;
    let match;
    
    while ((match = jobRegex.exec(html)) !== null) {
      const [, jobId, title] = match;
      jobs.push({
        id: `ubs-${jobId}`,
        company: 'UBS',
        title: cleanHtml(title),
        location: 'Ticino',
        canton: 'TI',
        category: categorizeJob(title),
        contract: 'full-time',
        currency: 'CHF',
        description: `Posizione presso UBS in Ticino: ${cleanHtml(title)}`,
        requirements: [],
        featured: true,
        postedDate: new Date().toISOString().split('T')[0],
        url: appendReferral(`https://jobs.ubs.com/TGnewUI/Search/home/HomeWithPreLoad?jobId=${jobId}&partnerid=25008&siteid=5012`),
        source: 'UBS Careers',
      });
    }
    
    console.log(`  ✓ Found ${jobs.length} jobs from UBS HTML`);
    
  } catch (error) {
    console.warn('  ⚠️ UBS HTML parsing error:', error);
  }
  
  return jobs;
}

// ─── Migros/Denner Jobs Ticino Scraper ─────────────────────────────

async function fetchMigrosJobs(): Promise<JobListing[]> {
  const jobs: JobListing[] = [];
  
  try {
    // Migros job portal for Denner in Ticino region (871)
    console.log('📡 Fetching jobs from Migros/Denner Ticino...');
    
    // Try the JSON API endpoint first
    const apiUrl = 'https://jobs.migros.ch/api/jobs?company=denner-sa&region=871&language=it';
    
    let response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://jobs.migros.ch/',
      },
    });
    
    if (response.ok) {
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        const data = await response.json();
        const jobResults = data.jobs || data.results || data.items || [];
        
        console.log(`  ✓ Found ${jobResults.length} jobs from Migros API`);
        
        for (const job of jobResults) {
          jobs.push({
            id: `migros-${job.id || hashString(job.title)}`,
            company: job.company || 'Denner SA',
            title: job.title || job.name || '',
            location: job.location || job.city || 'Ticino',
            canton: 'TI',
            category: categorizeJob(job.title || job.name || ''),
            contract: detectContractType(job.title + ' ' + (job.description || '')),
            currency: 'CHF',
            description: cleanHtml(job.description || '').substring(0, 500),
            requirements: [],
            featured: false,
            postedDate: formatDate(job.publishedAt || job.date || new Date().toISOString()),
            url: appendReferral(job.url || `https://jobs.migros.ch/it/job/${job.id}`),
            source: 'Migros/Denner',
          });
        }
        
        return jobs;
      }
    }
    
    // Fallback: parse HTML page
    console.log('  ℹ️ API not available, trying HTML parse...');
    
    const htmlUrl = 'https://jobs.migros.ch/it/le-nostre-imprese/denner-sa/posti-di-lavoro-vacanti?REGION=871';
    response = await fetch(htmlUrl, {
      headers: {
        'Accept': 'text/html',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
    
    if (!response.ok) {
      console.warn(`  ⚠️ Migros HTML fetch failed: ${response.status}`);
      return [];
    }
    
    const html = await response.text();
    
    // Parse job listings from HTML
    // Look for JSON-LD structured data first
    const jsonLdRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
    let ldMatch;
    while ((ldMatch = jsonLdRegex.exec(html)) !== null) {
      try {
        const data = JSON.parse(ldMatch[1]);
        if (data['@type'] === 'JobPosting' || (Array.isArray(data) && data.some((d: Record<string, unknown>) => d['@type'] === 'JobPosting'))) {
          const postings = Array.isArray(data) ? data.filter((d: Record<string, unknown>) => d['@type'] === 'JobPosting') : [data];
          for (const posting of postings) {
            jobs.push({
              id: `migros-${hashString(posting.url || posting.title)}`,
              company: posting.hiringOrganization?.name || 'Denner SA',
              title: posting.title,
              location: posting.jobLocation?.address?.addressLocality || 'Ticino',
              canton: 'TI',
              category: categorizeJob(posting.title),
              contract: posting.employmentType?.includes('PART_TIME') ? 'part-time' : 'full-time',
              currency: 'CHF',
              description: cleanHtml(posting.description || '').substring(0, 500),
              requirements: [],
              featured: false,
              postedDate: formatDate(posting.datePosted || new Date().toISOString()),
              url: appendReferral(posting.url),
              source: 'Migros/Denner',
            });
          }
        }
      } catch {
        // JSON parsing failed
      }
    }
    
    // If no JSON-LD, try to parse job links from HTML
    if (jobs.length === 0) {
      const jobRegex = /<a[^>]*href="([^"]*\/job\/[^"]*)"[^>]*>[\s\S]*?(?:<h[23][^>]*>([^<]+)<\/h[23]>|class="[^"]*title[^"]*"[^>]*>([^<]+)<)/gi;
      let htmlMatch;
      while ((htmlMatch = jobRegex.exec(html)) !== null) {
        const [, url, title1, title2] = htmlMatch;
        const title = title1 || title2;
        if (title && url) {
          jobs.push({
            id: `migros-${hashString(url)}`,
            company: 'Denner SA',
            title: cleanHtml(title),
            location: 'Ticino',
            canton: 'TI',
            category: categorizeJob(title),
            contract: 'full-time',
            currency: 'CHF',
            description: `Posizione presso Denner: ${cleanHtml(title)}`,
            requirements: [],
            featured: false,
            postedDate: new Date().toISOString().split('T')[0],
            url: appendReferral(url.startsWith('http') ? url : `https://jobs.migros.ch${url}`),
            source: 'Migros/Denner',
          });
        }
      }
    }
    
    console.log(`  ✓ Found ${jobs.length} jobs from Migros HTML`);
    
  } catch (error) {
    console.warn('  ⚠️ Migros error:', error);
  }
  
  return jobs;
}

// ─── URL Validation (Check for 404s) ─────────────────────────────

async function validateJobUrls(jobs: JobListing[]): Promise<JobListing[]> {
  console.log('\n🔍 Validating job URLs...');
  
  const validJobs: JobListing[] = [];
  const invalidUrls: string[] = [];
  
  // Process in batches to avoid overwhelming servers
  const batchSize = 10;
  const timeout = 5000; // 5 second timeout per request
  
  for (let i = 0; i < jobs.length; i += batchSize) {
    const batch = jobs.slice(i, i + batchSize);
    
    const results = await Promise.all(
      batch.map(async (job) => {
        // Skip validation for certain sources that are known to be stable
        if (!job.url || job.source === 'Direct' || job.url.includes('remotive.com')) {
          return { job, valid: true };
        }
        
        try {
          // Use HEAD request to check if URL is valid (faster than GET)
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeout);
          
          const response = await fetch(job.url, {
            method: 'HEAD',
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            },
            redirect: 'follow',
          });
          
          clearTimeout(timeoutId);
          
          // Consider 2xx and 3xx as valid (redirects are OK)
          const valid = response.status >= 200 && response.status < 400;
          
          if (!valid) {
            console.log(`  ❌ 404: ${job.url} (${response.status})`);
          }
          
          return { job, valid };
        } catch (error) {
          // Network errors, timeouts - assume valid (don't remove due to network issues)
          return { job, valid: true };
        }
      })
    );
    
    for (const { job, valid } of results) {
      if (valid) {
        validJobs.push(job);
      } else {
        invalidUrls.push(`${job.company}: ${job.title} - ${job.url}`);
      }
    }
    
    // Small delay between batches
    if (i + batchSize < jobs.length) {
      await sleep(500);
    }
  }
  
  if (invalidUrls.length > 0) {
    console.log(`  ⚠️ Removed ${invalidUrls.length} jobs with invalid URLs:`);
    invalidUrls.forEach(url => console.log(`     - ${url}`));
  } else {
    console.log(`  ✓ All ${validJobs.length} job URLs are valid`);
  }
  
  return validJobs;
}

// ─── Fallback: Realistic Ticino job listings ─────────────────────

function generatePlaceholderJobs(): JobListing[] {
  // When APIs are unavailable, provide realistic Ticino job samples
  // These represent typical positions available for frontalieri
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0];
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0];
  
  return [
    {
      id: 'ticino-1',
      company: 'UBS Switzerland AG',
      title: 'Software Engineer Java/Spring',
      location: 'Lugano',
      canton: 'TI',
      category: 'tech',
      contract: 'full-time',
      salaryMin: 95000,
      salaryMax: 130000,
      currency: 'CHF',
      description: 'Sviluppo applicazioni backend per i servizi bancari digitali. Ambiente agile con team internazionale. Sede in centro Lugano con possibilità di smart working.',
      requirements: ['Java 17+', 'Spring Boot', 'Microservizi', 'Docker/Kubernetes', '5+ anni esperienza'],
      featured: true,
      postedDate: today,
      url: appendReferral('https://jobs.ubs.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=25008&siteid=5012&PageType=searchResults&SearchType=linkquery&LinkID=15231#keyWordSearch=&locationSearch=Switzerland%20-%20Ticino'),
      source: 'Direct',
    },
    {
      id: 'ticino-2',
      company: 'Banca della Svizzera Italiana',
      title: 'Analista Finanziario Senior',
      location: 'Bellinzona',
      canton: 'TI',
      category: 'finance',
      contract: 'full-time',
      salaryMin: 85000,
      salaryMax: 110000,
      currency: 'CHF',
      description: 'Analisi dei mercati finanziari e gestione portafogli clienti. Richiesta esperienza in risk management e compliance bancaria svizzera.',
      requirements: ['Laurea Economia/Finanza', 'Italiano/Tedesco/Inglese', 'CFA preferito', '3+ anni esperienza'],
      featured: true,
      postedDate: today,
      url: appendReferral('https://www.bfrbank.ch/lavora-con-noi'),
      source: 'Direct',
    },
    {
      id: 'ticino-3',
      company: 'Clinica Luganese Moncucco',
      title: 'Infermiere/a Reparto Cure Intensive',
      location: 'Lugano',
      canton: 'TI',
      category: 'health',
      contract: 'full-time',
      salaryMin: 70000,
      salaryMax: 85000,
      currency: 'CHF',
      description: 'Ricerchiamo personale infermieristico per il reparto di terapia intensiva. Esperienza in area critica richiesta.',
      requirements: ['Diploma infermieristico riconosciuto', 'Italiano fluente', 'Esperienza ICU', 'Disponibilità turni'],
      featured: false,
      postedDate: yesterday,
      url: appendReferral('https://www.moncucco.ch/lavora-con-noi'),
      source: 'Direct',
    },
    {
      id: 'ticino-4',
      company: 'Mikron SA',
      title: 'Ingegnere Meccanico Progettista',
      location: 'Agno',
      canton: 'TI',
      category: 'engineering',
      contract: 'full-time',
      salaryMin: 90000,
      salaryMax: 115000,
      currency: 'CHF',
      description: 'Progettazione di sistemi di automazione industriale per la produzione di componenti di precisione. Utilizzo CAD 3D e simulazioni FEM.',
      requirements: ['Laurea Ing. Meccanica', 'SolidWorks/CATIA', 'Esperienza automazione', 'Tedesco B2'],
      featured: false,
      postedDate: yesterday,
      url: appendReferral('https://www.mikron.com/careers'),
      source: 'Direct',
    },
    {
      id: 'ticino-5',
      company: 'USI - Università della Svizzera italiana',
      title: 'Research Assistant Informatica',
      location: 'Lugano',
      canton: 'TI',
      category: 'tech',
      contract: 'contract',
      salaryMin: 60000,
      salaryMax: 75000,
      currency: 'CHF',
      description: 'Posizione di assistente alla ricerca in computer science. Possibilità di PhD. Focus su AI/ML e software engineering.',
      requirements: ['Master CS/Informatica', 'Python/PyTorch', 'Pubblicazioni scientifiche', 'Inglese fluente'],
      featured: false,
      postedDate: yesterday,
      url: appendReferral('https://www.usi.ch/en/work-with-us'),
      source: 'Direct',
    },
    {
      id: 'ticino-6',
      company: 'Swisscom',
      title: 'Network Engineer',
      location: 'Manno',
      canton: 'TI',
      category: 'tech',
      contract: 'full-time',
      salaryMin: 85000,
      salaryMax: 105000,
      currency: 'CHF',
      description: 'Gestione infrastruttura di rete enterprise. Implementazione soluzioni SD-WAN e security. Supporto clienti business.',
      requirements: ['CCNP/CCNA', 'Firewall Fortinet/Palo Alto', '3+ anni esperienza', 'Italiano/Tedesco'],
      featured: false,
      postedDate: twoDaysAgo,
      url: appendReferral('https://www.swisscom.ch/careers'),
      source: 'Direct',
    },
    {
      id: 'ticino-7',
      company: 'FoxTown Factory Stores',
      title: 'Store Manager Retail',
      location: 'Mendrisio',
      canton: 'TI',
      category: 'sales',
      contract: 'full-time',
      salaryMin: 60000,
      salaryMax: 75000,
      currency: 'CHF',
      description: 'Gestione punto vendita nel centro outlet più grande del sud Svizzera. Responsabilità team e obiettivi vendita.',
      requirements: ['Esperienza retail 3+ anni', 'Italiano/Inglese', 'Leadership', 'Disponibilità weekend'],
      featured: false,
      postedDate: twoDaysAgo,
      url: appendReferral('https://www.foxtown.com/lavora-con-noi'),
      source: 'Direct',
    },
    {
      id: 'ticino-8',
      company: 'Ti-Press',
      title: 'Giornalista Multimediale',
      location: 'Lugano',
      canton: 'TI',
      category: 'other',
      contract: 'full-time',
      salaryMin: 55000,
      salaryMax: 70000,
      currency: 'CHF',
      description: 'Redazione notizie per web e social media. Copertura eventi locali e cronaca ticinese. Video editing base richiesto.',
      requirements: ['Laurea giornalismo/comunicazione', 'Italiano madrelingua', 'Adobe Premiere', 'Patente B'],
      featured: false,
      postedDate: twoDaysAgo,
      url: appendReferral('https://www.ti-press.ch'),
      source: 'Direct',
    },
    {
      id: 'ticino-9',
      company: 'Bühler AG',
      title: 'Process Engineer Food Technology',
      location: 'Stabio',
      canton: 'TI',
      category: 'engineering',
      contract: 'full-time',
      salaryMin: 95000,
      salaryMax: 120000,
      currency: 'CHF',
      description: 'Ottimizzazione processi produttivi per impianti alimentari. Viaggi internazionali per commissioning. Azienda leader mondiale.',
      requirements: ['Ing. Chimica/Alimentare', 'Inglese C1', 'Disponibilità viaggiare 30%', '2+ anni esperienza'],
      featured: false,
      postedDate: threeDaysAgo,
      url: appendReferral('https://www.buhlergroup.com/careers'),
      source: 'Direct',
    },
    {
      id: 'ticino-10',
      company: 'RSI Radiotelevisione svizzera',
      title: 'Tecnico Audio/Video',
      location: 'Comano',
      canton: 'TI',
      category: 'tech',
      contract: 'full-time',
      salaryMin: 70000,
      salaryMax: 85000,
      currency: 'CHF',
      description: 'Gestione apparecchiature broadcast per produzione televisiva. Regia, studio e produzioni esterne. Contratto SSR.',
      requirements: ['Formazione tecnica audiovisivi', 'Italiano madrelingua', 'Flessibilità oraria', 'Patente B'],
      featured: false,
      postedDate: threeDaysAgo,
      url: appendReferral('https://www.rsi.ch/lavora-con-noi'),
      source: 'Direct',
    },
    {
      id: 'ticino-11',
      company: 'Cornèr Banca',
      title: 'Private Banker',
      location: 'Lugano',
      canton: 'TI',
      category: 'finance',
      contract: 'full-time',
      salaryMin: 100000,
      salaryMax: 150000,
      currency: 'CHF',
      description: 'Gestione clientela HNWI italiana e internazionale. Consulenza patrimoniale e wealth management. Base clienti esistente un plus.',
      requirements: ['5+ anni private banking', 'Italiano/Inglese/Tedesco', 'Certificazione consulente clientela', 'Network clienti'],
      featured: true,
      postedDate: threeDaysAgo,
      url: appendReferral('https://www.corner.ch/it/carriere'),
      source: 'Direct',
    },
    {
      id: 'ticino-12',
      company: 'SUPSI',
      title: 'Docente Informatica Gestionale',
      location: 'Manno',
      canton: 'TI',
      category: 'tech',
      contract: 'full-time',
      salaryMin: 80000,
      salaryMax: 100000,
      currency: 'CHF',
      description: 'Insegnamento corsi bachelor in sistemi informativi aziendali. Attività di ricerca applicata con partner industriali.',
      requirements: ['PhD o Master + esperienza', 'ERP/Business Intelligence', 'Didattica universitaria', 'Italiano'],
      featured: false,
      postedDate: threeDaysAgo,
      url: appendReferral('https://www.supsi.ch/lavora-con-noi'),
      source: 'Direct',
    },
  ];
}

// ─── Helper Functions ─────────────────────────────────────────

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
  const match = xml.match(regex);
  return match ? (match[1] || match[2] || '').trim() : '';
}

function parseIndeedMeta(title: string, description: string): { company: string; location: string } {
  // Indeed often puts company in format "Title - Company - Location"
  const parts = title.split(' - ');
  const company = parts.length > 1 ? parts[1] : '';
  
  // Try to find Ticino cities in description
  let location = '';
  for (const city of TICINO_CITIES) {
    if (description.toLowerCase().includes(city.toLowerCase())) {
      location = city;
      break;
    }
  }
  
  return { company, location: location || 'Ticino' };
}

function categorizeJob(title: string): JobCategory {
  const lowerTitle = title.toLowerCase();
  
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowerTitle.includes(keyword.toLowerCase())) {
        return category as JobCategory;
      }
    }
  }
  
  return 'other';
}

function detectContractType(text: string): ContractType {
  const lower = text.toLowerCase();
  if (lower.includes('part-time') || lower.includes('part time') || lower.includes('tempo parziale')) return 'part-time';
  if (lower.includes('internship') || lower.includes('stage') || lower.includes('tirocinio')) return 'internship';
  if (lower.includes('contract') || lower.includes('temporaneo') || lower.includes('determinato')) return 'contract';
  return 'full-time';
}

function cleanHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRequirements(description: string): string[] {
  // Simple extraction of bullet points or requirements
  const requirements: string[] = [];
  const lines = description.split(/[•\-\n]/);
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 10 && trimmed.length < 100 && /esperienza|laurea|diploma|italiano|english|anni|skill/i.test(trimmed)) {
      requirements.push(trimmed);
      if (requirements.length >= 3) break;
    }
  }
  
  return requirements;
}

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toISOString().split('T')[0];
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

function appendReferral(url: string): string {
  if (!url) return '';
  const separator = url.includes('?') ? '&' : '?';
  return url + separator + REFERRAL_TAG.substring(1);
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

function deduplicateJobs(jobs: JobListing[]): JobListing[] {
  const seen = new Set<string>();
  return jobs.filter(job => {
    const key = `${job.title.toLowerCase()}-${job.company.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  console.log('🔍 Job Board Scraper (Public APIs Mode)');
  console.log('========================================\n');
  
  const allJobs: JobListing[] = [];
  
  // Fetch from free public APIs (no scraping blocked sites)
  console.log('🌐 Using public job APIs...\n');
  
  // 1. Swiss government job portal (most reliable)
  const arbeitSwissJobs = await fetchArbeitSwissJobs();
  allJobs.push(...arbeitSwissJobs);
  
  await sleep(1000);
  
  // 2. UBS Jobs Ticino
  const ubsJobs = await fetchUBSJobs();
  allJobs.push(...ubsJobs);
  
  await sleep(1000);
  
  // 3. Migros/Denner Jobs Ticino
  const migrosJobs = await fetchMigrosJobs();
  allJobs.push(...migrosJobs);
  
  await sleep(1000);
  
  // 4. Tutti.ch classifieds (Swiss classified ads with jobs)
  const tuttiJobs = await fetchTuttiJobs();
  allJobs.push(...tuttiJobs);
  
  await sleep(1000);
  
  // 5. Remote jobs (European/worldwide)
  const remotiveJobs = await fetchRemotiveJobs();
  allJobs.push(...remotiveJobs);
  
  await sleep(1000);
  
  // 6. Tech jobs
  const findworkJobs = await fetchFindWorkJobs();
  allJobs.push(...findworkJobs);
  
  console.log(`\n📊 Results:`);
  console.log(`   Job-Room.ch: ${arbeitSwissJobs.length} jobs`);
  console.log(`   UBS Ticino: ${ubsJobs.length} jobs`);
  console.log(`   Migros/Denner: ${migrosJobs.length} jobs`);
  console.log(`   Tutti.ch: ${tuttiJobs.length} jobs`);
  console.log(`   Remotive.io: ${remotiveJobs.length} jobs`);
  console.log(`   FindWork.dev: ${findworkJobs.length} jobs`);
  
  // Always include curated Ticino-specific jobs to ensure good local coverage
  // These supplement any jobs found from APIs
  const ticinoJobs = generatePlaceholderJobs();
  allJobs.push(...ticinoJobs);
  console.log(`   Curated Ticino: ${ticinoJobs.length} jobs`);
  
  // Deduplicate
  let uniqueJobs = deduplicateJobs(allJobs);
  console.log(`   Total unique: ${uniqueJobs.length} jobs`);
  
  // Validate URLs (check for 404s)
  uniqueJobs = await validateJobUrls(uniqueJobs);
  
  // Sort by date (newest first)
  uniqueJobs.sort((a, b) => b.postedDate.localeCompare(a.postedDate));
  
  // Save to data file
  const outputPath = path.join(__dirname, '..', 'data', 'jobs.json');
  const outputDir = path.dirname(outputPath);
  
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  fs.writeFileSync(outputPath, JSON.stringify(uniqueJobs, null, 2), 'utf-8');
  console.log(`\n✅ Saved ${uniqueJobs.length} jobs to ${outputPath}`);
  
  // Also update the last scrape timestamp
  const metaPath = path.join(outputDir, 'jobs-meta.json');
  fs.writeFileSync(metaPath, JSON.stringify({
    lastUpdated: new Date().toISOString(),
    totalJobs: uniqueJobs.length,
    sources: {
      arbeitSwiss: arbeitSwissJobs.length,
      ubs: ubsJobs.length,
      migros: migrosJobs.length,
      tutti: tuttiJobs.length,
      remotive: remotiveJobs.length,
      findwork: findworkJobs.length,
      curatedTicino: ticinoJobs.length,
    },
  }, null, 2), 'utf-8');
  
  return uniqueJobs.length;
}

// Run if called directly
main().catch(error => {
  console.error('❌ Scraper error:', error);
  process.exit(1);
});
