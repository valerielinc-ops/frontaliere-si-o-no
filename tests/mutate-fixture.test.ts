import { describe, it, expect } from 'vitest';
import { mutateFixture } from './helpers/mutateFixture';

// Guard for the guard (#7265): the multi-office j2w cases build their input by
// patching a recorded fixture, so a needle that stops matching must fail the
// case loudly instead of silently parsing the pristine fixture.
describe('mutateFixture', () => {
  it('applies the substitution when the needle matches', () => {
    expect(mutateFixture('<td>Pratteln, CH</td>', 'Pratteln, CH', 'Pratteln, CH +2 more')).toBe(
      '<td>Pratteln, CH +2 more</td>',
    );
  });

  it('throws instead of returning the pristine fixture when the needle is absent', () => {
    expect(() => mutateFixture('<td>Pratteln, CH</td>', '  Pratteln, CH\n', 'x')).toThrow(
      /no-op substitution/,
    );
  });

  it('throws on a regex needle that matches nothing', () => {
    expect(() => mutateFixture('<td>Pratteln</td>', /class="jobLocation"/, 'x')).toThrow(
      /no-op substitution/,
    );
  });
});
