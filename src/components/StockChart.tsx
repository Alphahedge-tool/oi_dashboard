import { useRef, useEffect, useState, useCallback } from "react";
import { createChart, ColorType, CandlestickSeries, HistogramSeries, LineSeries, type IChartApi, type Time } from "lightweight-charts";
import { useChartData, type OHLCVCandle } from "@/hooks/useChartData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { BarChart3, Loader2, X, CandlestickChart, LineChart } from "lucide-react";

const TIME_RANGES = ["1W", "1M", "3M", "6M", "1Y"] as const;
type TimeRange = (typeof TIME_RANGES)[number];

interface StockChartProps {
  symbol: string;
  /** Inline mode renders directly, otherwise renders inside a Card */
  inline?: boolean;
  /** Initial height in pixels */
  height?: number;
  /** If provided, renders as a Sheet (drawer) */
  asSheet?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function ChartCore({
  symbol,
  height = 340,
}: {
  symbol: string;
  height?: number;
}) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [range, setRange] = useState<TimeRange>("3M");
  const [chartType, setChartType] = useState<"candle" | "line">("candle");
  const { data: candles, isLoading, error } = useChartData(symbol, range);

  const buildChart = useCallback(() => {
    if (!chartContainerRef.current || !candles || candles.length === 0) return;

    // Destroy previous chart
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const container = chartContainerRef.current;
    const isDark = document.documentElement.classList.contains("dark");
    const chartSurface = isDark ? "#0f171a" : "#ffffff";
    const mutedText = isDark ? "#92a4aa" : "#64748b";
    const gridColor = isDark ? "rgba(127,127,127,0.12)" : "rgba(15,23,42,0.08)";
    const borderColor = isDark ? "rgba(127,127,127,0.18)" : "rgba(15,23,42,0.12)";
    const upColor = isDark ? "#4fe0a0" : "#0f9f6e";
    const downColor = isDark ? "#ff746f" : "#dc2626";

    const chart = createChart(container, {
      width: container.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: chartSurface },
        textColor: mutedText,
        fontFamily: "'JetBrains Mono', 'Inter', system-ui, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: gridColor },
        horzLines: { color: gridColor },
      },
      crosshair: {
        mode: 1,
        vertLine: { color: isDark ? "rgba(66,211,199,0.42)" : "rgba(13,148,136,0.35)", width: 1, style: 2, labelBackgroundColor: isDark ? "#123432" : "#ccfbf1" },
        horzLine: { color: isDark ? "rgba(66,211,199,0.42)" : "rgba(13,148,136,0.35)", width: 1, style: 2, labelBackgroundColor: isDark ? "#123432" : "#ccfbf1" },
      },
      rightPriceScale: {
        borderVisible: true,
        borderColor,
        scaleMargins: { top: 0.1, bottom: 0.25 },
      },
      timeScale: {
        borderVisible: true,
        borderColor,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 3,
        minBarSpacing: range === "1W" ? 3 : 4,
      },
      localization: {
        locale: "en-IN",
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true },
    });

    chartRef.current = chart;

    // Format candle data for lightweight-charts
    const formattedCandles = candles.map((c) => ({
      time: c.time as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    if (chartType === "candle") {
      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor,
        downColor,
        borderVisible: false,
        wickUpColor: upColor,
        wickDownColor: downColor,
      });
      candleSeries.setData(formattedCandles);
    } else {
      const isPositive = candles[candles.length - 1].close >= candles[0].close;
      const lineSeries = chart.addSeries(LineSeries, {
        color: isPositive ? upColor : downColor,
        lineWidth: 2,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 4,
      });
      lineSeries.setData(
        candles.map((c) => ({ time: c.time as Time, value: c.close }))
      );
    }

    // Volume histogram
    const volumeData = candles
      .filter((c) => c.volume && c.volume > 0)
      .map((c, i, arr) => ({
        time: c.time as Time,
        value: c.volume!,
        color:
          i > 0 && c.close >= arr[i - 1].close
            ? (isDark ? "rgba(79,224,160,0.34)" : "rgba(15,159,110,0.22)")
            : (isDark ? "rgba(255,116,111,0.32)" : "rgba(220,38,38,0.18)"),
      }));

    if (volumeData.length > 0) {
      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "",
      });
      volumeSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
      });
      volumeSeries.setData(volumeData);
    }

    chart.timeScale().fitContent();

    // Resize handler
    const resizeObserver = new ResizeObserver((entries) => {
      const { width: w } = entries[0].contentRect;
      chart.applyOptions({ width: w });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, height, chartType, range]);

  useEffect(() => {
    const cleanup = buildChart();
    return () => cleanup?.();
  }, [buildChart]);

  const lastCandle = candles?.[candles.length - 1];
  const firstCandle = candles?.[0];
  const priceChange =
    lastCandle && firstCandle
      ? ((lastCandle.close - firstCandle.close) / firstCandle.close) * 100
      : 0;

  return (
    <div className="space-y-2 rounded border border-slate-200 bg-white p-2 dark:border-[#223036] dark:bg-[#0f171a]">
      {/* Controls */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ToggleGroup
            type="single"
            value={range}
            onValueChange={(v) => v && setRange(v as TimeRange)}
            className="rounded bg-slate-100 p-0.5 dark:bg-[#111c20]"
          >
            {TIME_RANGES.map((r) => (
              <ToggleGroupItem
                key={r}
                value={r}
                className="h-6 rounded px-2.5 text-xs data-[state=on]:bg-white data-[state=on]:text-teal-800 data-[state=on]:shadow-sm dark:data-[state=on]:bg-[#123432] dark:data-[state=on]:text-[#d8fffb]"
              >
                {r}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <ToggleGroup
            type="single"
            value={chartType}
            onValueChange={(v) => v && setChartType(v as "candle" | "line")}
            className="rounded bg-slate-100 p-0.5 dark:bg-[#111c20]"
          >
            <ToggleGroupItem value="candle" className="h-6 w-7 rounded p-0 data-[state=on]:bg-white data-[state=on]:text-teal-800 data-[state=on]:shadow-sm dark:data-[state=on]:bg-[#123432] dark:data-[state=on]:text-[#d8fffb]">
              <CandlestickChart className="h-3.5 w-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem value="line" className="h-6 w-7 rounded p-0 data-[state=on]:bg-white data-[state=on]:text-teal-800 data-[state=on]:shadow-sm dark:data-[state=on]:bg-[#123432] dark:data-[state=on]:text-[#d8fffb]">
              <LineChart className="h-3.5 w-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div className="flex items-center gap-2">
          {lastCandle && (
            <>
              <span className="text-xs font-mono font-semibold">
                ₹{lastCandle.close.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
              </span>
              <Badge
                variant="outline"
                className={`text-[11px] font-mono ${priceChange >= 0 ? "text-bullish border-bullish/30" : "text-bearish border-bearish/30"}`}
              >
                {priceChange >= 0 ? "+" : ""}
                {priceChange.toFixed(2)}%
              </Badge>
            </>
          )}
          {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
      </div>

      {/* Chart Container */}
      <div className="relative">
        {isLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 backdrop-blur-sm rounded-lg">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading chart...
            </div>
          </div>
        )}
        {error && !candles && (
          <div className="flex items-center justify-center h-[200px] text-sm text-muted-foreground">
            Chart data unavailable. Start the proxy server for live data.
          </div>
        )}
        <div ref={chartContainerRef} className="w-full overflow-hidden rounded bg-white dark:bg-[#0f171a]" />
        {candles && candles.length === 0 && !isLoading && (
          <div className="flex items-center justify-center h-[200px] text-sm text-muted-foreground">
            No historical data available for {symbol}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Full interactive stock chart component.
 * Can render inline (as a Card) or as a Sheet (drawer).
 */
export function StockChart({
  symbol,
  inline = false,
  height = 340,
  asSheet = false,
  open = false,
  onOpenChange,
}: StockChartProps) {
  if (asSheet) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="h-[480px]">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="h-4 w-4 text-primary" />
              {symbol} — Price Chart
            </SheetTitle>
          </SheetHeader>
          <div className="mt-3">
            <ChartCore symbol={symbol} height={380} />
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  if (inline) {
    return <ChartCore symbol={symbol} height={height} />;
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          {symbol} — Price Chart
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartCore symbol={symbol} height={height} />
      </CardContent>
    </Card>
  );
}
