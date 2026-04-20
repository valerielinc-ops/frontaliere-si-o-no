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

describe('buildJobBoardSeo (F3a — CTR-optimized titles)', () => {
  const year = 2026

  it('injects count and fire emoji on title when count >= threshold (IT)', () => {
    const entry = buildJobBoardSeo('it', 2408, year)
    // Short <title> (50-60 chars): keyword + year + count + 🔥, NO brand
    expect(entry.title).toContain('2408')
    expect(entry.title).toContain('🔥')
    expect(entry.title).toContain(`${year}`)
    expect(entry.title).toContain('Offerte Lavoro Ticino')
    // OG title retains legacy brand suffix (unconstrained length)
    expect(entry.ogT.startsWith('🔥 2408 ')).toBe(true)
    expect(entry.ogT).toContain('Offerte di Lavoro Ticino')
    // Desc includes number + primary keyword + CTA
    expect(entry.desc).toContain('2408')
    expect(entry.desc).toContain('offerte di lavoro in Ticino')
    expect(entry.desc).toMatch(/Candidati/)
  })

  it('omits fire emoji on title when count below threshold', () => {
    const below = FIRE_EMOJI_THRESHOLD - 1
    const entry = buildJobBoardSeo('it', below, year)
    expect(entry.title).toContain(String(below))
    expect(entry.title).not.toContain('🔥')
  })

  it('injects fire emoji exactly at threshold', () => {
    const entry = buildJobBoardSeo('en', FIRE_EMOJI_THRESHOLD, year)
    expect(entry.title).toContain('🔥')
    expect(entry.title).toContain(String(FIRE_EMOJI_THRESHOLD))
    expect(entry.ogT.startsWith(`🔥 ${FIRE_EMOJI_THRESHOLD} `)).toBe(true)
  })

  it('falls back to count-less copy when count is zero', () => {
    const entry = buildJobBoardSeo('it', 0, year)
    expect(entry.title).not.toContain('🔥')
    expect(entry.title).toContain('Offerte Lavoro Ticino')
    // Zero-count desc has no numeric jobs count
    expect(entry.desc).not.toMatch(/\b\d{2,}\b/)
  })

  it('mentions primary sector keywords in every locale description', () => {
    // Desc now leads with "sanità/healthcare/Pflege/santé" as primary sector
    // anchor — matches highest-impression queries like "lavoro sanità ticino".
    const it = buildJobBoardSeo('it', 1200, year)
    expect(it.desc).toContain('sanità')
    expect(it.desc).toContain('EOC')

    const en = buildJobBoardSeo('en', 1200, year)
    expect(en.desc).toContain('healthcare')
    expect(en.desc).toContain('EOC')

    const de = buildJobBoardSeo('de', 1200, year)
    expect(de.desc).toContain('Pflege')
    expect(de.desc).toContain('EOC')

    const fr = buildJobBoardSeo('fr', 1200, year)
    expect(fr.desc).toContain('santé')
    expect(fr.desc).toContain('EOC')
  })

  it('produces locale-appropriate copy', () => {
    const en = buildJobBoardSeo('en', 2394, year)
    expect(en.title).toContain('Jobs in Ticino')
    expect(en.desc).toContain('Switzerland')

    const de = buildJobBoardSeo('de', 2394, year)
    expect(de.title).toContain('Jobs im Tessin')
    expect(de.desc).toContain('Pflege')

    const fr = buildJobBoardSeo('fr', 2406, year)
    expect(fr.title).toContain('Emploi Tessin')
    expect(fr.desc).toContain('offres')
  })

  it('is deterministic for fixed inputs', () => {
    const a = buildJobBoardSeo('it', 1234, 2026)
    const b = buildJobBoardSeo('it', 1234, 2026)
    expect(a).toEqual(b)
  })

  it('enforces 50-60 visible-char title length for SERP safety', () => {
    // Google truncates <title> around 60 visible chars; below 50 looks stubby.
    for (const loc of ['it', 'en', 'de', 'fr'] as const) {
      for (const count of [0, 1, 42, 148, 500, 2408, 12345]) {
        const entry = buildJobBoardSeo(loc, count, year)
        const visible = [...entry.title].length
        expect(
          visible,
          `${loc} count=${count}: "${entry.title}" length=${visible}`,
        ).toBeGreaterThanOrEqual(50)
        expect(visible).toBeLessThanOrEqual(60)
      }
    }
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
