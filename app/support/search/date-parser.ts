import { ISO8601DateString as DateString } from '../types';

const dateExpressions = [
  /^(?<op>=|>=?|<=?)?(?<date>\d{4}(?:-\d{2}(?:-\d{2})?)?)$/, // "=YYYY-MM-DD", ">=YYYY-MM", "<=YYYY"
  /^(?<start>\d{4}(?:-\d{2}(?:-\d{2})?)?|\*)\.\.(?<end>\d{4}(?:-\d{2}(?:-\d{2})?)?|\*)$/, // "YYYY-MM-DD..YYYY-MM-DD" or "YYYY-MM-DD..*"
];

export function parseDateExpression(dateExpr: string): [DateString | '', DateString | ''] | null {
  let match = null;

  for (const expression of dateExpressions) {
    if ((match = expression.exec(dateExpr)) !== null) {
      break;
    }
  }

  if (!match) {
    return null;
  }

  const { op, date, start, end } = match.groups!;

  // The returning dates will be used in the SQL query as "date BETWEEN start
  // AND end", which is equivalent to "date >= start AND date <= end". The date
  // values are converted to timestamp in the SQL query, so the '2020-01-01'
  // will be converted to '2020-01-01 00:00:00'.
  if (date && isValidDate(date)) {
    if (op === '>=') {
      return [startOf(date), ''];
    } else if (op === '>') {
      return [endOf(date), ''];
    } else if (op === '<=') {
      return ['', endOf(date)];
    } else if (op === '<') {
      return ['', startOf(date)];
    }

    // op === '=' or op is empty
    return [startOf(date), endOf(date)];
  }

  if (isValidDate(start) && isValidDate(end)) {
    return [startOf(start), endOf(end)];
  } else if (isValidDate(start)) {
    return [startOf(start), ''];
  } else if (isValidDate(end)) {
    return ['', endOf(end)];
  }

  return null;
}

function isValidDate(dateString: string): dateString is DateString {
  return Number.isFinite(new Date(dateString).valueOf());
}

function startOf(dateString: DateString): DateString {
  return dateToISOString(new Date(dateString));
}

function endOf(dateString: DateString): DateString {
  const date = new Date(dateString);

  if (dateString.length === 4) {
    // YYYY
    date.setFullYear(date.getFullYear() + 1);
  } else if (dateString.length === 7) {
    // YYYY-MM
    date.setMonth(date.getMonth() + 1);
  } else {
    // YYYY-MM-DD
    date.setDate(date.getDate() + 1);
  }

  return dateToISOString(date);
}

function dateToISOString(date: Date): DateString {
  return date.toISOString().slice(0, 10) as DateString;
}
