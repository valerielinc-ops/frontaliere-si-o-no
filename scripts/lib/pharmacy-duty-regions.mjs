import { OFCT_REGIONS } from './pharmacy-ticino-parser.mjs';

/** The Locarnese association supplies a separate server-rendered duty calendar. */
export const LOCARNESE_REGION = Object.freeze({
  key: 'locarnese',
  name: 'Locarnese',
  url: 'https://www.farmacielocarnese.ch/',
});

/** Every region whose duty intervals are part of the Ticino atomic release. */
export const TICINO_DUTY_REGIONS = Object.freeze([
  ...OFCT_REGIONS,
  LOCARNESE_REGION,
]);
