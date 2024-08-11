const dateExpressions = [
  /^(?<op>=|>=?|<=?)?(?<date>\d{4}-\d{2}-\d{2})$/,
  /^(?<start>\d{4}-\d{2}-\d{2}|\*)\.\.(?<end>\d{4}-\d{2}-\d{2}|\*)$/, // "YYYY-MM-DD..YYYY-MM-DD" or "YYYY-MM-DD..*"
];

export function parseDateExpression(dateExpr: string): [string, string] | null {
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
      // Starting from this day midnight
      return [date, ''];
    } else if (op === '>') {
      // Starting from next day midnight
      return [nextDay(date), ''];
    } else if (op === '<=') {
      // Ending at next day midnight, i.e. including all this day
      return ['', nextDay(date)];
    } else if (op === '<') {
      // Ending at this day midnight
      return ['', date];
    }

    // op === '=' or op is empty
    return [date, nextDay(date)];
  }

  if (start && end && (isValidDate(start) || isValidDate(end))) {
    return [start === '*' ? '' : start, end === '*' ? '' : nextDay(end)];
  }

  return null;
}

function isValidDate(dateString: string): boolean {
  return Number.isFinite(new Date(dateString).valueOf());
}

function nextDay(dateString: string): string {
  const date = new Date(dateString);
  date.setDate(date.getDate() + 1);
  return date.toISOString().substring(0, 10);
}
