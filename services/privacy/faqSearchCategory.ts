import { classifyQuestionTopic } from './questionTopic';
import { FAQ_SEARCH_CATEGORIES } from './faqSearchCategories.mjs';

const FAQ_SEARCH_CATEGORY_BY_TOPIC = {
  taxes: 'taxes',
  permits: 'permits',
  healthcare: 'health',
  pension: 'pension',
  family: 'family',
  commute: 'daily',
} as const;

export type FaqSearchCategory = (typeof FAQ_SEARCH_CATEGORIES)[number];

/** Return only a closed FAQ category so user search text never enters demand telemetry. */
export function classifyFaqSearchCategory(query: string): FaqSearchCategory {
  const topic = classifyQuestionTopic(query);
  return Object.hasOwn(FAQ_SEARCH_CATEGORY_BY_TOPIC, topic)
    ? FAQ_SEARCH_CATEGORY_BY_TOPIC[topic as keyof typeof FAQ_SEARCH_CATEGORY_BY_TOPIC]
    : 'other';
}
