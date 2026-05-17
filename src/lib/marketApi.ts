import type { OptionData, ExpiryDate, IndexData } from "./mockData";
import { getActiveBroker, getBrokerCredentials, saveBrokerCredentials, syncBrokerRuntimeKeys } from "./brokerConfig";

// Local proxy base URL — override via VITE_PROXY_URL if deploying proxy elsewhere
const PROXY_BASE = import.meta.env.VITE_PROXY_URL || "http://localhost:4002";

// Direct fetch to local proxy with optional user credentials
async function fetchDhanProxy(endpoint: string, params?: Record<string, string>): Promise<any> {
  const qp = new URLSearchParams({ endpoint, ...params });
  const url = `${PROXY_BASE}/api/dhan-proxy?${qp.toString()}`;

  // Inject user's Dhan credentials if available
  const headers: Record<string, string> = {};
  const activeBroker = getActiveBroker();
  if (activeBroker?.brokerId === "dhan" && activeBroker.values.clientId && activeBroker.values.accessToken) {
    headers["x-dhan-client-id"] = activeBroker.values.clientId;
    headers["x-dhan-access-token"] = activeBroker.values.accessToken;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Dhan proxy error ${res.status}: ${errText}`);
  }
  return res.json();
}

async function fetchUpstoxProxy(endpoint: "option-chain" | "expiry-list", params?: Record<string, string>): Promise<any> {
  const upstoxBroker = getBrokerCredentials("upstox");
  const headers: Record<string, string> = {};
  if (upstoxBroker?.values.accessToken) {
    headers["x-upstox-access-token"] = upstoxBroker.values.accessToken;
  }

  const qp = new URLSearchParams(params);
  const path = endpoint === "option-chain" ? "/api/upstox-option-chain" : "/api/upstox-expiries";
  const res = await fetch(`${PROXY_BASE}${path}?${qp.toString()}`, { headers });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Upstox proxy error ${res.status}: ${errText}`);
  }
  return res.json();
}

// NSE proxy for indices & market status
async function fetchNSEProxy(endpoint: string, symbol?: string): Promise<any> {
  const params = new URLSearchParams({ endpoint });
  if (symbol) params.set("symbol", symbol);
  const url = `${PROXY_BASE}/api/nse-proxy?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`NSE proxy error ${res.status}: ${errText}`);
  }
  return res.json();
}

// ── Parse Dhan Option Chain Response ──

interface DhanOptionChainData {
  data: {
    oc: Record<string, {
      ce?: DhanOptionLeg;
      pe?: DhanOptionLeg;
    }>;
    iv_oc?: Record<string, {
      ce_iv?: number;
      pe_iv?: number;
    }>;
    gk_oc?: Record<string, {
      ce_delta?: number; ce_gamma?: number; ce_theta?: number; ce_vega?: number;
      pe_delta?: number; pe_gamma?: number; pe_theta?: number; pe_vega?: number;
    }>;
    last_price?: number;
    oi_data?: Record<string, {
      ce_oi?: number; pe_oi?: number;
      ce_oi_chg?: number; pe_oi_chg?: number;
    }>;
  };
  status: string;
}

interface DhanOptionLeg {
  ltp?: number;
  last_price?: number;
  close?: number;
  volume?: number;
  oi?: number;
  oi_chg?: number;
  previous_oi?: number;
  iv?: number;
  implied_volatility?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  bid_price?: number;
  ask_price?: number;
  best_bid_price?: number;
  best_ask_price?: number;
  top_bid_price?: number;
  top_ask_price?: number;
  greeks?: {
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?: number;
  };
}

export function parseDhanOptionChain(raw: DhanOptionChainData): {
  chain: OptionData[];
  spotPrice: number;
  totalCEOI: number;
  totalPEOI: number;
} {
  const oc = raw?.data?.oc || {};
  const spotPrice = raw?.data?.last_price || 0;

  let totalCEOI = 0;
  let totalPEOI = 0;

  const chain: OptionData[] = Object.keys(oc)
    .map(strikeStr => {
      const strike = parseFloat(strikeStr);
      const legData = oc[strikeStr];

      const ceOI = legData.ce?.oi || 0;
      const peOI = legData.pe?.oi || 0;
      totalCEOI += ceOI;
      totalPEOI += peOI;

      // Support both Dhan API v1 (flat fields) and v2 (nested greeks object)
      const ceGreeks = legData.ce?.greeks || {};
      const peGreeks = legData.pe?.greeks || {};

      return {
        strikePrice: strike,
        ce: {
          ltp: legData.ce?.last_price || legData.ce?.ltp || 0,
          oi: ceOI,
          previousOi: legData.ce?.previous_oi || ceOI,
          oiChange: legData.ce?.oi_chg || (ceOI - (legData.ce?.previous_oi || ceOI)),
          volume: legData.ce?.volume || 0,
          iv: legData.ce?.implied_volatility || legData.ce?.iv || 0,
          delta: ceGreeks.delta || legData.ce?.delta || 0,
          gamma: ceGreeks.gamma || legData.ce?.gamma || 0,
          theta: ceGreeks.theta || legData.ce?.theta || 0,
          vega: ceGreeks.vega || legData.ce?.vega || 0,
          bidPrice: legData.ce?.top_bid_price || legData.ce?.best_bid_price || legData.ce?.bid_price || 0,
          askPrice: legData.ce?.top_ask_price || legData.ce?.best_ask_price || legData.ce?.ask_price || 0,
        },
        pe: {
          ltp: legData.pe?.last_price || legData.pe?.ltp || 0,
          oi: peOI,
          previousOi: legData.pe?.previous_oi || peOI,
          oiChange: legData.pe?.oi_chg || (peOI - (legData.pe?.previous_oi || peOI)),
          volume: legData.pe?.volume || 0,
          iv: legData.pe?.implied_volatility || legData.pe?.iv || 0,
          delta: peGreeks.delta || legData.pe?.delta || 0,
          gamma: peGreeks.gamma || legData.pe?.gamma || 0,
          theta: peGreeks.theta || legData.pe?.theta || 0,
          vega: peGreeks.vega || legData.pe?.vega || 0,
          bidPrice: legData.pe?.top_bid_price || legData.pe?.best_bid_price || legData.pe?.bid_price || 0,
          askPrice: legData.pe?.top_ask_price || legData.pe?.best_ask_price || legData.pe?.ask_price || 0,
        },
      };
    })
    .sort((a, b) => a.strikePrice - b.strikePrice);

  return { chain, spotPrice, totalCEOI, totalPEOI };
}

function pickNumber(...values: any[]): number {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function pickOptionalNumber(...values: any[]): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function parseUpstoxLeg(option: any) {
  const md = option?.market_data || option?.marketData || {};
  const g = option?.option_greeks || option?.optionGreeks || option?.greeks || {};
  const oi = pickNumber(md.oi, md.open_interest, md.openInterest, option?.oi);
  const explicitPreviousOi = pickOptionalNumber(
    md.previous_oi,
    md.previousOi,
    md.prev_oi,
    md.prevOi,
    md.previous_open_interest,
    md.previousOpenInterest,
    option?.previous_oi,
    option?.previousOi,
    option?.prev_oi,
    option?.prevOi,
  );
  const explicitOiChange = pickOptionalNumber(
    md.oi_change,
    md.oiChange,
    md.oi_chg,
    md.change_oi,
    md.changeOi,
    md.changeinOpenInterest,
    option?.oi_change,
    option?.oiChange,
    option?.oi_chg,
    option?.changeinOpenInterest,
  );
  const previousOi = explicitPreviousOi ?? (explicitOiChange !== undefined ? oi - explicitOiChange : undefined);
  return {
    instrumentKey: option?.instrument_key || option?.instrumentKey || "",
    ltp: pickNumber(md.ltp, md.last_price, md.lastPrice, option?.ltp),
    oi,
    previousOi,
    oiChange: explicitOiChange ?? (previousOi !== undefined ? oi - previousOi : 0),
    volume: pickNumber(md.volume, md.vol, option?.volume),
    iv: pickNumber(option?.iv, md.iv, g.iv, option?.implied_volatility),
    delta: pickNumber(g.delta, option?.delta),
    gamma: pickNumber(g.gamma, option?.gamma),
    theta: pickNumber(g.theta, option?.theta),
    vega: pickNumber(g.vega, option?.vega),
    bidPrice: pickNumber(md.bid_price, md.bidPrice, option?.bid_price),
    askPrice: pickNumber(md.ask_price, md.askPrice, option?.ask_price),
  };
}

export function parseUpstoxOptionChain(raw: any): {
  chain: OptionData[];
  spotPrice: number;
  totalCEOI: number;
  totalPEOI: number;
} {
  const rows = Array.isArray(raw?.data)
    ? raw.data
    : Array.isArray(raw?.option_chain)
    ? raw.option_chain
    : Array.isArray(raw?.records)
    ? raw.records
    : [];

  let totalCEOI = 0;
  let totalPEOI = 0;
  const chain = rows
    .map((entry: any) => {
      const ce = parseUpstoxLeg(entry?.call_options || entry?.callOptions || {});
      const pe = parseUpstoxLeg(entry?.put_options || entry?.putOptions || {});
      totalCEOI += ce.oi;
      totalPEOI += pe.oi;
      return {
        strikePrice: pickNumber(entry?.strike_price, entry?.strikePrice),
        ce,
        pe,
      };
    })
    .filter((row: OptionData) => row.strikePrice > 0)
    .sort((a: OptionData, b: OptionData) => a.strikePrice - b.strikePrice);

  return {
    chain,
    spotPrice: pickNumber(raw?.underlying_spot_price, raw?.underlyingSpotPrice, raw?.data?.underlying_spot_price),
    totalCEOI,
    totalPEOI,
  };
}

// ── Parse NSE Indices Response (kept for Dashboard) ──

export function parseNSEIndices(raw: any): IndexData[] {
  const indices = ["NIFTY 50", "NIFTY BANK", "NIFTY FINANCIAL SERVICES", "NIFTY MIDCAP 50"];
  const symbolMap: Record<string, string> = {
    "NIFTY 50": "NIFTY",
    "NIFTY BANK": "BANKNIFTY",
    "NIFTY FINANCIAL SERVICES": "FINNIFTY",
    "NIFTY MIDCAP 50": "MIDCPNIFTY",
  };

  if (!raw?.data) return [];

  return raw.data
    .filter((d: any) => indices.includes(d.index))
    .map((d: any) => ({
      name: d.index,
      symbol: symbolMap[d.index] || d.index,
      ltp: d.last,
      change: d.variation || 0,
      changePercent: d.percentChange || 0,
      high: d.high || d.last,
      low: d.low || d.last,
      open: d.open || d.last,
      prevClose: d.previousClose || d.last,
    }));
}

// NSE parse for backward compat
interface NSEOptionChainResponse {
  records: {
    expiryDates: string[];
    strikePrices: number[];
    data: Array<{
      strikePrice: number;
      expiryDate: string;
      CE?: any;
      PE?: any;
    }>;
  };
  filtered: {
    CE: { totOI: number; totVol: number };
    PE: { totOI: number; totVol: number };
  };
}

export function parseNSEOptionChain(raw: NSEOptionChainResponse, selectedExpiry?: string) {
  // Guard against malformed/empty response
  if (!raw?.records?.expiryDates || !raw?.records?.data) {
    return { chain: [], spotPrice: 0, expiries: [], totalCEOI: 0, totalPEOI: 0 };
  }

  const expiries: ExpiryDate[] = raw.records.expiryDates.map((exp) => {
    const d = new Date(exp);
    const now = new Date();
    const days = Math.max(0, Math.ceil((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    return { label: exp, value: exp, daysToExpiry: days };
  });

  const expiryFilter = selectedExpiry || raw.records.expiryDates[0];
  const filteredData = raw.records.data.filter((d) => d.expiryDate === expiryFilter);

  let spotPrice = 0;
  const chain: OptionData[] = filteredData.map((item) => {
    if (item.CE?.underlyingValue) spotPrice = item.CE.underlyingValue;
    if (item.PE?.underlyingValue) spotPrice = item.PE.underlyingValue;
    const defaultLeg = { ltp: 0, oi: 0, oiChange: 0, volume: 0, iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0, bidPrice: 0, askPrice: 0 };
    return {
      strikePrice: item.strikePrice,
      ce: item.CE ? {
        ltp: item.CE.lastPrice, oi: item.CE.openInterest, oiChange: item.CE.changeinOpenInterest,
        previousOi: item.CE.openInterest - (item.CE.changeinOpenInterest || 0),
        volume: item.CE.totalTradedVolume, iv: item.CE.impliedVolatility,
        delta: 0, gamma: 0, theta: 0, vega: 0,
        bidPrice: item.CE.bidprice, askPrice: item.CE.askPrice,
      } : defaultLeg,
      pe: item.PE ? {
        ltp: item.PE.lastPrice, oi: item.PE.openInterest, oiChange: item.PE.changeinOpenInterest,
        previousOi: item.PE.openInterest - (item.PE.changeinOpenInterest || 0),
        volume: item.PE.totalTradedVolume, iv: item.PE.impliedVolatility,
        delta: 0, gamma: 0, theta: 0, vega: 0,
        bidPrice: item.PE.bidprice, askPrice: item.PE.askPrice,
      } : defaultLeg,
    };
  });

  return { chain, spotPrice, expiries, totalCEOI: raw.filtered?.CE?.totOI || 0, totalPEOI: raw.filtered?.PE?.totOI || 0 };
}

// ── Exported fetch functions ──

// Upstox Option Chain (primary) with NSE fallback
export async function fetchLiveOptionChain(symbol: string, expiry?: string) {
  // Try Upstox first (Trishakti data path)
  try {
    let selectedExpiry = expiry;
    let expiries: ExpiryDate[] = [];

    const expiryRaw = await fetchUpstoxProxy("expiry-list", { symbol: symbol.toUpperCase() });
    if (expiryRaw?.data?.length) {
      expiries = expiryRaw.data.map((dateStr: string) => {
        const d = new Date(`${dateStr}T00:00:00+05:30`);
        const days = Math.max(0, Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
        return {
          label: d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
          value: dateStr,
          daysToExpiry: days,
        };
      });
      selectedExpiry ||= expiryRaw.data[0];
    }

    if (selectedExpiry) {
      const raw = await fetchUpstoxProxy("option-chain", {
        symbol: symbol.toUpperCase(),
        expiry: selectedExpiry,
      });
      const parsed = parseUpstoxOptionChain(raw);
      if (parsed.chain.length) {
        return {
          ...parsed,
          expiries,
          source: "upstox" as const,
          afterHours: false,
          cachedAt: null,
        };
      }
    }
  } catch (e) {
    console.warn("Upstox option chain fetch failed, trying NSE:", e);
  }

  // Legacy Dhan fallback, useful if the user still has old keys configured
  try {
    const params: Record<string, string> = { symbol: symbol.toUpperCase() };
    if (expiry) params.expiry = expiry;
    const raw = await fetchDhanProxy("option-chain", params);
    if (raw?.status === "success" && raw?.data?.oc) {
      const parsed = parseDhanOptionChain(raw);
      // Also fetch expiry list
      let expiries: ExpiryDate[] = [];
      try {
        const expiryRaw = await fetchDhanProxy("expiry-list", { symbol: symbol.toUpperCase() });
        if (expiryRaw?.data) {
          expiries = expiryRaw.data.map((dateStr: string) => {
            const d = new Date(dateStr);
            const days = Math.max(0, Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
            return {
              label: d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
              value: dateStr,
              daysToExpiry: days,
            };
          });
        }
      } catch {
        // Expiry fetch failed, continue with chain data
      }
      return {
        ...parsed, expiries, source: "dhan" as const,
        afterHours: raw.afterHours || false,
        cachedAt: raw.cachedAt || null,
      };
    }
  } catch (e) {
    console.warn("Dhan option chain fetch failed, trying NSE:", e);
  }

  // Fallback to NSE
  try {
    const raw = await fetchNSEProxy("option-chain", symbol);
    const parsed = parseNSEOptionChain(raw, expiry);
    return { ...parsed, source: "nse" as const, afterHours: false, cachedAt: null };
  } catch (e) {
    console.warn("NSE option chain also failed:", e);
    throw e;
  }
}

// Upstox expiry list
export async function fetchExpiryList(symbol: string): Promise<ExpiryDate[]> {
  try {
    const raw = await fetchUpstoxProxy("expiry-list", { symbol: symbol.toUpperCase() });
    if (raw?.data) {
      return raw.data.map((dateStr: string) => {
        const d = new Date(`${dateStr}T00:00:00+05:30`);
        const days = Math.max(0, Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
        return {
          label: d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
          value: dateStr,
          daysToExpiry: days,
        };
      });
    }
  } catch (e) {
    console.warn("Upstox expiry list fetch failed:", e);
  }

  try {
    const raw = await fetchDhanProxy("expiry-list", { symbol: symbol.toUpperCase() });
    if (raw?.data) {
      return raw.data.map((dateStr: string) => {
        const d = new Date(dateStr);
        const days = Math.max(0, Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
        return {
          label: d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
          value: dateStr,
          daysToExpiry: days,
        };
      });
    }
  } catch (e) {
    console.warn("Dhan expiry list fetch failed:", e);
  }
  return [];
}

// NSE Indices (Dhan doesn't provide broad index overview the same way)
export async function fetchLiveIndices() {
  const raw = await fetchNSEProxy("indices");
  return parseNSEIndices(raw);
}

export async function fetchMarketStatus() {
  return fetchNSEProxy("market-status");
}

export async function fetchFnOStocks() {
  return fetchNSEProxy("equity-derivatives");
}

// ── All Indices (for VIX, sector performance) ──

const SECTOR_INDEX_MAP: Record<string, string> = {
  "NIFTY IT": "IT",
  "NIFTY BANK": "Banking",
  "NIFTY AUTO": "Auto",
  "NIFTY PHARMA": "Pharma",
  "NIFTY METAL": "Metal",
  "NIFTY ENERGY": "Energy",
  "NIFTY FMCG": "FMCG",
  "NIFTY REALTY": "Realty",
  "NIFTY MEDIA": "Media",
  "NIFTY PSU BANK": "PSU Bank",
  "NIFTY FIN SERVICE": "Fin Svc",
  "NIFTY INFRA": "Infra",
  "NIFTY HEALTHCARE INDEX": "Health",
  "NIFTY CONSUMER DURABLES": "Consumer",
};

export async function fetchAllIndices() {
  const raw = await fetchNSEProxy("indices");
  if (!raw?.data) return null;

  // Extract VIX
  const vixEntry = raw.data.find((d: any) => d.index === "INDIA VIX");
  const vix = vixEntry ? {
    value: vixEntry.last,
    change: vixEntry.variation || 0,
    changePercent: vixEntry.percentChange || 0,
    high: vixEntry.high || vixEntry.last,
    low: vixEntry.low || vixEntry.last,
  } : null;

  // Extract sector indices
  const sectors = raw.data
    .filter((d: any) => SECTOR_INDEX_MAP[d.index])
    .map((d: any) => ({
      name: SECTOR_INDEX_MAP[d.index],
      fullName: d.index,
      change: d.percentChange || 0,
      ltp: d.last || 0,
      open: d.open || d.last,
      high: d.high || d.last,
      low: d.low || d.last,
    }));

  // Advance/Decline from NIFTY 50
  const nifty50 = raw.data.find((d: any) => d.index === "NIFTY 50");
  const advances = nifty50?.advances || 0;
  const declines = nifty50?.declines || 0;
  const unchanged = nifty50?.unchanged || 0;

  return { vix, sectors, advances, declines, unchanged };
}

// ── F&O Stocks List (Top Movers + Most Active) ──

export interface FnOStockData {
  symbol: string;
  ltp: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  volume: number;
  // OI fields from NSE equity-derivatives endpoint
  totalTradedVolume?: number;
  openInterest?: number;
  oiChange?: number;
  sector?: string;
}

export async function fetchLiveFnOStocks(): Promise<FnOStockData[]> {
  // Try NSE first (has OI data)
  try {
    const raw = await fetchNSEProxy("equity-derivatives");
    if (raw?.data?.length > 0) {
      return raw.data
        .filter((d: any) => d.symbol && d.symbol !== "NIFTY 50" && d.lastPrice)
        .map((d: any) => ({
          symbol: d.symbol,
          ltp: d.lastPrice || 0,
          change: d.change || 0,
          changePercent: d.pChange || 0,
          open: d.open || d.lastPrice,
          high: d.dayHigh || d.lastPrice,
          low: d.dayLow || d.lastPrice,
          previousClose: d.previousClose || d.lastPrice,
          volume: d.totalTradedVolume || 0,
          totalTradedVolume: d.totalTradedVolume || 0,
          openInterest: d.openInterest || 0,
          oiChange: d.changeinOpenInterest || 0,
          sector: d.meta?.industry || "",
        }));
    }
  } catch (e) {
    console.warn("NSE F&O stocks fetch failed, trying TradingView:", e);
  }

  // Fallback to TradingView Scanner (no OI but great LTP/volume data)
  try {
    const tvData = await fetchTradingViewStocks();
    if (tvData.length > 0) return tvData;
  } catch (e) {
    console.warn("TradingView stocks fetch also failed:", e);
  }

  return [];
}

// ── TradingView Scanner API ──

export async function fetchTradingViewStocks(): Promise<FnOStockData[]> {
  const url = `${PROXY_BASE}/api/tv-scan?type=stocks`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TV scan error: ${res.status}`);
  const data = await res.json();
  
  return (data.stocks || []).map((s: any) => ({
    symbol: s.symbol || "",
    ltp: s.ltp || 0,
    change: s.changeAbs || 0,
    changePercent: s.changePercent || 0,
    open: s.open || 0,
    high: s.high || 0,
    low: s.low || 0,
    previousClose: (s.ltp || 0) - (s.changeAbs || 0),
    volume: s.volume || 0,
    totalTradedVolume: s.volume || 0,
    openInterest: 0,
    oiChange: 0,
    sector: s.sector || "",
  }));
}

export async function fetchTradingViewIndices(): Promise<any[]> {
  const url = `${PROXY_BASE}/api/tv-scan?type=indices`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TV indices error: ${res.status}`);
  const data = await res.json();
  return data.stocks || [];
}

// ── FII/DII Activity Data ──

export interface FIIDIIData {
  category: string; // "FII/FPI" or "DII"
  date: string;
  buyValue: number;
  sellValue: number;
  netValue: number;
}

export async function fetchFIIDII(): Promise<FIIDIIData[]> {
  const raw = await fetchNSEProxy("fii-dii");
  if (!raw?.data) return [];
  
  return raw.data.map((d: any) => ({
    category: d.category || "",
    date: d.date || "",
    buyValue: parseFloat(d.buyValue?.replace(/,/g, "")) || 0,
    sellValue: parseFloat(d.sellValue?.replace(/,/g, "")) || 0,
    netValue: parseFloat(d.netValue?.replace(/,/g, "")) || 0,
  }));
}

// ── Test Connection ──

export async function testDhanConnection(): Promise<{ status: string; message: string }> {
  const headers: Record<string, string> = {};
  const activeBroker = getActiveBroker();
  if (activeBroker?.brokerId === "dhan" && activeBroker.values.clientId && activeBroker.values.accessToken) {
    headers["x-dhan-client-id"] = activeBroker.values.clientId;
    headers["x-dhan-access-token"] = activeBroker.values.accessToken;
  }
  const res = await fetch(`${PROXY_BASE}/api/test-connection`, { headers });
  return res.json();
}

export async function fetchProxyHealth(): Promise<any> {
  const res = await fetch(`${PROXY_BASE}/health`);
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}

// ── Upstox Instrument Master (Trishakti-style symbol universe) ──

export interface UpstoxInstrument {
  instrumentKey: string;
  tradingSymbol: string;
  symbol: string;
  name: string;
  exchange: string;
  segment: string;
  instrumentType: string;
  underlyingSymbol?: string;
  lotSize?: number;
  tickSize?: number;
  expiry?: string | number | null;
  strike?: string | number | null;
}

export async function fetchUpstoxInstruments(params: {
  mode?: "all" | "tradable" | "underlyings";
  q?: string;
  limit?: number;
} = {}): Promise<UpstoxInstrument[]> {
  const qp = new URLSearchParams({
    format: "json",
    mode: params.mode || "underlyings",
  });
  if (params.q) qp.set("q", params.q);
  if (params.limit) qp.set("limit", String(params.limit));

  const res = await fetch(`${PROXY_BASE}/api/upstox-instruments?${qp.toString()}`);
  if (!res.ok) throw new Error(`Upstox instruments error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json?.data || [];
}

function getSavedBrokerById(brokerId: string) {
  try {
    const raw = localStorage.getItem("optionsdesk_broker_keys");
    const brokers = raw ? JSON.parse(raw) : [];
    return brokers.find((broker: any) => broker.brokerId === brokerId) || null;
  } catch {
    return null;
  }
}

function getNubraHeaders(): Record<string, string> {
  const nubra = getBrokerCredentials("nubra") || getSavedBrokerById("nubra");
  const values = nubra?.values || {};
  const sessionToken = values.sessionToken || values.session_token || localStorage.getItem("nubra_session_token") || "";
  const authToken = values.authToken || values.auth_token || localStorage.getItem("nubra_auth_token") || "";
  const deviceId = values.deviceId || values.device_id || localStorage.getItem("nubra_device_id") || "";
  const rawCookie = values.rawCookie || values.raw_cookie || localStorage.getItem("nubra_raw_cookie") || "";
  return {
    ...(sessionToken ? { "x-session-token": sessionToken } : {}),
    ...(authToken ? { "x-auth-token": authToken } : {}),
    ...(deviceId ? { "x-device-id": deviceId } : {}),
    ...(rawCookie ? { "x-raw-cookie": rawCookie } : {}),
  };
}

export async function fetchNubraInstruments(): Promise<any> {
  const res = await fetch(`${PROXY_BASE}/api/nubra-instruments`, { headers: getNubraHeaders() });
  if (!res.ok) throw new Error(`Nubra instruments error ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function fetchNubraTimeseries(chart: string, query: any[]): Promise<any> {
  const headers = { ...getNubraHeaders(), "Content-Type": "application/json" };
  const res = await fetch(`${PROXY_BASE}/api/nubra-timeseries`, {
    method: "POST",
    headers,
    body: JSON.stringify({ chart, query }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (isNubraUnauthorized(text) && await refreshNubraSession()) {
      const retry = await fetch(`${PROXY_BASE}/api/nubra-timeseries`, {
        method: "POST",
        headers: { ...getNubraHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ chart, query }),
      });
      if (retry.ok) return retry.json();
      const retryText = await retry.text();
      throw new Error(cleanNubraError(retryText, retry.status));
    }
    throw new Error(cleanNubraError(text, res.status));
  }
  return res.json();
}

function isNubraUnauthorized(text: string): boolean {
  return /401|unauthori[sz]ed|session/i.test(text || "");
}

function cleanNubraError(text: string, status: number): string {
  if (isNubraUnauthorized(text)) {
    return "Nubra session expired. Reconnect Nubra from Broker API Keys, or save mobile/MPIN/TOTP for auto-login.";
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed?.error) return `Nubra timeseries error: ${parsed.error}`;
  } catch { /* ignore */ }
  return `Nubra timeseries error ${status}`;
}

async function refreshNubraSession(): Promise<boolean> {
  const saved = getBrokerCredentials("nubra") || getSavedBrokerById("nubra");
  const values = saved?.values || {};
  const phone = values.phone || localStorage.getItem("nubra_phone") || "";
  const mpin = values.mpin || localStorage.getItem("nubra_mpin") || "";
  const totpSecret = values.totpSecret || values.totp_secret || localStorage.getItem("nubra_totp_secret") || "";
  if (!phone || !mpin || !totpSecret) return false;

  const res = await fetch(`${PROXY_BASE}/api/nubra-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, mpin, totp_secret: totpSecret }),
  });
  if (!res.ok) return false;
  const data = await res.json().catch(() => ({}));
  if (!data?.session_token) return false;

  const nextValues = {
    ...values,
    phone,
    mpin,
    totpSecret,
    sessionToken: data.session_token || "",
    authToken: data.auth_token || "",
    deviceId: data.device_id || "",
    rawCookie: data.raw_cookie || `authToken=${data.auth_token || ""}; sessionToken=${data.session_token || ""}`,
  };
  saveBrokerCredentials({
    brokerId: "nubra",
    values: nextValues,
    addedAt: saved?.addedAt || new Date().toISOString(),
    isActive: saved?.isActive || false,
  });
  syncBrokerRuntimeKeys("nubra", nextValues);
  localStorage.setItem("nubra_login_date", new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }));
  localStorage.setItem("nubra_login_ts", String(Date.now()));
  return true;
}

// ── Instrument Master Download ──

export async function fetchInstrumentMaster(): Promise<{
  instruments: any[];
  count: number;
}> {
  const result = await fetchDhanProxy("instruments");
  return result;
}

// ── Historical Candle Data ──

export interface HistoricalCandleResponse {
  status: string;
  data: {
    timestamp: number[];
    open: number[];
    high: number[];
    low: number[];
    close: number[];
    volume: number[];
    oi?: number[];
  };
  remarks?: string;
}

export async function fetchHistoricalCandles(
  securityId: string,
  exchangeSegment: string = "IDX_I",
  instrument: string = "INDEX",
  interval: string = "5",
  fromDate?: string,
  toDate?: string,
): Promise<HistoricalCandleResponse> {
  const params: Record<string, string> = {
    securityId,
    exchangeSegment,
    instrument,
    interval,
  };
  if (fromDate) params.fromDate = fromDate;
  if (toDate) params.toDate = toDate;

  return fetchDhanProxy("historical", params);
}

// ── Yahoo Finance Chart Data (free, no auth) ──

export async function fetchYahooChart(
  symbol: string,
  interval: string = "D",
  fromDate?: string,
  toDate?: string,
): Promise<HistoricalCandleResponse> {
  const params = new URLSearchParams({ symbol, interval });
  if (fromDate) params.set("fromDate", fromDate);
  if (toDate) params.set("toDate", toDate);

  const url = `${PROXY_BASE}/api/yahoo-chart?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Yahoo chart error ${res.status}: ${errText}`);
  }
  return res.json();
}
