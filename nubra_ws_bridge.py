"""
Nubra WebSocket Bridge Server
==============================
- Connects to Nubra's apibatch WS using the session_token from localStorage (passed by frontend)
- Decodes protobuf messages (OHLCV buckets + Greeks)
- Re-broadcasts clean JSON to frontend clients on ws://localhost:8765

Subscription protocol (frontend → bridge):
  { "action": "subscribe", "session_token": "...", "data_type": "ohlcv"|"greeks"|"index"|"option"|"orderbook",
    "symbols": ["NIFTY"], "ref_ids": [1058227], "interval": "3", "exchange": "NSE" }
  { "action": "unsubscribe", ... }

Messages sent to frontend:
  { "type": "ohlcv",      "data": { ... } }
  { "type": "greeks",     "data": { "ref_id": 1058227, "delta": ..., "ltp": ..., ... } }
  { "type": "orderbook",  "data": { "ref_id": ..., "last_traded_price": ...,
      "bids": [{"price": ..., "quantity": ..., "num_orders": ...}, ...],
      "asks": [...] } }
  { "type": "connected" }
  { "type": "error", "message": "..." }
"""

import asyncio
import json
import logging
import math
import sys
import websockets
import aiohttp
from google.protobuf.any_pb2 import Any as ProtoAny

# Import Nubra protobuf definitions
try:
    from nubra_python_sdk.protos import nubrafrontend_pb2
except ImportError:
    print("ERROR: nubra_python_sdk not installed. Run: pip install nubra-sdk", file=sys.stderr)
    sys.exit(1)


logging.basicConfig(level=logging.INFO, format="%(asctime)s [bridge] %(message)s")
log = logging.getLogger("nubra_bridge")

BRIDGE_PORT = 8765
NUBRA_WS_BATCH = "wss://api.nubra.io/apibatch/ws"

# INTERVAL enum → string map (from SDK source)
INTERVAL_MAP = {
    0: "invalid", 1: "1s", 2: "10s", 3: "1m", 4: "2m", 5: "3m",
    6: "5m", 7: "10m", 8: "15m", 9: "30m", 10: "1h", 11: "2h",
    12: "4h", 13: "1d", 14: "1w", 15: "mt", 16: "1yr"
}

# Nubra interval string → proto enum int (for subscription messages)
INTERVAL_STR_TO_INT = {v: k for k, v in INTERVAL_MAP.items()}


class NubraBridge:
    """One bridge instance per connected frontend client."""

    def __init__(self, ws: websockets.WebSocketServerProtocol):
        self.ws = ws
        self.session_token: str = ""
        self.nubra_ws: aiohttp.ClientWebSocketResponse | None = None
        self.session: aiohttp.ClientSession | None = None
        self._recv_task: asyncio.Task | None = None

    async def handle(self):
        log.info(f"Frontend connected: {self.ws.remote_address}")
        try:
            async for raw in self.ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                action = msg.get("action")
                if action == "subscribe":
                    await self._on_subscribe(msg)
                elif action == "unsubscribe":
                    await self._on_unsubscribe(msg)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            await self._cleanup()
            log.info("Frontend disconnected")

    async def _on_subscribe(self, msg: dict):
        token = msg.get("session_token", "")
        if token and token != self.session_token:
            # New token — (re)connect to Nubra
            self.session_token = token
            await self._connect_nubra()

        # Wait up to 5s for Nubra connection to be ready
        for _ in range(50):
            if self.nubra_ws and not self.nubra_ws.closed:
                break
            await asyncio.sleep(0.1)

        if not self.nubra_ws or self.nubra_ws.closed:
            await self._send_json({"type": "error", "message": "Nubra WS not connected"})
            return

        data_type = msg.get("data_type", "ohlcv")
        exchange = msg.get("exchange", "NSE")
        symbols = msg.get("symbols", [])
        ref_ids = msg.get("ref_ids", [])
        interval = msg.get("interval", "1m")  # string like "1m", "5m", "1d"

        if data_type == "orderbook":
            # Uses the same existing Nubra WS connection — session_token is the bearer token
            payload = {"instruments": [int(r) for r in ref_ids], "indexes": []}
            sub_msg = f"batch_subscribe {self.session_token} orderbook {json.dumps(payload, separators=(',', ':'))}"
            log.info(f"Subscribing orderbook: {sub_msg[:120]}")
            await self.nubra_ws.send_str(sub_msg)
            return

        if data_type == "ohlcv":
            payload = {"instruments": [], "indexes": symbols}
            sub_msg = f"batch_subscribe {self.session_token} index_bucket {json.dumps(payload, separators=(',', ':'))} {interval} {exchange}"
        elif data_type == "greeks":
            payload = {"instruments": [int(r) for r in ref_ids], "indexes": []}
            sub_msg = f"batch_subscribe {self.session_token} greeks {json.dumps(payload, separators=(',', ':'))}"
        elif data_type == "index":
            payload = {"instruments": [], "indexes": symbols}
            sub_msg = f"batch_subscribe {self.session_token} index {json.dumps(payload, separators=(',', ':'))} {exchange}"
        elif data_type == "option":
            chain_list = []
            for s in symbols:
                parts = s.split(":")
                if len(parts) == 2:
                    chain_list.append({"exchange": exchange, "asset": parts[0], "expiry": parts[1]})
            if not chain_list:
                log.warning("option subscribe: no valid symbols parsed")
                return
            sub_msg = f"batch_subscribe {self.session_token} option {json.dumps(chain_list, separators=(',', ':'))}"
        else:
            return

        log.info(f"Subscribing: {sub_msg[:120]}")
        await self.nubra_ws.send_str(sub_msg)

    async def _on_unsubscribe(self, msg: dict):
        if not self.nubra_ws or self.nubra_ws.closed:
            return
        data_type = msg.get("data_type", "ohlcv")
        exchange = msg.get("exchange", "NSE")
        symbols = msg.get("symbols", [])
        ref_ids = msg.get("ref_ids", [])
        interval = msg.get("interval", "3")

        if data_type == "ohlcv":
            payload = {"instruments": [], "indexes": symbols}
            sub_msg = f"batch_unsubscribe {self.session_token} index_bucket {json.dumps(payload, separators=(',', ':'))} {interval} {exchange}"
        elif data_type == "greeks":
            payload = {"instruments": [int(r) for r in ref_ids], "indexes": []}
            sub_msg = f"batch_unsubscribe {self.session_token} greeks {json.dumps(payload, separators=(',', ':'))}"
        else:
            return

        await self.nubra_ws.send_str(sub_msg)

    async def _connect_nubra(self):
        await self._cleanup()
        self.session = aiohttp.ClientSession()
        try:
            self.nubra_ws = await self.session.ws_connect(NUBRA_WS_BATCH, autoping=False)
            log.info("Connected to Nubra WS")
            await self._send_json({"type": "connected"})
            self._recv_task = asyncio.create_task(self._recv_loop())
        except Exception as e:
            log.error(f"Failed to connect to Nubra WS: {e}")
            await self._send_json({"type": "error", "message": str(e)})

    async def _recv_loop(self):
        try:
            async for msg in self.nubra_ws:
                if msg.type == aiohttp.WSMsgType.BINARY:
                    await self._decode_and_forward(msg.data)
                elif msg.type == aiohttp.WSMsgType.TEXT:
                    text = msg.data.strip()
                    if text == "Invalid Token":
                        await self._send_json({"type": "error", "message": "Invalid Token"})
                    else:
                        log.info(f"Nubra text: {text}")
                elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING):
                    break
        except Exception as e:
            log.error(f"Recv loop error: {e}")
            await self._send_json({"type": "error", "message": str(e)})

    async def _decode_and_forward(self, raw: bytes):
        try:
            wrapper = ProtoAny()
            wrapper.ParseFromString(raw)
            inner = ProtoAny()
            inner.ParseFromString(wrapper.value)

            if inner.type_url.endswith("BatchWebSocketIndexBucketMessage"):
                msg = nubrafrontend_pb2.BatchWebSocketIndexBucketMessage()
                inner.Unpack(msg)
                for obj in list(msg.indexes) + list(msg.instruments):
                    await self._send_json({
                        "type": "ohlcv",
                        "data": {
                            "indexname": obj.indexname,
                            "exchange": obj.exchange,
                            "interval": INTERVAL_MAP.get(obj.interval, str(obj.interval)),
                            "timestamp": obj.timestamp,
                            "open": obj.open,
                            "high": obj.high,
                            "low": obj.low,
                            "close": obj.close,
                            "bucket_volume": obj.bucket_volume,
                            "tick_volume": obj.tick_volume,
                            "cumulative_volume": obj.cumulative_volume,
                            "bucket_timestamp": obj.bucket_timestamp,
                        }
                    })

            elif inner.type_url.endswith("BatchWebSocketOrderbookMessage"):
                msg = nubrafrontend_pb2.BatchWebSocketOrderbookMessage()
                inner.Unpack(msg)
                for obj in msg.instruments:
                    await self._send_json({
                        "type": "orderbook",
                        "data": {
                            "ref_id": obj.ref_id,
                            "timestamp": obj.timestamp,
                            "last_traded_price": obj.ltp,
                            "last_traded_quantity": obj.ltq,
                            "volume": obj.volume,
                            "bids": [{"price": b.price, "quantity": b.quantity, "num_orders": b.orders} for b in obj.bids],
                            "asks": [{"price": a.price, "quantity": a.quantity, "num_orders": a.orders} for a in obj.asks],
                        }
                    })

            elif inner.type_url.endswith("BatchWebSocketGreeksMessage"):
                msg = nubrafrontend_pb2.BatchWebSocketGreeksMessage()
                inner.Unpack(msg)
                for obj in msg.instruments:
                    await self._send_json({
                        "type": "greeks",
                        "data": {
                            "ref_id": obj.ref_id,
                            "timestamp": obj.ts,
                            "ltp": obj.ltp,
                            "iv": obj.iv,
                            "delta": obj.delta,
                            "gamma": obj.gamma,
                            "theta": obj.theta,
                            "vega": obj.vega,
                            "oi": obj.oi,
                        }
                    })

            elif inner.type_url.endswith("BatchWebSocketIndexMessage"):
                msg = nubrafrontend_pb2.BatchWebSocketIndexMessage()
                inner.Unpack(msg)
                for obj in list(msg.indexes) + list(msg.instruments):
                    await self._send_json({
                        "type": "index",
                        "data": {
                            "indexname": obj.indexname,
                            "exchange": obj.exchange,
                            "timestamp": obj.timestamp,
                            "index_value": obj.index_value,
                            "volume": obj.volume,
                            "changepercent": obj.changepercent,
                        }
                    })

            elif inner.type_url.endswith("WebSocketMsgOptionChainUpdate"):
                msg = nubrafrontend_pb2.WebSocketMsgOptionChainUpdate()
                inner.Unpack(msg)


                def _safe(v):
                    """NaN/Inf → None (NaN is invalid JSON and breaks JSON.parse in browser)"""
                    if v is None:
                        return None
                    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                        return None
                    return v if v else None

                def _paisa(v):
                    """Convert paisa (×100) → rupees, handling NaN/Inf"""
                    s = _safe(v)
                    return s / 100 if s else None

                def serialize_item(item):
                    return {
                        "ref_id": item.ref_id or None,
                        "timestamp": item.ts or None,
                        "strike_price": _paisa(item.sp),
                        "lot_size": item.ls or None,
                        "last_traded_price": _paisa(item.ltp),
                        "last_traded_price_change": _paisa(item.ltpchg),
                        "iv": _safe(item.iv),
                        "delta": _safe(item.delta),
                        "gamma": _safe(item.gamma),
                        "theta": _safe(item.theta),
                        "vega": _safe(item.vega),
                        "volume": item.volume or None,
                        "open_interest": item.oi or None,
                        "previous_open_interest": item.prev_oi or None,
                    }

                await self._send_json({
                    "type": "option",
                    "data": {
                        "asset": msg.asset,
                        "exchange": msg.exchange,
                        "expiry": msg.expiry,
                        "at_the_money_strike": (msg.atm / 100) if msg.atm else 0,
                        "current_price": (msg.currentprice / 100) if msg.currentprice else 0,
                        "ce": [serialize_item(i) for i in msg.ce],
                        "pe": [serialize_item(i) for i in msg.pe],
                    }
                })

        except Exception as e:
            log.warning(f"Decode error: {e}")

    async def _send_json(self, obj: dict):
        try:
            await self.ws.send(json.dumps(obj))
        except Exception:
            pass

    async def _cleanup(self):
        if self._recv_task:
            self._recv_task.cancel()
            self._recv_task = None
        if self.nubra_ws and not self.nubra_ws.closed:
            await self.nubra_ws.close()
        if self.session and not self.session.closed:
            await self.session.close()
        self.nubra_ws = None
        self.session = None


async def main():
    log.info(f"Nubra WS Bridge starting on ws://localhost:{BRIDGE_PORT}")
    async def handler(ws):
        bridge = NubraBridge(ws)
        await bridge.handle()

    async with websockets.serve(handler, "localhost", BRIDGE_PORT):
        log.info(f"Bridge ready on ws://localhost:{BRIDGE_PORT}")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
