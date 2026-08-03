import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useBotContext } from "@/store/bot-context";
import { Settings2, KeySquare, SlidersHorizontal, ShieldAlert, CheckCircle2, XCircle, Lock } from "lucide-react";
import { useTestKraken, useTestCoinbase } from "@workspace/api-client-react";

export default function Settings() {
  const { credentials, setCredentials, settings, setSettings, liveMode, setLiveMode, isRunning, secretsLoaded } = useBotContext();

  const [localCreds, setLocalCreds] = useState(credentials);
  const [localSettings, setLocalSettings] = useState(settings);

  const testKrakenMutation = useTestKraken();
  const testCoinbaseMutation = useTestCoinbase();

  const [krakenStatus, setKrakenStatus] = useState<"idle" | "success" | "error">("idle");
  const [krakenMessage, setKrakenMessage] = useState("");
  const [coinbaseStatus, setCoinbaseStatus] = useState<"idle" | "success" | "error">("idle");
  const [coinbaseMessage, setCoinbaseMessage] = useState("");

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
                <Label>Combined Fees (%)</Label>
                <span className="text-xs text-muted-foreground font-mono">Total taker fees across both exchanges (default 0.80%)</span>
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
                <Label>Max Position (SOL)</Label>
                <span className="text-xs text-muted-foreground font-mono">Hard cap per trade regardless of Kelly output</span>
              </div>
              <Input
                type="number"
                step="0.1"
                min="0.1"
                max="10"
                value={localSettings.maxPositionSol}
                onChange={(e) => setLocalSettings({ ...localSettings, maxPositionSol: parseFloat(e.target.value) || 1.0 })}
              />
            </div>

            <Button className="w-full mt-2" onClick={handleSaveSettings}>
              SAVE KELLY PARAMETERS
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
