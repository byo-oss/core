// The README's setup wiring, end to end: organization hooks that reference
// `auth` (type-checks without a self-reference error) and reach the plugins.
import { getAuthTables } from "@better-auth/core/db";
import { type MemoryDB, memoryAdapter } from "@better-auth/memory-adapter";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import { deleteMemberData, deleteOrganizationData } from "./lifecycle";
import { fixturePlugin, listItems, seedItem } from "./test-utils";

function createAppAuth() {
  const base = {
    baseURL: "http://localhost:3000",
    secret: "byo-core-test-secret-0123456789abcdef",
    emailAndPassword: { enabled: true },
  } satisfies Partial<BetterAuthOptions>;
  const plugins = [
    organization({
      organizationHooks: {
        afterDeleteOrganization: async ({ organization }) => {
          await deleteOrganizationData(auth, organization.id);
        },
        afterRemoveMember: async ({ member }) => {
          await deleteMemberData(auth, {
            userId: member.userId,
            organizationId: member.organizationId,
          });
        },
      },
    }),
    fixturePlugin("alpha"),
  ];
  const tables = getAuthTables({ ...base, plugins });
  const db = Object.keys(tables).reduce<MemoryDB>((acc, table) => {
    acc[table] = [];
    return acc;
  }, {});
  const auth = betterAuth({ ...base, plugins, database: memoryAdapter(db) });
  return auth;
}

async function signUp(auth: ReturnType<typeof createAppAuth>, email: string) {
  const { headers, response } = await auth.api.signUpEmail({
    body: { email, password: "password-1234", name: email.split("@")[0] ?? "" },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { user: response.user, headers: new Headers({ cookie }) };
}

describe("organization hooks wired to the fan-out", () => {
  it("removing a member and deleting the org reach the plugin's cleanups", async () => {
    const auth = createAppAuth();
    const owner = await signUp(auth, "owner@example.com");
    const other = await signUp(auth, "other@example.com");
    const org = await auth.api.createOrganization({
      body: { name: "Acme", slug: "acme" },
      headers: owner.headers,
    });
    if (!org) throw new Error("no org");
    await auth.api.addMember({
      body: { userId: other.user.id, organizationId: org.id, role: "member" },
    });
    await seedItem(auth, "alpha", {
      organizationId: org.id,
      userId: owner.user.id,
    });
    await seedItem(auth, "alpha", {
      organizationId: org.id,
      userId: other.user.id,
    });
    await seedItem(auth, "alpha", {
      organizationId: "elsewhere",
      userId: other.user.id,
    });

    await auth.api.removeMember({
      body: { memberIdOrEmail: other.user.email, organizationId: org.id },
      headers: owner.headers,
    });
    expect(
      (await listItems(auth, "alpha")).map((r) => r.userId).sort(),
    ).toEqual([owner.user.id, other.user.id].sort());

    await auth.api.deleteOrganization({
      body: { organizationId: org.id },
      headers: owner.headers,
    });
    expect(
      (await listItems(auth, "alpha")).map((r) => r.organizationId),
    ).toEqual(["elsewhere"]);
  });
});
