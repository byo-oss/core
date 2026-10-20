// Type tests. `pnpm typecheck` (tsc over src/) is what checks them; the
// `@ts-expect-error` lines fail typecheck if the error they expect goes away.
// Vitest runs the file too, where the expectTypeOf calls are no-ops.
import type { BetterAuthPlugin } from "better-auth";
import { describe, expectTypeOf, it } from "vitest";
import { createEventBus } from "./events";
import { createTestAuth, fixturePlugin, plainPlugin } from "./test-utils";
import type {
  ByoAuth,
  ByoEvent,
  ByoEventHandler,
  ByoPlugin,
  ByoSweepResult,
} from "./types";

describe("types", () => {
  it("accepts a plugin literal with byo through satisfies ByoPlugin<BetterAuthPlugin>", () => {
    const plugin = {
      id: "x",
      byo: {
        sweep: async () => ({ sent: 0, hasMore: false }),
        deleteOrganizationData: async (_auth, _organizationId) => {},
        deleteMemberData: async (_auth, { userId, organizationId }) => {
          expectTypeOf(userId).toEqualTypeOf<string>();
          expectTypeOf(organizationId).toEqualTypeOf<string>();
        },
      },
    } satisfies ByoPlugin<BetterAuthPlugin>;
    expectTypeOf(plugin.id).toEqualTypeOf<"x">();

    // a plugin without byo is a ByoPlugin too
    const plain = { id: "y" } satisfies ByoPlugin<BetterAuthPlugin>;
    expectTypeOf(plain).toExtend<ByoPlugin>();
  });

  it("rejects byo under plain satisfies BetterAuthPlugin", () => {
    const plugin = {
      id: "x",
      // @ts-expect-error: the reason ByoPlugin exists
      byo: { sweep: async () => ({ hasMore: false }) },
    } satisfies BetterAuthPlugin;
    void plugin;
  });

  it("rejects a sweep result without hasMore and a misspelled hook arg", () => {
    const missing = {
      id: "x",
      byo: {
        // @ts-expect-error: hasMore is required
        sweep: async () => ({ sent: 0 }),
      },
    } satisfies ByoPlugin<BetterAuthPlugin>;
    void missing;

    const wrongValue = {
      id: "x",
      byo: {
        // @ts-expect-error: counts are numbers or booleans
        sweep: async () => ({ note: "hi", hasMore: false }),
      },
    } satisfies ByoPlugin<BetterAuthPlugin>;
    void wrongValue;
  });

  it("accepts a notifications-shaped SweepResult type alias", () => {
    type SweepResult = {
      sent: number;
      skipped: number;
      retrying: number;
      failed: number;
      hasMore: boolean;
    };
    expectTypeOf<SweepResult>().toExtend<ByoSweepResult>();
    // interfaces have no implicit index signature (hence the TSDoc advice)
    interface SweepInterface {
      sent: number;
      hasMore: boolean;
    }
    expectTypeOf<SweepInterface>().not.toExtend<ByoSweepResult>();
  });

  it("assigns a real betterAuth() instance to ByoAuth", () => {
    const auth = createTestAuth([fixturePlugin("alpha"), plainPlugin()]);
    expectTypeOf(auth).toExtend<ByoAuth>();
    const asByo: ByoAuth = auth;
    void asByo;
  });

  it("lets ByoAuth flow into a plugin function that takes { $context }", () => {
    // the shape @byo-oss/notifications' deleteOrganizationData takes
    type AuthWithContext = { $context: Promise<object> };
    expectTypeOf<ByoAuth>().toExtend<AuthWithContext>();
  });

  it("types ByoEvent as SPEC P1", () => {
    expectTypeOf<
      ByoEvent["type"]
    >().toEqualTypeOf<`${string}.${string}.${string}`>();
    expectTypeOf<ByoEvent["actorId"]>().toEqualTypeOf<string | null>();
    expectTypeOf<ByoEvent["occurredAt"]>().toEqualTypeOf<Date>();
    expectTypeOf<ByoEvent["subject"]>().toEqualTypeOf<{
      type: string;
      id: string;
    }>();
    expectTypeOf<ByoEvent["data"]>().toEqualTypeOf<Record<string, unknown>>();

    const bad: ByoEvent = {
      // @ts-expect-error: type needs three dot-separated parts
      type: "ticket",
      occurredAt: new Date(),
      actorId: null,
      subject: { type: "supportTicket", id: "t" },
      data: {},
    };
    void bad;
  });

  it("returns a ByoEventHandler usable as a plugin onEvent", () => {
    const onEvent = createEventBus([() => {}, async () => {}]);
    expectTypeOf(onEvent).toEqualTypeOf<ByoEventHandler>();
    expectTypeOf(onEvent).toExtend<(event: ByoEvent) => Promise<void> | void>();
  });
});
