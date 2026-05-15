import { useEffect, useMemo, useState } from "react";
import type { OptionData } from "@/lib/mockData";
import { upstoxWS, type UpstoxTick } from "@/lib/upstoxWebSocket";

function hasPreviousOi(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function mergeLegWithSnapshot<T extends OptionData["ce"]>(next: T, snapshot?: T): T {
  if (!snapshot || hasPreviousOi(next.previousOi)) return next;
  if (hasPreviousOi(snapshot.previousOi)) {
    return {
      ...next,
      previousOi: snapshot.previousOi,
      oiChange: next.oi - snapshot.previousOi,
    };
  }
  if (snapshot.oiChange) {
    const previousOi = snapshot.oi - snapshot.oiChange;
    return {
      ...next,
      previousOi,
      oiChange: next.oi - previousOi,
    };
  }
  return next;
}

function applyTick(row: OptionData, side: "ce" | "pe", tick: UpstoxTick): OptionData {
  const leg = row[side];
  const nextOi = tick.oi || leg.oi;
  const previousOi = hasPreviousOi(leg.previousOi)
    ? leg.previousOi
    : leg.oiChange
      ? leg.oi - leg.oiChange
      : undefined;
  return {
    ...row,
    [side]: {
      ...leg,
      ltp: tick.ltp || leg.ltp,
      oi: nextOi,
      previousOi,
      oiChange: previousOi !== undefined ? nextOi - previousOi : leg.oiChange,
      iv: tick.iv || leg.iv,
      delta: Number.isFinite(tick.delta) ? tick.delta : leg.delta,
      gamma: Number.isFinite(tick.gamma) ? tick.gamma : leg.gamma,
      theta: Number.isFinite(tick.theta) ? tick.theta : leg.theta,
      vega: Number.isFinite(tick.vega) ? tick.vega : leg.vega,
      bidPrice: tick.bidAskQuote?.[0]?.bidP || leg.bidPrice,
      askPrice: tick.bidAskQuote?.[0]?.askP || leg.askPrice,
    },
  };
}

export function useUpstoxLiveOptionChain(chain: OptionData[], enabled: boolean) {
  const [liveChain, setLiveChain] = useState<OptionData[]>(chain);
  const [connected, setConnected] = useState(false);

  const keyMap = useMemo(() => {
    const map = new Map<string, { strikePrice: number; side: "ce" | "pe" }>();
    chain.forEach((row) => {
      const ceKey = (row.ce as any).instrumentKey;
      const peKey = (row.pe as any).instrumentKey;
      if (ceKey) map.set(ceKey, { strikePrice: row.strikePrice, side: "ce" });
      if (peKey) map.set(peKey, { strikePrice: row.strikePrice, side: "pe" });
    });
    return map;
  }, [chain]);

  useEffect(() => {
    setLiveChain((prev) =>
      chain.map((row) => {
        const snapshot = prev.find((oldRow) => oldRow.strikePrice === row.strikePrice);
        return {
          ...row,
          ce: mergeLegWithSnapshot(row.ce, snapshot?.ce),
          pe: mergeLegWithSnapshot(row.pe, snapshot?.pe),
        };
      }),
    );
  }, [chain]);

  useEffect(() => upstoxWS.onStatus(setConnected), []);

  useEffect(() => {
    if (!enabled || keyMap.size === 0) return;
    const keys = [...keyMap.keys()];
    upstoxWS.connect();
    upstoxWS.requestKeys(keys);

    const unsubs = keys.map((key) =>
      upstoxWS.subscribe(key, (tick) => {
        const meta = keyMap.get(key);
        if (!meta) return;
        setLiveChain((prev) =>
          prev.map((row) =>
            row.strikePrice === meta.strikePrice ? applyTick(row, meta.side, tick) : row,
          ),
        );
      }),
    );

    return () => {
      unsubs.forEach((unsub) => unsub());
      upstoxWS.releaseKeys(keys);
    };
  }, [enabled, keyMap]);

  return { chain: liveChain, connected };
}
