// Stops waiting when `signal` aborts but leaves `pending` running for other callers.
export function awaitAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) {
    return pending;
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );

    if (signal.aborted) {
      onAbort();
    }
  });
}

export function cached<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  let pending = cache.get(key);

  if (pending === undefined) {
    pending = load().catch((cause: unknown) => {
      cache.delete(key);
      throw cause;
    });
    cache.set(key, pending);
  }

  return pending;
}
