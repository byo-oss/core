import { hasHook, installedByoPlugins } from "./plugins";
import type { ByoAuth, ByoHookName, ByoPluginHooks } from "./types";

type CleanupHook = Exclude<ByoHookName, "sweep">;

/** One plugin's failure inside a fan-out. */
export type ByoFanOutFailure = { pluginId: string; error: unknown };

/**
 * Thrown by {@link deleteOrganizationData} and {@link deleteMemberData} after
 * every plugin has run, when at least one failed. `errors` holds one wrapped
 * `Error` per failure (message names the plugin, `cause` is the original);
 * `failures` pairs each plugin id with its original error.
 */
export class ByoFanOutError extends AggregateError {
  readonly hook: CleanupHook;
  readonly failures: ByoFanOutFailure[];

  constructor(hook: CleanupHook, failures: ByoFanOutFailure[]) {
    const ids = failures.map((f) => f.pluginId).join(", ");
    super(
      failures.map(
        ({ pluginId, error }) =>
          new Error(`[@byo-oss/core] plugin "${pluginId}" ${hook} failed`, {
            cause: error,
          }),
      ),
      `[@byo-oss/core] ${hook} failed in ${failures.length} plugin(s): ${ids}`,
    );
    this.name = "ByoFanOutError";
    this.hook = hook;
    this.failures = failures;
  }
}

async function fanOut(
  auth: ByoAuth,
  hook: CleanupHook,
  call: (byo: ByoPluginHooks) => Promise<void> | undefined,
): Promise<void> {
  const failures: ByoFanOutFailure[] = [];
  // sequential, never Promise.all: inside a transaction every hook shares one
  // connection, and concurrent queries on it aren't safe
  for (const { id, byo } of installedByoPlugins(auth)) {
    if (!hasHook(byo, hook)) continue;
    try {
      await call(byo);
    } catch (error) {
      failures.push({ pluginId: id, error });
    }
  }
  if (failures.length > 0) throw new ByoFanOutError(hook, failures);
}

/**
 * Delete what every installed BYO plugin holds for an organization (SPEC
 * §6.2, P5), by calling each plugin's `byo.deleteOrganizationData` in plugin
 * order.
 *
 * Every plugin runs even if an earlier one throws. Afterwards, if any failed,
 * this throws a {@link ByoFanOutError} (an `AggregateError` with a
 * `[@byo-oss/core]` message) so the caller notices. Resolves without doing
 * anything when no plugin declares the hook.
 *
 * Core opens no transaction of its own. Plugins resolve their adapter with
 * `getCurrentAdapter`, so calling this inside the app's transaction (for
 * example from an `organizationHooks` callback, or within
 * `runWithTransaction`) runs every plugin's cleanup on that transaction, and
 * the thrown error rolls it back.
 *
 * @example
 * ```ts
 * organization({
 *   organizationHooks: {
 *     afterDeleteOrganization: async ({ organization }) => {
 *       await deleteOrganizationData(auth, organization.id);
 *     },
 *   },
 * });
 * ```
 */
export function deleteOrganizationData(
  auth: ByoAuth,
  organizationId: string,
): Promise<void> {
  return fanOut(auth, "deleteOrganizationData", (byo) =>
    byo.deleteOrganizationData?.(auth, organizationId),
  );
}

/**
 * Delete what every installed BYO plugin holds for one member of an
 * organization, after they leave or are removed (SPEC §6.3, P5), by calling
 * each plugin's `byo.deleteMemberData` in plugin order.
 *
 * Same semantics as {@link deleteOrganizationData}: all plugins run, then a
 * {@link ByoFanOutError} if any failed; no-op when none declares the hook;
 * runs on the caller's transaction through `getCurrentAdapter`.
 *
 * @example
 * ```ts
 * organization({
 *   organizationHooks: {
 *     afterRemoveMember: async ({ member }) => {
 *       await deleteMemberData(auth, {
 *         userId: member.userId,
 *         organizationId: member.organizationId,
 *       });
 *     },
 *   },
 * });
 * ```
 */
export function deleteMemberData(
  auth: ByoAuth,
  input: { userId: string; organizationId: string },
): Promise<void> {
  return fanOut(auth, "deleteMemberData", (byo) =>
    byo.deleteMemberData?.(auth, {
      userId: input.userId,
      organizationId: input.organizationId,
    }),
  );
}
