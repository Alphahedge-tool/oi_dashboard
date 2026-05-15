import { useEffect, useMemo, useState } from "react";
import { upstoxWS, type UpstoxTick } from "@/lib/upstoxWebSocket";
import type { IndexData } from "@/lib/mockData";

const UPSTOX_INDEX_KEYS: Record<string, { key: string; name: string }> = {
  NIFTY: { key: "NSE_INDEX|Nifty 50", name: "NIFTY 50" },
  BANKNIFTY: { key: "NSE_INDEX|Nifty Bank", name: "NIFTY BANK" },
  FINNIFTY: { key: "NSE_INDEX|Nifty Fin Service", name: "NIFTY FINANCIAL SERVICES" },
  MIDCPNIFTY: { key: "NSE_INDEX|Nifty Midcap Select", name: "NIFTY MIDCAP SELECT" },
};

const UPSTOX_VIX_KEY = "NSE_INDEX|India VIX";

function toIndexData(symbol: string, tick: UpstoxTick): IndexData | null {
  if (!tick.ltp) return null;
  const prevClose = tick.cp || tick.ltp;
  const change = tick.ltp - prevClose;
  const changePercent = prevClose ? (change / prevClose) * 100 : 0;

  return {
    name: UPSTOX_INDEX_KEYS[symbol].name,
    symbol,
    ltp: tick.ltp,
    change,
    changePercent,
    open: tick.open || prevClose,
    high: tick.high || Math.max(tick.ltp, prevClose),
    low: tick.low || Math.min(tick.ltp, prevClose),
    prevClose,
  };
}

export interface UpstoxVixData {
  value: number;
  change: number;
  changePercent: number;
  high: number;
  low: number;
}

export function useUpstoxVix() {
  const [connected, setConnected] = useState(false);
  const [tick, setTick] = useState<UpstoxTick | null>(() => upstoxWS.get(UPSTOX_VIX_KEY));

  useEffect(() => upstoxWS.onStatus(setConnected), []);

  useEffect(() => {
    upstoxWS.connect();
    upstoxWS.requestKeys([UPSTOX_VIX_KEY]);
    const unsub = upstoxWS.subscribe(UPSTOX_VIX_KEY, setTick);

    return () => {
      unsub();
      upstoxWS.releaseKeys([UPSTOX_VIX_KEY]);
    };
  }, []);

  const vix = useMemo(() => {
    if (!tick?.ltp) return null;
    const prevClose = tick.cp || tick.ltp;
    const change = tick.ltp - prevClose;
    const changePercent = prevClose ? (change / prevClose) * 100 : 0;

    return {
      value: tick.ltp,
      change,
      changePercent,
      high: tick.high || Math.max(tick.ltp, prevClose),
      low: tick.low || Math.min(tick.ltp, prevClose),
    };
  }, [tick]);

  return { vix, isConnected: connected };
}

export function useUpstoxIndexTicks() {
  const [connected, setConnected] = useState(false);
  const [ticks, setTicks] = useState<Record<string, UpstoxTick>>({});

  useEffect(() => upstoxWS.onStatus(setConnected), []);

  useEffect(() => {
    const entries = Object.entries(UPSTOX_INDEX_KEYS);
    const keys = entries.map(([, meta]) => meta.key);

    upstoxWS.connect();
    upstoxWS.requestKeys(keys);

    const unsubs = entries.map(([symbol, meta]) =>
      upstoxWS.subscribe(meta.key, (tick) => {
        setTicks((prev) => ({ ...prev, [symbol]: tick }));
      }),
    );

    return () => {
      unsubs.forEach((unsub) => unsub());
      upstoxWS.releaseKeys(keys);
    };
  }, []);

  const indices = useMemo(
    () =>
      Object.keys(UPSTOX_INDEX_KEYS)
        .map((symbol) => (ticks[symbol] ? toIndexData(symbol, ticks[symbol]) : null))
        .filter(Boolean) as IndexData[],
    [ticks],
  );

  return { indices, connected };
}

export function useUpstoxFeedStatus() {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    upstoxWS.connect();
    return upstoxWS.onStatus(setConnected);
  }, []);

  return connected;
}
