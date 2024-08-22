import _ from 'lodash';
import pgFormat from 'pg-format';

import { List } from '../open-lists';

export function initObject(classDef, attrs, id, params) {
  return new classDef({ ...attrs, id, ...params });
}

export function prepareModelPayload(payload, namesMapping, valuesMapping) {
  const result = {};
  const keys = _.intersection(Object.keys(payload), Object.keys(namesMapping));

  for (const key of keys) {
    const mappedKey = namesMapping[key];
    const mappedVal = valuesMapping[key]
      ? // Passing payload as the second argument for cross-keys dependencies
        valuesMapping[key](payload[key], payload)
      : payload[key];
    result[mappedKey] = mappedVal;
  }

  return result;
}

// These helpers allow to use the IN operator with the empty list of values.
// 'IN <empty list>' always returns 'false' and 'NOT IN <empty list>' always returns 'true'.
// We don't escape 'field' here because pgFormat escaping doesn't work properly with dot-joined
// identifiers (as in 'table.field').

export function sqlIn(field, list) {
  list = List.from(list);

  if (list.isEmpty()) {
    return 'false';
  } else if (list.isEverything()) {
    return 'true';
  }

  return pgFormat(`${field} ${list.inclusive ? 'in' : 'not in'} (%L)`, list.items);
}

export function sqlInOrNull(field, list) {
  list = List.from(list);
  return orJoin([!list.inclusive && `${field} is null`, sqlIn(field, list)]);
}

export function sqlNotIn(field, list) {
  return sqlIn(field, List.inverse(list));
}

export function sqlNot(statement) {
  if (statement === 'true') {
    return 'false';
  } else if (statement === 'false') {
    return 'true';
  }

  return `not ${statement}`;
}

export function sqlIntarrayIn(field, list) {
  list = List.from(list);

  if (list.isEmpty()) {
    return 'false';
  } else if (list.isEverything()) {
    return 'true';
  }

  return pgFormat(`(${list.inclusive ? '' : 'not '}${field} && %L)`, `{${list.items.join(',')}}`);
}

function joinThem(array, joinBy, defaultValue, shortcutValue, skipValue) {
  if (array.some((x) => x === shortcutValue)) {
    return shortcutValue;
  }

  const parts = array.filter((x) => !!x && x !== skipValue);

  if (parts.length === 0) {
    return defaultValue;
  }

  if (parts.length === 1) {
    return parts[0];
  }

  return `(${parts.join(` ${joinBy} `)})`;
}

/**
 * @param {string[]} array
 * @param {string} def
 * @returns {string}
 */
export function andJoin(array, def = 'true') {
  return joinThem(array, 'and', def, 'false', 'true');
}

/**
 * @param {string[]} array
 * @param {string} def
 * @returns {string}
 */
export function orJoin(array, def = 'false') {
  return joinThem(array, 'or', def, 'true', 'false');
}
