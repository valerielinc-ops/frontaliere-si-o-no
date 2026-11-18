import { describe, expect, it } from 'vitest';
import { formPostingMatch, namesAnotherEmployer } from '../scripts/assisted-application/lib/portal/portal.mjs';

describe('portal form binding identity', () => {
  it('uses the exact employer-site application entry as the binding discriminator', () => {
    const applicationUrl = 'https://apply.example.test/forms/selected-role';
    const job = { company: 'Example Employer', title: 'Payroll Specialist' };

    expect(formPostingMatch('Application\nFirst name\nE-mail', job, {
      postingMatched: true,
      applicationEntry: true,
      applicationEntryUrl: applicationUrl,
      pageUrl: applicationUrl,
      postingUrl: 'https://careers.example.test/jobs/payroll-specialist',
      applyUrl: applicationUrl,
    })).toBe('match');
    expect(formPostingMatch('Application\nFirst name\nE-mail', job, {
      postingMatched: true,
      applicationEntry: true,
      applicationEntryUrl: applicationUrl,
      pageUrl: 'https://apply.example.test/forms/another-role',
      postingUrl: 'https://careers.example.test/jobs/payroll-specialist',
      applyUrl: applicationUrl,
    })).toBe('unknown');
  });

  it.each([
    ['Pinpoint',
      'https://kempinski.pinpointhq.com/en/postings/9d8a7c6b-5e4f-4321-9abc-0123456789de',
      'https://kempinski.pinpointhq.com/en/postings/9d8a7c6b-5e4f-4321-9abc-0123456789de/applications/new'],
    ['BrassRing',
      'https://jobs.ubs.com/TGNewUI/Search/Home/HomeWithPreLoad?partnerid=25008&siteid=5012&jobid=348358&PageType=jobdetails',
      'https://jobs.ubs.com/TGNewUI/Search/Home/HomeWithPreLoad?partnerid=25008&siteid=5012&jobid=348358&PageType=jobdetails#application'],
    ['Workday',
      'https://rituals.wd3.myworkdayjobs.com/en-US/Rituals/job/Zurich/Store-Assistant_R-19033',
      'https://rituals.wd3.myworkdayjobs.com/en-US/Rituals/job/Zurich/Store-Assistant_R-19033/apply/applyManually'],
  ])('uses the %s route discriminator for a generic ATS form', (_ats, postingUrl, applicationUrl) => {
    expect(formPostingMatch('Application\nFirst name\nE-mail', {
      company: 'Example Employer', title: 'Store Assistant',
    }, {
      postingMatched: true,
      postingEntry: true,
      applicationEntry: true,
      applicationEntryUrl: applicationUrl,
      pageUrl: applicationUrl,
      postingUrl,
      applyUrl: applicationUrl,
    })).toBe('match');
  });

  it('uses a proved Workday account handoff as the route binding', () => {
    const applyUrl = 'https://acme.wd3.myworkdayjobs.com/fr-FR/AcmeCareers/job/Mendrisio%2C-Outlet/Consultant_R-12345-1/apply/applyManually';
    const accountUrl = 'https://acme.wd3.myworkdayjobs.com/fr-FR/AcmeCareers/createAccount';

    expect(formPostingMatch('Application\nFirst name\nE-mail', {
      company: 'Acme AG', title: 'Consultant',
    }, {
      pageUrl: accountUrl,
      applyUrl,
      applicationEntry: true,
      postingMatched: true,
      applicationEntryUrl: accountUrl,
    })).toBe('match');
  });

  it('does not treat the selected role after a separator as another employer', () => {
    expect(namesAnotherEmployer('Example Employer - Payroll Specialist', {
      company: 'Example Employer',
      title: 'Payroll Specialist',
    })).toBe(false);
  });

  it('does not carry a stale application entry through a diverted route', () => {
    expect(formPostingMatch('Application\nPayroll Specialist', {
      company: 'Example Employer',
      title: 'Payroll Specialist',
    }, {
      postingMatched: true,
      applicationEntry: true,
      applicationEntryUrl: 'https://paid.example/apply/',
      pageUrl: 'https://other.example/spontaneous/',
      postingUrl: 'https://paid.example/job/123/',
    })).toBe('unknown');
  });

  it('recognizes safe hyphen-separated components of an employer-owned host', () => {
    expect(formPostingMatch('Application', {
      company: 'Example Employer',
      title: 'Payroll Specialist',
    }, {
      postingEntry: true,
      applicationEntry: true,
      applicationEntryUrl: 'https://apply.example-employer.ch/form/',
      pageUrl: 'https://apply.example-employer.ch/form/',
      postingUrl: 'https://jobs.example.ch/job/123/',
    })).toBe('match');
  });

  it('keeps generic application step headings from looking like another employer', () => {
    const job = { company: 'Acme AG', title: 'Senior Engineer' };
    const pageUrl = 'https://careers.acme.example/application';

    for (const heading of [
      'My Information', 'My Experience', 'My Documents', 'Application Questions', 'Voluntary Disclosures', 'My Education',
      'Meine Ausbildung', 'Mes études', 'La mia formazione', 'Review', 'Review and Submit', 'Personal Details',
      'Contact Details', 'Your Profile', 'Work History', 'Candidate Details',
    ]) {
      expect(formPostingMatch(`${heading}\nSenior Engineer`, job, {
        pageUrl,
        postingMatched: true,
        applicationEntry: true,
        pageHeading: heading,
        pageHeadings: [heading],
      })).toBe('unknown');
    }

    expect(formPostingMatch('Review\nSenior Engineer', job, {
      pageUrl,
      postingMatched: true,
      applicationEntry: true,
      pageHeading: 'Review - Other Resort',
      pageHeadings: ['Review - Other Resort'],
    })).toBe('mismatch');
  });

  it('requires exact TalentSoft requisition binding and an unambiguous visible heading set', () => {
    const job = { company: 'Ferrovia Retica (RhB)', title: 'Senior Engineer' };
    const pageUrl = 'https://rhb-career.talent-soft.com/job/fixture_2233.aspx';
    const paidPostingUrl = `${pageUrl}?source=paid-posting`;
    const localizedForm = `My application\nRhätische Bahn - My application\n${job.title}`;

    expect(formPostingMatch(localizedForm, job, {
      pageUrl,
      paidPostingUrl,
      pageHeading: 'Rhätische Bahn - My application',
    })).toBe('match');
    expect(formPostingMatch(localizedForm, job, {
      pageUrl,
      paidPostingUrl: paidPostingUrl.replace('_2233.aspx', '_2234.aspx'),
      postingEntry: true,
      pageHeading: 'Rhätische Bahn - My application',
    })).toBe('mismatch');
    expect(formPostingMatch('My application\nSenior Engineer', job, {
      pageUrl,
      paidPostingUrl,
      pageHeadings: ['Rhätische Bahn - My application', 'Other Resort - My application'],
    })).toBe('mismatch');
    expect(formPostingMatch('My application\nSenior Engineer', job, {
      pageUrl,
      paidPostingUrl,
      pageHeadings: null,
    })).toBe('unknown');
    expect(formPostingMatch('My application\nSenior Engineer', job, {
      pageUrl: 'https://rhb-career.talent-soft.com/application',
      pageHeadings: null,
    })).toBe('unknown');

    const wrongFinalRoute = pageUrl.replace('_2233.aspx', '_2234.aspx');
    expect(formPostingMatch('My application\nSenior Engineer', job, {
      pageUrl: wrongFinalRoute,
      paidPostingUrl,
      postingEntry: true,
      postingMatched: true,
      pageHeadings: [],
    })).toBe('mismatch');
  });

  it('keeps the ambiguous “About You” heading unresolved until the posting link is proved', () => {
    const job = { company: 'Acme AG', title: 'Senior Engineer' };
    const formText = 'About You\nSenior Engineer';
    const pageUrl = 'https://careers.example/application';
    const heading = 'About You';

    expect(formPostingMatch(formText, job, {
      pageUrl,
      pageHeading: heading,
      pageHeadings: [heading],
    })).toBe('unknown');
    expect(formPostingMatch(formText, job, {
      pageUrl,
      postingMatched: true,
      applicationEntry: true,
      pageHeading: heading,
      pageHeadings: [heading],
    })).toBe('unknown');
    expect(formPostingMatch(formText, job, {
      pageUrl,
      postingMatched: true,
      applicationEntry: true,
      pageHeading: 'About You - Other Resort',
      pageHeadings: ['About You - Other Resort'],
    })).toBe('unknown');
    expect(formPostingMatch(formText, { company: 'ABOUT YOU', title: job.title }, {
      pageUrl,
      pageHeading: heading,
      pageHeadings: [heading],
    })).toBe('match');
  });

  it('keeps an unexplained comma-separated employer heading unresolved', () => {
    const job = { company: 'Acme AG', title: 'Senior Engineer' };
    for (const heading of [
      'Acme, other resort', 'Acme, other resort in Lugano', 'Acme, other resort with benefits',
      'Acme, other resort and services', 'Acme, other resort at Lugano',
    ]) {
      expect(formPostingMatch(`${heading}\n${job.title}`, job, {
        pageUrl: 'https://careers.example/application',
        postingMatched: true,
        applicationEntry: true,
        pageHeading: heading,
        pageHeadings: [heading],
      })).toBe('unknown');
    }
  });

  it('keeps a known subsidiary description attached to the selected employer', () => {
    const job = { company: 'Acme AG', title: 'Senior Engineer' };
    const heading = 'Acme, young affiliate of Example Group';
    expect(formPostingMatch(`${heading}\n${job.title}`, job, {
      pageUrl: 'https://careers.example/application',
      postingMatched: true,
      applicationEntry: true,
      pageHeading: heading,
      pageHeadings: [heading],
    })).toBe('match');

    const wrongEmployerHeading = 'Acme, young subsidiary of Other Resort';
    expect(formPostingMatch(`${wrongEmployerHeading}\n${job.title}`, {
      company: 'Other Resort AG', title: job.title,
    }, {
      pageUrl: 'https://careers.example/application',
      postingMatched: true,
      applicationEntry: true,
      pageHeading: wrongEmployerHeading,
      pageHeadings: [wrongEmployerHeading],
    })).toBe('unknown');
  });
});
