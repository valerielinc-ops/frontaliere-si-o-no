import { describe, it, expect } from 'vitest';
import {
  employerMatchesHospital,
  classifyHealthcareRole,
  isHealthcareRole,
  normalizeCategory,
  extractHospitalCity,
  isHospitalTypeName,
} from '../build-plugins/healthFacilitiesMatch';
import {
  HEALTH_FACILITIES,
  HEALTH_FACILITY_LOCALES,
  HEALTH_FACILITY_MIN_JOBS,
  buildHealthFacilityPath,
  isHealthFacilityPath,
  getHealthFacility,
} from '../build-plugins/healthFacilitiesData';
import { aggregateHealthFacilityJobs } from '../build-plugins/healthFacilitiesJobsAggregate';

describe('healthFacilitiesMatch — employer ↔ hospital matching', () => {
  it('matches an employer whose name contains the hospital core (either direction)', () => {
    expect(employerMatchesHospital('Kantonsspital Winterthur (KSW)', 'Kantonsspital Winterthur')).toBe(true);
    expect(employerMatchesHospital('EOC – Ente Ospedaliero Cantonale', 'EOC Ente ospedaliero cantonale (Ospedale di Lugano)')).toBe(true);
    expect(employerMatchesHospital('See-Spital', 'See­-Spital (Standort Horgen)')).toBe(true);
  });

  it('rejects a bare geographic-token collision (the "Klinik Luzern" trap)', () => {
    expect(employerMatchesHospital('Stadt Luzern', 'Klinik Luzern (LUPS)')).toBe(false);
    expect(employerMatchesHospital('Canton du Valais', 'Hôpital du Valais (site Hôpital de Sierre)')).toBe(false);
  });

  it('flags hospital-typed employer names for the geo fallback', () => {
    expect(isHospitalTypeName('Spitäler fmi AG')).toBe(true);
    expect(isHospitalTypeName('Migros Luzern')).toBe(false);
  });

  it('extracts a city token from a directory name', () => {
    expect(extractHospitalCity('Spital Limmattal, Schlieren')).toBe('schlieren');
    expect(extractHospitalCity('EOC (Ospedale di Bellinzona)')).toBe('bellinzona');
  });

  it('normalizes the German directory categories', () => {
    expect(normalizeCategory('Akutsomatische Spitäler')).toBe('acute');
    expect(normalizeCategory('Rehabilitationskliniken')).toBe('rehab');
    expect(normalizeCategory('Psychiatriekliniken')).toBe('psychiatry');
    expect(normalizeCategory('Geburtshäuser')).toBe('birth');
  });
});

describe('healthFacilitiesMatch — healthcare-role classification', () => {
  it('classifies headline healthcare roles', () => {
    expect(classifyHealthcareRole('Infermiere diplomato SUP 80-100%')).toBe('infermiere');
    expect(classifyHealthcareRole('Operatore socio-sanitario OSS')).toBe('oss');
    expect(classifyHealthcareRole('Assistenzarzt Innere Medizin')).toBe('medico');
    expect(classifyHealthcareRole('Fisioterapista 60%')).toBe('terapista');
    expect(classifyHealthcareRole('Hebamme')).toBe('ostetrica');
  });

  it('returns null for non-healthcare and veterinary titles', () => {
    expect(classifyHealthcareRole('Software Engineer')).toBeNull();
    expect(classifyHealthcareRole('Tierpfleger EFZ')).toBeNull();
    expect(isHealthcareRole('Buchhalter')).toBe(false);
    expect(isHealthcareRole('Pflegefachfrau HF')).toBe(true);
  });

  it('classifies on the canonical title only — a non-healthcare title stays null regardless of what any translation might say (#4715)', () => {
    expect(classifyHealthcareRole('Impiegato/a di commercio')).toBeNull();
  });
});

describe('healthFacilitiesData — committed registry + routing', () => {
  it('has a non-empty committed registry with a sane floor', () => {
    expect(HEALTH_FACILITIES.length).toBeGreaterThan(0);
    expect(HEALTH_FACILITY_MIN_JOBS).toBeGreaterThanOrEqual(1);
  });

  it('builds trailing-slash canonical paths per locale', () => {
    const slug = HEALTH_FACILITIES[0].slug;
    for (const locale of HEALTH_FACILITY_LOCALES) {
      const path = buildHealthFacilityPath(locale, slug);
      expect(path.endsWith('/')).toBe(true);
      expect(path).toContain(slug);
      if (locale !== 'it') expect(path.startsWith(`/${locale}/`)).toBe(true);
    }
  });

  it('self-maps every enumerated facility path and rejects junk', () => {
    const slug = HEALTH_FACILITIES[0].slug;
    for (const locale of HEALTH_FACILITY_LOCALES) {
      expect(isHealthFacilityPath(buildHealthFacilityPath(locale, slug))).toBe(true);
      // trailing-slash-insensitive
      expect(isHealthFacilityPath(buildHealthFacilityPath(locale, slug).replace(/\/$/, ''))).toBe(true);
    }
    expect(isHealthFacilityPath('/strutture-sanitarie/definitely-not-a-facility/')).toBe(false);
    expect(getHealthFacility(slug)?.slug).toBe(slug);
  });

  it('stores at least one company key per facility for build-time job selection', () => {
    for (const f of HEALTH_FACILITIES) {
      expect(f.companyKeys.length).toBeGreaterThan(0);
    }
  });
});

describe('healthFacilitiesJobsAggregate — build-time snapshots', () => {
  it('returns one well-shaped snapshot per committed facility', () => {
    const snapshots = aggregateHealthFacilityJobs(process.cwd());
    expect(snapshots.size).toBe(HEALTH_FACILITIES.length);
    for (const f of HEALTH_FACILITIES) {
      const snap = snapshots.get(f.slug);
      expect(snap).toBeDefined();
      expect(snap!.liveCount).toBeGreaterThanOrEqual(0);
      expect(snap!.featured.length).toBeLessThanOrEqual(6);
      // roleCounts always carries all headline keys.
      expect(Object.keys(snap!.roleCounts)).toContain('infermiere');
    }
  });
});
