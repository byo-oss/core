import type { BetterAuthPlugin } from "better-auth";

/**
 * A domain event, exactly as the BYO conventions define it (Part 2, P1).
 *
 * Packages emit events after their write commits and hand them to an
 * `onEvent?: (event: ByoEvent) => void | Promise<void>` option. Delivery is
 * in-process and best-effort: an error in a consumer never fails the request
 * that caused the event.
 */
export type ByoEvent = {
  /**
   * `"<package id>.<noun>.<past-tense verb>"`, e.g.
   * `"support.ticket.created"` or `"feedback.post.status_changed"`.
   */
  type: `${string}.${string}.${string}`;
  /** When the change happened. */
  occurredAt: Date;
  /** The user who caused it, or `null` for the system. */
  actorId: string | null;
  /** Whom the event is about, when that's one person. */
  userId?: string;
  /** The organization the event belongs to, if any. */
  organizationId?: string;
  /** The record the event is about, e.g. `{ type: "supportTicket", id }`. */
  subject: { type: string; id: string };
  /** Ids, statuses and kinds. Never message bodies or secrets. */
  data: Record<string, unknown>;
};

/** Anything that consumes a {@link ByoEvent}: a plugin's `onEvent`, a bus, a logger. */
export type ByoEventHandler = (event: ByoEvent) => void | Promise<void>;

/**
 * What a plugin's sweep returns: counts (or flags) plus `hasMore`, following
 * the background-work contract (SPEC §5.3), e.g.
 * `{ sent: 3, skipped: 0, retrying: 1, failed: 0, hasMore: false }`.
 *
 * Declare your plugin's result with a `type` alias, not an `interface`:
 * interfaces get no implicit index signature, so they don't assign to the
 * `Record` part of this type.
 */
export type ByoSweepResult = { hasMore: boolean } & Record<
  string,
  number | boolean
>;

/**
 * The minimal shape of a `betterAuth()` instance that `@byo-oss/core` and the
 * `byo` hooks need. Structural on purpose, so any auth instance assigns to it
 * without generics.
 *
 * - `options.plugins` is read to find installed plugins, in order.
 * - `$context` is not read by core. It is here so a hook can resolve its
 *   adapter (`(await auth.$context).adapter`) or pass `auth` straight to the
 *   plugin's own exported functions that take `{ $context: Promise<object> }`.
 */
export type ByoAuth = {
  options: { plugins?: readonly unknown[] | undefined };
  $context: Promise<object>;
};

/**
 * Optional hooks a plugin declares under its `byo` key so the helpers in
 * `@byo-oss/core` can reach it.
 *
 * - `sweep` runs one batch of the plugin's background work (its `process*`
 *   endpoint) and returns counts plus `hasMore`. It must be safe to call
 *   repeatedly and concurrently (leases, SPEC §5.2).
 * - `deleteOrganizationData` and `deleteMemberData` are the plugin's lifecycle
 *   cleanups (SPEC §6.2, §6.3). Resolve the adapter with
 *   `getCurrentAdapter(context.adapter)` from `better-auth`, so a cleanup
 *   called inside the app's transaction runs on that transaction.
 */
export type ByoPluginHooks = {
  sweep?: (auth: ByoAuth) => Promise<ByoSweepResult>;
  deleteOrganizationData?: (
    auth: ByoAuth,
    organizationId: string,
  ) => Promise<void>;
  deleteMemberData?: (
    auth: ByoAuth,
    input: { userId: string; organizationId: string },
  ) => Promise<void>;
};

/** The names of the hooks in {@link ByoPluginHooks}. */
export type ByoHookName = keyof ByoPluginHooks;

/**
 * A better-auth plugin that may carry BYO hooks. End a plugin object with
 * `satisfies ByoPlugin<BetterAuthPlugin>`: `satisfies BetterAuthPlugin`
 * rejects the extra `byo` key. better-auth ignores the key at runtime and
 * keeps the object as given in `auth.options.plugins`.
 *
 * @example
 * ```ts
 * export const feedback = (options: FeedbackOptions = {}) =>
 *   ({
 *     id: "feedback",
 *     endpoints: { ... },
 *     byo: {
 *       sweep: (auth) => processFeedbackDigests(auth),
 *       deleteOrganizationData: (auth, organizationId) =>
 *         deleteFeedbackOrgData(auth, organizationId).then(() => {}),
 *     },
 *   }) satisfies ByoPlugin<BetterAuthPlugin>;
 * ```
 */
export type ByoPlugin<P extends BetterAuthPlugin = BetterAuthPlugin> = P & {
  byo?: ByoPluginHooks;
};
