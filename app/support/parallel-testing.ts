export function getWorkerId(): number {
  if (process.env.NODE_ENV !== 'test') {
    return 0;
  }

  let id = Number.parseInt(process.env.MOCHA_WORKER_ID || '0');

  if (!Number.isFinite(id)) {
    id = 0;
  }

  return id;
}

export function getDbSchemaName(): 'public' | string {
  const workerId = getWorkerId();
  return workerId === 0 ? 'public' : `test${workerId}`;
}
