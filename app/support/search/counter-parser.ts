const counterExpressions = [
  /^(?<op>=|>=?|<=?)?(?<value>\d+)$/,
  /^(?<start>\d+|\*)\.\.(?<end>\d+|\*)$/, // "3..10" or "3..*"
];

export function parseCounterExpression(counterExpr: string): [string, string] | null {
  let match = null;

  for (const expression of counterExpressions) {
    if ((match = expression.exec(counterExpr)) !== null) {
      break;
    }
  }

  if (!match) {
    return null;
  }

  const { op, value, start, end } = match.groups!;

  // The returning values will be used in the SQL query as "count BETWEEN start
  // AND end", which is equivalent to "count >= start AND count <= end".
  if (value) {
    const intValue = parseInt(value, 10);

    if (op === '>=') {
      return [intValue.toString(), ''];
    } else if (op === '>') {
      return [(intValue + 1).toString(), ''];
    } else if (op === '<=') {
      return ['', intValue.toString()];
    } else if (op === '<') {
      return ['', (intValue - 1).toString()];
    }

    // op == '=' or is empty
    return [intValue.toString(), intValue.toString()];
  }

  if (start && end && (start !== '*' || end !== '*')) {
    const intStart = parseInt(start, 10);
    const intEnd = parseInt(end, 10);
    return [start === '*' ? '' : intStart.toString(), end === '*' ? '' : intEnd.toString()];
  }

  return null;
}
