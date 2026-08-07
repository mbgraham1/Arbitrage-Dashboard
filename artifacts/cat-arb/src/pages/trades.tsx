import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useListTrades, useGetTradeSummary } from "@workspace/api-client-react";
import { format } from "date-fns";
import { ArrowRight, BarChart2, DollarSign, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Trades() {
  const tradesQuery = useListTrades();
  const summaryQuery = useGetTradeSummary();

  const trades = tradesQuery.data || [];
  const summary = summaryQuery.data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col">
        <h1 className="text-2xl font-bold uppercase tracking-tight flex items-center gap-2">
          <Activity className="h-6 w-6 text-primary" />
          Trade Ledger
        </h1>
        <p className="text-muted-foreground font-mono text-sm">Historical operations and performance</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 flex flex-col gap-1">
            <span className="text-xs font-bold text-muted-foreground uppercase">Total Trades</span>
            <span className="text-2xl font-mono font-bold">{summary?.totalTrades || 0}</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex flex-col gap-1">
            <span className="text-xs font-bold text-muted-foreground uppercase">Live Trades</span>
            <span className="text-2xl font-mono font-bold text-primary">{summary?.liveTrades || 0}</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex flex-col gap-1">
            <span className="text-xs font-bold text-muted-foreground uppercase">Avg Net Edge</span>
            <span className="text-2xl font-mono font-bold">{summary?.avgNetEdgePct.toFixed(3) || "0.000"}%</span>
          </CardContent>
        </Card>
        <Card className="bg-primary text-primary-foreground border-primary">
          <CardContent className="p-4 flex flex-col gap-1">
            <span className="text-xs font-bold uppercase opacity-80">Total Profit</span>
            <span className="text-2xl font-mono font-bold">${summary?.totalProfitUsd.toFixed(2) || "0.00"}</span>
          </CardContent>
        </Card>
      </div>

      {/* Trades Table */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <BarChart2 className="h-4 w-4" /> Execution History
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {tradesQuery.isPending ? (
            <div className="p-8 text-center text-sm font-mono text-muted-foreground animate-pulse">Loading ledger...</div>
          ) : trades.length === 0 ? (
            <div className="p-8 text-center text-sm font-mono text-muted-foreground">No trades recorded yet.</div>
          ) : (
            <table className="w-full text-sm font-mono whitespace-nowrap">
              <thead>
                <tr className="border-b-2 border-border bg-muted/50">
                  <th className="px-4 py-3 text-left font-bold uppercase text-xs">Date</th>
                  <th className="px-4 py-3 text-left font-bold uppercase text-xs">Mode</th>
                  <th className="px-4 py-3 text-left font-bold uppercase text-xs">Pair</th>
                  <th className="px-4 py-3 text-left font-bold uppercase text-xs">Route</th>
                  <th className="px-4 py-3 text-right font-bold uppercase text-xs">Volume</th>
                  <th className="px-4 py-3 text-right font-bold uppercase text-xs">Net Edge</th>
                  <th className="px-4 py-3 text-right font-bold uppercase text-xs">Profit (USD)</th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-border">
                {trades.map((trade) => (
                  <tr key={trade.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 text-muted-foreground">
                      {format(new Date(trade.createdAt), "MM/dd HH:mm:ss")}
                    </td>
                    <td className="px-4 py-3">
                      {trade.isDryRun ? (
                        <Badge variant="secondary" className="text-[10px]">DRY RUN</Badge>
                      ) : (
                        <Badge variant="default" className="text-[10px]">LIVE</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 border border-border text-muted-foreground">{trade.pair ?? "SOL/USD"}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-bold">{trade.buyExchange.toUpperCase()}</span>
                        <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        <span className="font-bold">{trade.sellExchange.toUpperCase()}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {trade.volumeSol.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={cn(trade.netEdgePct > 0 ? "text-success font-bold" : "")}>
                        {trade.netEdgePct.toFixed(3)}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-bold">
                      <span className={cn(trade.estimatedProfitUsd > 0 ? "text-success" : trade.estimatedProfitUsd < 0 ? "text-destructive" : "")}>
                        ${trade.estimatedProfitUsd.toFixed(2)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
