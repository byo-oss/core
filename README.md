# @byo-oss/core

One event bus, one cron route and one org-cleanup call for every BYO better-auth plugin in your app.

> Community plugin — not affiliated with the better-auth team.

`@byo-oss/core` is a small library, not a plugin: it adds no tables and no endpoints. It reads the plugins you already pass to `betterAuth({ plugins })` and calls the hooks that BYO plugins declare under a `byo` key.

## Install

```sh
npm install @byo-oss/core
```

Peer dependency: `better-auth` `^1.6.23`.

## Setup

1. Build one `onEvent` with `createEventBus` and pass it to every BYO plugin that emits events:

   ```ts
   import { createEventBus } from "@byo-oss/core";

   const onEvent = createEventBus([
     (event) => activity.record(event),
     async (event) => {
       if (event.type === "support.agent.replied" && event.userId) {
         await auth.api.notify({ body: { userId: event.userId, type: event.type, title: "New reply" } });
       }
     },
   ]);

   export const auth = betterAuth({
     plugins: [support({ onEvent }), feedback({ onEvent })],
   });
   ```

2. Add one cron route that calls `sweepAll`, and run it every minute from any scheduler:

   ```ts
   import { sweepAll } from "@byo-oss/core";

   export async function GET() {
     const result = await sweepAll(auth, { budgetMs: 20_000 });
     return Response.json(result);
   }
   ```

3. Wire the cleanup fan-out into the organization plugin's hooks:

   ```ts
   import { deleteMemberData, deleteOrganizationData } from "@byo-oss/core";

   organization({
     organizationHooks: {
       afterDeleteOrganization: async ({ organization }) => {
         await deleteOrganizationData(auth, organization.id);
       },
       afterRemoveMember: async ({ member }) => {
         await deleteMemberData(auth, { userId: member.userId, organizationId: member.organizationId });
       },
     },
   });
   ```

Protect the cron route the way your scheduler expects (a shared secret header, or a platform cron that isn't publicly reachable).

## Options

`createEventBus(consumers, options?)`

| Option | Default | Notes |
|---|---|---|
| `onError` | `console.error` with a `[@byo-oss/core]` prefix | `(error, event, consumerIndex) => void \| Promise<void>`. Called once per failing consumer. If it throws, that goes to `console.error` too. |

`sweepAll(auth, options?)`

| Option | Default | Notes |
|---|---|---|
| `budgetMs` | `25_000` | Total time across all plugins, checked before every call. A call already running can overrun it, so pick a value below your platform's timeout. |
| `now` | `Date.now` | Clock in ms, for tests. |
| `onError` | `console.error` with a `[@byo-oss/core]` prefix | `(error, pluginId) => void`. Called when a plugin's sweep throws. |

## API

| Export | Kind | Input | Returns |
|---|---|---|---|
| `createEventBus` | function | `consumers: ByoEventHandler[] \| ByoEventHandler`, `{ onError? }` | `ByoEventHandler`: runs each consumer in order, awaited, and never throws or rejects |
| `sweepAll` | function | `auth`, `{ budgetMs?, now?, onError? }` | `{ results: { pluginId, runs, last?, error? }[]; hasMore: boolean; timedOut: boolean }` |
| `deleteOrganizationData` | function | `auth`, `organizationId: string` | `Promise<void>`; throws `ByoFanOutError` after all plugins ran if any failed |
| `deleteMemberData` | function | `auth`, `{ userId, organizationId }` | `Promise<void>`; same failure rule |
| `listByoPlugins` | function | `auth` | `{ id, hooks: ("sweep" \| "deleteOrganizationData" \| "deleteMemberData")[] }[]` |
| `ByoFanOutError` | class | | `AggregateError` with `hook`, `failures: { pluginId, error }[]`, and one wrapped `Error` per failure in `errors` (`cause` is the original) |
| `ByoEvent` | type | | The event shape every BYO plugin emits (below) |
| `ByoEventHandler` | type | | `(event: ByoEvent) => void \| Promise<void>` |
| `ByoPlugin<P>` | type | | `P & { byo?: ByoPluginHooks }` |
| `ByoPluginHooks` | type | | `{ sweep?, deleteOrganizationData?, deleteMemberData? }` |
| `ByoSweepResult` | type | | `{ hasMore: boolean } & Record<string, number \| boolean>` |
| `ByoAuth` | type | | `{ options: { plugins?: readonly unknown[] }; $context: Promise<object> }`. Any `betterAuth()` instance assigns to it. |

`auth` is your `betterAuth()` instance.

```ts
type ByoEvent = {
  type: `${string}.${string}.${string}` // "<plugin id>.<noun>.<past-tense verb>", e.g. "support.ticket.created"
  occurredAt: Date
  actorId: string | null                 // a user id, or null for the system
  userId?: string                        // whom it's about, if one person
  organizationId?: string
  subject: { type: string; id: string }  // e.g. { type: "supportTicket", id }
  data: Record<string, unknown>          // ids, statuses, kinds; never bodies
}
```

### How each helper behaves

- **`createEventBus`**: consumers run one after another, in the order given. A consumer that throws or rejects is reported through `onError`, and the next consumer still runs. The list is copied when the bus is created.
- **`sweepAll`**: plugins run in `betterAuth({ plugins })` order. Each plugin's `byo.sweep` is called again while it returns `hasMore: true` and the budget remains, then the next plugin runs. A plugin that throws is recorded in its result, reported, and skipped for the rest of the call, and the other plugins still run. A plugin not reached before the budget ran out is listed with `runs: 0`, and the result has `timedOut: true` and `hasMore: true`. A plugin that threw doesn't count toward `hasMore`, so a caller that re-runs on `hasMore` can't spin on a broken plugin. Because plugins run in order, a busy plugin can use the whole budget. `hasMore: true` means call again soon.
- **`deleteOrganizationData` / `deleteMemberData`**: each plugin's hook is called in plugin order, one at a time. Every plugin runs even if an earlier one throws. Afterwards, if any failed, the call throws a `ByoFanOutError` (an `AggregateError` with a `[@byo-oss/core]` message naming the plugins), so you notice. If no plugin declares the hook, the call does nothing. Core opens no transaction. BYO plugins resolve their adapter with better-auth's `getCurrentAdapter`, so calling the fan-out inside your transaction (`runWithTransaction`, or a hook better-auth runs in one) runs every plugin's cleanup on that transaction, and the thrown error rolls all of them back.

Leaving an organization fires no `organizationHooks`. Call `deleteMemberData` yourself after a leave if you need it, or rely on plugins that clean up through their own `/organization/leave` hook.

## Guarantees

- **Events** are in-process and best-effort. The bus never fails the request that emitted the event, and nothing is retried or stored. A consumer that needs durability writes its own rows.
- **Sweeps**: `sweepAll` adds no guarantee of its own. Leases, retries, backoff and at-least-once delivery (and what can cause a duplicate) belong to each plugin's sweep and are documented in that plugin's README. Overlapping `sweepAll` calls are as safe as each plugin's sweep, which the BYO conventions require to be lease-based.
- **Cleanup** is all-plugins-then-throw: one plugin's failure never stops another plugin's cleanup. Outside a transaction, the cleanups that succeeded stay done when the call throws.

## For plugin authors

Declare the hooks under `byo`, and end the plugin object with `satisfies ByoPlugin<BetterAuthPlugin>`. `satisfies BetterAuthPlugin` alone rejects the extra key. better-auth ignores `byo` at runtime and keeps your object as given in `auth.options.plugins`.

```ts
import type { BetterAuthPlugin } from "better-auth";
import type { ByoPlugin } from "@byo-oss/core";

export const feedback = (options: FeedbackOptions = {}) =>
  ({
    id: "feedback",
    endpoints: { /* ... */ },
    byo: {
      sweep: (auth) => processFeedbackDigests(auth),          // returns { sent, failed, hasMore }
      deleteOrganizationData: async (auth, organizationId) => {
        await deleteFeedbackOrgData(auth, organizationId);
      },
      deleteMemberData: async (auth, { userId, organizationId }) => {
        await deleteFeedbackMemberData(auth, { userId, organizationId });
      },
    },
  }) satisfies ByoPlugin<BetterAuthPlugin>;
```

- Inside a hook, read the adapter with `getCurrentAdapter((await auth.$context).adapter)`, so the hook joins the caller's transaction.
- A sweep returns counts plus `hasMore`. Declare its result as a `type`, not an `interface`, so it assigns to `ByoSweepResult`.
- Keep exporting your own `deleteOrganizationData` / `deleteMemberData` and sweep endpoint. `byo` is a way to reach them, not a replacement.
- Depend on `@byo-oss/core` for the types and helpers. It has no runtime dependency on better-auth.

## What this is not (yet)

- Not a job queue or scheduler: you still need one cron that calls `sweepAll`.
- Not durable events: no outbox, no retries, no cross-process delivery.
- No user-delete fan-out: user data goes through foreign keys and each plugin's own `databaseHooks`.
- No data export fan-out, and no shared identity (`identify(request)`) helper yet.

## License

MIT
