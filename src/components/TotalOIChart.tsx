import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createChart, ColorType, HistogramSeries, LineSeries, type IChartApi, type ISeriesApi, type Time } from "lightweight-charts";
import { BarChart3, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useExpiryList } from "@/hooks/useMarketData";
import { fetchNubraTimeseries } from "@/lib/marketApi";

interface Props {
  symbol: string;
  compact?: boolean;
}

interface TotalOiPoint {
  ts: number;
  callOi: number;
  putOi: number;
}

type LightweightSeries = ISeriesApi<"Line"> | ISeriesApi<"Histogram">;

const SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"];
const NO_COMPARE = "__none__";
const BSE_SYMBOLS = new Set(["SENSEX", "BANKEX"]);

function formatOi(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)} L`;
  return `${sign}${abs.toLocaleString("en-IN")}`;
}

function toLakhs(value: number): number {
  return Number((Number(value || 0) / 100000).toFixed(2));
}

function normalizeSymbol(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function toNubraChainValue(symbol: string, expiry: string) {
  const d = new Date(`${expiry}T00:00:00+05:30`);
  const yyyy = d.toLocaleString("en-IN", { year: "numeric", timeZone: "Asia/Kolkata" });
  const mm = d.toLocaleString("en-IN", { month: "2-digit", timeZone: "Asia/Kolkata" });
  const dd = d.toLocaleString("en-IN", { day: "2-digit", timeZone: "Asia/Kolkata" });
  return `${normalizeSymbol(symbol)}_${yyyy}${mm}${dd}`;
}

function previousTradingDay(dateStr: string) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function lastTradingDay() {
  const istMs = Date.now() + 5.5 * 3600 * 1000;
  const d = new Date(istMs);
  const istMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && istMin < 9 * 60 + 15) d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function buildNubraTimeseriesWindow(tradingDate: string) {
  return {
    startDate: `${tradingDate}T03:45:00.000Z`,
    endDate: `${tradingDate}T10:00:00.000Z`,
    interval: "1m",
    intraDay: false,
    realTime: false,
  };
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatChartTime(time: Time) {
  const sec = typeof time === "number" ? time : 0;
  return formatTime(sec * 1000);
}

function cssHslVar(name: string, alpha?: number) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return `hsl(${value}${alpha == null ? "" : ` / ${alpha}`})`;
}

function istDayKey(ts: number) {
  return new Date(ts + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function parseTotalOiResponse(json: any, chainValues: string[]): TotalOiPoint[] {
  const totals = new Map<number, TotalOiPoint>();

  for (const entry of json?.result || []) {
    for (const valueObj of entry?.values || []) {
      for (const chainValue of chainValues) {
        const chainData = valueObj?.[chainValue];
        if (!chainData) continue;

        const callArr: Array<{ ts: number; v: number }> = chainData.cumulative_call_oi || [];
        const putArr: Array<{ ts: number; v: number }> = chainData.cumulative_put_oi || [];

        for (const point of callArr) {
          const ts = Math.floor(Number(point.ts || 0) / 1e9) * 1000;
          if (!Number.isFinite(ts) || ts <= 0) continue;
          const row = totals.get(ts) || { ts, callOi: 0, putOi: 0 };
          row.callOi += Number(point.v || 0);
          totals.set(ts, row);
        }

        for (const point of putArr) {
          const ts = Math.floor(Number(point.ts || 0) / 1e9) * 1000;
          if (!Number.isFinite(ts) || ts <= 0) continue;
          const row = totals.get(ts) || { ts, callOi: 0, putOi: 0 };
          row.putOi += Number(point.v || 0);
          totals.set(ts, row);
        }
      }
    }
  }

  return [...totals.values()]
    .filter((row) => row.callOi > 0 || row.putOi > 0)
    .sort((a, b) => a.ts - b.ts);
}

function applyOiChange(points: TotalOiPoint[], enabled: boolean) {
  if (!enabled) return points;
  const bases = new Map<string, TotalOiPoint>();
  for (const point of points) {
    const key = istDayKey(point.ts);
    if (!bases.has(key)) bases.set(key, point);
  }
  return points.map((point) => {
    const base = bases.get(istDayKey(point.ts)) || points[0] || point;
    return { ts: point.ts, callOi: point.callOi - base.callOi, putOi: point.putOi - base.putOi };
  });
}

async function fetchTotalOiForDate(symbol: string, expiryValues: string[], tradingDate: string) {
  const chainValues = expiryValues.map((expiry) => toNubraChainValue(symbol, expiry));
  const exchange = BSE_SYMBOLS.has(normalizeSymbol(symbol)) ? "BSE" : "NSE";
  const json = await fetchNubraTimeseries("Put_Call_Ratio", [
    {
      exchange,
      type: "CHAIN",
      values: chainValues,
      fields: ["cumulative_call_oi", "cumulative_put_oi"],
      ...buildNubraTimeseriesWindow(tradingDate),
    },
  ]);
  return parseTotalOiResponse(json, chainValues);
}

function useTotalOiSeries(symbol: string, expiryValues: string[], enabled: boolean) {
  const [points, setPoints] = useState<TotalOiPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [date, setDate] = useState("");

  useEffect(() => {
    if (!enabled || !symbol || expiryValues.length === 0) {
      setPoints([]);
      setError("");
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const tradingDate = lastTradingDay();
        let usedDate = tradingDate;
        let nextPoints = await fetchTotalOiForDate(symbol, expiryValues, tradingDate);
        if (nextPoints.length === 0) {
          usedDate = previousTradingDay(tradingDate);
          nextPoints = await fetchTotalOiForDate(symbol, expiryValues, usedDate);
        }
        if (!cancelled) {
          setPoints(nextPoints);
          setDate(usedDate);
        }
      } catch (err) {
        if (!cancelled) {
          setPoints([]);
          setError(err instanceof Error ? err.message : "Failed to load Total OI");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    const interval = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [enabled, symbol, expiryValues.join("|")]);

  return { points, loading, error, date };
}

function getLastTotals(points: TotalOiPoint[]) {
  const last = points[points.length - 1];
  const callOi = last?.callOi || 0;
  const putOi = last?.putOi || 0;
  return { callOi, putOi, spread: putOi - callOi, pcr: callOi > 0 ? putOi / callOi : 0 };
}

function displayError(error: string, symbol: string) {
  if (!error) return `No full-day Total OI returned for ${symbol}.`;
  if (/401|unauthori|session expired|session/i.test(error)) {
    return "Nubra session expired. Reconnect Nubra in Broker API Keys, or use Auto Login there to refresh the session.";
  }
  return error;
}

function ExpiryButtons({
  expiries,
  selected,
  onToggle,
}: {
  expiries: { value: string; label?: string; daysToExpiry?: number }[];
  selected: number[];
  onToggle: (index: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {expiries.slice(0, 4).map((expiry, index) => (
        <button
          key={expiry.value}
          type="button"
          onClick={() => onToggle(index)}
          className={`h-7 rounded-md border px-2 text-[11px] font-medium transition-colors ${
            selected.includes(index)
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border bg-background/70 text-muted-foreground hover:text-foreground"
          }`}
        >
          {expiry.label || expiry.value}
        </button>
      ))}
    </div>
  );
}

function TradingViewTotalOiChart({
  points,
  height,
  label,
  showOiChange,
}: {
  points: TotalOiPoint[];
  height: number;
  label: string;
  showOiChange: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{ call?: LightweightSeries; put?: LightweightSeries; spread?: LightweightSeries }>({});

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const chart = createChart(host, {
      autoSize: true,
      height,
      layout: {
        background: { type: ColorType.Solid, color: cssHslVar("--card") },
        textColor: cssHslVar("--muted-foreground"),
        fontFamily: "'JetBrains Mono', 'Inter', system-ui, sans-serif",
        fontSize: 10,
      },
      localization: {
        locale: "en-IN",
        timeFormatter: (time: Time) => formatChartTime(time),
        priceFormatter: (value: number) => `${Number(value).toFixed(2)}L`,
      },
      grid: {
        vertLines: { color: cssHslVar("--chart-grid", 0.78) },
        horzLines: { color: cssHslVar("--chart-grid", 0.78) },
      },
      rightPriceScale: { borderColor: cssHslVar("--border") },
      timeScale: {
        borderColor: cssHslVar("--border"),
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        tickMarkFormatter: (time: Time) => formatChartTime(time),
      },
      crosshair: { mode: 1 },
      handleScale: { mouseWheel: true, pinch: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
    });

    const spread = chart.addSeries(HistogramSeries, {
      priceScaleId: "right",
      priceFormat: { type: "custom", formatter: (value: number) => `${Number(value).toFixed(2)}L` },
      base: 0,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const call = chart.addSeries(LineSeries, {
      color: cssHslVar("--bearish"),
      lineWidth: 2,
      priceLineVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 3,
    });
    const put = chart.addSeries(LineSeries, {
      color: cssHslVar("--bullish"),
      lineWidth: 2,
      priceLineVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 3,
    });

    chartRef.current = chart;
    seriesRef.current = { call, put, spread };

    chart.subscribeCrosshairMove((param) => {
      const tooltip = tooltipRef.current;
      if (!tooltip || !param.point || param.time == null) {
        if (tooltip) tooltip.style.display = "none";
        return;
      }

      const callValue = Number((param.seriesData.get(call) as { value?: number } | undefined)?.value);
      const putValue = Number((param.seriesData.get(put) as { value?: number } | undefined)?.value);
      const spreadValue = Number((param.seriesData.get(spread) as { value?: number } | undefined)?.value);
      if (!Number.isFinite(callValue) && !Number.isFinite(putValue) && !Number.isFinite(spreadValue)) {
        tooltip.style.display = "none";
        return;
      }

      const left = param.point.x > host.clientWidth - 190 ? param.point.x - 178 : param.point.x + 12;
      const top = Math.max(8, Math.min(param.point.y + 12, host.clientHeight - 96));
      tooltip.style.display = "block";
      tooltip.style.transform = `translate(${left}px, ${top}px)`;
      tooltip.innerHTML = `
        <div class="mb-1 font-semibold text-foreground">${label} ${formatChartTime(param.time)}</div>
        <div class="flex items-center justify-between gap-4"><span class="text-bearish">Call ${showOiChange ? "Chg" : "OI"}</span><span>${Number.isFinite(callValue) ? `${callValue.toFixed(2)}L` : "-"}</span></div>
        <div class="flex items-center justify-between gap-4"><span class="text-bullish">Put ${showOiChange ? "Chg" : "OI"}</span><span>${Number.isFinite(putValue) ? `${putValue.toFixed(2)}L` : "-"}</span></div>
        <div class="flex items-center justify-between gap-4"><span class="text-primary">Spread</span><span>${Number.isFinite(spreadValue) ? `${spreadValue.toFixed(2)}L` : "-"}</span></div>
      `;
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = {};
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const { call, put, spread } = seriesRef.current;
    if (!chart || !call || !put || !spread) return;

    const lineData = points.map((point) => ({ time: Math.floor(point.ts / 1000) as Time, call: toLakhs(point.callOi), put: toLakhs(point.putOi), spread: toLakhs(point.putOi - point.callOi) }));
    call.setData(lineData.map((point) => ({ time: point.time, value: point.call })));
    put.setData(lineData.map((point) => ({ time: point.time, value: point.put })));
    spread.setData(
      lineData.map((point) => ({
        time: point.time,
        value: point.spread,
        color: point.spread >= 0 ? "rgba(34, 197, 94, 0.24)" : "rgba(239, 68, 68, 0.24)",
      })),
    );
    chart.timeScale().fitContent();
  }, [points]);

  useEffect(() => {
    chartRef.current?.applyOptions({ height });
  }, [height]);

  return (
    <div className="relative w-full overflow-hidden rounded-md border border-border/60 bg-card" style={{ height }}>
      <div ref={hostRef} className="h-full w-full" />
      <div className="pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-3 rounded border border-border/70 bg-card/80 px-2 py-1 text-[11px] backdrop-blur">
        <span className="font-semibold text-muted-foreground">{label}</span>
        <span className="text-bearish">Call</span>
        <span className="text-bullish">Put</span>
        <span className="text-primary">Spread</span>
      </div>
      <div
        ref={tooltipRef}
        className="pointer-events-none absolute left-0 top-0 z-20 hidden min-w-[166px] rounded-md border border-border bg-card/95 p-2 font-mono text-[11px] text-muted-foreground shadow-lg backdrop-blur"
      />
    </div>
  );
}

function SymbolButtons({
  value,
  onChange,
  includeNone = false,
  exclude,
}: {
  value: string;
  onChange: (value: string) => void;
  includeNone?: boolean;
  exclude?: string;
}) {
  const items = includeNone ? [NO_COMPARE, ...SYMBOLS.filter((item) => item !== exclude)] : SYMBOLS;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => {
        const label = item === NO_COMPARE ? "None" : item;
        return (
          <button
            key={item}
            type="button"
            onClick={() => onChange(item)}
            className={`h-7 rounded-md border px-2 text-[11px] font-semibold transition-colors ${
              value === item
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border bg-background/70 text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function TotalOIChartComponent({ symbol, compact = false }: Props) {
  const [chartsReady, setChartsReady] = useState(false);
  const [primarySymbol, setPrimarySymbol] = useState(symbol);
  const [compareSymbol, setCompareSymbol] = useState(NO_COMPARE);
  const [primaryExpiryIndexes, setPrimaryExpiryIndexes] = useState([0]);
  const [compareExpiryIndexes, setCompareExpiryIndexes] = useState([0]);
  const [showOiChange, setShowOiChange] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => setChartsReady(true), 350);
    return () => window.clearTimeout(id);
  }, []);

  const { data: primaryExpiryData, isLoading: primaryExpiriesLoading } = useExpiryList(primarySymbol);
  const { data: compareExpiryData, isLoading: compareExpiriesLoading } = useExpiryList(compareSymbol === NO_COMPARE ? primarySymbol : compareSymbol);

  const primaryExpiries = primaryExpiryData?.expiries || [];
  const compareExpiries = compareSymbol === NO_COMPARE ? [] : compareExpiryData?.expiries || [];
  const primaryExpiryValues = primaryExpiryIndexes.map((idx) => primaryExpiries[idx]?.value).filter(Boolean) as string[];
  const compareExpiryValues = compareExpiryIndexes.map((idx) => compareExpiries[idx]?.value).filter(Boolean) as string[];
  const compareEnabled = compareSymbol !== NO_COMPARE;

  const primarySeries = useTotalOiSeries(primarySymbol, primaryExpiryValues, primaryExpiryValues.length > 0);
  const compareSeries = useTotalOiSeries(compareSymbol, compareExpiryValues, compareEnabled && compareExpiryValues.length > 0);

  const primaryPoints = useMemo(() => applyOiChange(primarySeries.points, showOiChange), [primarySeries.points, showOiChange]);
  const comparePoints = useMemo(() => applyOiChange(compareSeries.points, showOiChange), [compareSeries.points, showOiChange]);
  const primaryTotals = useMemo(() => getLastTotals(primaryPoints), [primaryPoints]);
  const compareTotals = useMemo(() => getLastTotals(comparePoints), [comparePoints]);

  const isLoading = primaryExpiriesLoading || primarySeries.loading || (compareEnabled && (compareExpiriesLoading || compareSeries.loading));
  const hasPrimaryData = primaryPoints.length > 0;
  const hasCompareData = comparePoints.length > 0;
  const chartHeight = compact ? 260 : compareEnabled ? 330 : 430;

  const toggleIndex = (current: number[], index: number) => {
    if (current.includes(index)) return current.length === 1 ? current : current.filter((item) => item !== index);
    return [...current, index].sort((a, b) => a - b);
  };

  const renderSummary = (label: string, totals: ReturnType<typeof getLastTotals>) => (
    <div className="grid grid-cols-3 gap-2">
      <div className="rounded-md bg-accent/30 p-2">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label} {showOiChange ? "Call Chg" : "Call OI"}</p>
        <p className="font-mono text-sm font-bold text-bearish">{formatOi(totals.callOi)}</p>
      </div>
      <div className="rounded-md bg-accent/30 p-2">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label} {showOiChange ? "Put Chg" : "Put OI"}</p>
        <p className="font-mono text-sm font-bold text-bullish">{formatOi(totals.putOi)}</p>
      </div>
      <div className="rounded-md bg-accent/30 p-2">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label} Spread</p>
        <p className={`font-mono text-sm font-bold ${totals.spread >= 0 ? "text-bullish" : "text-bearish"}`}>{formatOi(totals.spread)}</p>
      </div>
    </div>
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" />
            Total OI Full Day
            <Badge variant="outline" className="text-xs h-4 text-primary border-primary/30">
              {primarySeries.date || primarySymbol}
            </Badge>
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Label className="text-xs text-muted-foreground">OI Change</Label>
            <Switch checked={showOiChange} onCheckedChange={setShowOiChange} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 xl:grid-cols-2">
          <div className="space-y-2 rounded-md border border-border/70 bg-background/40 p-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Chart 1</span>
              <SymbolButtons value={primarySymbol} onChange={(value) => { setPrimarySymbol(value); setPrimaryExpiryIndexes([0]); }} />
            </div>
          <ExpiryButtons expiries={primaryExpiries} selected={primaryExpiryIndexes} onToggle={(idx) => setPrimaryExpiryIndexes((current) => toggleIndex(current, idx))} />
          </div>

          <div className="space-y-2 rounded-md border border-border/70 bg-background/40 p-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Chart 2</span>
              <SymbolButtons value={compareSymbol} includeNone exclude={primarySymbol} onChange={(value) => { setCompareSymbol(value); setCompareExpiryIndexes([0]); }} />
            </div>
            {compareEnabled ? (
            <ExpiryButtons expiries={compareExpiries} selected={compareExpiryIndexes} onToggle={(idx) => setCompareExpiryIndexes((current) => toggleIndex(current, idx))} />
          ) : (
            <div className="flex h-7 items-center text-xs text-muted-foreground">Select a symbol to add a second chart.</div>
          )}
          </div>
        </div>

        {(hasPrimaryData || hasCompareData) && (
          <div className={compareEnabled ? "grid gap-2 xl:grid-cols-2" : "grid gap-2"}>
            {hasPrimaryData && renderSummary(primarySymbol, primaryTotals)}
            {compareEnabled && hasCompareData && renderSummary(compareSymbol, compareTotals)}
          </div>
        )}

        {!chartsReady ? (
          <div className={compact ? "flex h-[260px] items-center justify-center gap-2 text-sm text-muted-foreground" : "flex h-[430px] items-center justify-center gap-2 text-sm text-muted-foreground"}>
            <Loader2 className="h-4 w-4 animate-spin" />
            Preparing Total OI chart...
          </div>
        ) : isLoading ? (
          <div className={compact ? "flex h-[260px] items-center justify-center gap-2 text-sm text-muted-foreground" : "flex h-[430px] items-center justify-center gap-2 text-sm text-muted-foreground"}>
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading total OI...
          </div>
        ) : !hasPrimaryData ? (
          <div className={compact ? "flex h-[260px] items-center justify-center text-sm text-muted-foreground" : "flex h-[430px] items-center justify-center text-sm text-muted-foreground"}>
            {displayError(primarySeries.error, primarySymbol)}
          </div>
        ) : compareEnabled && !hasCompareData ? (
          <div className={compact ? "flex h-[260px] items-center justify-center text-sm text-muted-foreground" : "flex h-[430px] items-center justify-center text-sm text-muted-foreground"}>
            {displayError(compareSeries.error, compareSymbol)}
          </div>
        ) : compareEnabled ? (
          <div className="grid gap-3 xl:grid-cols-2">
            <div className="space-y-1">
              <p className="text-xs font-semibold text-muted-foreground">{primarySymbol}</p>
              <TradingViewTotalOiChart points={primaryPoints} height={chartHeight} label={primarySymbol} showOiChange={showOiChange} />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold text-muted-foreground">{compareSymbol}</p>
              <TradingViewTotalOiChart points={comparePoints} height={chartHeight} label={compareSymbol} showOiChange={showOiChange} />
            </div>
          </div>
        ) : (
          <TradingViewTotalOiChart points={primaryPoints} height={chartHeight} label={primarySymbol} showOiChange={showOiChange} />
        )}
      </CardContent>
    </Card>
  );
}

export const TotalOIChart = memo(TotalOIChartComponent);
