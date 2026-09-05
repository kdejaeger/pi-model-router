export interface PendingCompactionContext {
  isIdle(): boolean;
  compact(options?: { onComplete?: () => void; onError?: (error: Error) => void }): void;
}

export interface PendingCompactionController {
  /** Schedules one compaction; true only when it was newly scheduled. */
  request(context: PendingCompactionContext): boolean;
  clear(): void;
  /** Drains a pending compaction; resolves true when an attempt ran and settled. */
  run(context: PendingCompactionContext, onError?: (error: Error) => void): Promise<boolean>;
}

export const createPendingCompaction = (): PendingCompactionController => {
  let pending = false;

  return {
    request: (context) => {
      if (context.isIdle()) return false;
      const wasPending = pending;
      pending = true;
      return !wasPending;
    },
    clear: () => {
      pending = false;
    },
    run: async (context, onError) => {
      if (!pending) return false;
      pending = false;

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const fail = (error: Error) => {
          // Settle first: a throwing onError must not turn run() into a rejection.
          finish();
          onError?.(error);
        };
        try {
          context.compact({ onComplete: finish, onError: fail });
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      return true;
    },
  };
};
