import type { ByoEvent, ByoEventHandler } from "./types";

export type EventBusOptions = {
  /**
   * Called once per failing consumer, with the error, the event and the
   * consumer's index in the list. Defaults to `console.error` with a
   * `[@byo-oss/core]` prefix. If `onError` itself throws, that error goes to
   * `console.error` and the bus carries on.
   */
  onError?: (
    error: unknown,
    event: ByoEvent,
    consumerIndex: number,
  ) => void | Promise<void>;
};

function defaultOnError(error: unknown, event: ByoEvent, index: number) {
  console.error(
    `[@byo-oss/core] event consumer ${index} failed on "${event.type}"`,
    error,
  );
}

/**
 * Combine several event consumers into one `onEvent`.
 *
 * - Consumers run one after another, in the order given, each awaited.
 * - Each consumer's error (sync throw or rejection) is caught on its own and
 *   reported through `onError`; the next consumer still runs.
 * - The returned handler never throws and never rejects, so a plugin can
 *   await it without risking the request.
 * - The consumer list is copied when the bus is created.
 *
 * @example
 * ```ts
 * const onEvent = createEventBus([
 *   (event) => activity.record(event),
 *   (event) => forwardToInbox(event),
 * ]);
 * betterAuth({ plugins: [support({ onEvent }), feedback({ onEvent })] });
 * ```
 */
export function createEventBus(
  consumers: ByoEventHandler[] | ByoEventHandler,
  options: EventBusOptions = {},
): ByoEventHandler {
  const list = Array.isArray(consumers) ? [...consumers] : [consumers];
  const onError = options.onError ?? defaultOnError;

  return async (event) => {
    for (const [index, consumer] of list.entries()) {
      try {
        await consumer(event);
      } catch (error) {
        try {
          await onError(error, event, index);
        } catch (reportError) {
          console.error(
            "[@byo-oss/core] onError threw while reporting a consumer error",
            reportError,
            error,
          );
        }
      }
    }
  };
}
