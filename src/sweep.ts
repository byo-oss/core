import { hasHook, installedByoPlugins } from "./plugins";
import type { ByoAuth, ByoSweepResult } from "./types";

export type SweepAllOptions = {
  /**
   * Total time budget across all plugins, in milliseconds. Checked before
   * every call, so one call that's already running may overrun it. Pick a
   * value below your scheduler's or platform's timeout. Default `25_000`.
   */
  budgetMs?: number;
  /** Clock in milliseconds, for tests. Default `Date.now`. */
  now?: () => number;
  /**
   * Called when a plugin's sweep throws, with the error and plugin id.
   * Defaults to `console.error` with a `[@byo-oss/core]` prefix. The error is
   * also returned in that plugin's result.
   */
  onError?: (error: unknown, pluginId: string) => void;
};

/** One plugin's outcome in {@link sweepAll}. */
export type PluginSweepResult = {
  pluginId: string;
  /** How many times its sweep was called. `0` means the budget ran out first. */
  runs: number;
  /** What the last call returned, if one succeeded. */
  last?: ByoSweepResult;
  /** What the last call threw, if it threw. */
  error?: unknown;
};

export type SweepAllResult = {
  /** One entry per installed plugin with `byo.sweep`, in plugin order. */
  results: PluginSweepResult[];
  /**
   * Some plugin still has work: its last sweep returned `hasMore: true`, or
   * it was never reached. A plugin whose sweep threw doesn't count, so a
   * caller that loops on `hasMore` can't spin on a broken plugin.
   */
  hasMore: boolean;
  /** The budget ran out with work left (a loop was cut short or a plugin skipped). */
  timedOut: boolean;
};

const DEFAULT_BUDGET_MS = 25_000;

function defaultOnError(error: unknown, pluginId: string) {
  console.error(`[@byo-oss/core] sweep of plugin "${pluginId}" failed`, error);
}

/**
 * Run every installed plugin's `byo.sweep`, so one cron route serves them all
 * (SPEC P5).
 *
 * Plugins run in `auth.options.plugins` order. Each one is called repeatedly
 * while it returns `hasMore: true` and the budget remains; then the next
 * plugin runs. Plugins are sequential, so a busy plugin can use the whole
 * budget and leave later ones for the next call: the result's `hasMore` is
 * the signal to call again soon. A sweep that throws is caught, recorded and
 * reported through `onError`, and the next plugin still runs. A return value
 * without `hasMore: true` counts as done. `sweepAll` itself never throws for
 * a plugin's failure.
 *
 * Delivery guarantees (leases, retries, at-least-once) belong to each
 * plugin's sweep, not to this loop.
 *
 * @example
 * ```ts
 * // app/api/cron/route.ts, called every minute
 * export async function GET() {
 *   const { hasMore, results } = await sweepAll(auth, { budgetMs: 20_000 });
 *   return Response.json({ hasMore, results });
 * }
 * ```
 */
export async function sweepAll(
  auth: ByoAuth,
  options: SweepAllOptions = {},
): Promise<SweepAllResult> {
  const now = options.now ?? Date.now;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const onError = options.onError ?? defaultOnError;
  const deadline = now() + budgetMs;

  const results: PluginSweepResult[] = [];
  let hasMore = false;
  let timedOut = false;

  for (const { id, byo } of installedByoPlugins(auth)) {
    if (!hasHook(byo, "sweep")) continue;
    const result: PluginSweepResult = { pluginId: id, runs: 0 };
    results.push(result);

    let more = true;
    while (more) {
      if (now() >= deadline) {
        timedOut = true;
        hasMore = true;
        break;
      }
      result.runs++;
      try {
        // hasHook checked above; called as a method to keep `this`
        const last = await byo.sweep?.(auth);
        result.last = last;
        more =
          typeof last === "object" && last !== null && last.hasMore === true;
      } catch (error) {
        result.error = error;
        try {
          onError(error, id);
        } catch {
          // a broken reporter must not stop the other plugins
        }
        more = false;
      }
    }
  }

  return { results, hasMore, timedOut };
}
