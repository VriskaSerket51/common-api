export interface ShutdownOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const validateShutdownOptions = ({ timeoutMs = 30_000 }: ShutdownOptions): void => {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("timeoutMs must be between 0 and 2147483647.");
  }
};

/** Limits waiting, not execution. Non-cooperative work may continue after rejection. */
export const waitForShutdown = <T>(
  work: Promise<T>, options: ShutdownOptions = {}, onCancel?: (reason: Error) => void,
): Promise<T> => {
  validateShutdownOptions(options);
  const { timeoutMs = 30_000, signal } = options;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const cancel = (reason: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { onCancel?.(reason); } finally { reject(reason); }
    };
    const abort = () => cancel(new Error("Shutdown was aborted.", { cause: signal?.reason }));
    work.then(value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => cancel(new Error("Shutdown timed out after " + timeoutMs + "ms.")), timeoutMs);
  });
};
