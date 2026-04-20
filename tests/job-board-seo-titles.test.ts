import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildJobBoardSeo,
  countActiveJobsByLocale,
  getActiveJobCountsByLocale,
  isJobActiveForLocale,
  isJobBoardLandingPath,
  FIRE_EMOJI_THRESHOLD,
  JOB_BOARD_LANDING_PATHS,
  type JobBoardLocale,
} from '../build-plugins/jobBoardSeo'

describe('isJobBoardLandingPath', () => {
  it('matches all four landing paths with trailing slash', () => {
    expect(isJobBoardLandingPath('/cerca-lavoro-ticino/')).toBe(true)
    expect(isJobBoardLandingPath('/en/find-jobs-ticino/')).toBe(true)
    expect(isJobBoardLandingPath('/de/jobs-im-tessin/')).toBe(true)
    expect(isJobBoardLandingPath('/fr/trouver-emploi-tessin/')).toBe(true)
  })

  it('matches paths without trailing slash', () => {
    expect(isJobBoardLandingPath('/cerca-lavoro-ticino')).toBe(true)
    expect(isJobBoardLandingPath('/en/find-jobs-ticino')).toBe(true)
  })

  it('does not match detail pages or unrelated paths', () => {
    expect(isJobBoardLandingPath('/cerca-lavoro-ticino/some-job-slug/')).toBe(false)
    expect(isJobBoardLandingPath('/cerca-lavoro-ticino/pagina-2/')).toBe(false)
    expect(isJobBoardLandingPath('/')).toBe(false)
    expect(isJobBoardLandingPath('/en/')).toBe(false)
    expect(isJobBoardLandingPath('')).toBe(false)
  })
})

describe('buildJobBoardSeo', () => {
  const year = 2026

  it('injects count and fire emoji when count >= threshold (IT)', () => {
    const entry = buildJobBoardSeo('it', 2408, year)
    expect(entry.title.startsWith('🔥 2408 ')).toBe(true)
    expect(entry.title).toContain(`${year}`)
    expect(entry.title).toContain('Offerte di Lavoro Ticino')
    expect(entry.title).toContain('Frontaliere Ticino')
    expect(entry.desc).toContain('2408')
    expect(entry.desc).toContain('case anziani')
    expect(entry.ogT.startsWith('🔥 2408 ')).toBe(true)
  })

  it('omits fire emoji when count below threshold', () => {
    const below = FIRE_EMOJI_THRESHOLD - 1
    const entry = buildJobBoardSeo('it', below, year)
    expect(entry.title.startsWith(`${below} Offerte`)).toBe(true)
    expect(entry.title).not.toContain('🔥')
  })

  it('injects fire emoji exactly at threshold', () => {
    const entry = buildJobBoardSeo('en', FIRE_EMOJI_THRESHOLD, year)
    expect(entry.title.startsWith(`🔥 ${FIRE_EMOJI_THRESHOLD} `)).toBe(true)
  })

  it('falls back to count-less copy when count is zero', () => {
    const entry = buildJobBoardSeo('it', 0, year)
    expect(entry.title).not.toContain('🔥')
    expect(entry.title.startsWith('Offerte di Lavoro Ticino')).toBe(true)
    expect(entry.desc).not.toMatch(/\d/)
  })

  it('preserves brand names in every locale', () => {
    for (const loc of ['it', 'en', 'de', 'fr'] as const) {
      const entry = buildJobBoardSeo(loc, 1200, year)
      // EOC, Lidl, Aldi should be mentioned verbatim in desc
      expect(entry.desc).toContain('EOC')
      expect(entry.desc).toContain('Lidl')
      expect(entry.desc).toContain('Aldi')
    }
  })

  it('produces locale-appropriate copy', () => {
    const en = buildJobBoardSeo('en', 2394, year)
    expect(en.title).toContain('Jobs in Ticino')
    expect(en.desc).toContain('Switzerland')

    const de = buildJobBoardSeo('de', 2394, year)
    expect(de.title).toContain('Jobs im Tessin')
    expect(de.desc).toContain('Pflege')

    const fr = buildJobBoardSeo('fr', 2406, year)
    expect(fr.title).toContain('Emploi au Tessin')
    expect(fr.desc).toContain('offres')
  })

  it('is deterministic for fixed inputs', () => {
    const a = buildJobBoardSeo('it', 1234, 2026)
    const b = buildJobBoardSeo('it', 1234, 2026)
    expect(a).toEqual(b)
  })
})

describe('isJobActiveForLocale', () => {
  const longDesc = 'word '.repeat(60).trim()
  const shortDesc = 'word '.repeat(10).trim()

  it('returns true when the locale description has >=50 words', () => {
    expect(isJobActiveForLocale({ descriptionByLocale: { it: longDesc } }, 'it')).toBe(true)
  })

  it('falls back to top-level description for Italian only', () => {
    expect(isJobActiveForLocale({ description: longDesc }, 'it')).toBe(true)
    expect(isJobActiveForLocale({ description: longDesc }, 'en')).toBe(false)
  })

  it('excludes expired jobs', () => {
    expect(
      isJobActiveForLocale({ expired: true, descriptionByLocale: { it: longDesc } }, 'it'),
    ).toBe(false)
  })

  it('excludes jobs flagged needsRetranslation (boolean)', () => {
    expect(
      isJobActiveForLocale(
        { needsRetranslation: true, descriptionByLocale: { it: longDesc } },
        'it',
      ),
    ).toBe(false)
  })

  it('excludes jobs flagged needsRetranslation for that locale (object)', () => {
    const job = {
      needsRetranslation: { en: true },
      descriptionByLocale: { it: longDesc, en: longDesc },
    }
    expect(isJobActiveForLocale(job, 'it')).toBe(true)
    expect(isJobActiveForLocale(job, 'en')).toBe(false)
  })

  it('excludes descriptions with <50 words', () => {
    expect(
      isJobActiveForLocale({ descriptionByLocale: { it: shortDesc } }, 'it'),
    ).toBe(false)
  })
})

describe('countActiveJobsByLocale', () => {
  it('tallies active jobs per locale', () => {
    const longDesc = 'word '.repeat(60).trim()
    const shortDesc = 'word '.repeat(10).trim()
    const jobs = [
      { descriptionByLocale: { it: longDesc, en: longDesc, de: longDesc, fr: longDesc } },
      { descriptionByLocale: { it: longDesc, en: shortDesc, de: longDesc, fr: longDesc } },
      { expired: true, descriptionByLocale: { it: longDesc, en: longDesc, de: longDesc, fr: longDesc } },
    ]
    const counts = countActiveJobsByLocale(jobs)
    expect(counts).toEqual({ it: 2, en: 1, de: 2, fr: 2 })
  })
})

describe('getActiveJobCountsByLocale', () => {
  it('returns zeros when data/jobs.json is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbsEo-'))
    try {
      const counts = getActiveJobCountsByLocale(tmp)
      expect(counts).toEqual({ it: 0, en: 0, de: 0, fr: 0 })
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('reads and counts active jobs from data/jobs.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jbsEo-'))
    try {
      fs.mkdirSync(path.join(tmp, 'data'), { recursive: true })
      const longDesc = 'word '.repeat(60).trim()
      const jobs = [
        { descriptionByLocale: { it: longDesc, en: longDesc, de: longDesc, fr: longDesc } },
        { descriptionByLocale: { it: longDesc, en: longDesc, de: longDesc, fr: longDesc } },
      ]
      fs.writeFileSync(path.join(tmp, 'data/jobs.json'), JSON.stringify(jobs))
      const counts = getActiveJobCountsByLocale(tmp)
      expect(counts).toEqual({ it: 2, en: 2, de: 2, fr: 2 })
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('JOB_BOARD_LANDING_PATHS', () => {
  it('has one path per locale', () => {
    const locales: JobBoardLocale[] = ['it', 'en', 'de', 'fr']
    for (const l of locales) {
      expect(JOB_BOARD_LANDING_PATHS[l]).toMatch(/^\/.+\/$/)
    }
  })
})
