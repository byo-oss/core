import type { ByoAuth, ByoHookName, ByoPluginHooks } from "./types";

const HOOK_NAMES = [
  "sweep",
  "deleteOrganizationData",
  "deleteMemberData",
] as const satisfies readonly ByoHookName[];

/** An installed plugin that declares a `byo` key. */
export type InstalledByoPlugin = { id: string; byo: ByoPluginHooks };

/** One row of {@link listByoPlugins}. */
export type ByoPluginInfo = { id: string; hooks: ByoHookName[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Plugins in `auth.options.plugins` order that carry a `byo` object. The
 * `byo` object is returned as given, so hooks are called as its methods.
 * @internal
 */
export function installedByoPlugins(auth: ByoAuth): InstalledByoPlugin[] {
  const found: InstalledByoPlugin[] = [];
  for (const plugin of auth.options.plugins ?? []) {
    if (!isRecord(plugin) || !isRecord(plugin.byo)) continue;
    found.push({ id: String(plugin.id), byo: plugin.byo as ByoPluginHooks });
  }
  return found;
}

/**
 * Whether `byo` provides `name` as a function. Anything else (a typo'd value,
 * `null`) counts as absent, so a malformed `byo` can't crash a sweep.
 * @internal
 */
export function hasHook(byo: ByoPluginHooks, name: ByoHookName): boolean {
  return typeof byo[name] === "function";
}

/**
 * The installed plugins that declare a `byo` key, in plugin order, with the
 * hooks each one provides. Useful for a health or diagnostics route.
 *
 * @example
 * ```ts
 * listByoPlugins(auth);
 * // [{ id: "support", hooks: ["sweep", "deleteOrganizationData", "deleteMemberData"] }]
 * ```
 */
export function listByoPlugins(auth: ByoAuth): ByoPluginInfo[] {
  return installedByoPlugins(auth).map(({ id, byo }) => ({
    id,
    hooks: HOOK_NAMES.filter((name) => hasHook(byo, name)),
  }));
}
