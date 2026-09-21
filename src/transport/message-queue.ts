/**
 * Socket events turned into an async iterable of text frames.
 *
 * Every WebSocket implementation delivers frames through callbacks, and every
 * adapter wants to read them with `for await`. The glue is the same for the
 * platform socket and for `ws`, so it is written once.
 */
export interface MessageQueue {
  push(message: string): void;
  /** The session ended normally: whatever is queued is still delivered. */
  end(): void;
  /** The session was cut short: queued frames first, then this error. */
  fail(error: Error): void;
  readonly messages: AsyncIterable<string>;
}

/** @param onRelease Called once the reader stops, however it stopped. */
export function createMessageQueue(onRelease: () => void = () => undefined): MessageQueue {
  const queue: string[] = [];
  let notify: (() => void) | undefined;
  let done = false;
  let failure: Error | undefined;

  const wake = (): void => {
    notify?.();
    notify = undefined;
  };

  return {
    push: message => {
      queue.push(message);
      wake();
    },
    end: () => {
      done = true;
      wake();
    },
    fail: error => {
      failure ??= error;
      done = true;
      wake();
    },
    messages: {
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            const message = queue.shift();
            if (message !== undefined) {
              yield message;
              continue;
            }
            if (done) {
              if (failure) throw failure;
              return;
            }
            await new Promise<void>(resolve => {
              notify = resolve;
            });
          }
        } finally {
          onRelease();
        }
      },
    },
  };
}

/** Whether a close code is one of the ways a session ends on purpose. */
export function isNormalClose(code: number): boolean {
  return code === 1000 || code === 1005;
}

/**
 * How long a server may take to close after being told the stream has ended.
 *
 * Long enough for a provider to flush the last results, short enough that a
 * server which never closes does not hold a session open indefinitely.
 */
export const CLOSE_GRACE_MS = 5_000;
