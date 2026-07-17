const lanes = new Map<string, Promise<void>>();

export async function withKiroAccountLane<T>(
  accountId: string,
  run: (release: () => void) => Promise<T>,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const key = `kiro:${accountId}`;
  const previous = lanes.get(key) ?? Promise.resolve();
  let release!: () => void;
  let released = false;
  const gate = new Promise<void>((resolve) => {
    release = () => {
      if (released) return;
      released = true;
      resolve();
    };
  });
  const pending = previous
    .catch(() => undefined)
    .then(async () => {
      if (options?.signal?.aborted) {
        release();
        throw new Error("Kiro account lane cancelled while queued");
      }
      await gate;
    });
  lanes.set(key, pending);
  try {
    await previous.catch(() => undefined);
    if (options?.signal?.aborted) {
      release();
      throw new Error("Kiro account lane cancelled while queued");
    }
    return await run(release);
  } finally {
    release();
    if (lanes.get(key) === pending) {
      lanes.delete(key);
    }
  }
}

export function resetKiroAccountLanes(): void {
  lanes.clear();
}
