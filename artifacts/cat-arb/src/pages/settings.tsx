import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useBotContext } from "@/store/bot-context";
import { Settings2, KeySquare, SlidersHorizontal, ShieldAlert, CheckCircle2, XCircle } from "lucide-react";
import { useTestKraken, useTestCoinbase } from "@workspace/api-client-react";

export default function Settings() {
  const { credentials, setCredentials, settings, setSettings, liveMode, setLiveMode, isRunning } = useBotContext();
  
  const [localCreds, setLocalCreds] = useState(credentials);
  const [localSettings, setLocalSettings] = useState(settings);
  
  const testKrakenMutation = useTestKraken();
  const testCoinbaseMutation = useTestCoinbase();

  const [krakenStatus, setKrakenStatus] = useState<"idle" | "success" | "error">("idle");
  const [coinbaseStatus, setCoinbaseStatus] = useState<"idle" | "success" | "error">("idle");

  const handleSaveCreds = () => {
    setCredentials(localCreds);
  };

  const handleSaveSettings = () => {
    setSettings(localSettings);
  };

  const testKraken = async () => {
    try {
      const res = await testKrakenMutation.mutateAsync({ 
        data: { krakenKey: localCreds.krakenKey, krakenSecret: localCreds.krakenSecret } 
      });
      if (res.ok) setKrakenStatus("success");
      else setKrakenStatus("error");
    } catch (e) {
      setKrakenStatus("error");
    }
  };

  const testCoinbase = async () => {
    try {
      const res = await testCoinbaseMutation.mutateAsync({ 
        data: { coinbaseKey: localCreds.coinbaseKey, coinbaseSecret: localCreds.coinbaseSecret } 
      });
      if (res.ok) setCoinbaseStatus("success");
      else setCoinbaseStatus("error");
    } catch (e) {
      setCoinbaseStatus("error");
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

      {/* Safety Toggle */}
      <Card className="border-4 border-destructive bg-destructive/5">
        <CardContent className="p-6 flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <h3 className="font-bold uppercase text-destructive flex items-center gap-2">
              <ShieldAlert className="h-5 w-5" /> Live Trading Mode
            </h3>
            <p className="text-sm font-mono text-muted-foreground">
              When disabled, bot runs in DRY RUN mode (no real orders).
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
            <CardDescription>Keys are stored locally in your browser.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            
            <div className="flex flex-col gap-4">
              <h4 className="font-bold uppercase text-sm border-b-2 border-border pb-1">Kraken</h4>
              <div className="space-y-2">
                <Label>API Key</Label>
                <Input 
                  type="password" 
                  value={localCreds.krakenKey}
                  onChange={(e) => setLocalCreds({ ...localCreds, krakenKey: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Private Key</Label>
                <Input 
                  type="password" 
                  value={localCreds.krakenSecret}
                  onChange={(e) => setLocalCreds({ ...localCreds, krakenSecret: e.target.value })}
                />
              </div>
              <div className="flex justify-between items-center mt-2">
                <Button variant="outline" size="sm" onClick={testKraken} disabled={testKrakenMutation.isPending}>
                  Test Connection
                </Button>
                {krakenStatus === "success" && <CheckCircle2 className="h-5 w-5 text-success" />}
                {krakenStatus === "error" && <XCircle className="h-5 w-5 text-destructive" />}
              </div>
            </div>

            <div className="flex flex-col gap-4 pt-4 border-t-2 border-border">
              <h4 className="font-bold uppercase text-sm border-b-2 border-border pb-1">Coinbase</h4>
              <div className="space-y-2">
                <Label>API Key Name</Label>
                <Input 
                  type="password" 
                  value={localCreds.coinbaseKey}
                  onChange={(e) => setLocalCreds({ ...localCreds, coinbaseKey: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Private Key PEM</Label>
                <textarea 
                  className="flex min-h-[80px] w-full border-2 border-input bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring"
                  value={localCreds.coinbaseSecret}
                  onChange={(e) => setLocalCreds({ ...localCreds, coinbaseSecret: e.target.value })}
                />
              </div>
              <div className="flex justify-between items-center mt-2">
                <Button variant="outline" size="sm" onClick={testCoinbase} disabled={testCoinbaseMutation.isPending}>
                  Test Connection
                </Button>
                {coinbaseStatus === "success" && <CheckCircle2 className="h-5 w-5 text-success" />}
                {coinbaseStatus === "error" && <XCircle className="h-5 w-5 text-destructive" />}
              </div>
            </div>

            <Button className="w-full mt-4" onClick={handleSaveCreds}>SAVE CREDENTIALS</Button>
          </CardContent>
        </Card>

        {/* Strategy Parameters */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SlidersHorizontal className="h-5 w-5" /> Strategy Parameters
            </CardTitle>
            <CardDescription>Configure entry criteria and risk.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            
            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>Min Net Edge (%)</Label>
                <span className="text-xs text-muted-foreground font-mono">Execute when Net Edge &gt;= this value</span>
              </div>
              <Input 
                type="number" 
                step="0.01" 
                value={localSettings.minNetEdge}
                onChange={(e) => setLocalSettings({ ...localSettings, minNetEdge: parseFloat(e.target.value) || 0 })}
              />
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>Combined Fees (%)</Label>
                <span className="text-xs text-muted-foreground font-mono">Assumed total taker fees (e.g. 0.40% + 0.20% = 0.60%)</span>
              </div>
              <Input 
                type="number" 
                step="0.01" 
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
                value={localSettings.slippage}
                onChange={(e) => setLocalSettings({ ...localSettings, slippage: parseFloat(e.target.value) || 0 })}
              />
            </div>

            <div className="space-y-3">
              <div className="flex flex-col gap-1">
                <Label>Cooldown (seconds)</Label>
                <span className="text-xs text-muted-foreground font-mono">Wait time after an execution</span>
              </div>
              <Input 
                type="number" 
                step="1" 
                value={localSettings.cooldown}
                onChange={(e) => setLocalSettings({ ...localSettings, cooldown: parseInt(e.target.value) || 0 })}
              />
            </div>

            <Button className="w-full mt-4" onClick={handleSaveSettings}>SAVE PARAMETERS</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
