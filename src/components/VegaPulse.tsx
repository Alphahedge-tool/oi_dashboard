import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createChart, BaselineSeries, ColorType, LineSeries, type IChartApi, type ISeriesApi, type Time } from "lightweight-charts";
import { Activity, Loader2, RefreshCw, LayoutGrid, Columns3, Square, PanelTop } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useExpiryList, useLiveIndices, useLiveOptionChain } from "@/hooks/useMarketData";
import { fetchNubraInstruments, fetchNubraTimeseries } from "@/lib/marketApi";
import type { OptionData } from "@/lib/mockData";
import { getSpotPrice } from "@/lib/positionStore";

type OptionSide = "CE" | "PE";
type GreekMode = "vega" | "theta" | "gamma";
type LayoutMode = "single" | "cols3" | "top2bot1" | "vega1tg2";

interface VegaPulseProps {
  symbol?: string;
  height?: number;
  compact?: boolean;
}

interface SelectedLeg {
  side: OptionSide;
  strike: number;
  symbol: string;
  openingVega: number;
  openingDelta: number;
  openingTheta: number;
  openingGamma: number;
}

interface GreekRow {
  ts: number;
  callVal: number;
  putVal: number;
}

interface PulsePoint {
  ts: number;
  callVal: number;
  putVal: number;
  totalVal: number;
  callPulse: number;
  putPulse: number;
  totalPulse: number;
}

interface SpotPoint {
  ts: number;
  value: number;
}

interface OiPoint {
  ts: number;
  callOi: number;
  putOi: number;
  openCallOi: number;
  openPutOi: number;
}

const BSE_SYMBOLS = new Set(["SENSEX", "BANKEX"]);
const INDEX_SYMBOLS = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"]);
const NUBRA_VALUE_BATCH_SIZE = 9;

const GREEK_CONFIG: Record<GreekMode, { label: string; field: string; ceColor: string; peColor: string; sentimentPrefix: string }> = {
  vega:  { label: "Vega",  field: "vega",  ceColor: "#22ff66", peColor: "#ff554d", sentimentPrefix: "Vega"  },
  theta: { label: "Theta", field: "theta", ceColor: "#38bdf8", peColor: "#f97316", sentimentPrefix: "Theta" },
  gamma: { label: "Gamma", field: "gamma", ceColor: "#a78bfa", peColor: "#fb7185", sentimentPrefix: "Gamma" },
};

function normalizeSymbol(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}


function toNubraOptionSymbol(symbol: string, expiry: string, strike: number, side: OptionSide) {
  const d = new Date(`${expiry}T00:00:00+05:30`);
  const yy = d.toLocaleString("en-IN", { year: "2-digit", timeZone: "Asia/Kolkata" });
  const month = String(Number(d.toLocaleString("en-IN", { month: "2-digit", timeZone: "Asia/Kolkata" })));
  const dd = d.toLocaleString("en-IN", { day: "2-digit", timeZone: "Asia/Kolkata" });
  return `${normalizeSymbol(symbol)}${yy}${month}${dd}${Math.round(strike)}${side}`;
}

function toNubraExpiryInt(expiry: string) {
  const d = new Date(`${expiry}T00:00:00+05:30`);
  const yyyy = d.toLocaleString("en-IN", { year: "numeric", timeZone: "Asia/Kolkata" });
  const mm = d.toLocaleString("en-IN", { month: "2-digit", timeZone: "Asia/Kolkata" });
  const dd = d.toLocaleString("en-IN", { day: "2-digit", timeZone: "Asia/Kolkata" });
  return Number(`${yyyy}${mm}${dd}`);
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
  return typeof time === "number" ? formatTime(time * 1000) : "";
}

function cssHslVar(name: string, alpha?: number) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return `hsl(${value}${alpha == null ? "" : ` / ${alpha}`})`;
}

function formatGreek(value: number) {
  const abs = Math.abs(value);
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  if (abs >= 100000) return `${sign}${(abs / 100000).toFixed(2)}L`;
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}K`;
  return `${sign}${abs.toFixed(4)}`;
}

function nearestAtmIndex(chain: OptionData[], spotPrice: number) {
  if (!chain.length || !Number.isFinite(spotPrice) || spotPrice <= 0) return -1;
  let best = 0;
  let bestDiff = Math.abs(chain[0].strikePrice - spotPrice);
  chain.forEach((row, index) => {
    const diff = Math.abs(row.strikePrice - spotPrice);
    if (diff < bestDiff) {
      best = index;
      bestDiff = diff;
    }
  });
  return best;
}

function resolveSpotPrice(chain: OptionData[], chainSpot: number, liveSpot: number, fallbackSpot: number) {
  const strikes = chain.map((row) => Number(row.strikePrice)).filter(Number.isFinite);
  const minStrike = Math.min(...strikes);
  const maxStrike = Math.max(...strikes);
  const candidates = [chainSpot, liveSpot, fallbackSpot].map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return candidates.find((value) => value >= minStrike && value <= maxStrike) || candidates[0] || 0;
}

function chooseVegaLegs(chain: OptionData[], spotPrice: number, symbol: string, expiry: string) {
  const atmIndex = nearestAtmIndex(chain, spotPrice);
  if (atmIndex < 0) return { callLegs: [] as SelectedLeg[], putLegs: [] as SelectedLeg[], atmStrike: 0 };

  const atmStrike = chain[atmIndex].strikePrice;
  let ceStart = atmIndex;
  for (let i = atmIndex; i >= 0; i -= 1) {
    if (Number(chain[i].ce.delta) >= 0.6) {
      ceStart = i;
      break;
    }
    ceStart = i;
  }

  let ceEnd = atmIndex;
  for (let i = atmIndex; i < chain.length; i += 1) {
    ceEnd = i;
    const delta = Number(chain[i].ce.delta);
    if (delta > 0 && delta <= 0.05) break;
  }

  let peStart = atmIndex;
  for (let i = atmIndex; i >= 0; i -= 1) {
    peStart = i;
    const delta = Math.abs(Number(chain[i].pe.delta));
    if (delta > 0 && delta <= 0.05) break;
  }

  let peEnd = atmIndex;
  for (let i = atmIndex; i < chain.length; i += 1) {
    if (Math.abs(Number(chain[i].pe.delta)) >= 0.6) {
      peEnd = i;
      break;
    }
    peEnd = i;
  }

  const callLegs = chain.slice(ceStart, ceEnd + 1)
    .filter((row) => Number(row.ce.vega) > 0)
    .map((row) => ({
      side: "CE" as const,
      strike: row.strikePrice,
      symbol: toNubraOptionSymbol(symbol, expiry, row.strikePrice, "CE"),
      openingVega: Number(row.ce.vega || 0),
      openingDelta: Number(row.ce.delta || 0),
      openingTheta: Number((row.ce as any).theta || 0),
      openingGamma: Number((row.ce as any).gamma || 0),
    }));
  const putLegs = chain.slice(peStart, peEnd + 1)
    .filter((row) => Number(row.pe.vega) > 0)
    .map((row) => ({
      side: "PE" as const,
      strike: row.strikePrice,
      symbol: toNubraOptionSymbol(symbol, expiry, row.strikePrice, "PE"),
      openingVega: Number(row.pe.vega || 0),
      openingDelta: Number(row.pe.delta || 0),
      openingTheta: Number((row.pe as any).theta || 0),
      openingGamma: Number((row.pe as any).gamma || 0),
    }));

  return { callLegs, putLegs, atmStrike };
}

function pointTs(point: any) {
  const raw = Number(point?.ts || point?.time || point?.timestamp || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (raw > 1e15) return Math.floor(raw / 1e6);
  return raw > 1e10 ? raw : raw * 1000;
}

function addGreekValue(rows: Map<number, GreekRow>, ts: number, side: OptionSide, value: number) {
  if (!Number.isFinite(ts) || ts <= 0 || !Number.isFinite(value)) return;
  const row = rows.get(ts) || { ts, callVal: 0, putVal: 0 };
  if (side === "CE") row.callVal += value;
  else row.putVal += value;
  rows.set(ts, row);
}

function valueFromPoint(point: any, strike: number, fieldName: string) {
  const direct = Number(point?.v ?? point?.value ?? point?.[fieldName]);
  if (Number.isFinite(direct)) return direct;
  const nested = point?.v || point?.value || point;
  if (nested && typeof nested === "object") {
    const hit = Number(nested[strike] ?? nested[String(strike)] ?? nested[`strike_${strike}`]);
    if (Number.isFinite(hit)) return hit;
  }
  return NaN;
}

function parseLegArray(rows: Map<number, GreekRow>, arr: any, side: OptionSide, strike: number, fieldName: string) {
  if (!Array.isArray(arr)) return;
  for (const point of arr) {
    const pointStrike = Number(point?.strike ?? point?.strike_price ?? point?.strikePrice ?? point?.s);
    if (Number.isFinite(pointStrike) && pointStrike !== strike) continue;
    const value = valueFromPoint(point, strike, fieldName);
    addGreekValue(rows, pointTs(point), side, value);
  }
}

function parseLegFromNode(rows: Map<number, GreekRow>, node: any, side: OptionSide, strike: number, fieldName: string) {
  if (!node || typeof node !== "object") return;
  parseLegArray(rows, node[fieldName], side, strike, fieldName);
  parseLegArray(rows, node?.[side]?.[fieldName] || node?.[side.toLowerCase()]?.[fieldName], side, strike, fieldName);
  parseLegArray(rows, node?.[side]?.[fieldName.charAt(0).toUpperCase() + fieldName.slice(1)] || node?.[side.toLowerCase()]?.[fieldName.charAt(0).toUpperCase() + fieldName.slice(1)], side, strike, fieldName);
}

function parseGreekRows(json: any, legs: SelectedLeg[], fieldName: string): GreekRow[] {
  const rows = new Map<number, GreekRow>();
  for (const entry of json?.result || []) {
    for (const valueObj of entry?.values || []) {
      for (const leg of legs) {
        parseLegFromNode(rows, valueObj?.[leg.symbol], leg.side, leg.strike, fieldName);
      }
    }
  }
  return [...rows.values()]
    .filter((row) => row.callVal !== 0 || row.putVal !== 0)
    .sort((a, b) => a.ts - b.ts);
}

function buildPulsePoints(rawRows: GreekRow[]): PulsePoint[] {
  const sorted = [...rawRows]
    .filter((row) => row.callVal !== 0 || row.putVal !== 0)
    .sort((a, b) => a.ts - b.ts);
  const opening = sorted[0] || { callVal: 0, putVal: 0 };
  return sorted.map((row) => {
    const totalVal = row.callVal + row.putVal;
    const openingTotal = opening.callVal + opening.putVal;
    return {
      ...row,
      totalVal,
      callPulse: row.callVal - opening.callVal,
      putPulse: row.putVal - opening.putVal,
      totalPulse: totalVal - openingTotal,
    };
  });
}

function buildLegValues(legs: SelectedLeg[]) {
  return [...new Set(legs.map((leg) => leg.symbol))];
}

function refdataSymbol(item: any) {
  return item?.stock_name || item?.symbol || item?.trading_symbol || item?.display_name || "";
}

function resolveLegSymbolsFromRefdata(legs: SelectedLeg[], refdata: any[], symbol: string, expiry: string) {
  const normalized = normalizeSymbol(symbol);
  const expiryInt = toNubraExpiryInt(expiry);
  if (!refdata.length || !expiryInt) return legs;

  return legs.map((leg) => {
    const expectedStrike = Math.round(leg.strike * 100);
    const match = refdata.find((item) => {
      const asset = normalizeSymbol(String(item?.asset || item?.underlying || item?.underlying_symbol || ""));
      const itemExpiry = Number(item?.expiry || item?.expiry_date || item?.order_expiry_date || 0);
      const itemStrike = Number(item?.strike_price || item?.strikePrice || 0);
      const optionType = String(item?.option_type || item?.optionType || "").toUpperCase();
      const derivativeType = String(item?.derivative_type || item?.derivativeType || "").toUpperCase();
      return asset === normalized
        && itemExpiry === expiryInt
        && itemStrike === expectedStrike
        && optionType === leg.side
        && (!derivativeType || derivativeType === "OPT");
    });
    const nextSymbol = refdataSymbol(match);
    return nextSymbol ? { ...leg, symbol: nextSymbol } : leg;
  });
}

function chunkValues<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

async function fetchGreekRowsWithFields({
  exchange,
  legs,
  tradingDate,
  fieldName,
}: {
  exchange: string;
  legs: SelectedLeg[];
  tradingDate: string;
  fieldName: string;
}) {
  const rows = new Map<number, GreekRow>();
  const valueBatches = chunkValues(buildLegValues(legs), NUBRA_VALUE_BATCH_SIZE);

  for (const values of valueBatches) {
    const batchLegs = legs.filter((leg) => values.includes(leg.symbol));
    const json = await fetchNubraTimeseries("", [
      {
        exchange,
        type: "OPT",
        values,
        fields: [fieldName],
        ...buildNubraTimeseriesWindow(tradingDate),
      },
    ]);

    for (const row of parseGreekRows(json, batchLegs, fieldName)) {
      const existing = rows.get(row.ts) || { ts: row.ts, callVal: 0, putVal: 0 };
      existing.callVal += row.callVal;
      existing.putVal += row.putVal;
      rows.set(row.ts, existing);
    }
  }

  return [...rows.values()];
}

async function fetchPulseForDate(symbol: string, expiry: string, legs: SelectedLeg[], tradingDate: string, fieldName: string) {
  const exchange = BSE_SYMBOLS.has(normalizeSymbol(symbol)) ? "BSE" : "NSE";
  let resolvedLegs = legs;
  try {
    const instruments = await fetchNubraInstruments();
    resolvedLegs = resolveLegSymbolsFromRefdata(legs, instruments?.refdata || [], symbol, expiry);
  } catch {
    resolvedLegs = legs;
  }
  const rows = await fetchGreekRowsWithFields({ exchange, legs: resolvedLegs, tradingDate, fieldName });
  return buildPulsePoints(rows);
}

function parseSpotRows(json: any, symbol: string): SpotPoint[] {
  const key = normalizeSymbol(symbol);
  const rows: SpotPoint[] = [];
  for (const entry of json?.result || []) {
    for (const valueObj of entry?.values || []) {
      const node = valueObj?.[key] || valueObj?.[symbol] || valueObj?.[normalizeSymbol(symbol)];
      const arr = node?.value || node?.close || [];
      if (!Array.isArray(arr)) continue;
      for (const point of arr) {
        const ts = pointTs(point);
        const value = Number(point?.v ?? point?.value);
        if (ts > 0 && Number.isFinite(value)) rows.push({ ts, value });
      }
    }
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

async function fetchSpotForDate(symbol: string, tradingDate: string) {
  const normalized = normalizeSymbol(symbol);
  const exchange = BSE_SYMBOLS.has(normalized) ? "BSE" : "NSE";
  const type = INDEX_SYMBOLS.has(normalized) ? "INDEX" : "STOCK";
  const json = await fetchNubraTimeseries("", [
    {
      exchange,
      type,
      values: [normalized],
      fields: ["value"],
      ...buildNubraTimeseriesWindow(tradingDate),
    },
  ]);
  return parseSpotRows(json, normalized);
}

function cumulativeAverage<T>(items: T[], pick: (item: T) => number) {
  let sum = 0;
  return items.map((item, index) => {
    sum += pick(item);
    return sum / (index + 1);
  });
}

function sentimentLabel(value: number, mode: GreekMode) {
  const prefix = GREEK_CONFIG[mode].sentimentPrefix;
  if (value > 20) return `Strong CE ${prefix}`;
  if (value > 5) return `CE ${prefix} Lead`;
  if (value < -20) return `Strong PE ${prefix}`;
  if (value < -5) return `PE ${prefix} Lead`;
  return "Neutral";
}

interface GreekChartProps {
  points: PulsePoint[];
  spotPoints: SpotPoint[];
  height: number;
  mode: GreekMode;
}

function GreekPulseChart({ points, spotPoints, height, mode }: GreekChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const paneLabelRefs = useRef<Array<HTMLDivElement | null>>([]);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{
    call?: ISeriesApi<"Line">;
    put?: ISeriesApi<"Line">;
    diff?: ISeriesApi<"Baseline">;
    diffAvg?: ISeriesApi<"Line">;
    spot?: ISeriesApi<"Line">;
    spotAvg?: ISeriesApi<"Line">;
  }>({});

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const cfg = GREEK_CONFIG[mode];
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
        priceFormatter: (value: number) => Number(value).toFixed(4),
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

    chart.panes()[0]?.setStretchFactor(0.42);
    chart.addPane()?.setStretchFactor(0.30);
    chart.addPane()?.setStretchFactor(0.28);

    const updatePaneLabels = () => {
      const hostRect = host.getBoundingClientRect();
      [0, 1, 2].forEach((paneIndex) => {
        const labelEl = paneLabelRefs.current[paneIndex];
        const paneEl = chart.panes()[paneIndex]?.getHTMLElement();
        if (!labelEl || !paneEl) return;
        const paneRect = paneEl.getBoundingClientRect();
        labelEl.style.display = "block";
        labelEl.style.top = `${Math.max(8, paneRect.top - hostRect.top + 8)}px`;
      });
    };
    const schedulePaneLabelUpdate = () => requestAnimationFrame(updatePaneLabels);
    const resizeObserver = new ResizeObserver(schedulePaneLabelUpdate);
    resizeObserver.observe(host);
    host.addEventListener("pointerdown", schedulePaneLabelUpdate);
    host.addEventListener("pointermove", schedulePaneLabelUpdate);
    window.addEventListener("resize", schedulePaneLabelUpdate);
    requestAnimationFrame(schedulePaneLabelUpdate);
    window.setTimeout(schedulePaneLabelUpdate, 100);

    const call = chart.addSeries(LineSeries, { color: cfg.ceColor, lineWidth: 2, crosshairMarkerRadius: 3, priceLineVisible: false, lastValueVisible: true, title: `CE ${cfg.label}` }, 0);
    const put = chart.addSeries(LineSeries, { color: cfg.peColor, lineWidth: 2, crosshairMarkerRadius: 3, priceLineVisible: false, lastValueVisible: true, title: `PE ${cfg.label}` }, 0);
    const diff = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: 0 },
      topLineColor: "rgba(0, 220, 130, 0.95)",
      topFillColor1: "rgba(0, 180, 120, 0.48)",
      topFillColor2: "rgba(0, 180, 120, 0.10)",
      bottomLineColor: "rgba(255, 82, 82, 0.95)",
      bottomFillColor1: "rgba(255, 82, 82, 0.48)",
      bottomFillColor2: "rgba(255, 82, 82, 0.10)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: `${cfg.label} Diff`,
    }, 1);
    const diffAvg = chart.addSeries(LineSeries, { color: "#f59e0b", lineWidth: 1, priceLineVisible: false, lastValueVisible: true, title: `${cfg.label} Diff Avg` }, 1);
    const spot = chart.addSeries(LineSeries, { color: "#1d9bf0", lineWidth: 1, crosshairMarkerRadius: 3, priceLineVisible: false, lastValueVisible: true, title: "Spot" }, 2);
    const spotAvg = chart.addSeries(LineSeries, { color: "#f59e0b", lineWidth: 1, priceLineVisible: false, lastValueVisible: true, title: "Spot Avg" }, 2);
    chartRef.current = chart;
    seriesRef.current = { call, put, diff, diffAvg, spot, spotAvg };

    chart.subscribeCrosshairMove((param) => {
      const tooltip = tooltipRef.current;
      if (!tooltip || !param.point || param.time == null) {
        if (tooltip) tooltip.style.display = "none";
        return;
      }
      const callValue = Number((param.seriesData.get(call) as { value?: number } | undefined)?.value);
      const putValue = Number((param.seriesData.get(put) as { value?: number } | undefined)?.value);
      const diffValue = Number((param.seriesData.get(diff) as { value?: number } | undefined)?.value);
      const diffAvgValue = Number((param.seriesData.get(diffAvg) as { value?: number } | undefined)?.value);
      const spotValue = Number((param.seriesData.get(spot) as { value?: number } | undefined)?.value);
      const spotAvgValue = Number((param.seriesData.get(spotAvg) as { value?: number } | undefined)?.value);
      const left = param.point.x > host.clientWidth - 190 ? param.point.x - 178 : param.point.x + 12;
      const top = Math.max(8, Math.min(param.point.y + 12, host.clientHeight - 142));
      tooltip.style.display = "block";
      tooltip.style.transform = `translate(${left}px, ${top}px)`;
      tooltip.innerHTML = `
        <div class="mb-1 font-semibold text-foreground">${formatChartTime(param.time)}</div>
        <div class="flex items-center justify-between gap-4"><span style="color:${cfg.ceColor}">CE Pulse</span><span>${Number.isFinite(callValue) ? formatGreek(callValue) : "-"}</span></div>
        <div class="flex items-center justify-between gap-4"><span style="color:${cfg.peColor}">PE Pulse</span><span>${Number.isFinite(putValue) ? formatGreek(putValue) : "-"}</span></div>
        <div class="flex items-center justify-between gap-4"><span class="text-primary">Sentiment</span><span>${Number.isFinite(diffValue) ? `${formatGreek(diffValue)} (${sentimentLabel(diffValue, mode)})` : "-"}</span></div>
        <div class="flex items-center justify-between gap-4"><span style="color:#f59e0b">Sentiment Avg</span><span>${Number.isFinite(diffAvgValue) ? formatGreek(diffAvgValue) : "-"}</span></div>
        <div class="flex items-center justify-between gap-4"><span style="color:#1d9bf0">Spot</span><span>${Number.isFinite(spotValue) ? spotValue.toFixed(2) : "-"}</span></div>
        <div class="flex items-center justify-between gap-4"><span style="color:#f59e0b">Spot Avg</span><span>${Number.isFinite(spotAvgValue) ? spotAvgValue.toFixed(2) : "-"}</span></div>
      `;
    });

    return () => {
      resizeObserver.disconnect();
      host.removeEventListener("pointerdown", schedulePaneLabelUpdate);
      host.removeEventListener("pointermove", schedulePaneLabelUpdate);
      window.removeEventListener("resize", schedulePaneLabelUpdate);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = {};
    };
  }, [mode]);

  useEffect(() => {
    const chart = chartRef.current;
    const { call, put, diff, diffAvg, spot, spotAvg } = seriesRef.current;
    if (!chart || !call || !put || !diff || !diffAvg || !spot || !spotAvg) return;
    const data = points.map((point) => ({ time: Math.floor(point.ts / 1000) as Time, call: point.callPulse, put: point.putPulse, diff: point.callPulse - point.putPulse }));
    const diffAverages = cumulativeAverage(data, (point) => point.diff);
    call.setData(data.map((point) => ({ time: point.time, value: point.call })));
    put.setData(data.map((point) => ({ time: point.time, value: point.put })));
    diff.setData(data.map((point) => ({ time: point.time, value: point.diff })));
    diffAvg.setData(data.map((point, index) => ({ time: point.time, value: diffAverages[index] })));
    const spotData = spotPoints.map((point) => ({ time: Math.floor(point.ts / 1000) as Time, value: point.value }));
    const spotAverages = cumulativeAverage(spotData, (point) => point.value);
    spot.setData(spotData);
    spotAvg.setData(spotData.map((point, index) => ({ time: point.time, value: spotAverages[index] })));
    chart.timeScale().fitContent();
  }, [points, spotPoints]);

  useEffect(() => {
    chartRef.current?.applyOptions({ height });
  }, [height]);

  const cfg = GREEK_CONFIG[mode];
  const panelLabels = [`CE PE ${cfg.label}`, `${cfg.label} Diff + Sentiment`, "Spot - Avg"];

  return (
    <div className="relative w-full overflow-hidden rounded-md border border-border/60 bg-card" style={{ height }}>
      <div ref={hostRef} className="h-full w-full" />
      {panelLabels.map((label, index) => (
        <div
          key={label}
          ref={(node) => { paneLabelRefs.current[index] = node; }}
          className="pointer-events-none absolute left-2 z-30 hidden rounded border border-border/70 bg-card/90 px-2 py-1 text-[11px] font-semibold text-foreground shadow-sm backdrop-blur"
        >
          {label}
        </div>
      ))}
      <div
        ref={tooltipRef}
        className="pointer-events-none absolute left-0 top-0 z-20 hidden min-w-[166px] rounded-md border border-border bg-card/95 p-2 font-mono text-[11px] text-muted-foreground shadow-lg backdrop-blur"
      />
    </div>
  );
}

interface AllGreeksData {
  vega: PulsePoint[];
  theta: PulsePoint[];
  gamma: PulsePoint[];
  spot: SpotPoint[];
  oi: OiPoint[];
}

const LAYOUT_OPTIONS: { mode: LayoutMode; icon: React.ReactNode; title: string }[] = [
  { mode: "single",    icon: <Square className="h-3.5 w-3.5" />,   title: "Single greek" },
  { mode: "cols3",     icon: <Columns3 className="h-3.5 w-3.5" />, title: "3 columns" },
  { mode: "top2bot1",  icon: <LayoutGrid className="h-3.5 w-3.5" />, title: "2 top + 1 bottom" },
  { mode: "vega1tg2",  icon: <PanelTop className="h-3.5 w-3.5" />,  title: "Vega top · Theta+Gamma below" },
];

function GreekSlot({
  mode, points, spotPoints, height, loading, error, isEmpty,
}: {
  mode: GreekMode;
  points: PulsePoint[];
  spotPoints: SpotPoint[];
  height: number;
  loading: boolean;
  error: string;
  isEmpty: boolean;
}) {
  const cfg = GREEK_CONFIG[mode];
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-1.5 px-1">
        <span className="text-[11px] font-bold" style={{ color: cfg.ceColor }}>{cfg.label}</span>
        <span className="text-[10px] text-muted-foreground">Pulse</span>
      </div>
      {loading ? (
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground rounded-md border border-border/40 bg-card" style={{ height }}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading…
        </div>
      ) : error ? (
        <div className="flex items-center justify-center text-xs text-muted-foreground rounded-md border border-border/40 bg-card" style={{ height }}>
          {error}
        </div>
      ) : points.length > 0 ? (
        <GreekPulseChart key={mode} points={points} spotPoints={spotPoints} height={height} mode={mode} />
      ) : (
        <div className="flex items-center justify-center text-xs text-muted-foreground rounded-md border border-border/40 bg-card" style={{ height }}>
          {isEmpty ? "Select expiry to load." : "No data."}
        </div>
      )}
    </div>
  );
}

// ── OI chart ─────────────────────────────────────────────────────────────────

function OiChart({ points, height }: { points: OiPoint[]; height: number }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{
    callOi?: ISeriesApi<"Line">;
    putOi?: ISeriesApi<"Line">;
    diff?: ISeriesApi<"Baseline">;
  }>({});

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
        priceFormatter: (v: number) => {
          const abs = Math.abs(v);
          const sign = v < 0 ? "-" : "";
          if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)}Cr`;
          if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)}L`;
          if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
          return `${sign}${abs.toFixed(0)}`;
        },
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

    chart.panes()[0]?.setStretchFactor(0.55);
    chart.addPane()?.setStretchFactor(0.45);

    const callOi = chart.addSeries(LineSeries, {
      color: "#22ff66", lineWidth: 2, crosshairMarkerRadius: 3,
      priceLineVisible: false, lastValueVisible: true, title: "Call OI",
    }, 0);
    const putOi = chart.addSeries(LineSeries, {
      color: "#ff554d", lineWidth: 2, crosshairMarkerRadius: 3,
      priceLineVisible: false, lastValueVisible: true, title: "Put OI",
    }, 0);
    const diff = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: 0 },
      // Put > Call → positive → green (put OI dominance)
      topLineColor: "rgba(0,220,130,0.95)", topFillColor1: "rgba(0,180,120,0.45)", topFillColor2: "rgba(0,180,120,0.08)",
      bottomLineColor: "rgba(255,82,82,0.95)", bottomFillColor1: "rgba(255,82,82,0.45)", bottomFillColor2: "rgba(255,82,82,0.08)",
      lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: "OI Diff (Put−Call)",
    }, 1);

    chartRef.current = chart;
    seriesRef.current = { callOi, putOi, diff };

    chart.subscribeCrosshairMove((param) => {
      const tooltip = tooltipRef.current;
      if (!tooltip || !param.point || param.time == null) { if (tooltip) tooltip.style.display = "none"; return; }
      const cv = Number((param.seriesData.get(callOi) as any)?.value);
      const pv = Number((param.seriesData.get(putOi) as any)?.value);
      const dv = Number((param.seriesData.get(diff) as any)?.value);
      const fmt = (n: number) => {
        const abs = Math.abs(n); const s = n < 0 ? "-" : "+";
        if (abs >= 1e7) return `${s}${(abs/1e7).toFixed(2)}Cr`;
        if (abs >= 1e5) return `${s}${(abs/1e5).toFixed(2)}L`;
        return `${s}${(abs/1e3).toFixed(1)}K`;
      };
      const left = param.point.x > host.clientWidth - 190 ? param.point.x - 178 : param.point.x + 12;
      const top = Math.max(8, Math.min(param.point.y + 12, host.clientHeight - 100));
      tooltip.style.display = "block";
      tooltip.style.transform = `translate(${left}px,${top}px)`;
      tooltip.innerHTML = `
        <div class="mb-1 font-semibold text-foreground">${formatChartTime(param.time)}</div>
        <div class="flex justify-between gap-4"><span style="color:#22ff66">Call OI</span><span>${Number.isFinite(cv) ? fmt(cv) : "-"}</span></div>
        <div class="flex justify-between gap-4"><span style="color:#ff554d">Put OI</span><span>${Number.isFinite(pv) ? fmt(pv) : "-"}</span></div>
        <div class="flex justify-between gap-4"><span class="text-primary">OI Diff (PE−CE)</span><span>${Number.isFinite(dv) ? fmt(dv) : "-"}</span></div>
      `;
    });

    return () => { chart.remove(); chartRef.current = null; seriesRef.current = {}; };
  }, []);

  useEffect(() => {
    const { callOi, putOi, diff } = seriesRef.current;
    if (!callOi || !putOi || !diff || points.length === 0) return;
    const toTime = (ts: number) => Math.floor(ts / 1000) as Time;
    callOi.setData(points.map((p) => ({ time: toTime(p.ts), value: p.callOi })));
    putOi.setData(points.map((p) => ({ time: toTime(p.ts), value: p.putOi })));
    // diff = put OI change − call OI change → positive when put dominates → green
    diff.setData(points.map((p) => ({ time: toTime(p.ts), value: (p.putOi - p.openPutOi) - (p.callOi - p.openCallOi) })));
    chartRef.current?.timeScale().fitContent();
  }, [points]);

  useEffect(() => { chartRef.current?.applyOptions({ height }); }, [height]);

  const latestOi = points[points.length - 1];
  const callChg = latestOi ? latestOi.callOi - latestOi.openCallOi : 0;
  const putChg  = latestOi ? latestOi.putOi  - latestOi.openPutOi  : 0;
  const fmtOi = (n: number) => {
    const abs = Math.abs(n); const s = n >= 0 ? "+" : "-";
    if (abs >= 1e7) return `${s}${(abs/1e7).toFixed(2)}Cr`;
    if (abs >= 1e5) return `${s}${(abs/1e5).toFixed(2)}L`;
    return `${s}${(abs/1e3).toFixed(1)}K`;
  };

  return (
    <div className="space-y-1">
      {/* mini stats row */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-md bg-accent/30 p-2">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Call OI (latest)</p>
          <p className="font-mono text-sm font-bold text-[#22ff66]">{latestOi ? fmtOi(latestOi.callOi).replace(/^[+-]/, "") : "-"}</p>
        </div>
        <div className="rounded-md bg-accent/30 p-2">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Put OI (latest)</p>
          <p className="font-mono text-sm font-bold text-[#ff554d]">{latestOi ? fmtOi(latestOi.putOi).replace(/^[+-]/, "") : "-"}</p>
        </div>
        <div className="rounded-md bg-accent/30 p-2">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">OI Δ from Open (PE−CE)</p>
          <p className={`font-mono text-sm font-bold ${(putChg - callChg) >= 0 ? "text-bullish" : "text-bearish"}`}>
            {latestOi ? fmtOi(putChg - callChg) : "-"}
          </p>
        </div>
      </div>
      <div className="relative w-full overflow-hidden rounded-md border border-border/60 bg-card" style={{ height }}>
        <div ref={hostRef} className="h-full w-full" />
        <div className="pointer-events-none absolute left-2 top-2 z-10 text-[10px] font-semibold text-muted-foreground">Call / Put OI</div>
        <div
          ref={tooltipRef}
          className="pointer-events-none absolute left-0 top-0 z-20 hidden min-w-[160px] rounded-md border border-border bg-card/95 p-2 font-mono text-[11px] text-muted-foreground shadow-lg backdrop-blur"
        />
      </div>
    </div>
  );
}

const BRIDGE_URL = "ws://localhost:8765";
const GREEKS_ALL: GreekMode[] = ["vega", "theta", "gamma"];

function getNubraSessionToken(): string {
  return localStorage.getItem("nubra_session_token") || "";
}

// Sums a greek field across CE/PE basket strikes from one WS option message
function sumWsGreeks(
  ceItems: any[],
  peItems: any[],
  basketStrikes: Set<number>,
  field: GreekMode,
): { callVal: number; putVal: number } {
  let callVal = 0;
  let putVal = 0;
  for (const item of ceItems) {
    const sp = Number(item?.strike_price ?? 0);
    if (!basketStrikes.has(sp)) continue;
    const v = Number(item?.[field]);
    if (Number.isFinite(v)) callVal += v;
  }
  for (const item of peItems) {
    const sp = Number(item?.strike_price ?? 0);
    if (!basketStrikes.has(sp)) continue;
    const v = Number(item?.[field]);
    if (Number.isFinite(v)) putVal += v;
  }
  return { callVal, putVal };
}

function appendWsPoint(prev: PulsePoint[], ts: number, callVal: number, putVal: number): PulsePoint[] {
  const opening = prev[0] ?? { callVal, putVal };
  const totalVal = callVal + putVal;
  const openingTotal = opening.callVal + opening.putVal;
  const next: PulsePoint = {
    ts,
    callVal,
    putVal,
    totalVal,
    callPulse: callVal - opening.callVal,
    putPulse: putVal - opening.putVal,
    totalPulse: totalVal - openingTotal,
  };
  // Replace last point if same minute, else append
  const last = prev[prev.length - 1];
  if (last && Math.floor(last.ts / 60000) === Math.floor(ts / 60000)) {
    return [...prev.slice(0, -1), next];
  }
  return [...prev, next];
}

function sumWsOi(ceItems: any[], peItems: any[], basketStrikes: Set<number>): { callOi: number; putOi: number } {
  let callOi = 0, putOi = 0;
  for (const item of ceItems) {
    const sp = Number(item?.strike_price ?? 0);
    if (!basketStrikes.has(sp)) continue;
    const v = Number(item?.open_interest ?? item?.oi ?? 0);
    if (Number.isFinite(v)) callOi += v;
  }
  for (const item of peItems) {
    const sp = Number(item?.strike_price ?? 0);
    if (!basketStrikes.has(sp)) continue;
    const v = Number(item?.open_interest ?? item?.oi ?? 0);
    if (Number.isFinite(v)) putOi += v;
  }
  return { callOi, putOi };
}

function appendWsOiPoint(prev: OiPoint[], ts: number, callOi: number, putOi: number): OiPoint[] {
  if (callOi === 0 && putOi === 0) return prev;
  const opening = prev[0] ?? { callOi, putOi };
  const next: OiPoint = { ts, callOi, putOi, openCallOi: opening.callOi, openPutOi: opening.putOi };
  const last = prev[prev.length - 1];
  if (last && Math.floor(last.ts / 60000) === Math.floor(ts / 60000)) return [...prev.slice(0, -1), next];
  return [...prev, next];
}

function VegaPulseComponent({ symbol = "NIFTY", height = 640, compact = false }: VegaPulseProps) {
  const [expiryIndex, setExpiryIndex] = useState(0);
  const [greekMode, setGreekMode] = useState<GreekMode>("vega");
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("single");
  const [allData, setAllData] = useState<AllGreeksData>({ vega: [], theta: [], gamma: [], spot: [], oi: [] });
  const [loadedGreeks, setLoadedGreeks] = useState<Set<GreekMode>>(new Set());
  const [loadingGreeks, setLoadingGreeks] = useState<Set<GreekMode>>(new Set());
  const [errors, setErrors] = useState<Partial<Record<GreekMode, string>>>({});
  const [date, setDate] = useState("");
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const wsReconnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: indicesResult } = useLiveIndices();
  const { data: expiryData, isLoading: expiriesLoading } = useExpiryList(symbol);
  const expiries = expiryData?.expiries || [];
  const selectedExpiry = expiries[expiryIndex]?.value;
  const { data: chainData, isLoading: chainLoading } = useLiveOptionChain(symbol, selectedExpiry);
  const liveSpot = indicesResult?.data?.find((item: any) => normalizeSymbol(item.symbol) === normalizeSymbol(symbol))?.ltp || 0;
  const spotPrice = useMemo(() => {
    return resolveSpotPrice(chainData?.chain || [], chainData?.spotPrice || 0, liveSpot, getSpotPrice(symbol));
  }, [chainData?.chain, chainData?.spotPrice, liveSpot, symbol]);

  const basket = useMemo(() => {
    return chooseVegaLegs(chainData?.chain || [], spotPrice, symbol, selectedExpiry || "");
  }, [chainData?.chain, spotPrice, symbol, selectedExpiry]);

  const allLegs = useMemo(() => [...basket.callLegs, ...basket.putLegs], [basket.callLegs, basket.putLegs]);

  // Pre-compute the set of basket strike prices for fast WS lookup
  const basketStrikes = useMemo(() => new Set(allLegs.map((l) => l.strike)), [allLegs]);

  const openingCallGreek = (mode: GreekMode) => {
    if (mode === "vega") return basket.callLegs.reduce((sum, leg) => sum + leg.openingVega, 0);
    if (mode === "theta") return basket.callLegs.reduce((sum, leg) => sum + leg.openingTheta, 0);
    return basket.callLegs.reduce((sum, leg) => sum + leg.openingGamma, 0);
  };
  const openingPutGreek = (mode: GreekMode) => {
    if (mode === "vega") return basket.putLegs.reduce((sum, leg) => sum + leg.openingVega, 0);
    if (mode === "theta") return basket.putLegs.reduce((sum, leg) => sum + leg.openingTheta, 0);
    return basket.putLegs.reduce((sum, leg) => sum + leg.openingGamma, 0);
  };

  const isGridLayout = layoutMode !== "single";

  // ── REST: initial historical load ────────────────────────────────────────

  const doFetchGreek = async (mode: GreekMode, expiry: string, legs: SelectedLeg[]) => {
    if (!expiry || legs.length === 0) return;
    setLoadingGreeks((prev) => new Set([...prev, mode]));
    setErrors((prev) => ({ ...prev, [mode]: "" }));
    try {
      const tradingDate = lastTradingDay();
      const fallbackDate = previousTradingDay(tradingDate);
      const field = GREEK_CONFIG[mode].field;
      let pts = await fetchPulseForDate(symbol, expiry, legs, tradingDate, field);
      if (pts.length === 0) pts = await fetchPulseForDate(symbol, expiry, legs, fallbackDate, field);
      setAllData((prev) => ({ ...prev, [mode]: pts }));
      setLoadedGreeks((prev) => new Set([...prev, mode]));
      if (pts.length === 0) setErrors((prev) => ({ ...prev, [mode]: `No ${GREEK_CONFIG[mode].label} data for this basket.` }));
    } catch (err) {
      setErrors((prev) => ({ ...prev, [mode]: err instanceof Error ? err.message : "Load failed" }));
    } finally {
      setLoadingGreeks((prev) => { const n = new Set(prev); n.delete(mode); return n; });
    }
  };

  const doFetchSpot = async (): Promise<SpotPoint[]> => {
    const tradingDate = lastTradingDay();
    const fallbackDate = previousTradingDay(tradingDate);
    let spotPts = await fetchSpotForDate(symbol, tradingDate).catch(() => [] as SpotPoint[]);
    if (spotPts.length === 0) spotPts = await fetchSpotForDate(symbol, fallbackDate).catch(() => [] as SpotPoint[]);
    setAllData((prev) => ({ ...prev, spot: spotPts }));
    setDate(tradingDate);
    return spotPts;
  };

  const doFetchOi = async (expiry: string, legs: SelectedLeg[]) => {
    if (!expiry || legs.length === 0) return;
    try {
      const tradingDate = lastTradingDay();
      const fallbackDate = previousTradingDay(tradingDate);
      const exchange = BSE_SYMBOLS.has(normalizeSymbol(symbol)) ? "BSE" : "NSE";
      let resolvedLegs = legs;
      try {
        const instruments = await fetchNubraInstruments();
        resolvedLegs = resolveLegSymbolsFromRefdata(legs, instruments?.refdata || [], symbol, expiry);
      } catch { /* use original legs */ }

      const fetchOiRows = async (date: string) => {
        const rows = await fetchGreekRowsWithFields({ exchange, legs: resolvedLegs, tradingDate: date, fieldName: "cumulative_oi" });
        return rows;
      };

      let rows = await fetchOiRows(tradingDate);
      if (rows.length === 0) rows = await fetchOiRows(fallbackDate);
      if (rows.length === 0) return;

      const sorted = rows.filter((r) => r.callVal !== 0 || r.putVal !== 0).sort((a, b) => a.ts - b.ts);
      const openCallOi = sorted[0]?.callVal ?? 0;
      const openPutOi  = sorted[0]?.putVal  ?? 0;
      const oiPts: OiPoint[] = sorted.map((r) => ({
        ts: r.ts, callOi: r.callVal, putOi: r.putVal, openCallOi, openPutOi,
      }));
      setAllData((prev) => ({ ...prev, oi: oiPts }));
    } catch { /* silent */ }
  };

  const doInitialLoad = async (expiry: string, legs: SelectedLeg[], grid: boolean, singleMode: GreekMode) => {
    if (!expiry || legs.length === 0) return;
    await doFetchSpot();
    await doFetchOi(expiry, legs);
    if (grid) {
      await Promise.all(GREEKS_ALL.map((m) => doFetchGreek(m, expiry, legs)));
    } else {
      await doFetchGreek(singleMode, expiry, legs);
    }
  };

  // ── WebSocket: live updates from Nubra bridge ────────────────────────────

  const connectWs = (expiry: string, strikes: Set<number>) => {
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onmessage = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    if (wsReconnTimer.current) { clearTimeout(wsReconnTimer.current); wsReconnTimer.current = null; }

    const sessionToken = getNubraSessionToken();
    if (!sessionToken || !expiry || strikes.size === 0) return;

    const exchange = BSE_SYMBOLS.has(normalizeSymbol(symbol)) ? "BSE" : "NSE";
    const ws = new WebSocket(BRIDGE_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      ws.send(JSON.stringify({
        action: "subscribe",
        session_token: sessionToken,
        data_type: "option",
        symbols: [`${normalizeSymbol(symbol)}:${expiry}`],
        exchange,
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type !== "option") return;
        const { ce = [], pe = [], current_price } = msg.data as { ce: any[]; pe: any[]; current_price?: number };
        const ts = Date.now();

        // Append live spot point
        if (Number.isFinite(current_price) && (current_price ?? 0) > 0) {
          setAllData((prev) => {
            const last = prev.spot[prev.spot.length - 1];
            if (last && Math.floor(last.ts / 60000) === Math.floor(ts / 60000)) {
              return { ...prev, spot: [...prev.spot.slice(0, -1), { ts, value: current_price! }] };
            }
            return { ...prev, spot: [...prev.spot, { ts, value: current_price! }] };
          });
        }

        // Append live greek + OI points
        setAllData((prev) => {
          const next = { ...prev };
          for (const m of GREEKS_ALL) {
            const { callVal, putVal } = sumWsGreeks(ce, pe, strikes, m);
            if (callVal !== 0 || putVal !== 0) next[m] = appendWsPoint(prev[m], ts, callVal, putVal);
          }
          const { callOi, putOi } = sumWsOi(ce, pe, strikes);
          next.oi = appendWsOiPoint(prev.oi, ts, callOi, putOi);
          return next;
        });
      } catch { /* ignore parse errors */ }
    };

    ws.onclose = () => {
      setWsConnected(false);
      wsRef.current = null;
      // Reconnect after 3s
      wsReconnTimer.current = setTimeout(() => connectWs(expiry, strikes), 3000);
    };

    ws.onerror = () => { ws.close(); };
  };

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleGreekSwitch = (mode: GreekMode) => {
    setGreekMode(mode);
    if (!loadedGreeks.has(mode) && allData[mode].length === 0) {
      void doFetchGreek(mode, selectedExpiry!, allLegs);
    }
  };

  const handleLayoutSwitch = (mode: LayoutMode) => {
    setLayoutMode(mode);
    if (mode !== "single") {
      GREEKS_ALL.forEach((m) => {
        if (!loadedGreeks.has(m) && allData[m].length === 0) void doFetchGreek(m, selectedExpiry!, allLegs);
      });
    }
  };

  const handleRefresh = () => {
    // Only reset REST data — WS keeps running and will append fresh ticks on top
    setLoadedGreeks(new Set());
    setAllData({ vega: [], theta: [], gamma: [], spot: [], oi: [] });
    setErrors({});
    void doInitialLoad(selectedExpiry || "", allLegs, isGridLayout, greekMode);
  };

  // ── Mount / expiry / basket change: REST load + WS connect ───────────────

  useEffect(() => {
    setAllData({ vega: [], theta: [], gamma: [], spot: [], oi: [] });
    setLoadedGreeks(new Set());
    setErrors({});
    if (!selectedExpiry || allLegs.length === 0) return;

    void doInitialLoad(selectedExpiry, allLegs, isGridLayout, greekMode);
    connectWs(selectedExpiry, basketStrikes);

    return () => {
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }
      if (wsReconnTimer.current) { clearTimeout(wsReconnTimer.current); wsReconnTimer.current = null; }
      setWsConnected(false);
    };
  }, [symbol, selectedExpiry, allLegs.map((leg) => `${leg.side}${leg.strike}`).join("|")]);

  const anyLoading = expiriesLoading || chainLoading || loadingGreeks.size > 0;
  const chartHeight = compact ? 220 : height;
  // In grid modes give each chart a reduced height so all fit on screen
  const gridChartH = compact ? 180 : Math.round(chartHeight * 0.62);
  const cfg = GREEK_CONFIG[greekMode];
  const activePoints = allData[greekMode];
  const latest = activePoints[activePoints.length - 1];
  const isEmpty = !selectedExpiry || allLegs.length === 0;

  return (
    <Card className="min-h-[calc(100vh-6rem)]">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-primary" />
            Greek Pulse
            <Badge variant="outline" className="h-4 border-primary/30 text-xs text-primary">{symbol}</Badge>
            {date && <Badge variant="outline" className="h-4 text-xs text-muted-foreground">{date}</Badge>}
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors ${
              wsConnected
                ? "border-green-500/40 bg-green-500/10 text-green-400"
                : "border-muted/40 bg-muted/10 text-muted-foreground"
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${wsConnected ? "bg-green-400 animate-pulse" : "bg-muted-foreground"}`} />
              {wsConnected ? "LIVE" : "WS OFF"}
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            {/* Layout toggle */}
            <div className="flex items-center rounded-md border border-border overflow-hidden">
              {LAYOUT_OPTIONS.map(({ mode, icon, title }) => (
                <button
                  key={mode}
                  type="button"
                  title={title}
                  onClick={() => handleLayoutSwitch(mode)}
                  className={`h-7 w-7 flex items-center justify-center transition-colors ${
                    layoutMode === mode
                      ? "bg-primary/20 text-primary"
                      : "bg-background/70 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {icon}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={handleRefresh} disabled={anyLoading || isEmpty}>
              <RefreshCw className={`h-3.5 w-3.5 ${anyLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 pb-4">
        {/* Toolbar row */}
        <div className="flex flex-wrap items-center gap-2">
          {expiries.slice(0, 3).map((expiry, index) => (
            <button
              key={expiry.value}
              type="button"
              onClick={() => setExpiryIndex(index)}
              className={`h-7 rounded-md border px-2 text-[11px] font-semibold transition-colors ${
                expiryIndex === index
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-background/70 text-muted-foreground hover:text-foreground"
              }`}
            >
              {expiry.label || expiry.value}
            </button>
          ))}

          {/* Greek selector — only relevant in single mode */}
          {layoutMode === "single" && (
            <div className="flex items-center rounded-md border border-border overflow-hidden">
              {(["vega", "theta", "gamma"] as GreekMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => handleGreekSwitch(mode)}
                  className={`h-7 px-3 text-[11px] font-semibold transition-colors ${
                    greekMode === mode ? "bg-primary/20" : "bg-background/70 text-muted-foreground hover:text-foreground"
                  }`}
                  style={greekMode === mode ? { color: GREEK_CONFIG[mode].ceColor } : {}}
                >
                  {GREEK_CONFIG[mode].label}
                  {!loadedGreeks.has(mode) && mode !== greekMode && (
                    <span className="ml-1 opacity-40 text-[9px]">○</span>
                  )}
                </button>
              ))}
            </div>
          )}

          <span className="text-xs text-muted-foreground">
            Spot {spotPrice ? spotPrice.toLocaleString("en-IN") : "-"} · ATM {basket.atmStrike || "-"} · CE {basket.callLegs.length} · PE {basket.putLegs.length}
          </span>
        </div>

        {/* Stats bar — single mode: 3 cards for active greek; grid mode: inline per-greek summary */}
        {layoutMode === "single" ? (
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md bg-accent/30 p-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Opening CE {cfg.label}</p>
              <p className="font-mono text-sm font-bold" style={{ color: cfg.ceColor }}>{formatGreek(openingCallGreek(greekMode))}</p>
            </div>
            <div className="rounded-md bg-accent/30 p-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Opening PE {cfg.label}</p>
              <p className="font-mono text-sm font-bold" style={{ color: cfg.peColor }}>{formatGreek(openingPutGreek(greekMode))}</p>
            </div>
            <div className="rounded-md bg-accent/30 p-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Latest Diff (CE−PE)</p>
              <p className={`font-mono text-sm font-bold ${((latest?.callPulse ?? 0) - (latest?.putPulse ?? 0)) >= 0 ? "text-bullish" : "text-bearish"}`}>
                {latest ? formatGreek(latest.callPulse - latest.putPulse) : "-"}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {(["vega", "theta", "gamma"] as GreekMode[]).map((m) => {
              const mcfg = GREEK_CONFIG[m];
              const mLatest = allData[m][allData[m].length - 1];
              return (
                <div key={m} className="rounded-md bg-accent/30 p-2 space-y-0.5">
                  <p className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: mcfg.ceColor }}>{mcfg.label}</p>
                  <div className="flex gap-3 font-mono text-xs">
                    <span style={{ color: mcfg.ceColor }}>CE {formatGreek(openingCallGreek(m))}</span>
                    <span style={{ color: mcfg.peColor }}>PE {formatGreek(openingPutGreek(m))}</span>
                    <span className={mLatest ? (((mLatest.callPulse - mLatest.putPulse) >= 0) ? "text-bullish" : "text-bearish") : "text-muted-foreground"}>
                      Δ {mLatest ? formatGreek(mLatest.callPulse - mLatest.putPulse) : "-"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Chart area */}
        {layoutMode === "single" && (
          expiriesLoading || chainLoading || loadingGreeks.has(greekMode) ? (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground" style={{ height: chartHeight }}>
              <Loader2 className="h-4 w-4 animate-spin" />Loading {cfg.label} Pulse…
            </div>
          ) : errors[greekMode] ? (
            <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height: chartHeight }}>{errors[greekMode]}</div>
          ) : activePoints.length > 0 ? (
            <GreekPulseChart key={greekMode} points={activePoints} spotPoints={allData.spot} height={chartHeight} mode={greekMode} />
          ) : (
            <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height: chartHeight }}>
              Select an expiry with live greeks to build {cfg.label} Pulse.
            </div>
          )
        )}

        {layoutMode === "cols3" && (
          <div className="grid grid-cols-3 gap-2">
            {(["vega", "theta", "gamma"] as GreekMode[]).map((m) => (
              <GreekSlot
                key={m}
                mode={m}
                points={allData[m]}
                spotPoints={allData.spot}
                height={gridChartH}
                loading={expiriesLoading || chainLoading || loadingGreeks.has(m)}
                error={errors[m] || ""}
                isEmpty={isEmpty}
              />
            ))}
          </div>
        )}

        {layoutMode === "top2bot1" && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              {(["vega", "theta"] as GreekMode[]).map((m) => (
                <GreekSlot
                  key={m}
                  mode={m}
                  points={allData[m]}
                  spotPoints={allData.spot}
                  height={gridChartH}
                  loading={expiriesLoading || chainLoading || loadingGreeks.has(m)}
                  error={errors[m] || ""}
                  isEmpty={isEmpty}
                />
              ))}
            </div>
            <GreekSlot
              mode="gamma"
              points={allData.gamma}
              spotPoints={allData.spot}
              height={gridChartH}
              loading={expiriesLoading || chainLoading || loadingGreeks.has("gamma")}
              error={errors.gamma || ""}
              isEmpty={isEmpty}
            />
          </div>
        )}

        {layoutMode === "vega1tg2" && (
          <div className="space-y-2">
            {/* Vega — full width on top */}
            <GreekSlot
              mode="vega"
              points={allData.vega}
              spotPoints={allData.spot}
              height={gridChartH}
              loading={expiriesLoading || chainLoading || loadingGreeks.has("vega")}
              error={errors.vega || ""}
              isEmpty={isEmpty}
            />
            {/* Theta + Gamma — side by side below */}
            <div className="grid grid-cols-2 gap-2">
              {(["theta", "gamma"] as GreekMode[]).map((m) => (
                <GreekSlot
                  key={m}
                  mode={m}
                  points={allData[m]}
                  spotPoints={allData.spot}
                  height={gridChartH}
                  loading={expiriesLoading || chainLoading || loadingGreeks.has(m)}
                  error={errors[m] || ""}
                  isEmpty={isEmpty}
                />
              ))}
            </div>
          </div>
        )}

        {/* OI chart — always shown below all greek layouts */}
        <div className="space-y-1">
          <div className="flex items-center gap-2 px-1 pt-1">
            <span className="text-[11px] font-bold text-primary">Basket OI</span>
            <span className="text-[10px] text-muted-foreground">Call · Put · Δ from Open</span>
          </div>
          {isEmpty ? (
            <div className="flex items-center justify-center rounded-md border border-border/40 bg-card text-xs text-muted-foreground" style={{ height: gridChartH }}>
              Select expiry to load OI.
            </div>
          ) : allData.oi.length > 0 ? (
            <OiChart points={allData.oi} height={gridChartH} />
          ) : (
            <div className="flex items-center justify-center gap-2 rounded-md border border-border/40 bg-card text-xs text-muted-foreground" style={{ height: gridChartH }}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />Loading OI…
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export const VegaPulse = memo(VegaPulseComponent);
