/**
 * DISCOVERY ENGINE card — read-only cross-venue arbitrage scan.
 *
 * Shows where the best REAL spreads live across 8 public exchanges plus the
 * two live venues, categorized honestly: executable now / requires setup /
 * not profitable. Projections at $10, $50, $100 — but live execution stays
 * capped at $10 on Kraken/Coinbase; nothing here fires trades.
 */
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useBotContext } from "@/store/bot-context";
import { useDiscoveryScan, DiscoveryResult, DiscoveryRow } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

const fmt = (v: number | null | undefined, d = 4) => (v == null ? "—" : `$${v.toFixed(d)}`);

const BLOCKER_LABEL: Record<string, string> = {
  NONE: "clear to run",
  NO_EDGE: "no gross edge — market too tight",
  BLOCKED_BY_FEES: "fees exceed the gross edge",
  INSUFFICIENT_INVENTORY: "positive net, blocked only by inventory",
  NEEDS_KEYS: "connect API keys to verify",
  NEEDS_ACCOUNT: "needs an account on another venue",
};

function Verdict({ row, kind }: { row: DiscoveryRow; kind: "best" | "nearmiss" }) {
  const positive = (row.net10 ?? -1) > 0;
  const c = row.costsAtBest;
  return (
    <div className={cn("rounded border p-2 space-y-1", kind === "best" && positive ? "border-green-500/60 bg-green-500/5" : "border-border bg-muted/30")}
      data-testid={kind === "best" ? "panel-disc-best" : "panel-disc-nearmiss"}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("font-semibold", kind === "best" && positive ? "text-green-500" : "text-foreground")}>
          {kind === "best" ? "BEST EXECUTABLE" : "BEST NEAR-MISS"}
        </span>
        <span>{row.asset} · {row.structure} · {row.buyVenue} → {row.sellVenue}</span>
        <span className={cn("rounded px-1.5 py-0.5 font-semibold", (row.net10 ?? -1) > 0 ? "bg-green-500/15 text-green-500" : "bg-muted text-muted-foreground")}>
          executable net @ $10: {fmt(row.net10)}
        </span>
        {row.bestSizeUsd != null && row.bestSizeUsd !== 10 && (
          <span className="text-muted-foreground">
            sweep peak {fmt(row.bestNetUsd)} @ ${row.bestSizeUsd} — <span className="text-amber-500">projection only; live execution is $10-capped</span>
          </span>
        )}
      </div>
      {c && (
        <div className="text-muted-foreground">
          costs @ optimal size: fees {fmt(c.feesUsd, 3)} · slippage {fmt(c.slippageUsd, 3)} · buffer {fmt(c.bufferUsd, 3)}{(c.basisHaircutUsd ?? 0) > 0 ? ` · basis ${fmt(c.basisHaircutUsd, 3)}` : ""}
          {" "}· fee source: {row.feeSource}
        </div>
      )}
      <div className="text-muted-foreground">
        <span className={cn("mr-1 rounded px-1 py-0.5", row.blockedBy === "NONE" ? "bg-green-500/15 text-green-500" : row.blockedBy === "INSUFFICIENT_INVENTORY" ? "bg-orange-500/15 text-orange-500" : "bg-muted")}>
          {BLOCKER_LABEL[row.blockedBy ?? ""] ?? row.blockedBy}
        </span>
        {row.requirement}
      </div>
    </div>
  );
}

function RowTable({ rows, showRequirement }: { rows: DiscoveryRow[]; showRequirement: boolean }) {
  if (!rows.length) return <div className="text-muted-foreground">none</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left whitespace-nowrap">
        <thead className="text-muted-foreground">
          <tr>
            <th>route</th><th className="text-right">fees %</th>
            <th className="text-right">net @$10</th><th className="text-right">@$50</th><th className="text-right">@$100</th>
            <th className="text-right">persist</th>
            {showRequirement && <th>what it needs</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const n = (sz: number) => r.nets?.find(x => x.sizeUsd === sz)?.netUsd ?? null;
            return (
              <tr key={i} data-testid={`row-disc-${i}`}>
                <td className="pr-2">
                  {r.asset}: buy {r.buyVenue} → sell {r.sellVenue}
                  {r.quoteNote !== "USD" && <span className="text-amber-500" title={r.quoteNote}> †</span>}
                  {r.feeSource !== "detected" && <span className="text-muted-foreground" title="fee tiers are published assumptions, not detected"> *</span>}
                  {r.coinbaseFeeIsBlocker && <span className="text-orange-500" title="This route would flip positive at a ~0.10% taker tier — Coinbase's fee tier is what kills it."> CB-fee</span>}
                </td>
                <td className="text-right pr-2 text-red-400">{r.buyTakerPct}+{r.sellTakerPct}</td>
                {[10, 50, 100].map(sz => {
                  const v = n(sz);
                  return <td key={sz} className={cn("text-right pr-2", (v ?? 0) > 0 ? "text-green-500 font-semibold" : "text-red-500")}>{fmt(v, 3)}</td>;
                })}
                <td className="text-right pr-2" title="consecutive scans this route stayed net-positive">{r.seenPositiveScans ?? 0}</td>
                {showRequirement && <td className="text-muted-foreground max-w-[380px] truncate" title={r.requirement}>{r.requirement}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DiscoveryCard() {
  const { credentials } = useBotContext();
  const [data, setData] = useState<DiscoveryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scan = useDiscoveryScan();
  const busy = useRef(false);
  const { krakenKey, krakenSecret, coinbaseKey, coinbaseSecret } = credentials;
  const hasCreds = !!krakenKey && !!krakenSecret && !!coinbaseKey && !!coinbaseSecret;

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const r = await scan.mutateAsync({ data: hasCreds ? { krakenKey, krakenSecret, coinbaseKey, coinbaseSecret } : {} });
        if (!cancelled) { setData(r); setError(null); }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally { busy.current = false; }
    };
    tick();
    const iv = setInterval(tick, 20_000);
    return () => { cancelled = true; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [krakenKey, krakenSecret, coinbaseKey, coinbaseSecret]);

  const okVenues = (data?.venues ?? []).filter(v => v.status === "ok" && (v.assetsCovered ?? 0) > 0);
  return (
    <Card data-testid="card-discovery" className="border-cyan-500/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          <span className="text-cyan-500">DISCOVERY ENGINE</span>{" "}
          <span className="text-muted-foreground font-normal">
            (read-only scan of {okVenues.length || 8} public exchanges + live venues · $10/$50/$100 projections · execution stays $10 on Kraken/Coinbase only · rescans 20s)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {error && <div className="text-red-500">Discovery scan failed: {error}</div>}
        {!data && !error && <div className="text-muted-foreground">Scanning public order books across venues…</div>}
        {data && (
          <>
            <div className={cn("font-semibold", (data.executableNow?.length ?? 0) > 0 ? "text-green-500" : "text-muted-foreground")} data-testid="text-disc-summary">
              {data.summary}
            </div>
            {data.bestExecutable && <Verdict row={data.bestExecutable} kind="best" />}
            {!data.bestExecutable && data.bestNearMiss && <Verdict row={data.bestNearMiss} kind="nearmiss" />}
            <div className="text-muted-foreground">
              {data.feesNote} {data.credNote && <span className="text-amber-500">{data.credNote}</span>}{" "}
              {(data.coinbaseFeeDrag ?? 0) > 0 && (
                <span className="text-orange-500">
                  Coinbase's taker tier is the specific blocker on {data.coinbaseFeeDrag} route(s) (marked "CB-fee") — those would flip positive at a ~0.10% tier venue.
                </span>
              )}
            </div>
            <div>
              <div className="font-semibold text-green-500 mb-1">Executable now (your keys + balances, $10 cap)</div>
              <RowTable rows={data.executableNow ?? []} showRequirement={true} />
            </div>
            <div>
              <div className="font-semibold text-amber-500 mb-1">Potentially profitable — requires another exchange/account or pre-positioned inventory</div>
              <RowTable rows={data.requiresSetup ?? []} showRequirement={true} />
            </div>
            <div>
              <div className="font-semibold text-muted-foreground mb-1">Best of the not-profitable (context — why nothing fires)</div>
              <RowTable rows={data.notProfitable ?? []} showRequirement={false} />
            </div>
            <div className="text-muted-foreground">
              Venues: {(data.venues ?? []).map(v => `${v.name} ${v.status === "ok" ? `(${v.assetsCovered} assets${v.quote === "USDT" ? ", USDT†" : ""})` : "(unreachable)"}`).join(" · ")}.
              {" "}† USDT-quoted books carry a 0.10%/leg basis haircut. * fees are published entry-tier assumptions until an account is connected.
              Projections at $50/$100 are informational — live execution never exceeds the $10 validation cap.
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
