# @byo-oss/core

Shared glue for BYO better-auth plugins: the `ByoEvent` type, an event bus, one `sweepAll` for every plugin's background work, and the org/member cleanup fan-out. It is a library, not a plugin: no tables, no endpoints, nothing to add to `betterAuth({ plugins })`. `README.md` is the full reference.

## Wiring it into an app

1. `npm install @byo-oss/core` (peer: `better-auth` `^1.7.7`).
2. Events: build one handler with `createEventBus([...consumers])` and pass it as `onEvent` to every BYO plugin that takes one. Consumers run in order; one consumer's error is reported through `onError` (default `console.error`) and never reaches the plugin or the request.
3. Background work: add one server-only route (or job) that calls `await sweepAll(auth)` and schedule it every minute. Keep `budgetMs` (default 25 000) below the platform's timeout. If the result has `hasMore: true`, more work is due, so call again soon. Errors are in `results[i].error` and also go to `onError`. Protect the route (secret header or a non-public cron).
4. Cleanup: in the app's `organization({ organizationHooks })`, call `deleteOrganizationData(auth, organization.id)` from `afterDeleteOrganization`, and `deleteMemberData(auth, { userId: member.userId, organizationId: member.organizationId })` from `afterRemoveMember`. Both run every plugin, then throw a `ByoFanOutError` (an `AggregateError`) if any failed. Don't swallow it silently: log it, or let it fail the job so it gets retried.
5. Check what's installed with `listByoPlugins(auth)`, which lists each plugin id and the hooks it declares.

Rules:
- Pass the real `auth` instance (`betterAuth(...)`), not `auth.$context`.
- Don't call one plugin's hooks through `auth.options.plugins` yourself. Use the helpers, so order and error handling stay consistent.
- To make cleanup atomic, call the fan-out inside a transaction: either a better-auth hook that already runs in one, or `runWithTransaction` from `@better-auth/core/context`. `better-auth` doesn't re-export `runWithTransaction`, so the app must install `@better-auth/core` at the same version as `better-auth`. Plugins pick the transaction up through `getCurrentAdapter`.
- Leaving an organization fires no `organizationHooks`. If a plugin doesn't clean up on `/organization/leave` itself, call `deleteMemberData` after a leave.

## Declaring `byo` in a plugin

```ts
import type { BetterAuthPlugin } from "better-auth";
import type { ByoPlugin } from "@byo-oss/core";

export const thing = (options: ThingOptions = {}) =>
  ({
    id: "thing",
    // endpoints, schema, hooks ...
    byo: {
      sweep: (auth) => processThings(auth),             // Promise<{ ...counts, hasMore }>
      deleteOrganizationData: async (auth, organizationId) => {
        await deleteThingOrgData(auth, organizationId);
      },
      deleteMemberData: async (auth, { userId, organizationId }) => {
        await deleteThingMemberData(auth, { userId, organizationId });
      },
    },
  }) satisfies ByoPlugin<BetterAuthPlugin>;
```

- End with `satisfies ByoPlugin<BetterAuthPlugin>`. `satisfies BetterAuthPlugin` rejects the `byo` key.
- Every hook is optional. Declare only what the plugin has.
- Hooks get `auth: ByoAuth` (`options.plugins` and `$context`). Resolve the adapter with `getCurrentAdapter((await auth.$context).adapter)`, never the raw `context.adapter`, so cleanup joins the caller's transaction.
- A cleanup hook returns `Promise<void>` and throws on failure. Wrap functions that return counts: `async (...) => { await fn(...) }`.
- A sweep returns `ByoSweepResult`: numbers or booleans plus `hasMore`. Declare its type with `type`, not `interface`. It must be safe to call repeatedly and concurrently (leases), because `sweepAll` loops on `hasMore` and cron runs can overlap.
- Keep exporting the plugin's own cleanup functions and `process*` endpoint. `byo` only lets core reach them.
- Test the wiring with a real `betterAuth` on the memory adapter: `sweepAll`, `deleteOrganizationData` and `deleteMemberData` from `@byo-oss/core` should reach the plugin.

## Working on this repo

- `pnpm install`, then `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- Source is in `src/`: `types.ts` (public types), `events.ts`, `sweep.ts`, `lifecycle.ts`, `plugins.ts` (plugin discovery, `listByoPlugins`), and `index.ts` (re-exports only).
- Tests run against a real better-auth instance on the memory adapter with fixture plugins (`src/test-utils.ts`). `src/types.test.ts` holds type tests that `pnpm typecheck` enforces (`@ts-expect-error`, `expectTypeOf`).
- Import better-auth with `import type` only. The built `dist/` must have no runtime import of better-auth.
- A change to public types or helper semantics updates `README.md` in the same PR.
- Follow the BYO conventions: https://github.com/byo-oss/conventions/blob/main/SPEC.md
