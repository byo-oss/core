import { runWithTransaction } from "@better-auth/core/context";
import type { DBTransactionAdapter } from "better-auth";
import { describe, expect, it } from "vitest";
import {
  ByoFanOutError,
  deleteMemberData,
  deleteOrganizationData,
} from "./lifecycle";
import { listByoPlugins } from "./plugins";
import {
  baseAdapter,
  createTestAuth,
  fixturePlugin,
  listItems,
  plainPlugin,
  seedItem,
} from "./test-utils";

async function seed(auth: Parameters<typeof seedItem>[0], ids: string[]) {
  for (const id of ids) {
    await seedItem(auth, id, { organizationId: "org_1", userId: "u_1" });
    await seedItem(auth, id, { organizationId: "org_1", userId: "u_2" });
    await seedItem(auth, id, { organizationId: "org_2", userId: "u_1" });
  }
}

describe("deleteOrganizationData", () => {
  it("calls every plugin's hook in plugin order and deletes their rows", async () => {
    const log: string[] = [];
    const auth = createTestAuth([
      fixturePlugin("alpha", { log }),
      plainPlugin(),
      fixturePlugin("beta", { log }),
    ]);
    await seed(auth, ["alpha", "beta"]);

    await deleteOrganizationData(auth, "org_1");

    expect(log).toEqual([
      "alpha:deleteOrganizationData",
      "beta:deleteOrganizationData",
    ]);
    for (const id of ["alpha", "beta"]) {
      const rows = await listItems(auth, id);
      expect(rows.map((r) => r.organizationId)).toEqual(["org_2"]);
    }
  });

  it("runs every plugin when one throws, then throws an AggregateError", async () => {
    const log: string[] = [];
    const auth = createTestAuth([
      fixturePlugin("alpha", { log, failCleanup: true }),
      fixturePlugin("beta", { log }),
    ]);
    await seed(auth, ["alpha", "beta"]);

    const error = await deleteOrganizationData(auth, "org_1").catch(
      (e: unknown) => e,
    );

    expect(log).toEqual([
      "alpha:deleteOrganizationData",
      "beta:deleteOrganizationData",
    ]);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toBeInstanceOf(ByoFanOutError);
    const fanOut = error as ByoFanOutError;
    expect(fanOut.message).toBe(
      "[@byo-oss/core] deleteOrganizationData failed in 1 plugin(s): alpha",
    );
    expect(fanOut.hook).toBe("deleteOrganizationData");
    expect(fanOut.failures.map((f) => f.pluginId)).toEqual(["alpha"]);
    expect(fanOut.errors).toHaveLength(1);
    const wrapped = fanOut.errors[0] as Error;
    expect(wrapped.message).toBe(
      '[@byo-oss/core] plugin "alpha" deleteOrganizationData failed',
    );
    expect((wrapped.cause as Error).message).toBe(
      "alpha deleteOrganizationData broke",
    );
    // beta still cleaned up
    const beta = await listItems(auth, "beta");
    expect(beta.map((r) => r.organizationId)).toEqual(["org_2"]);
  });

  it("collects every failure", async () => {
    const auth = createTestAuth([
      fixturePlugin("alpha", { failCleanup: true }),
      fixturePlugin("beta", { failCleanup: true }),
    ]);
    const error = (await deleteOrganizationData(auth, "org_1").catch(
      (e: unknown) => e,
    )) as ByoFanOutError;
    expect(error.failures.map((f) => f.pluginId)).toEqual(["alpha", "beta"]);
    expect(error.errors).toHaveLength(2);
  });

  it("is a no-op when no plugin declares the hook", async () => {
    const auth = createTestAuth([
      plainPlugin(),
      { id: "sweepOnly", byo: { sweep: async () => ({ hasMore: false }) } },
    ]);
    await expect(deleteOrganizationData(auth, "org_1")).resolves.toBe(
      undefined,
    );
    await expect(
      deleteMemberData(auth, { userId: "u_1", organizationId: "org_1" }),
    ).resolves.toBe(undefined);
  });

  it("runs on the caller's transaction and rolls back with it", async () => {
    const adapters: DBTransactionAdapter[] = [];
    const auth = createTestAuth([
      fixturePlugin("alpha", { onAdapter: (a) => adapters.push(a) }),
      fixturePlugin("beta", {
        failCleanup: true,
        onAdapter: (a) => adapters.push(a),
      }),
    ]);
    await seed(auth, ["alpha", "beta"]);
    const adapter = await baseAdapter(auth);

    await expect(
      runWithTransaction(adapter, () => deleteOrganizationData(auth, "org_1")),
    ).rejects.toBeInstanceOf(ByoFanOutError);

    expect(adapters).toHaveLength(2);
    expect(adapters[0]).not.toBe(adapter);
    expect(adapters[1]).toBe(adapters[0]);
    // the throw rolled back alpha's delete too
    expect(await listItems(auth, "alpha")).toHaveLength(3);
    expect(await listItems(auth, "beta")).toHaveLength(3);
  });
});

describe("deleteMemberData", () => {
  it("calls every plugin's hook in order with the member, deleting only their rows", async () => {
    const log: string[] = [];
    const auth = createTestAuth([
      fixturePlugin("alpha", { log }),
      fixturePlugin("beta", { log }),
    ]);
    await seed(auth, ["alpha", "beta"]);

    await deleteMemberData(auth, { userId: "u_1", organizationId: "org_1" });

    expect(log).toEqual(["alpha:deleteMemberData", "beta:deleteMemberData"]);
    for (const id of ["alpha", "beta"]) {
      const rows = await listItems(auth, id);
      expect(rows.map((r) => `${r.organizationId}/${r.userId}`).sort()).toEqual(
        ["org_1/u_2", "org_2/u_1"],
      );
    }
  });

  it("runs every plugin when one throws, then throws an AggregateError", async () => {
    const log: string[] = [];
    const auth = createTestAuth([
      fixturePlugin("alpha", { log }),
      fixturePlugin("beta", { log, failCleanup: true }),
    ]);

    const error = await deleteMemberData(auth, {
      userId: "u_1",
      organizationId: "org_1",
    }).catch((e: unknown) => e);

    expect(log).toEqual(["alpha:deleteMemberData", "beta:deleteMemberData"]);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as Error).message).toBe(
      "[@byo-oss/core] deleteMemberData failed in 1 plugin(s): beta",
    );
  });
});

describe("listByoPlugins", () => {
  it("lists plugins with a byo key, in order, with their hooks", () => {
    const auth = createTestAuth([
      fixturePlugin("alpha"),
      plainPlugin(),
      { id: "sweepOnly", byo: { sweep: async () => ({ hasMore: false }) } },
    ]);
    expect(listByoPlugins(auth)).toEqual([
      {
        id: "alpha",
        hooks: ["sweep", "deleteOrganizationData", "deleteMemberData"],
      },
      { id: "sweepOnly", hooks: ["sweep"] },
    ]);
  });

  it("ignores hooks that aren't functions", () => {
    const auth = createTestAuth([
      {
        id: "broken",
        byo: { sweep: "nope", deleteMemberData: null },
      } as unknown as ReturnType<typeof plainPlugin>,
    ]);
    expect(listByoPlugins(auth)).toEqual([{ id: "broken", hooks: [] }]);
  });
});
