/**
 * Two-Exchange Test — one-shot manual diagnostic, completely separate from
 * every arbitrage strategy. Buys ~$10 of ETH at market on Kraken, sells the
 * confirmed fill on Coinbase from pre-positioned ETH, and reports the exact
 * fills, fees, order ids, timestamps, and realized P&L. Never loops.
 */
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBotContext } from "@/store/bot-context";
import { useToast } from "@/hooks/use-toast";
import { useRunTwoExchangeTest, TwoExchangeTestResult, TwoExchangeTestLeg } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

function LegView({ label, leg }: { label: string; leg: TwoExchangeTestLeg | null | undefined }) {
  if (!leg) return null;
  return (
    <div className="rounded border p-2 space-y-0.5">
      <div className="font-semibold">{label} — {leg.exchange} {leg.side} <span className="text-muted-foreground font-normal">({leg.status ?? "?"})</span></div>
      {leg.orderId && <div className="text-muted-foreground break-all">order: {leg.orderId}</div>}
      <div>
        {leg.filledQty != null && <>qty {leg.filledQty.toFixed(8)} </>}
        {leg.avgPrice != null && <>@ ${leg.avgPrice.toFixed(2)} </>}
        {leg.notionalUsd != null && <>= ${leg.notionalUsd.toFixed(4)} </>}
        {leg.feeUsd != null && <span className="text-muted-foreground">fee ${leg.feeUsd.toFixed(4)}</span>}
      </div>
      {(leg.placedAt || leg.terminalAt) && <div className="text-muted-foreground">{leg.placedAt && <>placed {leg.placedAt}</>}{leg.terminalAt && <> · terminal {leg.terminalAt}</>}</div>}
      {leg.error && <div className="text-red-500">{leg.error}</div>}
    </div>
  );
}

export function TwoExchangeTestCard() {
  const { credentials, liveMode, addLog } = useBotContext();
  const { toast } = useToast();
  const [last, setLast] = useState<TwoExchangeTestResult | null>(null);
  const [running, setRunning] = useState(false);
  const exec = useRunTwoExchangeTest();

  const hasCreds = !!credentials.krakenKey && !!credentials.krakenSecret && !!credentials.coinbaseKey && !!credentials.coinbaseSecret;

  const run = async (isDryRun: boolean) => {
    if (!hasCreds) { toast({ title: "Kraken AND Coinbase API keys required", variant: "destructive" }); return; }
    setRunning(true);
    try {
      const r = await exec.mutateAsync({ data: {
        krakenKey: credentials.krakenKey, krakenSecret: credentials.krakenSecret,
        coinbaseKey: credentials.coinbaseKey, coinbaseSecret: credentials.coinbaseSecret,
        sizeUsd: 10, isDryRun,
      } });
      setLast(r);
      const msg = `[2XTEST] ${isDryRun ? "DRY" : "LIVE"} → ${r.outcome}${r.realizedProfitUsd != null ? ` realized $${r.realizedProfitUsd.toFixed(4)}` : ""}${r.blockReason ? ` — ${r.blockReason}` : ""}${r.error ? ` — ${r.error}` : ""}`;
      addLog(r.outcome === "completed" || r.outcome === "dry_run_ok" ? "success" : "error", msg);
      if (r.outcome === "sell_failed" || r.outcome === "partial_sell" || r.outcome === "indeterminate") {
        toast({ title: "TEST LEFT AN OPEN POSITION", description: r.error ?? "", variant: "destructive" });
      }
    } catch (e) {
      addLog("error", `[2XTEST] failed: ${(e as Error).message}`);
      toast({ title: "Two-exchange test failed", description: (e as Error).message, variant: "destructive" });
    } finally { setRunning(false); }
  };

  return (
    <Card data-testid="card-two-exchange-test">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Two-Exchange Test{" "}
          <span className="text-muted-foreground font-normal">
            (one-shot: buy ~$10 ETH on Kraken → sell confirmed fill on Coinbase — needs pre-funded ETH on Coinbase)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" disabled={running || !hasCreds} onClick={() => run(true)} data-testid="button-2xtest-dry">
            {running ? "Running…" : "Check balances (dry)"}
          </Button>
          <Button size="sm" variant="destructive" disabled={running || !hasCreds || !liveMode} onClick={() => run(false)} data-testid="button-2xtest-live">
            {running ? "Running…" : "Run LIVE test once"}
          </Button>
          {!liveMode && <span className="text-muted-foreground">enable LIVE mode to run for real</span>}
        </div>
        {last && (
          <div className="space-y-2" data-testid="text-2xtest-result">
            <div>
              outcome: <span className={cn("font-semibold", last.outcome === "completed" ? "text-green-500" : last.outcome === "dry_run_ok" ? "" : "text-red-500")}>{last.outcome}</span>
              {last.realizedProfitUsd != null && <> · realized P&L <span className={cn("font-semibold", last.realizedProfitUsd >= 0 ? "text-green-500" : "text-red-500")}>${last.realizedProfitUsd.toFixed(4)}</span></>}
              {last.residualEthOpen != null && last.residualEthOpen > 0 && <span className="text-red-500"> · residual {last.residualEthOpen.toFixed(8)} ETH open</span>}
            </div>
            {last.balances && (
              <div className="space-y-0.5" data-testid="text-2xtest-balances">
                <div>Kraken available: <span className="font-semibold">${last.balances.krakenUsd?.toFixed(2)}</span> USD</div>
                <div>
                  Coinbase ETH — total <span className="font-semibold">{(last.balances.coinbaseEthTotal ?? last.balances.coinbaseEth ?? 0).toFixed(8)}</span>
                  {" · "}staked <span className={cn("font-semibold", (last.balances.coinbaseEthStaked ?? 0) > 0 && "text-amber-500")}>{(last.balances.coinbaseEthStaked ?? 0).toFixed(8)}</span>
                  {(last.balances.coinbaseEthHold ?? 0) > 0 && <> · on hold <span className="font-semibold">{(last.balances.coinbaseEthHold ?? 0).toFixed(8)}</span></>}
                  {" · "}tradable <span className={cn("font-semibold", (last.balances.coinbaseEth ?? 0) > 0 ? "text-green-500" : "text-red-500")}>{(last.balances.coinbaseEth ?? 0).toFixed(8)}</span>
                </div>
                {(last.balances.coinbaseEthStaked ?? 0) > 0 && (last.balances.coinbaseEth ?? 0) < ((last.balances.coinbaseEthTotal ?? 0)) && (
                  <div className="text-amber-500">Staked ETH cannot be used for the sell leg — only the tradable amount counts.</div>
                )}
                {last.balances.coinbaseEthAccounts && last.balances.coinbaseEthAccounts.length > 0 && (
                  <div className="text-muted-foreground">
                    ETH accounts visible to this API key:{" "}
                    {last.balances.coinbaseEthAccounts.map((a, i) => (
                      <span key={i} className="mr-2">{a.name ?? a.currency}{a.staked ? " (staked)" : ""}: {((a.available ?? 0) + (a.hold ?? 0)).toFixed(8)}</span>
                    ))}
                  </div>
                )}
                {last.balances.coinbaseEthAccounts && last.balances.coinbaseEthAccounts.length === 0 && (
                  <div className="text-red-500">
                    No ETH account is visible to this API key's portfolio ({last.balances.coinbaseAccountsScanned ?? 0} accounts scanned) — your ETH likely sits in a different Coinbase portfolio or in staking the trading API can't see. Move/buy unstaked ETH in this key's portfolio, or create an API key on the portfolio holding the ETH.
                  </div>
                )}
              </div>
            )}
            {last.blockReason && <div className="text-amber-500">blocked: {last.blockReason}</div>}
            <LegView label="Leg 1" leg={last.buyLeg} />
            <LegView label="Leg 2" leg={last.sellLeg} />
            {last.error && <div className="text-red-500">{last.error}</div>}
            <div className="text-muted-foreground">{last.startedAt && <>started {last.startedAt}</>}{last.finishedAt && <> · finished {last.finishedAt}</>}</div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
