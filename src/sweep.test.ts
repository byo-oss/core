import { afterEach, describe, expect, it, vi } from "vitest";
import { sweepAll } from "./sweep";
import {
  createTestAuth,
  fakeClock,
  fixturePlugin,
  plainPlugin,
} from "./test-utils";
import type { ByoSweepResult } from "./types";

/** A sweep that reports `hasMore` for the first `batches - 1` calls. */
function batches(log: string[], id: string, count: number) {
  let calls = 0;
  return async (): Promise<ByoSweepResult> => {
    calls++;
    log.push(`${id}:${calls}`);
    return { sent: 1, failed: 0, hasMore: calls < count };
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sweepAll", () => {
  it("loops each plugin while hasMore, in plugin order, skipping plugins without byo", async () => {
    const log: string[] = [];
    const auth = createTestAuth([
      fixturePlugin("alpha", { sweep: batches(log, "alpha", 3) }),
      plainPlugin(),
      fixturePlugin("beta", { sweep: batches(log, "beta", 1) }),
    ]);

    const result = await sweepAll(auth);

    expect(log).toEqual(["alpha:1", "alpha:2", "alpha:3", "beta:1"]);
    expect(result).toEqual({
      results: [
        {
          pluginId: "alpha",
          runs: 3,
          last: { sent: 1, failed: 0, hasMore: false },
        },
        {
          pluginId: "beta",
          runs: 1,
          last: { sent: 1, failed: 0, hasMore: false },
        },
      ],
      hasMore: false,
      timedOut: false,
    });
  });

  it("returns no results when no plugin declares a sweep", async () => {
    const auth = createTestAuth([plainPlugin()]);
    expect(await sweepAll(auth)).toEqual({
      results: [],
      hasMore: false,
      timedOut: false,
    });
  });

  it("stops when the budget runs out and reports timedOut and hasMore", async () => {
    const log: string[] = [];
    const auth = createTestAuth([
      fixturePlugin("alpha", { sweep: batches(log, "alpha", 100) }),
      fixturePlugin("beta", { sweep: batches(log, "beta", 1) }),
    ]);

    // deadline = 0 + 30; each read of the clock advances 10ms:
    // checks at 10, 20 run; the check at 30 stops
    const result = await sweepAll(auth, {
      budgetMs: 30,
      now: fakeClock(10),
    });

    expect(log).toEqual(["alpha:1", "alpha:2"]);
    expect(result.timedOut).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(result.results).toEqual([
      {
        pluginId: "alpha",
        runs: 2,
        last: { sent: 1, failed: 0, hasMore: true },
      },
      // never reached: still listed, with no runs
      { pluginId: "beta", runs: 0 },
    ]);
  });

  it("isolates a throwing sweep, records the error and runs the next plugin", async () => {
    const log: string[] = [];
    const boom = new Error("sweep broke");
    const onError = vi.fn();
    const auth = createTestAuth([
      fixturePlugin("alpha", {
        sweep: async () => {
          log.push("alpha");
          throw boom;
        },
      }),
      fixturePlugin("beta", { sweep: batches(log, "beta", 2) }),
    ]);

    const result = await sweepAll(auth, { onError });

    expect(log).toEqual(["alpha", "beta:1", "beta:2"]);
    expect(onError).toHaveBeenCalledWith(boom, "alpha");
    expect(result.results[0]).toEqual({
      pluginId: "alpha",
      runs: 1,
      error: boom,
    });
    expect(result.results[1]?.runs).toBe(2);
    // a failing plugin doesn't keep hasMore true
    expect(result.hasMore).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("keeps hasMore from a batch before the throw out of the total", async () => {
    let calls = 0;
    const auth = createTestAuth([
      fixturePlugin("alpha", {
        sweep: async () => {
          calls++;
          if (calls === 2) throw new Error("second batch broke");
          return { hasMore: true };
        },
      }),
    ]);
    const result = await sweepAll(auth, { onError: () => {} });
    expect(result.results[0]?.runs).toBe(2);
    expect(result.results[0]?.last).toEqual({ hasMore: true });
    expect(result.results[0]?.error).toBeInstanceOf(Error);
    expect(result.hasMore).toBe(false);
  });

  it("reports sweep errors to console.error by default", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = createTestAuth([
      fixturePlugin("alpha", {
        sweep: async () => {
          throw new Error("x");
        },
      }),
    ]);
    await sweepAll(auth);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toBe(
      '[@byo-oss/core] sweep of plugin "alpha" failed',
    );
  });

  it("treats a result without hasMore: true as done", async () => {
    let calls = 0;
    const auth = createTestAuth([
      fixturePlugin("alpha", {
        // a sloppy plugin: not a real ByoSweepResult at runtime
        sweep: async () => {
          calls++;
          return undefined as unknown as ByoSweepResult;
        },
      }),
    ]);
    const result = await sweepAll(auth);
    expect(calls).toBe(1);
    expect(result.hasMore).toBe(false);
  });

  it("passes the auth instance to each sweep", async () => {
    const seen: unknown[] = [];
    const auth = createTestAuth([
      fixturePlugin("alpha", {
        sweep: async (a) => {
          seen.push(a);
          return { hasMore: false };
        },
      }),
    ]);
    await sweepAll(auth);
    expect(seen).toEqual([auth]);
  });
});
