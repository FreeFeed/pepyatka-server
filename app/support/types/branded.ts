import { Branded } from './helpers';

export type UUID = Branded<string, 'uuid'>;
export type IPAddr = Branded<string, 'IP address'>;
export type ISO8601DateTimeString = Branded<string, 'ISO 8601 DateTime'>;
export type ISO8601DurationString = Branded<string, 'ISO 8601 Duration'>;
export type ISO8601DateString = Branded<
  `${number}-${number}-${number}` | `${number}-${number}` | `${number}`,
  'ISO 8601 Date'
>;
