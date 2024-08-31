import pgFormat from 'pg-format';
import { intersection } from 'lodash';

import { List, ListLike } from '../open-lists';

export function prepareModelPayload<P extends Record<string, any>>(
  payload: P,
  namesMapping: Record<string, string>,
  valuesMapping: Record<string, (val: any, p?: P) => any>,
): Record<string, any> {
  const result: Record<string, any> = {};
  const keys = intersection(Object.keys(payload), Object.keys(namesMapping));

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

export function initObject<C, A extends Record<string, any>, P extends Record<string, any>>(
  classDef: new (args: Record<string, any>) => C,
  attrs: A,
  id: string,
  params: P,
) {
  return new classDef({ ...attrs, id, ...params });
}

// SQL builders for uniform AND/OR joins

type Falsy = null | undefined | false | 0 | '';

function joinThem(array: (string | Falsy)[], joinBy: 'and' | 'or'): string {
  const absorbingValue = joinBy === 'and' ? 'false' : 'true';
  const identityValue = joinBy === 'and' ? 'true' : 'false';

  if (array.some((x) => x === absorbingValue)) {
    return absorbingValue;
  }

  const parts = array.filter((x) => !!x && x !== identityValue) as string[];

  if (parts.length === 0) {
    return identityValue;
  }

  if (parts.length === 1) {
    return parts[0];
  }

  return `(${parts.join(` ${joinBy} `)})`;
}

export function andJoin(array: (string | Falsy)[]): string {
  return joinThem(array, 'and');
}

export function orJoin(array: (string | Falsy)[]): string {
  return joinThem(array, 'or');
}

// Just a 'not'

export function sqlNot(statement: string): string {
  if (statement === 'true') {
    return 'false';
  } else if (statement === 'false') {
    return 'true';
  }

  return `not ${statement.includes(' ') ? `(${statement})` : statement}`;
}

// These helpers allow to use the IN operator with the empty list of values. 'IN
// <empty list>' always returns 'false' and 'NOT IN <empty list>' always returns
// 'true'. We don't escape 'field' here because pgFormat escaping doesn't work
// properly with dot-joined identifiers (as in 'table.field').

export function sqlIn(field: string, listLike: ListLike<unknown>): string {
  const list = List.from(listLike);

  if (list.isEmpty()) {
    return 'false';
  } else if (list.isEverything()) {
    return 'true';
  }

  return pgFormat(`${field} ${list.inclusive ? 'in' : 'not in'} (%L)`, list.items);
}

export function sqlInOrNull(field: string, listLike: ListLike<unknown>): string {
  const list = List.from(listLike);
  return orJoin([!list.inclusive && `${field} is null`, sqlIn(field, list)]);
}

export function sqlNotIn(field: string, listLike: ListLike<unknown>): string {
  return sqlIn(field, List.inverse(listLike));
}

export function sqlIntarrayIn(field: string, listLike: ListLike<number>): string {
  const list = List.from(listLike);

  if (list.isEmpty()) {
    return 'false';
  } else if (list.isEverything()) {
    return 'true';
  }

  return pgFormat(`(${list.inclusive ? '' : 'not '}${field} && %L)`, `{${list.items.join(',')}}`);
}
