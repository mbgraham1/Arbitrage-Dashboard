/**
 * Derivation-parity proof: the client's Web Crypto deriveAccountId must
 * produce EXACTLY the server's accountIdFromKey (arb.ts) —
 * sha256(`${krakenKey}|${coinbaseKey ?? ""}`).hex.slice(0, 16) — otherwise
 * the scan would rank routes against a scope that never matches the scope
 * the executor records under, silently disabling per-account isolation.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { deriveAccountId } from "./account-id";

const serverAccountIdFromKey = (krakenKey: string, coinbaseKey?: string): string =>
  createHash("sha256").update(`${krakenKey}|${coinbaseKey ?? ""}`).digest("hex").slice(0, 16);

describe("deriveAccountId ↔ server accountIdFromKey parity", () => {
  it("matches for a Kraken-only account", async () => {
    expect(await deriveAccountId("kraken-key-abc")).toBe(serverAccountIdFromKey("kraken-key-abc"));
  });

  it("matches for a Kraken + Coinbase account (key AND secret held)", async () => {
    expect(await deriveAccountId("kraken-key-abc", "coinbase-key-xyz", "coinbase-secret"))
      .toBe(serverAccountIdFromKey("kraken-key-abc", "coinbase-key-xyz"));
  });

  it("treats a missing Coinbase key exactly like the server (undefined ≡ empty)", async () => {
    expect(await deriveAccountId("k")).toBe(serverAccountIdFromKey("k", undefined));
    expect(await deriveAccountId("k", "")).toBe(serverAccountIdFromKey("k"));
  });

  it("a Coinbase key WITHOUT its secret must not fork the scope (canonical rule)", async () => {
    // Server records fills under hash(kraken|) when the Coinbase secret is
    // absent — the scan must rank under the same id or the trader's own
    // history becomes invisible to their own gate.
    expect(await deriveAccountId("k", "cb-key-no-secret"))
      .toBe(serverAccountIdFromKey("k"));
    expect(await deriveAccountId("k", "cb-key-no-secret", ""))
      .toBe(serverAccountIdFromKey("k"));
  });

  it("is 16 lowercase hex chars and differs per account", async () => {
    const a = await deriveAccountId("account-a");
    const b = await deriveAccountId("account-b");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });

  it("returns null without a Kraken key (server then applies the neutral prior)", async () => {
    expect(await deriveAccountId("")).toBeNull();
  });
});
