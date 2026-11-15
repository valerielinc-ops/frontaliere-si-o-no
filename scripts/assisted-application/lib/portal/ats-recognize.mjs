/**
 * ATS host/extraction hints adapted from freehire (MIT, Copyright (c) 2026 freehire contributors).
 * This module is pure: it reads only supplied URLs/markup and performs no I/O.
 */
export const ATS_BOARD_HOSTS = Object.freeze([
  {
    "host": "greenhouse.io",
    "provider": "greenhouse",
    "mode": "path"
  },
  {
    "host": "jobs.lever.co",
    "provider": "lever",
    "mode": "path"
  },
  {
    "host": "jobs.eu.lever.co",
    "provider": "lever",
    "mode": "path"
  },
  {
    "host": "jobs.ashbyhq.com",
    "provider": "ashby",
    "mode": "path"
  },
  {
    "host": "jobs.humanbit.ai",
    "provider": "humanbit",
    "mode": "path"
  },
  {
    "host": "jobs.recrutei.com.br",
    "provider": "recrutei",
    "mode": "path"
  },
  {
    "host": "jobs.pyjamahr.com",
    "provider": "pyjamahr",
    "mode": "path"
  },
  {
    "host": "apply.workable.com",
    "provider": "workable",
    "mode": "path"
  },
  {
    "host": "jobs.deel.com",
    "provider": "deel",
    "mode": "path"
  },
  {
    "host": "mein-check-in.de",
    "provider": "meincheckin",
    "mode": "path"
  },
  {
    "host": "jobs.gem.com",
    "provider": "gem",
    "mode": "path"
  },
  {
    "host": "jobs.friend.work",
    "provider": "friendwork",
    "mode": "path"
  },
  {
    "host": "jobs.jobvite.com",
    "provider": "jobvite",
    "mode": "path"
  },
  {
    "host": "herp.careers",
    "provider": "herp",
    "mode": "path"
  },
  {
    "host": "hrmos.co",
    "provider": "hrmos",
    "mode": "path"
  },
  {
    "host": "jobs.quickin.io",
    "provider": "quickin",
    "mode": "path"
  },
  {
    "host": "jobs.talenthr.io",
    "provider": "talenthr",
    "mode": "path"
  },
  {
    "host": "jobs.polymer.co",
    "provider": "polymer",
    "mode": "path"
  },
  {
    "host": "careers.pageuppeople.com",
    "provider": "pageup",
    "mode": "path_numeric"
  },
  {
    "host": "oportunidades.mindsight.com.br",
    "provider": "mindsight",
    "mode": "path"
  },
  {
    "host": "careers.hireology.com",
    "provider": "hireology",
    "mode": "path"
  },
  {
    "host": "hireology.careers",
    "provider": "hireology",
    "mode": "subdomain"
  },
  {
    "host": "myjobs.adp.com",
    "provider": "adpmyjobs",
    "mode": "path"
  },
  {
    "host": "applitrack.com",
    "provider": "applitrack",
    "mode": "path"
  },
  {
    "host": "careers-page.com",
    "provider": "manatal",
    "mode": "path"
  },
  {
    "host": "jobs.gusto.com",
    "provider": "gusto",
    "mode": "path"
  },
  {
    "host": "jobs.appone.com",
    "provider": "appone",
    "mode": "path"
  },
  {
    "host": "careers.jobscore.com",
    "provider": "jobscore",
    "mode": "path"
  },
  {
    "host": "jobs.smartrecruiters.com",
    "provider": "smartrecruiters",
    "mode": "path_portal"
  },
  {
    "host": "careers.smartrecruiters.com",
    "provider": "smartrecruiters",
    "mode": "path_portal"
  },
  {
    "host": "ats.rippling.com",
    "provider": "rippling",
    "mode": "path_locale"
  },
  {
    "host": "jobs.dayforcehcm.com",
    "provider": "dayforce",
    "mode": "path_locale_pair"
  },
  {
    "host": "careers.werecruit.io",
    "provider": "werecruit",
    "mode": "path_pair"
  },
  {
    "host": "recruitingbypaycor.com",
    "provider": "paycor",
    "mode": "query"
  },
  {
    "host": "candidate.hr-manager.net",
    "provider": "hrmanager",
    "mode": "query"
  },
  {
    "host": "pulse.tenstreet.com",
    "provider": "tenstreet",
    "mode": "query"
  },
  {
    "host": "skk.erecruiter.pl",
    "provider": "erecruiter",
    "mode": "query"
  },
  {
    "host": "eightfold.ai",
    "provider": "eightfold",
    "mode": "query"
  },
  {
    "host": "workforcenow.adp.com",
    "provider": "adp",
    "mode": "query_pair"
  },
  {
    "host": "tbe.taleo.net",
    "provider": "taleobe",
    "mode": "query_pair"
  },
  {
    "host": "icims.com",
    "provider": "icims",
    "mode": "icims"
  },
  {
    "host": "betterteam.com",
    "provider": "betterteam",
    "mode": "subdomain"
  },
  {
    "host": "recruitee.com",
    "provider": "recruitee",
    "mode": "subdomain"
  },
  {
    "host": "bamboohr.com",
    "provider": "bamboohr",
    "mode": "subdomain"
  },
  {
    "host": "breezy.hr",
    "provider": "breezy",
    "mode": "subdomain"
  },
  {
    "host": "jobspage.co",
    "provider": "jobspage",
    "mode": "subdomain"
  },
  {
    "host": "onlyfy.jobs",
    "provider": "onlyfy",
    "mode": "subdomain"
  },
  {
    "host": "jobbase.io",
    "provider": "onlyfy",
    "mode": "subdomain"
  },
  {
    "host": "freshteam.com",
    "provider": "freshteam",
    "mode": "subdomain"
  },
  {
    "host": "peopleforce.io",
    "provider": "peopleforce",
    "mode": "subdomain"
  },
  {
    "host": "potok.io",
    "provider": "potok",
    "mode": "subdomain"
  },
  {
    "host": "jobs.personio.com",
    "provider": "personio",
    "mode": "subdomain"
  },
  {
    "host": "jobs.personio.de",
    "provider": "personio",
    "mode": "subdomain"
  },
  {
    "host": "pinpointhq.com",
    "provider": "pinpoint",
    "mode": "subdomain"
  },
  {
    "host": "scalis.ai",
    "provider": "scalis",
    "mode": "subdomain"
  },
  {
    "host": "keka.com",
    "provider": "keka",
    "mode": "subdomain"
  },
  {
    "host": "hirehive.com",
    "provider": "hirehive",
    "mode": "subdomain"
  },
  {
    "host": "app.beehire.com",
    "provider": "beehire",
    "mode": "path_pattern"
  },
  {
    "host": "inploi.com",
    "provider": "inploi",
    "mode": "path_pattern"
  },
  {
    "host": "seamlesshiring.com",
    "provider": "seamlesshiring",
    "mode": "subdomain"
  },
  {
    "host": "selfrecruit.ge",
    "provider": "selfrecruit",
    "mode": "subdomain"
  },
  {
    "host": "talentlyft.com",
    "provider": "talentlyft",
    "mode": "subdomain"
  },
  {
    "host": "traffit.com",
    "provider": "traffit",
    "mode": "subdomain"
  },
  {
    "host": "recruitify.ai",
    "provider": "recruitify",
    "mode": "subdomain"
  },
  {
    "host": "applytojob.com",
    "provider": "jazzhr",
    "mode": "subdomain"
  },
  {
    "host": "applicantpro.com",
    "provider": "applicantpro",
    "mode": "subdomain"
  },
  {
    "host": "isolvedhire.com",
    "provider": "isolvedhire",
    "mode": "subdomain"
  },
  {
    "host": "careerplug.com",
    "provider": "careerplug",
    "mode": "subdomain"
  },
  {
    "host": "applicantstack.com",
    "provider": "applicantstack",
    "mode": "subdomain"
  },
  {
    "host": "hcshiring.com",
    "provider": "hcshiring",
    "mode": "subdomain"
  },
  {
    "host": "csod.com",
    "provider": "cornerstone",
    "mode": "subdomain"
  },
  {
    "host": "enlizt.me",
    "provider": "enlizt",
    "mode": "subdomain"
  },
  {
    "host": "hurma.work",
    "provider": "hurma",
    "mode": "subdomain"
  },
  {
    "host": "inhire.app",
    "provider": "inhire",
    "mode": "subdomain"
  },
  {
    "host": "likeit.fi",
    "provider": "likeit",
    "mode": "subdomain"
  },
  {
    "host": "spark.work",
    "provider": "spark",
    "mode": "subdomain"
  },
  {
    "host": "hire.trakstar.com",
    "provider": "trakstar",
    "mode": "subdomain"
  },
  {
    "host": "recruiterbox.com",
    "provider": "trakstar",
    "mode": "subdomain"
  },
  {
    "host": "easyapply.co",
    "provider": "gethired",
    "mode": "subdomain"
  },
  {
    "host": "firefishsoftware.com",
    "provider": "firefish",
    "mode": "host"
  },
  {
    "host": "portaldetalentos.senior.com.br",
    "provider": "senior",
    "mode": "subdomain"
  },
  {
    "host": "vagas.solides.com.br",
    "provider": "solides",
    "mode": "subdomain"
  },
  {
    "host": "softgarden.io",
    "provider": "softgarden",
    "mode": "subdomain"
  },
  {
    "host": "career.softgarden.de",
    "provider": "softgarden",
    "mode": "subdomain"
  },
  {
    "host": "careers.hibob.com",
    "provider": "hibob",
    "mode": "subdomain"
  },
  {
    "host": "coveto.de",
    "provider": "coveto",
    "mode": "subdomain"
  },
  {
    "host": "concludis.de",
    "provider": "concludis",
    "mode": "subdomain"
  },
  {
    "host": "kenjo.io",
    "provider": "kenjo",
    "mode": "subdomain"
  },
  {
    "host": "talentstorm.de",
    "provider": "talentstorm",
    "mode": "subdomain"
  },
  {
    "host": "homerun.co",
    "provider": "homerun",
    "mode": "subdomain"
  },
  {
    "host": "easycruit.com",
    "provider": "easycruit",
    "mode": "subdomain"
  },
  {
    "host": "oorwin.com",
    "provider": "oorwin",
    "mode": "subdomain"
  },
  {
    "host": "inhroffice.com",
    "provider": "hroffice",
    "mode": "subdomain"
  },
  {
    "host": "epreselec.com",
    "provider": "epreselec",
    "mode": "subdomain"
  },
  {
    "host": "viterbit.site",
    "provider": "viterbit",
    "mode": "subdomain"
  },
  {
    "host": "helixjobs.com",
    "provider": "helixjobs",
    "mode": "query"
  },
  {
    "host": "jobpage.cvwarehouse.com",
    "provider": "cvwarehouse",
    "mode": "query"
  },
  {
    "host": "career.emply.com",
    "provider": "emply",
    "mode": "subdomain"
  },
  {
    "host": "hrmdirect.com",
    "provider": "hrmdirect",
    "mode": "subdomain"
  },
  {
    "host": "apply.clearcompany.com",
    "provider": "hrmdirect",
    "mode": "path_pattern"
  },
  {
    "host": "hireclick.com",
    "provider": "hireclick",
    "mode": "subdomain"
  },
  {
    "host": "hiringroom.com",
    "provider": "hiringroom",
    "mode": "subdomain"
  },
  {
    "host": "gupy.io",
    "provider": "gupy",
    "mode": "subdomain"
  },
  {
    "host": "intervieweb",
    "provider": "intervieweb",
    "mode": "host"
  },
  {
    "host": "pandape.infojobs.com.br",
    "provider": "pandape",
    "mode": "subdomain"
  },
  {
    "host": "pandape.catho.com.br",
    "provider": "pandape",
    "mode": "subdomain"
  },
  {
    "host": "pandape.com.br",
    "provider": "pandape",
    "mode": "subdomain"
  },
  {
    "host": "pandape.computrabajo.com",
    "provider": "pandapelatam",
    "mode": "subdomain"
  },
  {
    "host": "huntflow.io",
    "provider": "huntflow",
    "mode": "subdomain_chain"
  },
  {
    "host": "zohorecruit",
    "provider": "zohorecruit",
    "mode": "host"
  },
  {
    "host": "teamtailor",
    "provider": "teamtailor",
    "mode": "host"
  },
  {
    "host": "factorial",
    "provider": "factorial",
    "mode": "host"
  },
  {
    "host": "factorialhr",
    "provider": "factorial",
    "mode": "host"
  },
  {
    "host": "gr8people",
    "provider": "gr8people",
    "mode": "host"
  },
  {
    "host": "workgr8",
    "provider": "gr8people",
    "mode": "host"
  },
  {
    "host": "eploy",
    "provider": "eploy",
    "mode": "host"
  },
  {
    "host": "dvinci-hr",
    "provider": "dvinci",
    "mode": "host"
  },
  {
    "host": "dvinci-easy",
    "provider": "dvinci",
    "mode": "host"
  },
  {
    "host": "dvinci",
    "provider": "dvinci",
    "mode": "host"
  },
  {
    "host": "talent-soft.com",
    "provider": "talentsoft",
    "mode": "host"
  },
  {
    "host": "profils.org",
    "provider": "talentsoft",
    "mode": "host"
  },
  {
    "host": "digitalrecruiters.com",
    "provider": "digitalrecruiters",
    "mode": "host"
  },
  {
    "host": "bizneo.cloud",
    "provider": "bizneo",
    "mode": "host"
  },
  {
    "host": "rexx-systems",
    "provider": "rexx",
    "mode": "host"
  },
  {
    "host": "rexx-recruitment",
    "provider": "rexx",
    "mode": "host"
  },
  {
    "host": "catsone",
    "provider": "catsone",
    "mode": "host"
  },
  {
    "host": "avature",
    "provider": "avature",
    "mode": "host"
  },
  {
    "host": "recruiter.co.kr",
    "provider": "recruiter_co_kr",
    "mode": "host"
  },
  {
    "host": "umantis.com",
    "provider": "umantis",
    "mode": "host"
  },
  {
    "host": "alignhrsolutions",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "alphastaff-hiring",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "atsmodule",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "checkwritersrecruit",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "deltahire-ats",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "edistoats",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "elevate-ats",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "esi-hire",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "exponentats",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "ezhiregov",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "gnahiring",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "hiringthing",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "iconnecthire",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "lumberhiring",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "nexstarrecruiter",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "oasisrecruit",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "primepay-recruit",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "prismhr-hire",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "rippling-ats",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "tcr-hire",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "teammemberhire-recruit",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "topdoghrrecruiting",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "topgradinghire",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "verahr-hiring",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "viewpointhr-ats",
    "provider": "hiringthing",
    "mode": "host"
  },
  {
    "host": "myworkdayjobs.com",
    "provider": "workday",
    "mode": "host_path"
  },
  {
    "host": "ultipro.com",
    "provider": "ukg",
    "mode": "host_tenant_board"
  },
  {
    "host": "ultipro.ca",
    "provider": "ukg",
    "mode": "host_tenant_board"
  },
  {
    "host": "rec.pro.ukg.net",
    "provider": "ukg",
    "mode": "host_tenant_board"
  },
  {
    "host": "saashr.com",
    "provider": "ukgready",
    "mode": "host_careers"
  },
  {
    "host": "entertimeonline.com",
    "provider": "ukgready",
    "mode": "host_careers"
  },
  {
    "host": "yourpayrollhr.com",
    "provider": "ukgready",
    "mode": "host_careers"
  },
  {
    "host": "mykronos.com",
    "provider": "ukgready",
    "mode": "host_careers"
  },
  {
    "host": "workforceready.com.au",
    "provider": "ukgready",
    "mode": "host_careers"
  },
  {
    "host": "workforceready.eu",
    "provider": "ukgready",
    "mode": "host_careers"
  },
  {
    "host": "paradox.ai",
    "provider": "paradox",
    "mode": "host_site"
  },
  {
    "host": "app.dover.com",
    "provider": "dover",
    "mode": "allowed_first_segment"
  },
  {
    "host": "jobs.dover.com",
    "provider": "dover",
    "mode": "path_pattern"
  },
  {
    "host": "app.higherme.com",
    "provider": "higherme",
    "mode": "allowed_first_segment"
  },
  {
    "host": "jobs.feishu.cn",
    "provider": "feishujobs",
    "mode": "tenant_host"
  },
  {
    "host": "jobs.hr.cloud.sap",
    "provider": "successfactors",
    "mode": "tenant_host"
  },
  {
    "host": "jobs2web.com",
    "provider": "successfactors",
    "mode": "tenant_host"
  },
  {
    "host": "phenompro.com",
    "provider": "phenom",
    "mode": "tenant_host"
  },
  {
    "host": "phenompeople.net",
    "provider": "phenom",
    "mode": "tenant_host"
  },
  {
    "host": "phenompeople.com",
    "provider": "phenom",
    "mode": "tenant_host"
  },
  {
    "host": "darwinbox.in",
    "provider": "darwinbox",
    "mode": "tenant_host"
  },
  {
    "host": "darwinbox.com",
    "provider": "darwinbox",
    "mode": "tenant_host"
  },
  {
    "host": "greythr.com",
    "provider": "greythr",
    "mode": "tenant_host"
  },
  {
    "host": "jibeapply.com",
    "provider": "jibe",
    "mode": "tenant_host"
  },
  {
    "host": "workstream.us",
    "provider": "workstream",
    "mode": "keyed_segment"
  },
  {
    "host": "livehire.com",
    "provider": "livehire",
    "mode": "keyed_segment"
  },
  {
    "host": "harri.com",
    "provider": "harri",
    "mode": "path_job"
  },
  {
    "host": "app.idealtraits.com",
    "provider": "idealtraits",
    "mode": "encoded_careers"
  },
  {
    "host": "paycomonline.net",
    "provider": "paycom",
    "mode": "path_pattern"
  },
  {
    "host": "comeet.com",
    "provider": "comeet",
    "mode": "path_pattern"
  },
  {
    "host": "comeet.co",
    "provider": "comeet",
    "mode": "path_pattern"
  },
  {
    "host": "governmentjobs.com",
    "provider": "neogov",
    "mode": "path_pattern"
  },
  {
    "host": "schooljobs.com",
    "provider": "neogov",
    "mode": "path_pattern"
  },
  {
    "host": "geekhunter.com",
    "provider": "geekhunter",
    "mode": "path_pattern"
  },
  {
    "host": "cleverstaff.net",
    "provider": "cleverstaff",
    "mode": "path_pattern"
  },
  {
    "host": "careers.flatchr.io",
    "provider": "flatchr",
    "mode": "path_pattern"
  },
  {
    "host": "app.trinethire.com",
    "provider": "trinethire",
    "mode": "path_pattern"
  },
  {
    "host": "jobs.gohire.io",
    "provider": "gohire",
    "mode": "path_pattern"
  },
  {
    "host": "recruiterflow.com",
    "provider": "recruiterflow",
    "mode": "path_pattern"
  },
  {
    "host": "taleo.net",
    "provider": "taleo",
    "mode": "path_pattern"
  },
  {
    "host": "oraclecloud.com",
    "provider": "oracle",
    "mode": "path_pattern"
  },
  {
    "host": "app.loxo.co",
    "provider": "loxo",
    "mode": "path_pattern"
  },
  {
    "host": "career.velorahr.com",
    "provider": "velorahr",
    "mode": "path_pattern"
  }
]);

const VENDOR_MARKERS = [
  ['radancy', /talentbrew/iu],
  ['phenom', /phenompeople/iu],
  ['jibe', /jibeapply/iu],
  ['teamtailor', /teamtailor/iu],
  ['bizneo', /\/vite\/assets\/custom-companies-[a-z0-9_-]+\.js/iu],
];
const DIRECT_MATCHERS = [
  ['greenhouse', /(?:^|[^a-z0-9])(?:boards|job-boards)\.greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([a-z0-9][a-z0-9-]*)/iu],
  ['greenhouse', /(?:^|[^a-z0-9])(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9][a-z0-9-]*)/iu],
  ['lever', /(?:^|[^a-z0-9])jobs\.lever\.co\/([a-z0-9][a-z0-9-]*)/iu],
  ['ashby', /(?:^|[^a-z0-9])jobs\.ashbyhq\.com\/([a-z0-9][a-z0-9-]*)/iu],
];
const VENDOR_DOMAINS = [
  'radancy.com', 'talentbrew.com', 'phenom.com', 'phenompeople.com', 'jibe.com', 'jibeapply.com',
  'teamtailor.com', 'bizneo.com', 'bizneo.cloud', 'eightfold.ai',
];
const RESERVED_PATH = new Set(['api', 'apply', 'boards', 'career', 'careers', 'co', 'details', 'embed', 'job', 'jobs', 'login', 'portal', 'search', 'sign-in', 'ta', 'v1']);

function hostMatchesRule(hostname, rule) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./u, '');
  const suffix = String(rule.host || '').toLowerCase();
  if (suffix.includes('.')) return host === suffix || host.endsWith(`.${suffix}`);
  return host.split('.').some((label, index, labels) => label === suffix && index > 0 && index < labels.length - 1);
}

function matchedHostRule(value) {
  let hostname;
  try { hostname = new URL(value).hostname.toLowerCase(); } catch { return null; }
  const matches = ATS_BOARD_HOSTS.filter(rule => hostMatchesRule(hostname, rule))
    .sort((left, right) => right.host.length - left.host.length);
  return matches[0] ? { ...matches[0], hostname } : null;
}

function boardHintFor(url, rule) {
  const segments = url.pathname.split('/').filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment); } catch { return ''; }
  });
  const mode = String(rule.mode || '');
  const locale = value => /^[a-z]{2}(?:-[a-z]{2})?$/iu.test(value || '');
  const firstUseful = segments.find(segment => !RESERVED_PATH.has(segment.toLowerCase())) || '';
  if (mode === 'host') return url.hostname;
  if (mode === 'subdomain' || mode === 'subdomain_chain' || mode === 'tenant_host') {
    const apex = rule.host.includes('.') ? rule.host : '';
    const base = apex && (url.hostname === apex || url.hostname.endsWith(`.${apex}`)) ? apex : '';
    const label = base ? url.hostname.slice(0, -(base.length + 1)) : '';
    return label || '';
  }
  if (mode === 'host_path') {
    const path = segments[0] && locale(segments[0]) ? segments[1] : segments[0];
    return path ? `${url.hostname}/${path}` : '';
  }
  if (mode === 'host_tenant_board') {
    const jobBoard = segments.findIndex(segment => segment.toLowerCase() === 'jobboard');
    return jobBoard > 0 && segments[jobBoard + 1] ? `${url.hostname}/${segments[jobBoard - 1]}/${segments[jobBoard + 1]}` : '';
  }
  if (mode === 'host_careers') {
    const ta = segments.findIndex(segment => segment.toLowerCase() === 'ta');
    return ta >= 0 && segments[ta + 1] ? `${url.hostname}/${segments[ta + 1].replace(/\.careers$/iu, '')}` : '';
  }
  if (mode === 'host_site') {
    const co = segments.findIndex(segment => segment.toLowerCase() === 'co');
    return co >= 0 && segments[co + 1] ? `${url.hostname}/${segments[co + 1].toLowerCase()}` : '';
  }
  if (mode === 'path_locale') return (locale(segments[0]) ? segments[1] : segments[0]) || '';
  if (mode === 'path_locale_pair') {
    const start = locale(segments[0]) ? 1 : 0;
    return segments[start + 1] ? `${segments[start]}/${segments[start + 1]}`.toLowerCase() : '';
  }
  if (mode === 'encoded_careers') {
    if (segments.length < 3 || segments[2].toLowerCase() !== 'careers') return '';
    const encoded = segments[1];
    if (!/^[a-z0-9+/]+={0,2}$/iu.test(encoded)) return '';
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return /^(?:0|[1-9]\d*)$/u.test(decoded) && Buffer.from(decoded).toString('base64') === encoded ? decoded : '';
  }
  if (mode === 'path_pair') return segments[1] ? `${segments[0]}/${segments[1]}` : '';
  if (mode === 'query') {
    const key = [...url.searchParams.keys()].find(name => /^(?:clientid|customer|company_id|cfg|companyguid|subdomain|domain)$/iu.test(name));
    return key ? url.searchParams.get(key) || '' : '';
  }
  if (mode === 'query_pair') {
    const values = [...url.searchParams.entries()].filter(([key]) => /^(?:cid|ccid|org|cws)$/iu.test(key)).map(([, value]) => value);
    return values.length >= 2 ? values.slice(0, 2).join(':') : '';
  }
  if (mode === 'path_job') return segments[0] || '';
  if (mode === 'path_pattern' || mode === 'path_portal' || mode === 'allowed_first_segment' || mode === 'keyed_segment') {
    const jobIndex = segments.findIndex(segment => /^(?:job|jobs|career|careers|postings|v4)$/iu.test(segment));
    return (jobIndex >= 0 ? segments[jobIndex + 1] : firstUseful) || '';
  }
  if (mode === 'path_numeric') return segments.find(segment => /^\d+$/u.test(segment)) || '';
  if (mode === 'icims') return url.hostname;
  return firstUseful;
}

function absoluteUrls(value) {
  return [...String(value || '').matchAll(/https?:\/\/[^\s"'<>()[\]{}\\]+/giu)].map(match => match[0].replace(/[.,;!?]+$/u, ''));
}

function htmlLinks(html) {
  const links = [];
  for (const match of String(html || '').matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/giu)) {
    const href = match[2].replace(/&amp;/giu, '&');
    const text = match[3].replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim();
    try { links.push({ href: new URL(href, 'https://local.invalid').href, text }); } catch { /* malformed link */ }
  }
  return links;
}

function normalized(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function matchesPostingLink(value, text, job = {}) {
  let url;
  try { url = new URL(value); } catch { return false; }
  const whole = `${url.pathname} ${url.search}`.toLowerCase();
  const reqId = String(job.requirementId || job.reqId || job.jobId || '').trim().toLowerCase();
  if (reqId && whole.includes(reqId)) return true;
  const title = normalized(job.title);
  return title.length >= 8 && normalized(`${url.pathname} ${text}`).includes(title);
}

function sameHostSearchUrl(pageUrl, job = {}) {
  try {
    const current = new URL(pageUrl);
    if (current.protocol !== 'https:') return '';
    const search = new URL('/search', current.origin);
    const query = [job.requirementId || job.reqId || job.jobId, job.title].filter(Boolean).join(' ');
    if (!query) return '';
    search.searchParams.set('q', String(query).slice(0, 180));
    return search.href;
  } catch {
    return '';
  }
}

/** Detect a supported ATS route or ATS links embedded in a custom careers site. */
export function recognizeAts({ pageUrl = '', html = '', snapshot = '', job = {} } = {}) {
  const links = [...htmlLinks(html), ...absoluteUrls(`${html}\n${snapshot}`).map(href => ({ href, text: '' }))];
  const urlCandidates = [pageUrl, ...links.map(link => link.href)].filter(Boolean);
  let recognized = null;
  for (const value of urlCandidates) {
    for (const [provider, pattern] of DIRECT_MATCHERS) {
      const match = pattern.exec(value);
      if (match) {
        recognized = { provider, mode: 'direct_link', boardHint: match[1], source: value === pageUrl ? 'route' : 'link' };
        break;
      }
    }
    if (recognized) break;
    const rule = matchedHostRule(value);
    if (rule) {
      let parsed;
      try { parsed = new URL(value); } catch { continue; }
      recognized = { provider: rule.provider, mode: rule.mode, boardHint: boardHintFor(parsed, rule), source: value === pageUrl ? 'route' : 'link' };
      break;
    }
  }
  if (!recognized) {
    const host = (() => { try { return new URL(pageUrl).hostname; } catch { return ''; } })();
    const isVendorDomain = VENDOR_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
    if (!isVendorDomain) {
      const marker = VENDOR_MARKERS.find(([, pattern]) => pattern.test(html));
      if (marker && host) recognized = { provider: marker[0], mode: 'self_hosted', boardHint: host, source: 'page_fingerprint' };
    }
  }
  if (!recognized) return { provider: '', mode: '', boardHint: '', source: 'unknown', canonicalPostingUrl: '', searchUrl: sameHostSearchUrl(pageUrl, job) };
  const postingLink = links.find(link => matchesPostingLink(link.href, link.text, job));
  let canonicalPostingUrl = '';
  if (postingLink) {
    try {
      const url = new URL(postingLink.href);
      if (url.protocol === 'https:' && !url.username && !url.password) canonicalPostingUrl = url.href;
    } catch { /* no canonical posting link */ }
  }
  return {
    ...recognized,
    boardHint: String(recognized.boardHint || '').slice(0, 180),
    canonicalPostingUrl,
    searchUrl: sameHostSearchUrl(pageUrl, job),
  };
}
