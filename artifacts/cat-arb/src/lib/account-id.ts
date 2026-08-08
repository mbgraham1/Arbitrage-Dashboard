/**
 * Client-side mirror of the server's account scope (arb.ts accountScope →
 * accountIdFromKey): sha256(`${krakenKey}|${coinbaseKey ?? ""}`) hex,
 * first 16 chars — where the Coinbase key participates ONLY when its secret
 * is also held (canonical credential-presence rule). A lone Coinbase key
 * can't trade, so it must not fork the scope: the id the scan ranks under
 * must be the id the executor gates on and records fills under.
 *
 * Uses Web Crypto; no key material ever leaves the browser. Returns null
 * when no Kraken key is held (the server then applies the neutral prior).
 */
export async function deriveAccountId(krakenKey: string, coinbaseKey?: string, coinbaseSecret?: string): Promise<string | null> {
  if (!krakenKey) return null;
  const scopedCoinbaseKey = coinbaseKey && coinbaseSecret ? coinbaseKey : "";
  const data = new TextEncoder().encode(`${krakenKey}|${scopedCoinbaseKey}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
