import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useBotContext, ALL_PAIRS } from "@/store/bot-context";
import { Settings2, KeySquare, SlidersHorizontal, ShieldAlert, CheckCircle2, XCircle, Lock, Layers, BookOpen, Repeat2, AlertTriangle } from "lucide-react";
import { useTestKraken, useTestCoinbase, useTestGemini, GeminiTestResult } from "@workspace/api-client-react";

const INVENTORY_ASSETS = ["BTC", "ETH", "SOL", "AVAX", "DOT"] as const;

export default function Settings() {
  const { credentials, setCredentials, settings, setSettings, liveMode, setLiveMode, isRunning, secretsLoaded, cachedBalances, latestPriceData } = useBotContext();

  const [localCreds, setLocalCreds] = useState(credentials);
  const [localSettings, setLocalSettings] = useState(settings);

  const testKrakenMutation = useTestKraken();
  const testCoinbaseMutation = useTestCoinbase();
  const testGeminiMutation = useTestGemini();

  const [krakenStatus, setKrakenStatus] = useState<"idle" | "success" | "error">("idle");
  const [krakenMessage, setKrakenMessage] = useState("");
  const [coinbaseStatus, setCoinbaseStatus] = useState<"idle" | "success" | "error">("idle");
  const [coinbaseMessage, setCoinbaseMessage] = useState("");
  const [geminiStatus, setGeminiStatus] = useState<"idle" | "success" | "error">("idle");
  const [geminiMessage, setGeminiMessage] = useState("");
  const [geminiInfo, setGeminiInfo] = useState<GeminiTestResult | null>(null);

  const handleSaveCreds = () => {
    setCredentials(localCreds);
  };

  const handleSaveSettings = () => {
    setSettings(localSettings);
  };

  const testKraken = async () => {
    setKrakenStatus("idle");
    try {
      const res = await testKrakenMutation.mutateAsync({
        data: { krakenKey: localCreds.krakenKey, krakenSecret: localCreds.krakenSecret },
      });
      setKrakenStatus(res.ok ? "success" : "error");
      setKrakenMessage(res.message);
    } catch (e: unknown) {
      setKrakenStatus("error");
      setKrakenMessage(e instanceof Error ? e.message : "Connection failed");
    }
  };

  const testCoinbase = async () => {
    setCoinbaseStatus("idle");
    try {
      const res = await testCoinbaseMutation.mutateAsync({
        data: { coinbaseKey: localCreds.coinbaseKey, coinbaseSecret: localCreds.coinbaseSecret },
      });
      setCoinbaseStatus(res.ok ? "success" : "error");
      setCoinbaseMessage(res.message);
    } catch (e: unknown) {
      setCoinbaseStatus("error");
      setCoinbaseMessage(e instanceof Error ? e.message : "Connection failed");
    }
  };

  const testGemini = async () => {
    setGeminiStatus("idle");
    setGeminiInfo(null);
    try {
      const res = await testGeminiMutation.mutateAsync({
        data: { geminiKey: localCreds.geminiKey ?? "", geminiSecret: localCreds.geminiSecret ?? "" },
      });
      setGeminiStatus(res.ok ? "success" : "error");
      setGeminiMessage(res.message);
      if (res.ok && res.makerPct != null && res.takerPct != null) {
        setGeminiInfo(res);
      }
    } catch (e: unknown) {
      setGeminiStatus("error");
      setGeminiMessage(e instanceof Error ? e.message : "Connection failed");
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-4xl mx-auto">
      <div className="flex flex-col">
        <h1 className="text-2xl font-bold uppercase tracking-tight flex items-center gap-2">
          <Settings2 className="h-6 w-6 text-primary" />
          Configuration
        </h1>
        <p className="text-muted-foreground font-mono text-sm">API access and strategy parameters</p>
      </div>

      {/* Secrets notice */}
      {secretsLoaded && (
        <div className="flex items-center gap-3 border-2 border-primary/40 bg-primary/5 px-4 py-3">
          <Lock className="h-4 w-4 text-primary shrink-0" />
          <p className="text-sm font-mono text-primary">
            Credentials auto-loaded from Replit Secrets (KRAKEN_API_KEY · KRAKEN_SECRET · COINBASE_API_KEY · COINBASE_SECRET). Fields below override them for this session.
          </p>
        </div>
      )}

      {/* Safety Toggle */}
      <Card className="border-4 border-destructive bg-destructive/5">
        <CardContent className="p-6 flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <h3 className="font-bold uppercase text-destructive flex items-center gap-2">
              <ShieldAlert className="h-5 w-5" /> Live Trading Mode
            </h3>
            <p className="text-sm font-mono text-muted-foreground">
              When disabled, bot runs in DRY RUN mode — no real orders placed.
            </p>
          </div>
          <div className="flex items-center gap-4">
            <span className="font-bold font-mono text-destructive uppercase">
              {liveMode ? "ARMED" : "SAFE"}
            </span>
            <Switch
              checked={liveMode}
              onCheckedChange={setLiveMode}
              disabled={isRunning}
              data-testid="switch-live-mode"
              className="data-[state=checked]:bg-destructive data-[state=checked]:border-destructive"
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-6">
        {/* API Credentials */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeySquare className="h-5 w-5" /> Exchange APIs
            </CardTitle>
            <CardDescription>
              Keys persist in your browser. Set Replit Secrets for auto-load across sessions:
              KRAKEN_API_KEY · KRAKEN_SECRET · COINBASE_API_KEY · COINBASE_SECRET
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">

            <div className="flex flex-col gap-4">
              <h4 className="font-bold uppercase text-sm border-b-2 border-border pb-1">Kraken</h4>
              <div className="space-y-2">
                <Label>API Key</Label>
                <Input
                  type="password"
                  data-testid="input-kraken-key"
                  value={localCreds.krakenKey}
                  onChange={(e) => setLocalCreds({ ...localCreds, krakenKey: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Private Key (Base64)</Label>
                <Input
                  type="password"
                  data-testid="input-kraken-secret"
                  value={localCreds.krakenSecret}
                  onChange={(e) => setLocalCreds({ ...localCreds, krakenSecret: e.target.value })}
                />
              </div>
              <div className="flex justify-between items-center mt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={testKraken}
                  disabled={testKrakenMutation.isPending}
                  data-testid="button-test-kraken"
                >
                  Test Connection
                </Button>
                <div className="flex items-center gap-2">
                  {krakenStatus === "success" && (
                    <>
                      <CheckCircle2 className="h-5 w-5 text-green-500" />
                      <span className="text-xs font-mono text-green-500">{krakenMessage}</span>
                    </>
                  )}
                  {krakenStatus === "error" && (
                    <>
                      <XCircle className="h-5 w-5 text-destructive" />
                      <span className="text-xs font-mono text-destructive truncate max-w-[140px]">{krakenMessage}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-4 pt-4 border-t-2 border-border">
              <h4 className="font-bold uppercase text-sm border-b-2 border-border pb-1">Coinbase</h4>
              <div className="space-y-2">
                <Label>API Key Name</Label>
                <Input
                  type="password"
                  data-testid="input-coinbase-key"
                  value={localCreds.coinbaseKey}
                  onChange={(e) => setLocalCreds({ ...localCreds, coinbaseKey: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Private Key (PEM)</Label>
                <textarea
                  className="flex min-h-[80px] w-full border-2 border-input bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring"
                  data-testid="input-coinbase-secret"
                  value={localCreds.coinbaseSecret}
                  onChange={(e) => setLocalCreds({ ...localCreds, coinbaseSecret: e.target.value })}
                />
              </div>
              <div className="flex justify-between items-center mt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={testCoinbase}
                  disabled={testCoinbaseMutation.isPending}
                  data-testid="button-test-coinbase"
                >
                  Test Connection
                </Button>
                <div className="flex items-center gap-2">
                  {coinbaseStatus === "success" && (
                    <>
                      <CheckCircle2 className="h-5 w-5 text-green-500" />
                      <span className="text-xs font-mono text-green-500">{coinbaseMessage}</span>
                    </>
                  )}
                  {coinbaseStatus === "error" && (
                    <>
                      <XCircle className="h-5 w-5 text-destructive" />
                      <span className="text-xs font-mono text-destructive truncate max-w-[140px]">{coinbaseMessage}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Gemini — READ-ONLY venue: balances + detected fee tier for Discovery/Hunter. Live Gemini trading is never enabled. */}
            <div className="flex flex-col gap-3 pt-4 border-t">
              <div className="flex flex-col gap-1">
                <Label className="font-bold">Gemini (read-only)</Label>
                <span className="text-xs text-muted-foreground font-mono">
                  Used for balances + your detected fee tier in Discovery and the Profit Hunter. Live Gemini trading is NOT enabled — execution stays Kraken/Coinbase with the $10 cap.
                </span>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="gemini-key">API Key</Label>
                <Input
                  id="gemini-key"
                  type="password"
                  data-testid="input-gemini-key"
                  value={localCreds.geminiKey ?? ""}
                  onChange={(e) => setLocalCreds({ ...localCreds, geminiKey: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="gemini-secret">API Secret</Label>
                <Input
                  id="gemini-secret"
                  type="password"
                  data-testid="input-gemini-secret"
                  value={localCreds.geminiSecret ?? ""}
                  onChange={(e) => setLocalCreds({ ...localCreds, geminiSecret: e.target.value })}
                />
              </div>
              <div className="flex justify-between items-center mt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={testGemini}
                  disabled={testGeminiMutation.isPending}
                  data-testid="button-test-gemini"
                >
                  Test Connection
                </Button>
                <div className="flex items-center gap-2">
                  {geminiStatus === "success" && (
                    <>
                      <CheckCircle2 className="h-5 w-5 text-green-500" />
                      <span className="text-xs font-mono text-green-500 truncate max-w-[200px]" title={geminiMessage}>{geminiMessage}</span>
                    </>
                  )}
                  {geminiStatus === "error" && (
                    <>
                      <XCircle className="h-5 w-5 text-destructive" />
                      <span className="text-xs font-mono text-destructive truncate max-w-[140px]" title={geminiMessage}>{geminiMessage}</span>
                    </>
                  )}
                </div>
              </div>
              {geminiInfo && (
                <div className="text-xs font-mono text-muted-foreground border border-border p-2 space-y-2" data-testid="text-gemini-info">
                  {/* (c) Auth + detected fee tier — always shown (auth is verified even when balances are not). */}
                  <div>Detected fee tier: <span className="text-green-500">{(geminiInfo.makerPct ?? 0).toFixed(3)}% maker / {(geminiInfo.takerPct ?? 0).toFixed(3)}% taker</span></div>

                  {/* (a) Balances verified → green + per-currency table. */}
                  {geminiInfo.balancesVerified && (
                    <div data-testid="text-gemini-balances-verified">
                      <div className="text-green-500 flex items-center gap-1">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Balances verified{geminiInfo.keyScope ? ` (${geminiInfo.keyScope} key)` : ""}
                      </div>
                      {(geminiInfo.balanceDetail?.length ?? 0) > 0 ? (
                        <table className="w-full text-left mt-1">
                          <thead className="text-muted-foreground">
                            <tr><th className="pr-3">Currency</th><th className="pr-3 text-right">Total</th><th className="pr-3 text-right">Available</th><th className="text-right">Held</th></tr>
                          </thead>
                          <tbody>
                            {geminiInfo.balanceDetail!.map((b) => (
                              <tr key={b.currency}>
                                <td className="pr-3">{b.currency}</td>
                                <td className="pr-3 text-right">{b.total}</td>
                                <td className="pr-3 text-right">{b.available}</td>
                                <td className="text-right">{b.held}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <div className="text-muted-foreground mt-1">No balances in this scope.</div>
                      )}
                    </div>
                  )}

                  {/* (b) scopeIssue → prominent amber/red alert with VERBATIM text; never render $0.00 as real. */}
                  {geminiInfo.scopeIssue && (
                    <div className="border border-amber-500/60 bg-amber-500/10 rounded p-2 space-y-1" data-testid="text-gemini-scope-issue">
                      <div className="text-amber-500 flex items-center gap-1 font-bold">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Balances NOT verified — treat as UNVERIFIED, not $0.00
                      </div>
                      <div className="text-amber-400 whitespace-pre-wrap">{geminiInfo.scopeIssue}</div>
                      {geminiInfo.keyScope && <div className="text-muted-foreground">Key scope: {geminiInfo.keyScope}</div>}
                      {(geminiInfo.accountScopes?.length ?? 0) > 0 && (
                        <div className="mt-1">
                          <div className="text-muted-foreground">Account scopes visible to this key:</div>
                          {geminiInfo.accountScopes!.map((sc, i) => (
                            <div key={i} className="pl-2">
                              <span className="text-foreground">{sc.account ?? "(default scope)"}</span>
                              {sc.error
                                ? <span className="text-destructive"> — error: {sc.error}</span>
                                : <span className="text-muted-foreground"> — {sc.balances.length ? sc.balances.map(b => `${b.currency} ${b.total}`).join(", ") : "no balances"}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <Button className="w-full mt-4" onClick={handleSaveCreds} data-testid="button-save-creds">
              SAVE CREDENTIALS
            </Button>
          </CardContent>
        </Card>

        {/* Strategy Parameters */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SlidersHorizontal className="h-5 w-5" /> Strategy Parameters
            </CardTitle>
            <CardDescription>Configure entry criteria and timing.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">

            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>Min Net Edge (%)</Label>
                <span className="text-xs text-muted-foreground font-mono">Execute when net edge &gt;= this value</span>
              </div>
              <Input
                type="number"
                step="0.01"
                data-testid="input-min-net-edge"
                value={localSettings.minNetEdge}
                onChange={(e) => setLocalSettings({ ...localSettings, minNetEdge: parseFloat(e.target.value) || 0 })}
              />
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>Min Net Profit (USD)</Label>
                <span className="text-xs text-muted-foreground font-mono">Execute only when estimated net profit &gt;= this value</span>
              </div>
              <Input
                type="number"
                step="0.25"
                min="0"
                data-testid="input-min-profit-usd"
                value={localSettings.minProfitUsd}
                onChange={(e) => setLocalSettings({ ...localSettings, minProfitUsd: parseFloat(e.target.value) || 0 })}
              />
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>Thin-Edge Warning Threshold (%)</Label>
                <span className="text-xs text-muted-foreground font-mono">Live executes with profit below this % of trade size ask for confirmation (default 0.1%)</span>
              </div>
              <Input
                type="number"
                step="0.01"
                min="0"
                data-testid="input-thin-edge-warn-pct"
                value={localSettings.thinEdgeWarnPct}
                onChange={(e) => setLocalSettings({ ...localSettings, thinEdgeWarnPct: Math.max(0, parseFloat(e.target.value) || 0) })}
              />
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>Partial Fill Tolerance ({(localSettings.partialFillTolerancePct ?? 99.9).toFixed(0)}%)</Label>
                <span className="text-xs text-muted-foreground font-mono">
                  A leg filled to at least this % counts as complete — the cycle continues sized to the actual fill and any leftover is swept back to USD at market. Server enforces a 50% floor; below 100% partial cycles can realize less than the scanned edge.
                </span>
              </div>
              <input
                type="range"
                min={50}
                max={100}
                step={1}
                data-testid="slider-partial-fill-tolerance"
                value={Math.round(localSettings.partialFillTolerancePct ?? 99.9)}
                onChange={(e) => setLocalSettings({ ...localSettings, partialFillTolerancePct: parseInt(e.target.value, 10) })}
                className="w-full accent-primary"
              />
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>Combined Fees (%)</Label>
                <span className="text-xs text-muted-foreground font-mono">
                  Combined fees across both exchanges (default 0.56% = Kraken maker 0.16% + Coinbase maker 0.40%). Used by the auto bot loop, which places LIMIT (maker) orders. Force Scan &amp; Trade places MARKET orders instead — it pays TAKER fees, so that path uses your detected Kraken taker tier + a {`0.60%`} Coinbase taker assumption, and only falls back to this value when the Kraken tier can't be detected.
                </span>
              </div>
              <Input
                type="number"
                step="0.01"
                data-testid="input-total-fees"
                value={localSettings.totalFees}
                onChange={(e) => setLocalSettings({ ...localSettings, totalFees: parseFloat(e.target.value) || 0 })}
              />
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>Slippage Tolerance (%)</Label>
                <span className="text-xs text-muted-foreground font-mono">Buffer for price movement during execution</span>
              </div>
              <Input
                type="number"
                step="0.01"
                data-testid="input-slippage"
                value={localSettings.slippage}
                onChange={(e) => setLocalSettings({ ...localSettings, slippage: parseFloat(e.target.value) || 0 })}
              />
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>Cooldown (seconds)</Label>
                <span className="text-xs text-muted-foreground font-mono">Wait time after each execution</span>
              </div>
              <Input
                type="number"
                step="1"
                min="10"
                data-testid="input-cooldown"
                value={localSettings.cooldown}
                onChange={(e) => setLocalSettings({ ...localSettings, cooldown: parseInt(e.target.value) || 60 })}
              />
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>Poll Interval (seconds)</Label>
                <span className="text-xs text-muted-foreground font-mono">
                  How often the bot scans for prices · 2–15s (currently {localSettings.pollInterval}s)
                </span>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-xs font-mono text-muted-foreground w-4">2</span>
                <input
                  type="range"
                  min="2"
                  max="15"
                  step="1"
                  data-testid="input-poll-interval"
                  value={localSettings.pollInterval}
                  onChange={(e) => setLocalSettings({ ...localSettings, pollInterval: parseInt(e.target.value) })}
                  className="flex-1 accent-primary"
                />
                <span className="text-xs font-mono text-muted-foreground w-5">15</span>
                <span className="font-mono font-bold text-primary w-8 text-right">{localSettings.pollInterval}s</span>
              </div>
            </div>

            <Button className="w-full mt-4" onClick={handleSaveSettings} data-testid="button-save-settings">
              SAVE PARAMETERS
            </Button>
          </CardContent>
        </Card>

        {/* Kelly Criterion */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SlidersHorizontal className="h-5 w-5" /> Kelly Criterion Sizing
            </CardTitle>
            <CardDescription>
              Dynamic position sizing: f* = (b·p − q) / b · bankroll. Quarter-Kelly by default.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">

            {/* Live balances — lets traders cross-check Kelly's bankroll & inventory */}
            <div className="border-2 border-border rounded-sm">
              <div className="px-3 py-2 border-b-2 border-border flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wide">Live Balances</span>
                <span className="text-[10px] font-mono text-muted-foreground">
                  {cachedBalances ? "refreshes every 30s while bot runs" : isRunning ? "fetching…" : "start bot to load"}
                </span>
              </div>
              {cachedBalances ? (() => {
                const baseAsset = cachedBalances.baseAsset ?? "SOL";
                const isNonSol = baseAsset !== "SOL";
                const krakenAmt = isNonSol
                  ? (cachedBalances.baseAssetOnKraken ?? 0)
                  : (cachedBalances.solOnKraken ?? 0);
                const coinbaseAmt = isNonSol
                  ? (cachedBalances.baseAssetOnCoinbase ?? 0)
                  : (cachedBalances.solOnCoinbase ?? 0);
                const precision = baseAsset === "BTC" ? 6 : 4;
                // Approx USD value of base-asset holdings, priced from the
                // latest scan's buy price. Only shown when the live price is
                // for the SAME base asset as the balances — a stale price for
                // a different pair must never be used for the conversion.
                const priceBase = latestPriceData?.pair?.split("/")[0] ?? null;
                const basePrice =
                  priceBase === baseAsset && (latestPriceData?.buyPrice ?? 0) > 0
                    ? latestPriceData!.buyPrice
                    : null;
                const usdApprox = (amt: number) =>
                  basePrice != null ? `≈ $${(amt * basePrice).toFixed(2)}` : null;
                return (
                  <div className="grid grid-cols-3 divide-x-2 divide-border text-center">
                    <div className="p-2 flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase text-muted-foreground">Kraken {baseAsset}</span>
                      <span className="font-mono text-sm">{krakenAmt.toFixed(precision)}</span>
                      {usdApprox(krakenAmt) && (
                        <span className="text-[10px] font-mono text-muted-foreground" data-testid="text-kraken-usd-value">{usdApprox(krakenAmt)}</span>
                      )}
                    </div>
                    <div className="p-2 flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase text-muted-foreground">Coinbase {baseAsset}</span>
                      <span className="font-mono text-sm">{coinbaseAmt.toFixed(precision)}</span>
                      {usdApprox(coinbaseAmt) && (
                        <span className="text-[10px] font-mono text-muted-foreground" data-testid="text-coinbase-usd-value">{usdApprox(coinbaseAmt)}</span>
                      )}
                    </div>
                    <div className="p-2 flex flex-col gap-0.5 bg-primary/5">
                      <span className="text-[10px] uppercase text-primary font-bold">Coinbase USD · bankroll</span>
                      <span className="font-mono text-sm text-primary font-bold">${cachedBalances.usdOnCoinbase?.toFixed(2) ?? "0.00"}</span>
                    </div>
                  </div>
                );
              })() : (
                <div className="p-3 text-center text-xs font-mono text-muted-foreground">
                  No balance data — Kelly sizing uses Coinbase USD as bankroll once the bot fetches balances.
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>Win Rate (0–1)</Label>
                <span className="text-xs text-muted-foreground font-mono">Estimated fraction of profitable trades (default 0.55)</span>
              </div>
              <Input
                type="number"
                step="0.01"
                min="0.01"
                max="0.99"
                value={localSettings.winRate}
                onChange={(e) => setLocalSettings({ ...localSettings, winRate: parseFloat(e.target.value) || 0.55 })}
              />
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>Kelly Fraction (0–1)</Label>
                <span className="text-xs text-muted-foreground font-mono">Cap on full Kelly — 0.25 = quarter-Kelly (recommended)</span>
              </div>
              <Input
                type="number"
                step="0.05"
                min="0.01"
                max="1"
                value={localSettings.kellyFraction}
                onChange={(e) => setLocalSettings({ ...localSettings, kellyFraction: parseFloat(e.target.value) || 0.25 })}
              />
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>Max Position (USD notional)</Label>
                <span className="text-xs text-muted-foreground font-mono">Hard USD cap per trade — applies to BTC, ETH, SOL equally</span>
              </div>
              <Input
                type="number"
                step="10"
                min="10"
                max="100000"
                value={localSettings.maxPositionUsd}
                onChange={(e) => setLocalSettings({ ...localSettings, maxPositionUsd: parseFloat(e.target.value) || 150 })}
              />
            </div>

            <Button className="w-full mt-2" onClick={handleSaveSettings}>
              SAVE KELLY PARAMETERS
            </Button>
          </CardContent>
        </Card>

        {/* Order Book Hunter */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5" /> Order Book Hunter
            </CardTitle>
            <CardDescription>
              Parameters for the OB triangular scanner and auto-execute loop. Trade size controls how deep into the book each simulation walks and is the dollar amount the auto-executor fires. Fees estimate Kraken's per-leg taker rate; the auto-executor uses its own OB Min Profit (USD) floor below — separate from the cross-exchange bot's minimum.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">

            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>Trade Size (USD)</Label>
                <span className="text-xs text-muted-foreground font-mono">Dollar amount per OB scan simulation (default $10)</span>
              </div>
              <Input
                type="number"
                step="5"
                min="1"
                data-testid="input-ob-trade-size"
                value={localSettings.obTradeSize}
                onChange={(e) => setLocalSettings({ ...localSettings, obTradeSize: parseFloat(e.target.value) || 10 })}
              />
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>Estimated Fees per Leg (%)</Label>
                <span className="text-xs text-muted-foreground font-mono">Kraken taker fee per leg — used for profit estimates (default 0.40%)</span>
              </div>
              <Input
                type="number"
                step="0.01"
                min="0"
                max="2"
                data-testid="input-ob-fees-pct"
                value={localSettings.obFeesPct}
                onChange={(e) => setLocalSettings({ ...localSettings, obFeesPct: parseFloat(e.target.value) || 0.16 })}
              />
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>OB Min Profit (USD)</Label>
                <span className="text-xs text-muted-foreground font-mono">OB auto-executor fires only when estimated net profit &gt;= this value (default $0.02) — separate from the cross-exchange bot's Min Net Profit</span>
              </div>
              <Input
                type="number"
                step="0.01"
                min="0"
                data-testid="input-ob-min-profit-usd"
                value={localSettings.obMinProfitUsd}
                onChange={(e) => setLocalSettings({ ...localSettings, obMinProfitUsd: Math.max(0, parseFloat(e.target.value) || 0) })}
              />
            </div>

            <Button className="w-full mt-2" onClick={handleSaveSettings} data-testid="button-save-ob-settings">
              SAVE OB HUNTER SETTINGS
            </Button>
          </CardContent>
        </Card>

        {/* Inventory Mode */}
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Repeat2 className="h-5 w-5" /> Inventory Mode
            </CardTitle>
            <CardDescription>
              Hold balances on both Kraken and Coinbase simultaneously. When an asset is cheaper on one venue, buy there and sell from your existing inventory on the other — no transfer needed. The scanner shows an "Inventory Opportunity" card on the dashboard when spread exceeds 2× fees.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <div className="flex items-center justify-between border-2 border-border p-4">
              <div className="flex flex-col gap-1">
                <span className="font-bold text-sm uppercase">Enable Inventory Mode</span>
                <span className="text-xs font-mono text-muted-foreground">Show inventory opportunities on the dashboard and allow execution</span>
              </div>
              <Switch
                checked={localSettings.inventoryModeEnabled ?? false}
                onCheckedChange={(checked) => setLocalSettings({ ...localSettings, inventoryModeEnabled: checked })}
                data-testid="switch-inventory-mode"
              />
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>Target % per Exchange</Label>
                <span className="text-xs text-muted-foreground font-mono">
                  Ideal split of each asset between Kraken and Coinbase (default 50% each). A rebalance alert fires when one side drops below 20% of this target.
                </span>
              </div>
              <Input
                type="number"
                step="5"
                min="10"
                max="90"
                data-testid="input-inventory-target-pct"
                value={localSettings.inventoryTargetPct ?? 50}
                onChange={(e) => setLocalSettings({ ...localSettings, inventoryTargetPct: parseFloat(e.target.value) || 50 })}
              />
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>Trade Size (USD)</Label>
                <span className="text-xs text-muted-foreground font-mono">Dollar amount per inventory arb execution (default $10)</span>
              </div>
              <Input
                type="number"
                step="5"
                min="1"
                data-testid="input-inventory-trade-size"
                value={localSettings.inventoryTradeSizeUsd ?? 10}
                onChange={(e) => setLocalSettings({ ...localSettings, inventoryTradeSizeUsd: parseFloat(e.target.value) || 10 })}
              />
            </div>

            <div className="space-y-3">
              <Label>Watched Assets</Label>
              <span className="text-xs text-muted-foreground font-mono">Enable assets to monitor for inventory opportunities</span>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 mt-2">
                {INVENTORY_ASSETS.map((asset) => {
                  const currentAssets: string[] = localSettings.inventoryAssets ?? ["BTC", "ETH", "SOL"];
                  const enabled = currentAssets.includes(asset);
                  const isLast = currentAssets.length === 1 && enabled;
                  return (
                    <div
                      key={asset}
                      className={`flex items-center justify-between gap-2 border-2 px-3 py-2 ${
                        enabled ? "border-primary/60 bg-primary/5" : "border-border bg-muted/30"
                      }`}
                    >
                      <span className="font-bold font-mono text-sm">{asset}</span>
                      <Switch
                        checked={enabled}
                        disabled={isLast}
                        title={isLast ? "At least one asset must be enabled" : undefined}
                        onCheckedChange={(checked) => {
                          const next = checked
                            ? [...currentAssets, asset]
                            : currentAssets.filter(a => a !== asset);
                          setLocalSettings({ ...localSettings, inventoryAssets: next });
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            <Button className="w-full mt-2" onClick={handleSaveSettings} data-testid="button-save-inventory">
              SAVE INVENTORY SETTINGS
            </Button>
          </CardContent>
        </Card>

        {/* Pair Selection */}
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Layers className="h-5 w-5" /> Watched Pairs
            </CardTitle>
            <CardDescription>
              Toggle which pairs the scanner checks on every poll. Disabled pairs are skipped entirely — useful for excluding thin or illiquid markets.
              At least one pair must remain enabled. Changes take effect after saving.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {ALL_PAIRS.map((pair) => {
                const enabled = (localSettings.enabledPairs ?? [...ALL_PAIRS]).includes(pair);
                const coin = pair.split("/")[0];
                const isLast = (localSettings.enabledPairs ?? [...ALL_PAIRS]).length === 1 && enabled;
                return (
                  <div
                    key={pair}
                    className={`flex items-center justify-between gap-2 border-2 px-3 py-2 ${
                      enabled ? "border-primary/60 bg-primary/5" : "border-border bg-muted/30"
                    }`}
                  >
                    <div className="flex flex-col">
                      <span className="font-bold font-mono text-sm">{coin}</span>
                      <span className="text-[10px] font-mono text-muted-foreground">{pair}</span>
                    </div>
                    <Switch
                      checked={enabled}
                      disabled={isLast}
                      title={isLast ? "At least one pair must be enabled" : undefined}
                      onCheckedChange={(checked) => {
                        const current: string[] = localSettings.enabledPairs ?? [...ALL_PAIRS];
                        const next = checked
                          ? [...current, pair]
                          : current.filter((p) => p !== pair);
                        setLocalSettings({ ...localSettings, enabledPairs: next });
                      }}
                    />
                  </div>
                );
              })}
            </div>
            <Button className="w-full mt-6" onClick={handleSaveSettings} data-testid="button-save-pairs">
              SAVE PAIR SELECTION
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
