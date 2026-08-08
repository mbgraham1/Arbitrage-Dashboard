import React, { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp } from "lucide-react";
import { format } from "date-fns";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import type { TriScanRecord } from "@workspace/api-client-react";

// Fixed palette per series so colours stay stable across refetches.
const SERIES_COLORS: Record<string, string> = {
  "Kraken ETH": "hsl(210, 90%, 55%)",
  "Kraken BTC": "hsl(35, 95%, 55%)",
  "Coinbase ETH": "hsl(150, 70%, 45%)",
  "Coinbase BTC": "hsl(280, 70%, 60%)",
};
const FALLBACK_COLORS = [
  "hsl(0, 75%, 55%)",
  "hsl(180, 60%, 45%)",
  "hsl(320, 70%, 55%)",
];

function seriesKey(row: TriScanRecord): string {
  const variant = (row.variant ?? "eth").toUpperCase();
  return `${row.exchange} ${variant}`;
}

interface ChartPoint {
  ts: number;
  [series: string]: number;
}

export function TriProfitChart({ items }: { items: TriScanRecord[] }) {
  const { data, seriesNames } = useMemo(() => {
    const names = new Set<string>();
    const points: ChartPoint[] = [];
    // Items arrive newest-first; chart wants oldest-first.
    for (let i = items.length - 1; i >= 0; i--) {
      const row = items[i];
      const key = seriesKey(row);
      names.add(key);
      const ts = new Date(row.scannedAt ?? row.createdAt).getTime();
      if (!Number.isFinite(ts)) continue;
      points.push({ ts, [key]: row.profitPct });
    }
    points.sort((a, b) => a.ts - b.ts);
    return { data: points, seriesNames: Array.from(names).sort() };
  }, [items]);

  if (data.length === 0) return null;

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp className="h-4 w-4" /> Profit % Over Time
          <span className="ml-auto text-xs text-muted-foreground font-normal font-mono">
            Last {items.length} scans
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="ts"
                type="number"
                domain={["dataMin", "dataMax"]}
                scale="time"
                tickFormatter={(ts: number) => format(new Date(ts), "MM/dd HH:mm")}
                tick={{ fontSize: 10, fontFamily: "monospace" }}
                stroke="hsl(var(--muted-foreground))"
              />
              <YAxis
                tickFormatter={(v: number) => `${v.toFixed(3)}%`}
                tick={{ fontSize: 10, fontFamily: "monospace" }}
                width={64}
                stroke="hsl(var(--muted-foreground))"
                domain={["auto", "auto"]}
              />
              <Tooltip
                labelFormatter={(ts) => format(new Date(Number(ts)), "MM/dd HH:mm:ss")}
                formatter={(value: number | string, name: string) => [
                  `${Number(value).toFixed(4)}%`,
                  name,
                ]}
                contentStyle={{
                  background: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  fontSize: 11,
                  fontFamily: "monospace",
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: "monospace" }} />
              {seriesNames.map((name, i) => (
                <Line
                  key={name}
                  type="monotone"
                  dataKey={name}
                  name={name}
                  stroke={SERIES_COLORS[name] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length]}
                  strokeWidth={1.5}
                  dot={{ r: 2 }}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
