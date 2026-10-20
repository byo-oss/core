import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "./events";
import type { ByoEvent } from "./types";

const event: ByoEvent = {
  type: "support.ticket.created",
  occurredAt: new Date("2026-10-20T00:00:00Z"),
  actorId: "user_1",
  organizationId: "org_1",
  subject: { type: "supportTicket", id: "t_1" },
  data: { status: "open" },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createEventBus", () => {
  it("calls every consumer in order, each awaited before the next", async () => {
    const order: string[] = [];
    const bus = createEventBus([
      async (e) => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(`a:${e.subject.id}`);
      },
      (e) => {
        order.push(`b:${e.subject.id}`);
      },
      async () => {
        await Promise.resolve();
        order.push("c");
      },
    ]);

    await bus(event);

    expect(order).toEqual(["a:t_1", "b:t_1", "c"]);
  });

  it("accepts a single consumer", async () => {
    const seen: ByoEvent[] = [];
    await createEventBus((e) => {
      seen.push(e);
    })(event);
    expect(seen).toEqual([event]);
  });

  it("isolates a consumer that rejects and one that throws synchronously", async () => {
    const order: string[] = [];
    const onError = vi.fn();
    const rejecting = new Error("async boom");
    const throwing = new Error("sync boom");
    const bus = createEventBus(
      [
        () => {
          order.push("a");
        },
        async () => {
          throw rejecting;
        },
        () => {
          throw throwing;
        },
        () => {
          order.push("d");
        },
      ],
      { onError },
    );

    await expect(bus(event)).resolves.toBeUndefined();

    expect(order).toEqual(["a", "d"]);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenNthCalledWith(1, rejecting, event, 1);
    expect(onError).toHaveBeenNthCalledWith(2, throwing, event, 2);
  });

  it("defaults to console.error with a [@byo-oss/core] prefix", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("boom");

    await createEventBus([
      () => {
        throw boom;
      },
    ])(event);

    expect(spy).toHaveBeenCalledTimes(1);
    const [message, error] = spy.mock.calls[0] ?? [];
    expect(String(message)).toMatch(/^\[@byo-oss\/core\]/);
    expect(String(message)).toContain("support.ticket.created");
    expect(error).toBe(boom);
  });

  it("never rejects, even when onError throws or rejects", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ran: string[] = [];
    const fail = () => {
      throw new Error("consumer");
    };

    await expect(
      createEventBus([fail, () => void ran.push("after")], {
        onError: () => {
          throw new Error("reporter");
        },
      })(event),
    ).resolves.toBeUndefined();
    await expect(
      createEventBus([fail], {
        onError: async () => {
          throw new Error("async reporter");
        },
      })(event),
    ).resolves.toBeUndefined();

    expect(ran).toEqual(["after"]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/^\[@byo-oss\/core\]/);
  });

  it("awaits an async onError before the next consumer", async () => {
    const order: string[] = [];
    const bus = createEventBus(
      [
        () => {
          throw new Error("x");
        },
        () => void order.push("next"),
      ],
      {
        onError: async () => {
          await new Promise((r) => setTimeout(r, 5));
          order.push("reported");
        },
      },
    );
    await bus(event);
    expect(order).toEqual(["reported", "next"]);
  });

  it("copies the consumer list when created", async () => {
    const ran: string[] = [];
    const consumers = [() => void ran.push("a")];
    const bus = createEventBus(consumers);
    consumers.push(() => void ran.push("late"));
    await bus(event);
    expect(ran).toEqual(["a"]);
  });
});
