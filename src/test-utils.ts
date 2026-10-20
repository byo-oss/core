import { getAuthTables } from "@better-auth/core/db";
import type { MemoryDB } from "@better-auth/memory-adapter";
import { memoryAdapter } from "@better-auth/memory-adapter";
import {
  type AuthContext,
  type BetterAuthOptions,
  type BetterAuthPlugin,
  betterAuth,
  type DBTransactionAdapter,
  getCurrentAdapter,
} from "better-auth";
import type { ByoAuth, ByoPlugin, ByoPluginHooks } from "./types";

const baseOptions = {
  baseURL: "http://localhost:3000",
  secret: "byo-core-test-secret-0123456789abcdef",
} satisfies Partial<BetterAuthOptions>;

function seededMemoryAdapter(options: BetterAuthOptions) {
  const tables = getAuthTables(options);
  const memoryDB = Object.keys(tables).reduce<MemoryDB>((db, table) => {
    db[table] = [];
    return db;
  }, {});
  return memoryAdapter(memoryDB);
}

/** A real better-auth instance on the memory adapter with the given plugins. */
export function createTestAuth<const P extends BetterAuthPlugin[]>(plugins: P) {
  return betterAuth({
    ...baseOptions,
    plugins,
    database: seededMemoryAdapter({ ...baseOptions, plugins }),
  });
}

/** The instance's own adapter, outside any transaction. */
export async function baseAdapter(auth: ByoAuth) {
  return ((await auth.$context) as AuthContext).adapter;
}

/** The adapter a hook should use: the transaction's when one is active. */
export async function currentAdapter(
  auth: ByoAuth,
): Promise<DBTransactionAdapter> {
  const context = (await auth.$context) as AuthContext;
  return getCurrentAdapter(context.adapter);
}

/** The model a fixture plugin owns, e.g. `alphaItem`. */
export const itemModel = (id: string) => `${id}Item`;

export type FixtureOptions = {
  /** Shared call log; each hook appends `"<id>:<hook>"`. */
  log?: string[];
  /** Replaces the default sweep (which returns `{ processed: 0, hasMore: false }`). */
  sweep?: ByoPluginHooks["sweep"];
  /** Makes both cleanup hooks throw after logging. */
  failCleanup?: boolean;
  /** Called with the adapter each cleanup hook resolved. */
  onAdapter?: (adapter: DBTransactionAdapter) => void;
};

/**
 * A plugin shaped like a real BYO plugin: one table keyed by organization and
 * user, cleanups that delete its rows through `getCurrentAdapter`, and a
 * sweep.
 */
export function fixturePlugin(id: string, options: FixtureOptions = {}) {
  const model = itemModel(id);
  const log = options.log ?? [];

  async function deleteWhere(
    auth: ByoAuth,
    hook: string,
    where: { field: string; value: string }[],
  ) {
    log.push(`${id}:${hook}`);
    const adapter = await currentAdapter(auth);
    options.onAdapter?.(adapter);
    await adapter.deleteMany({ model, where });
    if (options.failCleanup) throw new Error(`${id} ${hook} broke`);
  }

  return {
    id,
    schema: {
      [model]: {
        fields: {
          organizationId: { type: "string", required: true },
          userId: { type: "string", required: true },
        },
      },
    },
    byo: {
      sweep:
        options.sweep ??
        (async () => {
          log.push(`${id}:sweep`);
          return { processed: 0, hasMore: false };
        }),
      deleteOrganizationData: (auth, organizationId) =>
        deleteWhere(auth, "deleteOrganizationData", [
          { field: "organizationId", value: organizationId },
        ]),
      deleteMemberData: (auth, { userId, organizationId }) =>
        deleteWhere(auth, "deleteMemberData", [
          { field: "userId", value: userId },
          { field: "organizationId", value: organizationId },
        ]),
    },
  } satisfies ByoPlugin<BetterAuthPlugin>;
}

/** A plain better-auth plugin with no `byo` key. */
export const plainPlugin = () => ({ id: "plain" }) satisfies BetterAuthPlugin;

/** A clock that moves forward `stepMs` every time it's read. */
export function fakeClock(stepMs: number, start = 0) {
  let t = start;
  return () => {
    const value = t;
    t += stepMs;
    return value;
  };
}

/** Create one row in a fixture plugin's table. */
export async function seedItem(
  auth: ByoAuth,
  pluginId: string,
  data: { organizationId: string; userId: string },
) {
  const context = (await auth.$context) as AuthContext;
  return context.adapter.create({ model: itemModel(pluginId), data });
}

/** All rows in a fixture plugin's table. */
export async function listItems(auth: ByoAuth, pluginId: string) {
  const context = (await auth.$context) as AuthContext;
  return context.adapter.findMany<{
    id: string;
    organizationId: string;
    userId: string;
  }>({ model: itemModel(pluginId), limit: 1000 });
}
