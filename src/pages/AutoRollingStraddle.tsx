import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createChart, ColorType, LineSeries, LineStyle, type IChartApi, type ISeriesApi, type LineData, type Time } from "lightweight-charts";
import { Activity, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useLiveOptionChain, useUpstoxSymbols } from "@/hooks/useMarketData";
import { getBrokerCredentials, syncBrokerRuntimeKeys } from "@/lib/brokerConfig";

type IntervalOpt = { label: string; min: number; upstox: string };
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type LegCandles = { strike: number; ceKey: string; peKey: string; ceIv: number; peIv: number; ce: Candle[]; pe: Candle[] };
type PremiumPoint = LineData & {
  ceTypical: number;
  peTypical: number;
  ceVolume: number;
  peVolume: number;
};
type CandlePage = { candles: Candle[]; prev: number | null };
type SeriesKey = "premium" | "premiumVwap" | "rollingIv" | "spot" | "strike" | "syntheticFut" | "spotAtmSyntheticFut" | "ce" | "pe";
type TooltipItem = { key: SeriesKey; label: string; color: string; value: number };
type ChartTooltip = { x: number; y: number; align: "left" | "right"; timeLabel: string; items: TooltipItem[] };
type LoadedContext = {
  symbol: string;
  expiry?: string;
  spotKey: string;
  spotCandles: Candle[];
  legs: LegCandles[];
  nextFrom: number | null;
  ivData: LineData[];
  pointCount: number;
};

const PROXY_BASE = import.meta.env.VITE_PROXY_URL || "http://localhost:4002";
const IST_OFFSET_SEC = 5.5 * 60 * 60;

const INTERVALS: IntervalOpt[] = [
  { label: "1m", min: 1, upstox: "I1" },
  { label: "5m", min: 5, upstox: "I5" },
  { label: "15m", min: 15, upstox: "I15" },
  { label: "30m", min: 30, upstox: "I30" },
];

const INDEX_KEYS: Record<string, string> = {
  NIFTY: "NSE_INDEX|Nifty 50",
  BANKNIFTY: "NSE_INDEX|Nifty Bank",
  FINNIFTY: "NSE_INDEX|Nifty Fin Service",
  MIDCPNIFTY: "NSE_INDEX|Nifty Midcap Select",
  SENSEX: "BSE_INDEX|SENSEX",
  BANKEX: "BSE_INDEX|BANKEX",
};

const BSE_SYMBOLS = new Set(["SENSEX", "BANKEX"]);

const SERIES_META: Record<SeriesKey, { label: string; color: string }> = {
  premium: { label: "Lowest Straddle Premium", color: "#facc15" },
  premiumVwap: { label: "Premium VWAP", color: "#a3e635" },
  rollingIv: { label: "Rolling IV %", color: "#fb7185" },
  spot: { label: "Spot", color: "#5b74ff" },
  strike: { label: "True ATM Strike", color: "#60a5fa" },
  syntheticFut: { label: "True ATM Synthetic Fut", color: "#22d3ee" },
  spotAtmSyntheticFut: { label: "Spot ATM Synthetic Fut", color: "#f59e0b" },
  ce: { label: "True ATM CE", color: "#34d399" },
  pe: { label: "True ATM PE", color: "#f87171" },
};

const DEFAULT_VISIBLE: Record<SeriesKey, boolean> = {
  premium: true,
  premiumVwap: true,
  rollingIv: true,
  spot: true,
  strike: true,
  syntheticFut: true,
  spotAtmSyntheticFut: true,
  ce: true,
  pe: true,
};

const ATM_STRADDLE_WING = 5;

function timeToUnixSec(time: Time): number | null {
  if (typeof time === "number") return time;
  if (typeof time === "object" && time && "year" in time) {
    return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
  }
  return null;
}

function formatIstTime(time: Time, withDate = false) {
  const sec = timeToUnixSec(time);
  if (sec == null) return "";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: withDate ? "2-digit" : undefined,
    month: withDate ? "short" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(sec * 1000));
}

function formatIstTick(time: Time) {
  const sec = timeToUnixSec(time);
  if (sec == null) return "";
  const d = new Date(sec * 1000);
  const istMinutes = (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % (24 * 60);
  const isOpenTick = istMinutes === 9 * 60 + 15;
  return formatIstTime(time, isOpenTick);
}

function cssHslVar(name: string, alpha?: number) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return `hsl(${value}${alpha == null ? "" : ` / ${alpha}`})`;
}

function normalizeSymbol(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function toNubraChainValue(underlying: string, expiry: string) {
  const d = new Date(`${expiry}T00:00:00+05:30`);
  const yyyy = d.toLocaleString("en-IN", { year: "numeric", timeZone: "Asia/Kolkata" });
  const mm = d.toLocaleString("en-IN", { month: "2-digit", timeZone: "Asia/Kolkata" });
  const dd = d.toLocaleString("en-IN", { day: "2-digit", timeZone: "Asia/Kolkata" });
  return `${normalizeSymbol(underlying)}_${yyyy}${mm}${dd}`;
}

function lastTradingDay() {
  const istMs = Date.now() + IST_OFFSET_SEC * 1000;
  const d = new Date(istMs);
  const istMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && istMin < 9 * 60 + 15) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function previousTradingDay(dateStr: string) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function istDateFromMs(ms: number) {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function buildNubraTimeseriesWindow(tradingDate: string) {
  return {
    startDate: `${tradingDate}T03:45:00.000Z`,
    endDate: `${tradingDate}T10:00:00.000Z`,
    intraDay: false,
    realTime: false,
  };
}

function mapNubraIvPoints(points: { ts: number; v: number }[]): LineData[] {
  const out = points
    .map((point) => {
      const sec = Math.round(Number(point.ts) / 1e9);
      const snapped = Math.floor((sec + IST_OFFSET_SEC) / 60) * 60 - IST_OFFSET_SEC;
      const value = Number(point.v) * 100;
      return Number.isFinite(snapped) && Number.isFinite(value) && value > 0
        ? { time: snapped as Time, value }
        : null;
    })
    .filter((point): point is LineData => point != null)
    .sort((a, b) => Number(a.time) - Number(b.time));

  const seen = new Set<number>();
  return out.filter((point) => {
    const time = Number(point.time);
    if (seen.has(time)) return false;
    seen.add(time);
    return true;
  });
}

async function fetchNubraAtmIvForDate(symbol: string, expiry: string, tradingDate: string): Promise<LineData[]> {
  const savedNubra = getBrokerCredentials("nubra");
  if (savedNubra?.values) syncBrokerRuntimeKeys("nubra", savedNubra.values);
  const sessionToken = localStorage.getItem("nubra_session_token") || "";
  if (!sessionToken) return [];

  const chainValue = toNubraChainValue(symbol, expiry);
  const exchange = BSE_SYMBOLS.has(normalizeSymbol(symbol)) ? "BSE" : "NSE";
  const spotType = BSE_SYMBOLS.has(normalizeSymbol(symbol)) || ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"].includes(normalizeSymbol(symbol))
    ? "INDEX"
    : "STOCK";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-session-token": sessionToken,
    "x-auth-token": localStorage.getItem("nubra_auth_token") || "",
    "x-device-id": localStorage.getItem("nubra_device_id") || "web",
    "x-raw-cookie": localStorage.getItem("nubra_raw_cookie") || "",
  };

  const commonDates = { interval: "1m", ...buildNubraTimeseriesWindow(tradingDate) };
  const res = await fetch(`${PROXY_BASE}/api/nubra-timeseries`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      chart: "ATM_Volatility_vs_Spot",
      query: [
        { exchange, type: "CHAIN", values: [chainValue], fields: ["atm_iv"], ...commonDates },
        { exchange, type: spotType, values: [normalizeSymbol(symbol)], fields: ["value"], ...commonDates },
      ],
    }),
  });
  if (!res.ok) return [];
  const json = await res.json();

  let points: { ts: number; v: number }[] = [];
  for (const entry of json?.result || []) {
    for (const valObj of entry?.values || []) {
      if (valObj?.[chainValue]?.atm_iv?.length) {
        points = valObj[chainValue].atm_iv;
        break;
      }
    }
    if (points.length) break;
  }
  return mapNubraIvPoints(points);
}

async function fetchNubraAtmIv(symbol: string, expiry?: string): Promise<LineData[]> {
  if (!expiry) return [];
  const tradingDate = lastTradingDay();
  const current = await fetchNubraAtmIvForDate(symbol, expiry, tradingDate);
  if (current.length) return current;
  return fetchNubraAtmIvForDate(symbol, expiry, previousTradingDay(tradingDate));
}

function normalizeCandle(row: any): Candle | null {
  if (!Array.isArray(row) || row.length < 5) return null;
  const parsed = typeof row[0] === "number" ? row[0] : Date.parse(row[0]);
  if (!Number.isFinite(parsed)) return null;
  return {
    time: parsed > 10_000_000_000 ? Math.floor(parsed / 1000) : Math.floor(parsed),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5] || 0),
  };
}

function nearestStrike(strikes: number[], spot: number) {
  if (!strikes.length || !spot) return null;
  return strikes.reduce((best, strike) => Math.abs(strike - spot) < Math.abs(best - spot) ? strike : best, strikes[0]);
}

function nearestStrikeIndex(strikes: number[], spot: number) {
  if (!strikes.length || !spot) return -1;
  let bestIndex = 0;
  let bestDistance = Math.abs(strikes[0] - spot);
  for (let i = 1; i < strikes.length; i += 1) {
    const distance = Math.abs(strikes[i] - spot);
    if (distance < bestDistance) {
      bestIndex = i;
      bestDistance = distance;
    }
  }
  return bestIndex;
}

function candleAtOrBefore(candles: Candle[], time: number) {
  let lo = 0;
  let hi = candles.length - 1;
  let best: Candle | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (candles[mid].time <= time) {
      best = candles[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function normalizeIv(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value <= 1 ? value * 100 : value;
}

function averagePositive(values: number[]) {
  const usable = values.map(normalizeIv).filter((value) => value > 0);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : 0;
}

function istSessionKey(time: Time) {
  const sec = timeToUnixSec(time);
  if (sec == null) return "";
  return new Date(sec * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function typicalPrice(candle: Candle) {
  return (candle.high + candle.low + candle.close) / 3;
}

function buildPremiumVwap(series: PremiumPoint[]) {
  let currentSession = "";
  let cePv = 0;
  let ceVolume = 0;
  let ceFallback = 0;
  let pePv = 0;
  let peVolume = 0;
  let peFallback = 0;
  let fallbackCount = 0;

  return series.map((point) => {
    const session = istSessionKey(point.time);
    if (session !== currentSession) {
      currentSession = session;
      cePv = 0;
      ceVolume = 0;
      ceFallback = 0;
      pePv = 0;
      peVolume = 0;
      peFallback = 0;
      fallbackCount = 0;
    }

    fallbackCount += 1;
    ceFallback += point.ceTypical;
    peFallback += point.peTypical;

    if (Number.isFinite(point.ceVolume) && point.ceVolume > 0) {
      cePv += point.ceTypical * point.ceVolume;
      ceVolume += point.ceVolume;
    }
    if (Number.isFinite(point.peVolume) && point.peVolume > 0) {
      pePv += point.peTypical * point.peVolume;
      peVolume += point.peVolume;
    }

    const ceVwap = ceVolume > 0 ? cePv / ceVolume : ceFallback / fallbackCount;
    const peVwap = peVolume > 0 ? pePv / peVolume : peFallback / fallbackCount;

    return {
      time: point.time,
      value: ceVwap + peVwap,
    };
  });
}

function mergeCandles(existing: Candle[], incoming: Candle[]) {
  const byTime = new Map<number, Candle>();
  for (const candle of existing) byTime.set(candle.time, candle);
  for (const candle of incoming) byTime.set(candle.time, candle);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

async function fetchCandlePage(instrumentKey: string, interval: IntervalOpt, from: number): Promise<CandlePage> {
  const params = new URLSearchParams({
    instrumentKey,
    interval: interval.upstox,
    from: String(from),
    limit: "500",
  });
  const res = await fetch(`${PROXY_BASE}/api/upstox-public-candles?${params.toString()}`, {
    signal: AbortSignal.timeout(16000),
  });
  if (!res.ok) throw new Error(`candles ${res.status} for ${instrumentKey}`);
  const json = await res.json();
  const seen = new Set<number>();
  const candles = (json?.data?.candles || json?.candles || [])
    .map(normalizeCandle)
    .filter((c): c is Candle => !!c && Number.isFinite(c.close))
    .sort((a, b) => a.time - b.time)
    .filter((c) => {
      if (seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    });

  return {
    candles,
    prev: json?.data?.meta?.prevTimestamp || null,
  };
}

async function fetchPublicCandles(instrumentKey: string, interval: IntervalOpt): Promise<CandlePage> {
  const first = await fetchCandlePage(instrumentKey, interval, new Date().setHours(23, 59, 59, 999));
  if (first.candles.length || !first.prev) return first;
  return fetchCandlePage(instrumentKey, interval, Number(first.prev));
}

function pickLowestStraddleLeg(strikes: number[], byStrike: Map<number, LegCandles>, spot: number, time: number) {
  const centerIndex = nearestStrikeIndex(strikes, spot);
  if (centerIndex < 0) return null;

  const from = Math.max(0, centerIndex - ATM_STRADDLE_WING);
  const to = Math.min(strikes.length - 1, centerIndex + ATM_STRADDLE_WING);
  let best: { leg: LegCandles; ceBar: Candle; peBar: Candle; premium: number; distance: number } | null = null;

  for (let i = from; i <= to; i += 1) {
    const leg = byStrike.get(strikes[i]);
    if (!leg) continue;
    const ceBar = candleAtOrBefore(leg.ce, time);
    const peBar = candleAtOrBefore(leg.pe, time);
    const ceClose = ceBar?.close || 0;
    const peClose = peBar?.close || 0;
    if (!ceBar || !peBar || ceClose <= 0 || peClose <= 0) continue;

    const premium = ceClose + peClose;
    const distance = Math.abs(leg.strike - spot);
    if (!best || premium < best.premium || (premium === best.premium && distance < best.distance)) {
      best = { leg, ceBar, peBar, premium, distance };
    }
  }

  return best;
}

function buildRollingSeries(spotCandles: Candle[], legs: LegCandles[]) {
  const strikes = legs.map((leg) => leg.strike).sort((a, b) => a - b);
  const byStrike = new Map(legs.map((leg) => [leg.strike, leg]));
  const premium: PremiumPoint[] = [];
  const spot: LineData[] = [];
  const strike: LineData[] = [];
  const syntheticFut: LineData[] = [];
  const spotAtmSyntheticFut: LineData[] = [];
  const rollingIv: LineData[] = [];
  const ce: LineData[] = [];
  const pe: LineData[] = [];

  for (const bar of spotCandles) {
    const spotAtm = nearestStrike(strikes, bar.close);
    if (spotAtm != null) {
      const spotAtmLeg = byStrike.get(spotAtm);
      const spotAtmCeBar = spotAtmLeg ? candleAtOrBefore(spotAtmLeg.ce, bar.time) : null;
      const spotAtmPeBar = spotAtmLeg ? candleAtOrBefore(spotAtmLeg.pe, bar.time) : null;
      const spotAtmCeClose = spotAtmCeBar?.close || 0;
      const spotAtmPeClose = spotAtmPeBar?.close || 0;
      if (spotAtmCeClose > 0 && spotAtmPeClose > 0) {
        spotAtmSyntheticFut.push({
          time: bar.time as Time,
          value: spotAtm + spotAtmCeClose - spotAtmPeClose,
        });
      }
    }

    const selected = pickLowestStraddleLeg(strikes, byStrike, bar.close, bar.time);
    if (!selected) continue;
    const { leg, ceBar, peBar, premium: straddlePremium } = selected;
    const ceClose = ceBar.close;
    const peClose = peBar.close;
    const time = bar.time as Time;
    const atmIv = averagePositive([leg.ceIv, leg.peIv]);
    premium.push({
      time,
      value: straddlePremium,
      ceTypical: typicalPrice(ceBar),
      peTypical: typicalPrice(peBar),
      ceVolume: ceBar.volume || 0,
      peVolume: peBar.volume || 0,
    });
    spot.push({ time, value: bar.close });
    strike.push({ time, value: leg.strike });
    syntheticFut.push({ time, value: leg.strike + ceClose - peClose });
    if (atmIv > 0) rollingIv.push({ time, value: atmIv });
    ce.push({ time, value: ceClose });
    pe.push({ time, value: peClose });
  }

  return { premium, premiumVwap: buildPremiumVwap(premium), rollingIv, spot, strike, syntheticFut, spotAtmSyntheticFut, ce, pe };
}

function sessionStartTimes(series: LineData[]) {
  const starts: Time[] = [];
  let currentSession = "";
  for (const point of series) {
    const session = istSessionKey(point.time);
    if (!session || session === currentSession) continue;
    if (currentSession) starts.push(point.time);
    currentSession = session;
  }
  return starts;
}

function formatSeriesValue(key: SeriesKey, value: number) {
  if (!Number.isFinite(value)) return "-";
  if (key === "rollingIv") return `${value.toFixed(2)}%`;
  if (key === "strike") return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function AutoRollingStraddle() {
  const chartHostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Partial<Record<SeriesKey, ISeriesApi<"Line">>>>({});
  const daySeparatorTimesRef = useRef<Time[]>([]);
  const loadedRef = useRef<LoadedContext | null>(null);
  const loadingPreviousRef = useRef(false);
  const loadedFromRef = useRef<Set<number>>(new Set());
  const visibleRef = useRef(DEFAULT_VISIBLE);
  const [symbol, setSymbol] = useState("NIFTY");
  const [search, setSearch] = useState("");
  const [selectedExpiry, setSelectedExpiry] = useState<string | undefined>();
  const [interval, setInterval] = useState<IntervalOpt>(INTERVALS[1]);
  const [loading, setLoading] = useState(false);
  const [loadingPrevious, setLoadingPrevious] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState({ atm: 0, premium: 0, iv: 0, ivSource: "", changePct: 0, points: 0 });
  const [visible, setVisible] = useState(DEFAULT_VISIBLE);
  const [daySeparatorCoords, setDaySeparatorCoords] = useState<{ x: number; label: string }[]>([]);
  const [tooltip, setTooltip] = useState<ChartTooltip | null>(null);

  const { data: symbols = [] } = useUpstoxSymbols(search, 100);
  const { data: chainData, isLoading: chainLoading } = useLiveOptionChain(symbol, selectedExpiry);
  const expiries = chainData?.expiries || [];
  const chain = chainData?.chain || [];

  useEffect(() => {
    if (!selectedExpiry && expiries[0]?.value) setSelectedExpiry(expiries[0].value);
  }, [expiries, selectedExpiry]);

  useEffect(() => {
    const host = chartHostRef.current;
    if (!host) return;

    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: cssHslVar("--card") },
        textColor: cssHslVar("--muted-foreground"),
        fontFamily: "'JetBrains Mono', 'Inter', system-ui, sans-serif",
        fontSize: 11,
      },
      localization: {
        timeFormatter: (time: Time) => formatIstTime(time, true),
      },
      grid: {
        vertLines: { color: cssHslVar("--chart-grid", 0.78) },
        horzLines: { color: cssHslVar("--chart-grid", 0.78) },
      },
      rightPriceScale: { borderColor: cssHslVar("--border") },
      leftPriceScale: { visible: true, borderColor: cssHslVar("--border") },
      timeScale: {
        borderColor: cssHslVar("--border"),
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time) => formatIstTick(time),
      },
      crosshair: { mode: 1 },
      handleScale: { mouseWheel: true, pinch: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
    });

    chartRef.current = chart;
    chart.subscribeCrosshairMove((param: any) => {
      if (!param?.point || param.time == null) {
        setTooltip(null);
        return;
      }

      const leftScaleWidth = chart.priceScale("left").width();
      const hostWidth = chartHostRef.current?.clientWidth || 0;
      const x = param.point.x + leftScaleWidth;
      const y = param.point.y;
      const items = (Object.keys(SERIES_META) as SeriesKey[])
        .filter((key) => visibleRef.current[key])
        .map((key) => {
          const series = seriesRef.current[key];
          if (!series) return null;
          const data = param.seriesData.get(series);
          const value = Number(data?.value);
          if (!Number.isFinite(value)) return null;
          return {
            key,
            label: SERIES_META[key].label,
            color: SERIES_META[key].color,
            value,
          };
        })
        .filter((item): item is TooltipItem => !!item);

      if (!items.length) {
        setTooltip(null);
        return;
      }

      setTooltip({
        x,
        y,
        align: x > hostWidth - 280 ? "right" : "left",
        timeLabel: formatIstTime(param.time, true),
        items,
      });
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = {};
      daySeparatorTimesRef.current = [];
      setDaySeparatorCoords([]);
      setTooltip(null);
    };
  }, []);

  useEffect(() => {
    visibleRef.current = visible;
    for (const key of Object.keys(visible) as SeriesKey[]) {
      seriesRef.current[key]?.applyOptions({ visible: visible[key] });
    }
  }, [visible]);

  const symbolOptions = useMemo(() => {
    const base = symbols.map((item) => item.tradingSymbol || item.symbol).filter(Boolean);
    return Array.from(new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", ...base])).slice(0, 100);
  }, [symbols]);

  const updateDaySeparators = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const leftScaleWidth = chart.priceScale("left").width();
    const coords = daySeparatorTimesRef.current
      .map((time) => {
        const x = chart.timeScale().timeToCoordinate(time);
        return typeof x === "number" && Number.isFinite(x)
          ? { x: x + leftScaleWidth, label: formatIstTime(time, true).replace(",", "") }
          : null;
      })
      .filter((coord): coord is { x: number; label: string } => !!coord);
    setDaySeparatorCoords(coords);
  }, []);

  const updateSeriesData = useCallback((
    data: ReturnType<typeof buildRollingSeries>,
    rollingIv: LineData[],
    ivSource: string,
    preserveRange = true,
    prependedBars = 0,
  ) => {
    const chart = chartRef.current;
    if (!chart) return;
    const range = preserveRange ? chart.timeScale().getVisibleLogicalRange() : null;
    seriesRef.current.premium?.setData(data.premium);
    seriesRef.current.premiumVwap?.setData(data.premiumVwap);
    seriesRef.current.rollingIv?.setData(rollingIv);
    seriesRef.current.spot?.setData(data.spot);
    seriesRef.current.strike?.setData(data.strike);
    seriesRef.current.syntheticFut?.setData(data.syntheticFut);
    seriesRef.current.spotAtmSyntheticFut?.setData(data.spotAtmSyntheticFut);
    seriesRef.current.ce?.setData(data.ce);
    seriesRef.current.pe?.setData(data.pe);
    daySeparatorTimesRef.current = sessionStartTimes(data.premium);
    if (range) {
      chart.timeScale().setVisibleLogicalRange({
        from: range.from + prependedBars,
        to: range.to + prependedBars,
      });
    }
    requestAnimationFrame(updateDaySeparators);
    window.setTimeout(updateDaySeparators, 80);

    const firstPremium = data.premium[0]?.value || 0;
    const lastPremium = data.premium.at(-1)?.value || 0;
    setSummary({
      atm: data.strike.at(-1)?.value || 0,
      premium: lastPremium,
      iv: rollingIv.at(-1)?.value || 0,
      ivSource,
      changePct: firstPremium ? ((lastPremium - firstPremium) / firstPremium) * 100 : 0,
      points: data.premium.length,
    });
  }, [updateDaySeparators]);

  const loadPreviousDay = useCallback(async () => {
    const context = loadedRef.current;
    if (!context?.nextFrom || loadingPreviousRef.current || loadedFromRef.current.has(context.nextFrom)) return;
    loadingPreviousRef.current = true;
    setLoadingPrevious(true);
    const from = context.nextFrom;
    loadedFromRef.current.add(from);

    try {
      const spotPage = await fetchCandlePage(context.spotKey, interval, from);
      const nextLegs: LegCandles[] = [];
      for (const leg of context.legs) {
        const [cePage, pePage] = await Promise.all([
          fetchCandlePage(leg.ceKey, interval, from).catch(() => ({ candles: [] as Candle[], prev: null })),
          fetchCandlePage(leg.peKey, interval, from).catch(() => ({ candles: [] as Candle[], prev: null })),
        ]);
        nextLegs.push({
          ...leg,
          ce: mergeCandles(leg.ce, cePage.candles),
          pe: mergeCandles(leg.pe, pePage.candles),
        });
      }

      const nextSpot = mergeCandles(context.spotCandles, spotPage.candles);
      const data = buildRollingSeries(nextSpot, nextLegs);
      const previousIv = context.expiry ? await fetchNubraAtmIvForDate(context.symbol, context.expiry, istDateFromMs(from)).catch(() => [] as LineData[]) : [];
      const rollingIv = [...previousIv, ...context.ivData]
        .filter((point, index, arr) => arr.findIndex((item) => Number(item.time) === Number(point.time)) === index)
        .sort((a, b) => Number(a.time) - Number(b.time));

      loadedRef.current = {
        ...context,
        spotCandles: nextSpot,
        legs: nextLegs,
        nextFrom: spotPage.prev && spotPage.prev !== from ? Number(spotPage.prev) : null,
        ivData: rollingIv,
        pointCount: data.premium.length,
      };
      const prependedBars = Math.max(0, data.premium.length - context.pointCount);
      updateSeriesData(data, rollingIv, rollingIv.length ? "Nubra" : "Nubra missing", true, prependedBars);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      loadingPreviousRef.current = false;
      setLoadingPrevious(false);
    }
  }, [interval, updateSeriesData]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const timeScale = chart.timeScale();
    const handler = (range: any) => {
      const context = loadedRef.current;
      updateDaySeparators();
      if (!range || !context?.nextFrom || loadingPreviousRef.current) return;
      const span = Math.max(1, range.to - range.from);
      const pxPerBar = timeScale.width() / span;
      const pxFromLoadedLeft = range.from * pxPerBar;
      if (pxFromLoadedLeft <= 60) void loadPreviousDay();
    };
    timeScale.subscribeVisibleLogicalRangeChange(handler);
    return () => timeScale.unsubscribeVisibleLogicalRangeChange(handler);
  }, [loadPreviousDay, updateDaySeparators]);

  const load = useCallback(async () => {
    const chart = chartRef.current;
    if (!chart) return;
    if (!chain.length) {
      setError("Option chain is not loaded yet.");
      return;
    }

    setLoading(true);
    setError("");
    try {
      for (const series of Object.values(seriesRef.current)) {
        try { chart.removeSeries(series); } catch { /* ignore */ }
      }
      seriesRef.current = {};
      loadedRef.current = null;
      loadedFromRef.current = new Set();

      const spotKey = INDEX_KEYS[symbol] || symbols.find((item) =>
        normalizeSymbol(item.tradingSymbol || item.symbol) === normalizeSymbol(symbol)
      )?.instrumentKey;
      if (!spotKey) throw new Error(`No Upstox spot instrument key found for ${symbol}`);

      const spotPage = await fetchPublicCandles(spotKey, interval);
      const spotCandles = spotPage.candles;
      if (!spotCandles.length) throw new Error(`No spot candles returned for ${symbol}`);

      const sortedChain = [...chain].sort((a, b) => a.strikePrice - b.strikePrice);
      const chainStrikes = sortedChain.map((row) => row.strikePrice);
      const spotValues = spotCandles.map((candle) => candle.close).filter((value) => Number.isFinite(value) && value > 0);
      const minSpot = Math.min(...spotValues);
      const maxSpot = Math.max(...spotValues);
      const fallbackSpot = spotCandles.at(-1)?.close || chainData?.spotPrice || 0;
      const lowerCenter = nearestStrikeIndex(chainStrikes, Number.isFinite(minSpot) ? minSpot : fallbackSpot);
      const upperCenter = nearestStrikeIndex(chainStrikes, Number.isFinite(maxSpot) ? maxSpot : fallbackSpot);
      const fromIndex = Math.max(0, Math.min(lowerCenter, upperCenter) - ATM_STRADDLE_WING);
      const toIndex = Math.min(sortedChain.length - 1, Math.max(lowerCenter, upperCenter) + ATM_STRADDLE_WING);
      const selectedRows = sortedChain
        .slice(fromIndex, toIndex + 1)
        .filter((row) => (row.ce as any).instrumentKey && (row.pe as any).instrumentKey);

      const legs: LegCandles[] = [];
      for (const row of selectedRows) {
        const ceKey = (row.ce as any).instrumentKey;
        const peKey = (row.pe as any).instrumentKey;
        const [ceCandles, peCandles] = await Promise.all([
          fetchPublicCandles(ceKey, interval).then((page) => page.candles).catch(() => []),
          fetchPublicCandles(peKey, interval).then((page) => page.candles).catch(() => []),
        ]);
        if (ceCandles.length && peCandles.length) {
          legs.push({
            strike: row.strikePrice,
            ceKey,
            peKey,
            ceIv: Number((row.ce as any).iv || 0),
            peIv: Number((row.pe as any).iv || 0),
            ce: ceCandles,
            pe: peCandles,
          });
        }
      }

      if (!legs.length) throw new Error("No CE/PE option candles returned for the loaded option chain.");

      const data = buildRollingSeries(spotCandles, legs);
      if (!data.premium.length) throw new Error("Could not align spot candles with CE/PE candles.");
      const nubraIv = await fetchNubraAtmIv(symbol, selectedExpiry).catch(() => [] as LineData[]);
      const ivSource = nubraIv.length ? "Nubra" : "Nubra missing";
      const rollingIv = nubraIv;

      const addLine = (key: SeriesKey, priceScaleId = "right", lineWidth = 2, style = LineStyle.Solid) => {
        const series = chart.addSeries(LineSeries, {
          color: SERIES_META[key].color,
          lineWidth,
          lineStyle: style,
          priceScaleId,
          title: SERIES_META[key].label,
          lastValueVisible: true,
          priceLineVisible: false,
        });
        series.applyOptions({ visible: visible[key] });
        seriesRef.current[key] = series;
        return series;
      };

      addLine("premium", "right", 2).setData(data.premium);
      addLine("premiumVwap", "right", 2, LineStyle.Dashed).setData(data.premiumVwap);
      const ivSeries = addLine("rollingIv", "iv", 2);
      ivSeries.priceScale().applyOptions({ visible: false, scaleMargins: { top: 0.08, bottom: 0.08 } });
      ivSeries.setData(rollingIv);
      addLine("spot", "left", 2).setData(data.spot);
      addLine("strike", "left", 1, LineStyle.Dotted).setData(data.strike);
      addLine("syntheticFut", "left", 2, LineStyle.Dashed).setData(data.syntheticFut);
      addLine("spotAtmSyntheticFut", "left", 2, LineStyle.Dashed).setData(data.spotAtmSyntheticFut);
      addLine("ce", "right", 1).setData(data.ce);
      addLine("pe", "right", 1).setData(data.pe);

      loadedRef.current = {
        symbol,
        expiry: selectedExpiry,
        spotKey,
        spotCandles,
        legs,
        nextFrom: spotPage.prev ? Number(spotPage.prev) : null,
        ivData: nubraIv,
        pointCount: data.premium.length,
      };
      updateSeriesData(data, rollingIv, ivSource, false);
      chart.timeScale().fitContent();
      requestAnimationFrame(updateDaySeparators);
      window.setTimeout(updateDaySeparators, 120);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [chain, chainData?.spotPrice, interval, selectedExpiry, symbol, symbols, updateSeriesData, updateDaySeparators, visible]);

  return (
    <div className="-m-3 flex h-[calc(100vh-78px)] min-h-[720px] flex-col overflow-hidden bg-background text-foreground lg:-m-4">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
        <div className="flex h-10 min-w-[160px] flex-col justify-center rounded-md border border-border bg-muted/30 px-2">
          <span className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">Underlying</span>
          <input
            value={search || symbol}
            onChange={(event) => setSearch(event.target.value.toUpperCase())}
            onFocus={() => setSearch("")}
            list="auto-roll-symbols"
            className="h-5 bg-transparent text-xs font-bold text-foreground outline-none"
          />
          <datalist id="auto-roll-symbols">
            {symbolOptions.map((item) => <option key={item} value={item} />)}
          </datalist>
        </div>

        <Button
          variant="outline"
          className="h-10 rounded-md text-xs font-bold"
          onClick={() => {
            if (search.trim()) {
              setSymbol(search.trim().toUpperCase());
              setSelectedExpiry(undefined);
            }
          }}
        >
          Set
        </Button>

        <div className="flex h-10 min-w-[150px] flex-col justify-center rounded-md border border-border bg-muted/30 px-2">
          <span className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">Expiry</span>
          <select
            value={selectedExpiry || ""}
            onChange={(event) => setSelectedExpiry(event.target.value || undefined)}
            className="h-5 bg-transparent text-xs font-bold text-foreground outline-none"
          >
            {expiries.map((expiry) => (
              <option key={expiry.value} value={expiry.value} className="bg-card text-card-foreground">
                {expiry.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex h-10 min-w-[84px] flex-col justify-center rounded-md border border-border bg-muted/30 px-2">
          <span className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">Timeframe</span>
          <select
            value={interval.label}
            onChange={(event) => setInterval(INTERVALS.find((item) => item.label === event.target.value) || INTERVALS[1])}
            className="h-5 bg-transparent text-xs font-bold text-foreground outline-none"
          >
            {INTERVALS.map((item) => <option key={item.label} value={item.label} className="bg-card text-card-foreground">{item.label}</option>)}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {(Object.keys(SERIES_META) as SeriesKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setVisible((prev) => ({ ...prev, [key]: !prev[key] }))}
              className={`h-7 rounded-md border px-2 text-[10px] font-semibold transition-colors ${visible[key] ? "border-primary/30 bg-primary/10 text-foreground" : "border-border bg-muted/20 text-muted-foreground"}`}
            >
              <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: SERIES_META[key].color }} />
              {SERIES_META[key].label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Badge variant="outline" className="border-border bg-muted/30 text-muted-foreground">
            True ATM {summary.atm ? summary.atm.toFixed(0) : "--"}
          </Badge>
          <Badge variant="outline" className="border-border bg-muted/30 text-muted-foreground">
            Premium {summary.premium ? summary.premium.toFixed(2) : "--"}
          </Badge>
          <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">
            IV {summary.iv ? `${summary.iv.toFixed(2)}%` : "--"} {summary.ivSource ? `(${summary.ivSource})` : ""}
          </Badge>
          <Badge variant="outline" className={summary.changePct >= 0 ? "border-emerald-400/30 text-emerald-300" : "border-red-400/30 text-red-300"}>
            {summary.changePct >= 0 ? "+" : ""}{summary.changePct.toFixed(2)}%
          </Badge>
          <Button
            className="h-9 rounded-md text-xs font-bold"
            onClick={load}
            disabled={loading || chainLoading || !selectedExpiry}
          >
            {loading || chainLoading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
            Load
          </Button>
        </div>
      </div>

      {error && (
        <div className="border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{error}</div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={chartHostRef} className="h-full w-full" />
        <div className="pointer-events-none absolute inset-0 z-20">
          {daySeparatorCoords.map(({ x, label }) => (
            <div
              key={`${label}-${x}`}
              className="absolute top-0 h-full border-l-2 border-dashed border-cyan-300/80 shadow-[0_0_10px_rgba(103,232,249,0.28)]"
              style={{ left: `${x}px` }}
            >
              <span className="absolute left-1 top-2 rounded-sm border border-cyan-300/40 bg-background/90 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-100 shadow-sm">
                {label}
              </span>
            </div>
          ))}
        </div>
        {tooltip && (
          <div
            className="pointer-events-none absolute z-30 min-w-[236px] rounded-md border border-border/80 bg-card/95 px-3 py-2 text-xs shadow-xl backdrop-blur"
            style={{
              left: `${tooltip.x}px`,
              top: `${tooltip.y}px`,
              transform: tooltip.align === "right" ? "translate(-104%, 10px)" : "translate(12px, 10px)",
            }}
          >
            <div className="mb-1.5 border-b border-border/70 pb-1 text-[11px] font-semibold text-muted-foreground">
              {tooltip.timeLabel}
            </div>
            <div className="space-y-1">
              {tooltip.items.map((item) => (
                <div key={item.key} className="grid grid-cols-[10px_1fr_auto] items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: item.color }} />
                  <span className="truncate text-muted-foreground">{item.label}</span>
                  <span className="font-mono font-semibold text-foreground">{formatSeriesValue(item.key, item.value)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {!summary.points && !loading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-md border border-border bg-card/90 px-4 py-3 text-center shadow-lg">
              <Activity className="mx-auto mb-2 h-5 w-5 text-primary" />
              <div className="text-sm font-semibold">Load auto rolling straddle</div>
              <div className="mt-1 text-xs text-muted-foreground">For each candle, checks spot ATM ±5 strikes and rolls to the lowest CE+PE straddle.</div>
            </div>
          </div>
        )}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/45">
            <div className="flex items-center gap-2 rounded-md border border-border bg-card px-4 py-3 text-sm shadow-lg">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              Building rolling ATM straddle...
            </div>
          </div>
        )}
      </div>

      <div className="flex min-h-9 items-center gap-3 border-t border-border bg-card px-3 text-[11px] text-muted-foreground">
        {Object.entries(SERIES_META).map(([key, meta]) => (
          visible[key as SeriesKey] && (
            <span key={key} className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: meta.color }} />
              {meta.label}
            </span>
          )
        ))}
        <span className="ml-auto">
          {loadingPrevious ? "Loading previous session..." : summary.points ? `${summary.points} aligned bars` : "Waiting for load"}
        </span>
      </div>
    </div>
  );
}
