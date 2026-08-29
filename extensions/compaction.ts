export interface PendingCompactionContext {
  isIdle(): boolean;
  compact(options?: { onComplete?: () => void; onError?: (error: Error) => void }): void;
}

export interface PendingCompactionController {
  request(context: PendingCompactionContext): boolean;
  clear(): void;
  run(context: PendingCompactionContext, onError?: (error: Error) => void): Promise<boolean>;
}

export const createPendingCompaction = (): PendingCompactionController => {
  let pending = false;

  return {
    request: (context) => {
      if (context.isIdle()) return false;
      pending = true;
      return true;
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
          onError?.(error);
          finish();
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
