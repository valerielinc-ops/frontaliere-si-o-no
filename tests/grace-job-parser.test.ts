import { describe, expect, it } from 'vitest';
import { selectGraceDescription } from '../scripts/lib/grace-job-parser.mjs';

describe('grace-job-parser', () => {
  it('prefers the rich jobDesigner container over the short meta teaser', () => {
    const description = selectGraceDescription({
      metaDesc: 'Looking for a job as Front Office Supervisor? Start your new career!',
      containerText: `WHO WE NEED We are looking for ambitious talents who will become the shapers of the new reborn legendary hotel in one of the most prestigious alpine resorts in the world.
        WHAT WILL YOU DO? Maintain highest standards of a 5* superior hotel reception, ensure outstanding customer care, be a role model for the team and create memorable guest experiences.
        YOUR PROFILE You have hospitality experience, lead with example, take ownership and enjoy working in a fast-paced luxury environment.`,
    });

    expect(description).toContain('WHO WE NEED');
    expect(description).toContain('WHAT WILL YOU DO?');
    expect(description.length).toBeGreaterThan(280);
    expect(description).not.toBe('Looking for a job as Front Office Supervisor? Start your new career!');
  });

  it('falls back to the meta description when no richer content exists', () => {
    const description = selectGraceDescription({
      metaDesc: 'Looking for a job as Concierge? Start your new career!',
      containerText: '',
      mainText: '',
      bodyText: '',
    });

    expect(description).toBe('Looking for a job as Concierge? Start your new career!');
  });
});
