/** A wait that passed its time cap (its `name` says so in logs, `error.type`). */
export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';
}

/**
 * Rejects (with a {@link TimeoutError}) if `promise` hasn't settled within `ms`. Used wherever a hang would
 * be worse than a clear failure (startup secret reads, health checks).
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(`${what} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
