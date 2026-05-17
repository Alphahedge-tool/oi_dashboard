import { memo, useMemo } from "react";
import { Area, AreaChart, CartesianGrid, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getATMIV, getIVSkew } from "@/lib/oiUtils";
import type { OptionData } from "@/lib/mockData";

interface Props {
  chain: OptionData[];
  spotPrice: number;
  symbol: string;
  height?: number;
}

function IVSmileCardComponent({ chain, spotPrice, symbol, height = 300 }: Props) {
  const atmData = useMemo(() => getATMIV(chain, spotPrice), [chain, spotPrice]);

  const ivSkewData = useMemo(() => {
    const skew = getIVSkew(chain);
    if (skew.length === 0) return [];

    const stepSize = chain.length > 1 ? Math.abs(chain[1].strikePrice - chain[0].strikePrice) : 50;
    const chainMidStrike = chain[Math.floor(chain.length / 2)]?.strikePrice || 0;
    const centerStrike =
      Number.isFinite(spotPrice) && spotPrice > 0
        ? spotPrice
        : atmData.atmStrike || chainMidStrike;
    const filtered = skew.filter((row) => !centerStrike || Math.abs(row.strike - centerStrike) <= stepSize * 20);

    return filtered.length > 0 ? filtered : skew;
  }, [chain, spotPrice, atmData.atmStrike]);

  const stepSize = chain.length > 1 ? Math.abs(chain[1].strikePrice - chain[0].strikePrice) : 50;
  const chartCenterStrike =
    atmData.atmStrike ||
    (Number.isFinite(spotPrice) && spotPrice > 0 ? Math.round(spotPrice / stepSize) * stepSize : 0);
  const tooltipStyle = {
    backgroundColor: "hsl(var(--card))",
    border: "1px solid hsl(var(--border))",
    borderRadius: "6px",
    fontSize: "11px",
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          {symbol} IV Smile / Skew
          <Badge variant="outline" className="text-xs h-4 ml-auto text-bullish border-bullish/30">LIVE</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div style={{ height }}>
          {ivSkewData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%" debounce={250}>
              <AreaChart data={ivSkewData}>
                <defs>
                  <linearGradient id={`ivSmileGrad-${symbol}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--chart-grid))" />
                <XAxis dataKey="strike" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} />
                <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} domain={["dataMin - 2", "dataMax + 2"]} />
                <Tooltip contentStyle={tooltipStyle} formatter={(value: number | null) => [value === null ? "-" : `${Number(value).toFixed(1)}%`, ""]} />
                {chartCenterStrike > 0 && (
                  <ReferenceLine x={chartCenterStrike} stroke="hsl(var(--primary))" strokeDasharray="3 3" label={{ value: "ATM", fill: "hsl(var(--primary))", fontSize: 9, position: "top" }} />
                )}
                <Line type="monotone" dataKey="callIV" stroke="hsl(142 71% 45%)" strokeWidth={2} dot={false} connectNulls name="Call IV" />
                <Line type="monotone" dataKey="putIV" stroke="hsl(0 84% 60%)" strokeWidth={2} dot={false} connectNulls name="Put IV" />
                <Area type="monotone" dataKey="avgIV" stroke="hsl(var(--primary))" fill={`url(#ivSmileGrad-${symbol})`} strokeWidth={1.5} strokeDasharray="5 5" dot={false} name="Avg IV" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No IV data available
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export const IVSmileCard = memo(IVSmileCardComponent);
