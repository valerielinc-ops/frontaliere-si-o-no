import { describe, expect, it } from 'vitest';
import { answerQuestionDescriptor, nativeQuestionOptionsView } from '../functions/src/lib/applicationQuestionContract.js';
import { candidateQuestionAnswerKey } from '../functions/src/assistedApplicationCandidateEdits.js';
const question = () => ({ id: 'permit', question: 'Do you hold a permit?', type: 'choice', options: ['Yes', 'No'],
  applicationOptions: ['Yes', 'No, I do not hold a permit'], optionMap: [{ candidate: 'Yes', application: 'Yes' }, { candidate: 'No', application: 'No, I do not hold a permit' }],
  originalNativeContract: { question: 'Do you hold a permit?', kind: 'select', options: ['Yes', 'No, I do not hold a permit'],
    optionValues: [{ label: 'Yes', value: '1' }, { label: 'No, I do not hold a permit', value: '0' }] } });
describe('complete native choice disclosure and mapping', () => {
  it('keeps every native clause and the exact candidate/native label pair in the confirmed descriptor', () => {
    const q = question(); const descriptor = answerQuestionDescriptor(q);
    expect(descriptor!.optionMap).toEqual(q.optionMap); expect(descriptor!.applicationOptions).toEqual(q.applicationOptions);
    expect(nativeQuestionOptionsView(descriptor)).toEqual({ originalQuestionOptions: q.originalNativeContract.optionValues, originalQuestionOptionMap: q.optionMap });
  });
  it.each(['missing_map', 'wrong_map', 'incomplete_catalog', 'duplicate_native', 'bad_value'])('does not issue a descriptor for undisclosable options: %s', change => {
    const q: any = question();
    if (change === 'missing_map') delete q.optionMap;
    if (change === 'wrong_map') q.optionMap[1].candidate = 'Never shown';
    if (change === 'incomplete_catalog') q.applicationOptions = ['Yes'];
    if (change === 'duplicate_native') { q.originalNativeContract.options[1] = 'Yes'; q.originalNativeContract.optionValues[1].label = 'Yes'; }
    if (change === 'bad_value') q.originalNativeContract.optionValues[1].value = {};
    expect(answerQuestionDescriptor(q)).toBeNull();
  });
  it('excludes only the structural placeholder from mapping, preserving it in the full source catalog', () => {
    const q: any = question(); q.originalNativeContract.options.unshift('Choose');
    q.originalNativeContract.optionValues.unshift({ label: 'Choose', value: '', placeholder: true });
    expect(nativeQuestionOptionsView(answerQuestionDescriptor(q))!.originalQuestionOptions).toHaveLength(3);
    delete q.originalNativeContract.optionValues[0].placeholder;
    expect(answerQuestionDescriptor(q)).toBeNull(); // The word Choose is not proof of a placeholder.
  });
  it('does not alias changed application mapping metadata to a generic language question', () => {
    const q: any = { id: 'english', question: 'What is your English proficiency level?', type: 'choice', options: ['C1'], applicationOptions: ['C1 for this employer'], optionMap: [{ candidate: 'C1', application: 'C1 for this employer' }] };
    expect(candidateQuestionAnswerKey(q)).not.toBe('language_en_any_proficiency');
    const before = candidateQuestionAnswerKey(q); q.optionMap[0].application = 'C1 after training';
    expect(candidateQuestionAnswerKey(q)).not.toBe(before);
  });
});
