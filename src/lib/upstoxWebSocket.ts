import { Buffer } from "buffer";
import * as protobuf from "protobufjs";
import { getActiveBroker } from "./brokerConfig";

const PROXY_BASE = import.meta.env.VITE_PROXY_URL || "http://localhost:4002";
const PROXY_TOKEN = "__proxy__";

const PROTO_DEFINITION = `
syntax = "proto3";
package com.upstox.marketdatafeederv3udapi.rpc.proto;

message LTPC { double ltp = 1; int64 ltt = 2; int64 ltq = 3; double cp = 4; }
message MarketLevel { repeated Quote bidAskQuote = 1; }
message MarketOHLC { repeated OHLC ohlc = 1; }
message Quote { int64 bidQ = 1; double bidP = 2; int64 askQ = 3; double askP = 4; }
message OptionGreeks { double delta = 1; double theta = 2; double gamma = 3; double vega = 4; double rho = 5; }
message OHLC { string interval = 1; double open = 2; double high = 3; double low = 4; double close = 5; int64 vol = 6; int64 ts = 7; }
enum Type { initial_feed = 0; live_feed = 1; market_info = 2; }
message MarketFullFeed {
  LTPC ltpc = 1; MarketLevel marketLevel = 2; OptionGreeks optionGreeks = 3; MarketOHLC marketOHLC = 4;
  double atp = 5; int64 vtt = 6; double oi = 7; double iv = 8; double tbq = 9; double tsq = 10;
}
message IndexFullFeed { LTPC ltpc = 1; MarketOHLC marketOHLC = 2; }
message FullFeed { oneof FullFeedUnion { MarketFullFeed marketFF = 1; IndexFullFeed indexFF = 2; } }
message FirstLevelWithGreeks { LTPC ltpc = 1; Quote firstDepth = 2; OptionGreeks optionGreeks = 3; int64 vtt = 4; double oi = 5; double iv = 6; }
message Feed {
  oneof FeedUnion { LTPC ltpc = 1; FullFeed fullFeed = 2; FirstLevelWithGreeks firstLevelWithGreeks = 3; }
  RequestMode requestMode = 4;
}
enum RequestMode { ltpc = 0; full_d5 = 1; option_greeks = 2; full_d30 = 3; }
enum MarketStatus { PRE_OPEN_START = 0; PRE_OPEN_END = 1; NORMAL_OPEN = 2; NORMAL_CLOSE = 3; CLOSING_START = 4; CLOSING_END = 5; }
message MarketInfo { map<string, MarketStatus> segmentStatus = 1; }
message FeedResponse { Type type = 1; map<string, Feed> feeds = 2; int64 currentTs = 3; MarketInfo marketInfo = 4; }
`;

export interface UpstoxTick {
  ltp: number;
  cp: number;
  open: number;
  high: number;
  low: number;
  oi: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  bidAskQuote: Array<{ bidP: number; askP: number; bidQ: string; askQ: string }>;
}

type TickListener = (tick: UpstoxTick) => void;
type StatusListener = (connected: boolean) => void;

class UpstoxWebSocket {
  private ws: WebSocket | null = null;
  private token = "";
  private root: protobuf.Root | null = null;
  private connecting = false;
  private connected = false;
  private destroyed = false;
  private retryCount = 0;
  private connectRun = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMessageAt = 0;
  private listeners = new Map<string, Set<TickListener>>();
  private statusListeners = new Set<StatusListener>();
  private requestedKeys = new Map<string, number>();
  private subscribedKeys = new Set<string>();
  private latest = new Map<string, UpstoxTick>();

  connect(token?: string) {
    const nextToken = token || this.getToken() || PROXY_TOKEN;
    if (nextToken === this.token && (this.connecting || this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING)) return;
    this.token = nextToken;
    this.destroyed = false;
    this.retryCount = 0;
    this.teardown();
    this.connectSocket();
  }

  requestKeys(keys: string[]) {
    keys.filter(Boolean).forEach((key) => this.requestedKeys.set(key, (this.requestedKeys.get(key) || 0) + 1));
    this.syncSubscriptions();
  }

  releaseKeys(keys: string[]) {
    keys.filter(Boolean).forEach((key) => {
      const count = (this.requestedKeys.get(key) || 0) - 1;
      if (count <= 0) {
        this.requestedKeys.delete(key);
        this.subscribedKeys.delete(key);
      } else {
        this.requestedKeys.set(key, count);
      }
    });
  }

  subscribe(key: string, callback: TickListener) {
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key)!.add(callback);
    const cached = this.latest.get(key);
    if (cached) setTimeout(() => callback(cached), 0);
    return () => this.listeners.get(key)?.delete(callback);
  }

  onStatus(callback: StatusListener) {
    this.statusListeners.add(callback);
    setTimeout(() => callback(this.connected), 0);
    return () => this.statusListeners.delete(callback);
  }

  get(key: string) {
    return this.latest.get(key) || null;
  }

  disconnect() {
    this.destroyed = true;
    this.teardown();
    this.notifyStatus(false);
  }

  private getToken() {
    const broker = getActiveBroker();
    return broker?.brokerId === "upstox" ? broker.values.accessToken || "" : "";
  }

  private async initProtobuf() {
    if (this.root) return;
    this.root = protobuf.parse(PROTO_DEFINITION).root;
  }

  private async getWsUrl() {
    const headers: Record<string, string> = {};
    if (this.token && this.token !== PROXY_TOKEN) {
      headers["x-upstox-access-token"] = this.token;
    }
    const response = await fetch(`${PROXY_BASE}/api/upstox-feed-authorize`, { headers });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(detail || "Upstox proxy websocket authorization failed");
    }
    const json = await response.json();
    const url = json?.data?.authorizedRedirectUri;
    if (!url) throw new Error("Upstox proxy did not return a websocket URL");
    return url;
  }

  private async connectSocket() {
    if (this.destroyed || !this.token) return;
    const run = ++this.connectRun;
    this.connecting = true;
    try {
      await this.initProtobuf();
      const url = await this.getWsUrl();
      if (this.destroyed || run !== this.connectRun) return;

      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        if (this.destroyed || run !== this.connectRun) return;
        this.connecting = false;
        this.retryCount = 0;
        this.lastMessageAt = Date.now();
        this.notifyStatus(true);
        const keys = [...this.requestedKeys.keys()];
        this.sendSubscribe(keys);
        keys.forEach((key) => this.subscribedKeys.add(key));
        this.armStaleWatchdog();
      };
      this.ws.onclose = () => {
        if (run !== this.connectRun) return;
        this.ws = null;
        this.connecting = false;
        this.subscribedKeys.clear();
        this.notifyStatus(false);
        this.clearStaleWatchdog();
        this.scheduleReconnect();
      };
      this.ws.onerror = () => {
        this.notifyStatus(false);
      };
      this.ws.onmessage = async (event) => {
        if (this.destroyed || run !== this.connectRun) return;
        this.lastMessageAt = Date.now();
        const arrayBuffer = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
        const response = this.decode(Buffer.from(arrayBuffer));
        if (response?.feeds) this.processFeeds(response.feeds);
      };
    } catch (error) {
      if (run !== this.connectRun) return;
      this.connecting = false;
      this.notifyStatus(false);
      console.warn("[UpstoxWS] connect failed", error);
      this.scheduleReconnect();
    }
  }

  private decode(buffer: Buffer) {
    if (!this.root) return null;
    try {
      const FeedResponse = this.root.lookupType("com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse");
      return FeedResponse.decode(buffer) as any;
    } catch {
      return null;
    }
  }

  private processFeeds(feeds: Record<string, any>) {
    Object.entries(feeds).forEach(([key, feed]) => {
      const tick = this.parseFeed(key, feed);
      if (!tick) return;
      this.latest.set(key, tick);
      this.listeners.get(key)?.forEach((callback) => callback(tick));
    });
  }

  private parseFeed(key: string, feed: any): UpstoxTick | null {
    const prev = this.latest.get(key);
    const source = feed.fullFeed?.marketFF || feed.fullFeed?.indexFF || feed.firstLevelWithGreeks || feed;
    const ltpc = source.ltpc || feed.ltpc || {};
    const greeks = source.optionGreeks || {};
    const dayBar = (source.marketOHLC?.ohlc || []).find((bar: any) => String(bar.interval).toLowerCase() === "1d")
      || source.marketOHLC?.ohlc?.[0]
      || {};
    if (!ltpc.ltp && !source.oi && !source.iv) return null;
    const rawIv = Number(source.iv);
    const iv = Number.isFinite(rawIv) && rawIv > 0
      ? rawIv * (rawIv <= 1 ? 100 : 1)
      : prev?.iv || 0;

    return {
      ltp: Number(ltpc.ltp || prev?.ltp || 0),
      cp: Number(ltpc.cp || prev?.cp || 0),
      open: Number(dayBar.open || prev?.open || 0),
      high: Number(dayBar.high || prev?.high || ltpc.ltp || 0),
      low: Number(dayBar.low || prev?.low || ltpc.ltp || 0),
      oi: Number(source.oi || prev?.oi || 0),
      iv,
      delta: Number(greeks.delta || prev?.delta || 0),
      gamma: Number(greeks.gamma || prev?.gamma || 0),
      theta: Number(greeks.theta || prev?.theta || 0),
      vega: Number(greeks.vega || prev?.vega || 0),
      rho: Number(greeks.rho || prev?.rho || 0),
      bidAskQuote: (source.marketLevel?.bidAskQuote || []).map((quote: any) => ({
        bidQ: quote.bidQ?.toString() || "",
        bidP: Number(quote.bidP || 0),
        askQ: quote.askQ?.toString() || "",
        askP: Number(quote.askP || 0),
      })),
    };
  }

  private syncSubscriptions() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const toAdd = [...this.requestedKeys.keys()].filter((key) => !this.subscribedKeys.has(key));
    this.sendSubscribe(toAdd);
    toAdd.forEach((key) => this.subscribedKeys.add(key));
  }

  private sendSubscribe(keys: string[]) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || keys.length === 0) return;
    this.ws.send(Buffer.from(JSON.stringify({
      guid: `oi_dashboard_${Date.now()}`,
      method: "sub",
      data: { mode: "full", instrumentKeys: keys },
    })));
  }

  private teardown() {
    this.connectRun += 1;
    this.connecting = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearStaleWatchdog();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.subscribedKeys.clear();
  }

  private scheduleReconnect() {
    if (this.destroyed) return;
    this.retryCount += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(2000 * 2 ** Math.min(this.retryCount - 1, 4), 30000);
    this.reconnectTimer = setTimeout(() => this.connectSocket(), delay);
  }

  private armStaleWatchdog() {
    this.clearStaleWatchdog();
    this.staleTimer = setInterval(() => {
      if (this.destroyed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.requestedKeys.size === 0) return;
      const staleForMs = Date.now() - this.lastMessageAt;
      if (staleForMs < 45000) return;
      console.warn("[UpstoxWS] feed stale, reconnecting");
      this.ws.close();
    }, 15000);
  }

  private clearStaleWatchdog() {
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = null;
  }

  private notifyStatus(connected: boolean) {
    this.connected = connected;
    this.statusListeners.forEach((callback) => callback(connected));
  }
}

export const upstoxWS = new UpstoxWebSocket();
