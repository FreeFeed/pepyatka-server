/**
 * Type safe check for ENOENT errors
 */
export function isNoEntryError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
