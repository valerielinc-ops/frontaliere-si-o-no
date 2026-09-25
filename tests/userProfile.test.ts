/**
 * Tests for UserProfile module
 * 
 * Tests exported helpers (loadUserProfile, profileToSimInputs),
 * the FamilyMember type, and profile data model.
 */
import {
  loadUserProfile,
  profileToSimInputs,
  type UserProfileData,
  type FamilyMember,
} from '@/components/pages/UserProfile';

/** Shared base fields that are required but not relevant to most tests */
const BASE_FIELDS: Pick<UserProfileData, 'gender' | 'workplace' | 'preferredDogana' | 'preferredLanguage' | 'grossSalary' | 'permitExpiry'> = {
  gender: '',
  workplace: '',
  preferredDogana: '',
  preferredLanguage: '',
  grossSalary: '',
  permitExpiry: '',
};

describe('UserProfile helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('loadUserProfile', () => {
    it('returns default profile when localStorage is empty', () => {
      const profile = loadUserProfile();
      expect(profile.workPosition).toBe('');
      expect(profile.age).toBe('');
      expect(profile.familySituation).toBe('');
      expect(profile.frontaliereType).toBe('');
      expect(profile.municipality).toBe('');
      expect(profile.children).toBe('0');
      expect(profile.familyMembers).toBe('1');
    });

    it('loads saved profile from localStorage', () => {
      const saved: UserProfileData = {
        workPosition: 'Software Engineer',
        age: '26-35',
        familySituation: 'married',
        frontaliereType: 'permit-g',
        municipality: 'Como (CO)',
        children: '2',
        familyMembers: '4',
        familyMembersList: [],
        ...BASE_FIELDS,
      };
      localStorage.setItem('frontaliere_user_profile', JSON.stringify(saved));
      const profile = loadUserProfile();
      expect(profile.workPosition).toBe('Software Engineer');
      expect(profile.age).toBe('26-35');
      expect(profile.familySituation).toBe('married');
      expect(profile.frontaliereType).toBe('permit-g');
      expect(profile.municipality).toBe('Como (CO)');
      expect(profile.children).toBe('2');
      expect(profile.familyMembers).toBe('4');
    });

    it('handles corrupted localStorage gracefully', () => {
      localStorage.setItem('frontaliere_user_profile', 'not-json');
      const profile = loadUserProfile();
      expect(profile.workPosition).toBe('');
    });

    it('merges partial data with defaults', () => {
      localStorage.setItem('frontaliere_user_profile', JSON.stringify({ workPosition: 'Dev' }));
      const profile = loadUserProfile();
      expect(profile.workPosition).toBe('Dev');
      expect(profile.children).toBe('0');
      expect(profile.familyMembers).toBe('1');
    });
  });

  describe('profileToSimInputs', () => {
    it('returns empty object for empty profile', () => {
      const profile: UserProfileData = {
        workPosition: '', age: '', familySituation: '', frontaliereType: '',
        municipality: '', children: '0', familyMembers: '1', ...BASE_FIELDS,
      };
      const result = profileToSimInputs(profile);
      expect(result.maritalStatus).toBeUndefined();
      expect(result.frontierWorkerType).toBeUndefined();
    });

    it('maps married → MARRIED', () => {
      const profile: UserProfileData = {
        workPosition: '', age: '', familySituation: 'married', frontaliereType: '',
        municipality: '', children: '0', familyMembers: '1', ...BASE_FIELDS,
      };
      const result = profileToSimInputs(profile);
      expect(result.maritalStatus).toBe('MARRIED');
    });

    it('maps single → SINGLE', () => {
      const profile: UserProfileData = {
        workPosition: '', age: '', familySituation: 'single', frontaliereType: '',
        municipality: '', children: '0', familyMembers: '1', ...BASE_FIELDS,
      };
      const result = profileToSimInputs(profile);
      expect(result.maritalStatus).toBe('SINGLE');
    });

    it('maps divorced → SINGLE', () => {
      const profile: UserProfileData = {
        workPosition: '', age: '', familySituation: 'divorced', frontaliereType: '',
        municipality: '', children: '0', familyMembers: '1', ...BASE_FIELDS,
      };
      const result = profileToSimInputs(profile);
      expect(result.maritalStatus).toBe('SINGLE');
    });

    it('maps cohabiting → SINGLE', () => {
      const profile: UserProfileData = {
        workPosition: '', age: '', familySituation: 'cohabiting', frontaliereType: '',
        municipality: '', children: '0', familyMembers: '1', ...BASE_FIELDS,
      };
      const result = profileToSimInputs(profile);
      expect(result.maritalStatus).toBe('SINGLE');
    });

    it('maps permit-g → NEW', () => {
      const profile: UserProfileData = {
        workPosition: '', age: '', familySituation: '', frontaliereType: 'permit-g',
        municipality: '', children: '0', familyMembers: '1', ...BASE_FIELDS,
      };
      const result = profileToSimInputs(profile);
      expect(result.frontierWorkerType).toBe('NEW');
    });

    it('maps permit-b → OLD', () => {
      const profile: UserProfileData = {
        workPosition: '', age: '', familySituation: '', frontaliereType: 'permit-b',
        municipality: '', children: '0', familyMembers: '1', ...BASE_FIELDS,
      };
      const result = profileToSimInputs(profile);
      expect(result.frontierWorkerType).toBe('OLD');
    });

    it('maps children count correctly', () => {
      const profile: UserProfileData = {
        workPosition: '', age: '', familySituation: '', frontaliereType: '',
        municipality: '', children: '3', familyMembers: '4', ...BASE_FIELDS,
      };
      const result = profileToSimInputs(profile);
      expect(result.children).toBe(3);
      expect(result.familyMembers).toBe(4);
    });

    it('maps age bracket to midpoint', () => {
      const profile: UserProfileData = {
        workPosition: '', age: '36-45', familySituation: '', frontaliereType: '',
        municipality: '', children: '0', familyMembers: '1', ...BASE_FIELDS,
      };
      const result = profileToSimInputs(profile);
      expect(result.age).toBe(40);
    });

    it('maps municipality to distance zone', () => {
      const profile: UserProfileData = {
        workPosition: '', age: '', familySituation: '', frontaliereType: '',
        municipality: 'Lavena Ponte Tresa (VA)', children: '0', familyMembers: '1', ...BASE_FIELDS,
      };
      const result = profileToSimInputs(profile);
      // Lavena Ponte Tresa is very close to the border
      expect(result.distanceZone).toBeDefined();
    });

    it('ignores unknown municipality', () => {
      const profile: UserProfileData = {
        workPosition: '', age: '', familySituation: '', frontaliereType: '',
        municipality: 'Roma (RM)', children: '0', familyMembers: '1', ...BASE_FIELDS,
      };
      const result = profileToSimInputs(profile);
      expect(result.distanceZone).toBeUndefined();
    });
  });

  describe('FamilyMember type', () => {
    it('can represent a child', () => {
      const member: FamilyMember = {
        id: 'test1',
        relationship: 'child',
        birthYear: '2015',
        liveTogether: true,
        dependent: true,
      };
      expect(member.relationship).toBe('child');
      expect(member.dependent).toBe(true);
    });

    it('can represent a spouse', () => {
      const member: FamilyMember = {
        id: 'test2',
        relationship: 'spouse',
        liveTogether: true,
        dependent: false,
      };
      expect(member.relationship).toBe('spouse');
      expect(member.birthYear).toBeUndefined();
    });

    it('supports all relationship types', () => {
      const types: FamilyMember['relationship'][] = ['spouse', 'child', 'parent', 'sibling', 'other'];
      types.forEach(rel => {
        const m: FamilyMember = { id: rel, relationship: rel, liveTogether: true, dependent: false };
        expect(m.relationship).toBe(rel);
      });
    });
  });

  describe('UserProfileData with familyMembersList', () => {
    it('includes familyMembersList in profile', () => {
      const profile: UserProfileData = {
        workPosition: 'Dev',
        age: '26-35',
        familySituation: 'married',
        frontaliereType: 'permit-g',
        municipality: 'Como (CO)',
        children: '2',
        familyMembers: '4',
        ...BASE_FIELDS,
        familyMembersList: [
          { id: '1', relationship: 'spouse', liveTogether: true, dependent: false },
          { id: '2', relationship: 'child', birthYear: '2018', liveTogether: true, dependent: true },
          { id: '3', relationship: 'child', birthYear: '2020', liveTogether: true, dependent: true },
        ],
      };
      expect(profile.familyMembersList).toHaveLength(3);
      expect(profile.familyMembersList![0].relationship).toBe('spouse');
      expect(profile.familyMembersList![1].relationship).toBe('child');
    });

    it('persists and loads familyMembersList from localStorage', () => {
      const profile: UserProfileData = {
        workPosition: '',
        age: '',
        familySituation: '',
        frontaliereType: '',
        municipality: '',
        children: '1',
        familyMembers: '2',
        ...BASE_FIELDS,
        familyMembersList: [
          { id: '1', relationship: 'child', birthYear: '2020', liveTogether: true, dependent: true },
        ],
      };
      localStorage.setItem('frontaliere_user_profile', JSON.stringify(profile));
      const loaded = loadUserProfile();
      expect(loaded.familyMembersList).toHaveLength(1);
      expect(loaded.familyMembersList![0].relationship).toBe('child');
      expect(loaded.familyMembersList![0].birthYear).toBe('2020');
    });
  });
});
