import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  BROKERS,
  getSavedBrokers,
  saveBrokerCredentials,
  removeBrokerCredentials,
  setActiveBroker,
  getActiveBroker,
  syncBrokerRuntimeKeys,
  clearBrokerRuntimeKeys,
  syncSavedBrokerRuntimeKeys,
  type BrokerInfo,
  type BrokerCredentials,
} from "@/lib/brokerConfig";
import { resetProxyStatus } from "@/hooks/useMarketData";
import { testDhanConnection } from "@/lib/marketApi";
import { upstoxWS } from "@/lib/upstoxWebSocket";
import { useProxyHealth } from "@/hooks/useMarketData";
import { useWebSocketStatus } from "@/hooks/useWebSocket";
import {
  Shield, ExternalLink, Trash2, CheckCircle2, Circle, Eye, EyeOff, Info, Key, Plug, AlertTriangle,
  Server, Zap, Globe, BarChart3, Loader2, CheckCircle, XCircle, Wifi,
} from "lucide-react";
import { DatabaseManager } from "@/components/DatabaseManager";
import { ChartDataDownloader } from "@/components/ChartDataDownloader";

const PROXY_BASE = import.meta.env.VITE_PROXY_URL || "http://localhost:4002";

function BrokerCard({
  broker,
  saved,
  isActive,
  onSave,
  onRemove,
  onSetActive,
}: {
  broker: BrokerInfo;
  saved?: BrokerCredentials;
  isActive: boolean;
  onSave: (brokerId: string, values: Record<string, string>) => void;
  onRemove: (brokerId: string) => void;
  onSetActive: (brokerId: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(saved?.values || {});
  const [showFields, setShowFields] = useState<Record<string, boolean>>({});
  const [isEditing, setIsEditing] = useState(!saved);

  const handleSave = () => {
    const missing = broker.fields.filter((f) => f.required && !values[f.key]?.trim());
    if (missing.length > 0) {
      toast.error(`Please fill: ${missing.map((f) => f.label).join(", ")}`);
      return;
    }
    onSave(broker.id, values);
    setIsEditing(false);
  };

  return (
    <Card className={`transition-all duration-200 ${isActive ? "ring-2 ring-primary shadow-lg" : "hover:shadow-md"}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{broker.logo}</span>
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                {broker.name}
                {saved && (
                  <Badge variant={isActive ? "default" : "secondary"} className="text-2xs">
                    {isActive ? "Active" : "Connected"}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">{broker.description}</CardDescription>
            </div>
          </div>
          <a href={broker.docsUrl} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground transition-colors">
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>

        <div className="flex flex-wrap gap-1.5 mt-2">
          {broker.features.map((f) => (
            <Badge key={f} variant="outline" className="text-2xs font-normal">
              {f}
            </Badge>
          ))}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {isEditing ? (
          <>
            {broker.fields.map((field) => (
              <div key={field.key} className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1">
                  {field.label}
                  {field.required && <span className="text-destructive">*</span>}
                </Label>
                <div className="relative">
                  <Input
                    type={field.type === "password" && !showFields[field.key] ? "password" : "text"}
                    placeholder={field.placeholder}
                    value={values[field.key] || ""}
                    onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                    className="text-sm pr-9"
                  />
                  {field.type === "password" && (
                    <button
                      type="button"
                      onClick={() => setShowFields({ ...showFields, [field.key]: !showFields[field.key] })}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showFields[field.key] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  )}
                </div>
                {field.helpText && (
                  <p className="text-2xs text-muted-foreground flex items-center gap-1">
                    <Info className="h-3 w-3 shrink-0" />
                    {field.helpText}
                  </p>
                )}
              </div>
            ))}
            <div className="flex gap-2 pt-2">
              <Button size="sm" onClick={handleSave} className="flex-1">
                <Key className="h-3.5 w-3.5 mr-1.5" />
                Save Keys
              </Button>
              {saved && (
                <Button size="sm" variant="ghost" onClick={() => setIsEditing(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              <span>{broker.fields.filter((f) => f.required).length} keys configured</span>
              <span className="text-2xs">• Added {new Date(saved!.addedAt).toLocaleDateString("en-IN")}</span>
            </div>
            <div className="flex gap-2">
              {!isActive && (
                <Button size="sm" variant="outline" onClick={() => onSetActive(broker.id)} className="flex-1">
                  <Circle className="h-3.5 w-3.5 mr-1.5" />
                  Set Active
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setIsEditing(true)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => onRemove(broker.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NubraAutoLoginPanel({
  saved,
  onSaved,
}: {
  saved?: BrokerCredentials;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({
    phone: saved?.values.phone || localStorage.getItem("nubra_phone") || "",
    mpin: saved?.values.mpin || localStorage.getItem("nubra_mpin") || "",
    totpSecret: saved?.values.totpSecret || localStorage.getItem("nubra_totp_secret") || "",
  });
  const [otp, setOtp] = useState("");
  const [tempToken, setTempToken] = useState("");
  const [phase, setPhase] = useState<"idle" | "otp" | "reenable">("idle");
  const [loading, setLoading] = useState(false);

  const persistNubra = (nextValues: Record<string, string>) => {
    const merged = { ...(saved?.values || {}), ...nextValues };
    saveBrokerCredentials({
      brokerId: "nubra",
      values: merged,
      addedAt: saved?.addedAt || new Date().toISOString(),
      isActive: saved?.isActive || false,
    });
    syncBrokerRuntimeKeys("nubra", merged);
    onSaved();
  };

  const postNubra = async (path: string, body: Record<string, string>) => {
    const res = await fetch(`${PROXY_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) throw new Error(data.error || data.message || `Nubra ${path} failed`);
    return { data, status: res.status };
  };

  const saveSession = (data: any, extra: Record<string, string> = {}) => {
    const sessionToken = data.session_token || "";
    const authToken = data.auth_token || "";
    const deviceId = data.device_id || "";
    const rawCookie = data.raw_cookie || `authToken=${authToken}; sessionToken=${sessionToken}`;
    const nextValues = {
      ...values,
      ...extra,
      sessionToken,
      authToken,
      deviceId,
      rawCookie,
    };
    setValues(nextValues);
    persistNubra(nextValues);
    localStorage.setItem("nubra_login_date", new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }));
    localStorage.setItem("nubra_login_ts", String(Date.now()));
  };

  const sendOtp = async () => {
    if (!values.phone || !values.mpin) {
      toast.error("Enter Nubra mobile number and MPIN first");
      return;
    }
    setLoading(true);
    try {
      persistNubra(values);
      const { data } = await postNubra("/api/nubra-send-otp", { phone: values.phone });
      setTempToken(data.temp_token || "");
      setPhase("otp");
      toast.success("Nubra OTP sent");
    } catch (e: any) {
      toast.error(e.message || "Failed to send Nubra OTP");
    } finally {
      setLoading(false);
    }
  };

  const verifyOtpSetup = async () => {
    if (!otp || !tempToken) {
      toast.error("Enter OTP first");
      return;
    }
    setLoading(true);
    try {
      const { data } = await postNubra("/api/nubra-setup-totp", {
        phone: values.phone,
        mpin: values.mpin,
        otp,
        temp_token: tempToken,
      });
      saveSession(data, { totpSecret: data.secret_key || values.totpSecret });
      setOtp("");
      setTempToken("");
      setPhase("idle");
      toast.success("Nubra TOTP generated and session connected");
    } catch (e: any) {
      toast.error(e.message || "Nubra OTP verification failed");
    } finally {
      setLoading(false);
    }
  };

  const autoLogin = async () => {
    if (!values.phone || !values.mpin || !values.totpSecret) {
      toast.error("Need mobile, MPIN, and TOTP secret. Use Send OTP first if secret is missing.");
      return;
    }
    setLoading(true);
    try {
      persistNubra(values);
      const { data, status } = await postNubra("/api/nubra-login", {
        phone: values.phone,
        mpin: values.mpin,
        totp_secret: values.totpSecret,
      });
      if (status === 202 && data.error === "totp_not_enabled") {
        setTempToken(data.temp_token || "");
        setPhase("reenable");
        toast.info("Nubra needs OTP to re-enable TOTP");
        return;
      }
      saveSession(data);
      toast.success("Nubra auto-login connected");
    } catch (e: any) {
      toast.error(e.message || "Nubra auto-login failed");
    } finally {
      setLoading(false);
    }
  };

  const reenableTotp = async () => {
    if (!otp || !tempToken) {
      toast.error("Enter OTP first");
      return;
    }
    setLoading(true);
    try {
      const { data } = await postNubra("/api/nubra-otp-reenable-totp", {
        phone: values.phone,
        mpin: values.mpin,
        otp,
        temp_token: tempToken,
        totp_secret: values.totpSecret,
      });
      saveSession(data, { totpSecret: data.secret_key || values.totpSecret });
      setOtp("");
      setTempToken("");
      setPhase("idle");
      toast.success("Nubra TOTP re-enabled and connected");
    } catch (e: any) {
      toast.error(e.message || "Failed to re-enable Nubra TOTP");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="border-teal-500/25 bg-teal-500/5">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Key className="h-4 w-4 text-teal-500" />
          Nubra OTP / Auto Login
          {saved?.values.sessionToken && <Badge className="ml-auto text-2xs">Session Saved</Badge>}
        </CardTitle>
        <CardDescription className="text-xs">Generate Nubra session/auth/device tokens from mobile OTP, then reconnect later using the saved TOTP secret.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-[1fr_1fr_1.4fr_auto]">
        <Input
          placeholder="Mobile number"
          value={values.phone || ""}
          onChange={(e) => setValues((prev) => ({ ...prev, phone: e.target.value }))}
        />
        <Input
          placeholder="MPIN"
          type="password"
          value={values.mpin || ""}
          onChange={(e) => setValues((prev) => ({ ...prev, mpin: e.target.value }))}
        />
        <Input
          placeholder="TOTP secret auto-generated after OTP setup"
          type="password"
          value={values.totpSecret || ""}
          onChange={(e) => setValues((prev) => ({ ...prev, totpSecret: e.target.value }))}
        />
        <div className="flex gap-2">
          <Button variant="outline" onClick={sendOtp} disabled={loading}>
            {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Send OTP
          </Button>
          <Button onClick={autoLogin} disabled={loading || !values.totpSecret}>
            Auto Login
          </Button>
        </div>

        {phase !== "idle" && (
          <div className="md:col-span-4 flex flex-wrap items-center gap-2 rounded-md border border-teal-500/20 bg-background/70 p-2">
            <Input
              className="max-w-40"
              placeholder="OTP"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
            />
            <Button onClick={phase === "reenable" ? reenableTotp : verifyOtpSetup} disabled={loading}>
              {phase === "reenable" ? "Re-enable TOTP" : "Verify OTP & Generate Secret"}
            </Button>
            <span className="text-xs text-muted-foreground">
              {phase === "reenable" ? "Nubra asked to re-enable TOTP." : "This will create the TOTP secret and session tokens."}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ConnectionStatusPanel() {
  const { data: health } = useProxyHealth();
  const wsConnected = useWebSocketStatus();
  const [dhanStatus, setDhanStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [dhanMessage, setDhanMessage] = useState("");

  const handleTestDhan = async () => {
    setDhanStatus("testing");
    try {
      const result = await testDhanConnection();
      if (result.status === "success") {
        setDhanStatus("success");
        setDhanMessage("Connected successfully");
        toast.success("Dhan API connection verified!");
      } else {
        setDhanStatus("error");
        setDhanMessage(result.message || "Connection failed");
        toast.error("Dhan connection failed: " + result.message);
      }
    } catch (e: any) {
      setDhanStatus("error");
      setDhanMessage(e.message || "Network error");
      toast.error("Connection test failed");
    }
  };

  const sources = [
    {
      name: "Dhan API (Primary)",
      icon: <Wifi className="h-4 w-4" />,
      status: dhanStatus === "success" ? "online" : dhanStatus === "error" ? "offline" : health?.sources?.dhan ? "online" : "unknown",
      detail: dhanStatus === "success"
        ? "Primary source · Option Chain, Greeks, WebSocket"
        : health?.sources?.dhan
        ? "Credentials loaded from .env · Option Chain, Expiry, WebSocket"
        : dhanMessage || "Click Test to verify — provides Option Chain, Greeks, Live Ticks",
      color: dhanStatus === "success" || health?.sources?.dhan ? "text-emerald-500" : dhanStatus === "error" ? "text-red-500" : "text-zinc-500",
    },
    {
      name: "Dhan WebSocket",
      icon: <Zap className="h-4 w-4" />,
      status: wsConnected ? "online" : "offline",
      detail: wsConnected
        ? `Live ticks · ${health?.websocket?.cachedTicks || 0} cached, ${health?.websocket?.instrumentsSubscribed || 0} instruments`
        : "Requires Dhan credentials · Real-time index + VIX ticks",
      color: wsConnected ? "text-emerald-500" : "text-zinc-500",
    },
    {
      name: "NSE India (Fallback)",
      icon: <Globe className="h-4 w-4" />,
      status: health?.reachable ? "online" : "offline",
      detail: "Fallback · Indices, Sectors, A/D, Option Chain if Dhan fails",
      color: health?.reachable ? "text-emerald-500" : "text-red-500",
    },
    {
      name: "TradingView Scanner",
      icon: <BarChart3 className="h-4 w-4" />,
      status: "online",
      detail: "No auth needed · 100+ F&O stocks LTP, Volume, Sectors",
      color: "text-emerald-500",
    },
    {
      name: "Proxy Server",
      icon: <Server className="h-4 w-4" />,
      status: health?.reachable ? "online" : "offline",
      detail: health?.reachable ? `Uptime: ${Math.floor((health.uptime || 0) / 60)}min · Routes all API traffic` : "Not reachable — run: npm run dev",
      color: health?.reachable ? "text-emerald-500" : "text-red-500",
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Wifi className="h-4 w-4 text-primary" />
          Connection Status
          <Badge variant="outline" className="text-2xs ml-auto">
            {sources.filter(s => s.status === "online").length}/{sources.length} Online
          </Badge>
        </CardTitle>
        <CardDescription className="text-xs">Real-time status of all data sources</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {sources.map((src) => (
          <div key={src.name} className="flex items-center gap-3 p-2 rounded-md bg-accent/20">
            <div className={src.color}>{src.icon}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium">{src.name}</span>
                <div className={`h-1.5 w-1.5 rounded-full ${
                  src.status === "online" ? "bg-emerald-500" :
                  src.status === "offline" ? "bg-red-500" : "bg-zinc-500"
                }`} />
              </div>
              <p className="text-xs text-muted-foreground truncate">{src.detail}</p>
            </div>
            {src.name.startsWith("Dhan API") && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1"
                onClick={handleTestDhan}
                disabled={dhanStatus === "testing"}
              >
                {dhanStatus === "testing" ? (
                  <><Loader2 className="h-3 w-3 animate-spin" /> Testing</>
                ) : dhanStatus === "success" ? (
                  <><CheckCircle className="h-3 w-3 text-emerald-500" /> Connected</>
                ) : dhanStatus === "error" ? (
                  <><XCircle className="h-3 w-3 text-red-500" /> Retry</>
                ) : (
                  <>Test</>
                )}
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function BrokerSettings() {
  const queryClient = useQueryClient();
  const [savedBrokers, setSavedBrokers] = useState(getSavedBrokers());
  const activeBroker = getActiveBroker();

  useEffect(() => {
    syncSavedBrokerRuntimeKeys();
  }, []);

  const refreshMarketData = () => {
    resetProxyStatus();
    queryClient.invalidateQueries();
  };

  const handleSave = (brokerId: string, values: Record<string, string>) => {
    const shouldActivate = brokerId === "upstox" || savedBrokers.length === 0 || activeBroker?.brokerId === brokerId;
    const creds: BrokerCredentials = {
      brokerId,
      values,
      addedAt: new Date().toISOString(),
      isActive: shouldActivate,
    };
    saveBrokerCredentials(creds);
    syncBrokerRuntimeKeys(brokerId, values);
    if (shouldActivate) setActiveBroker(brokerId);
    if (brokerId === "upstox") {
      upstoxWS.disconnect();
      upstoxWS.connect(values.accessToken);
    }
    setSavedBrokers(getSavedBrokers());
    refreshMarketData();
    toast.success(`${BROKERS.find((b) => b.id === brokerId)?.name} keys saved securely`);
  };

  const handleRemove = (brokerId: string) => {
    removeBrokerCredentials(brokerId);
    clearBrokerRuntimeKeys(brokerId);
    if (brokerId === "upstox") upstoxWS.disconnect();
    setSavedBrokers(getSavedBrokers());
    refreshMarketData();
    toast.info("Broker keys removed");
  };

  const handleSetActive = (brokerId: string) => {
    setActiveBroker(brokerId);
    if (brokerId === "upstox") {
      const upstox = getSavedBrokers().find((b) => b.brokerId === "upstox");
      upstoxWS.disconnect();
      upstoxWS.connect(upstox?.values.accessToken);
    }
    setSavedBrokers(getSavedBrokers());
    refreshMarketData();
    toast.success(`${BROKERS.find((b) => b.id === brokerId)?.name} is now active`);
  };

  const connectedIds = savedBrokers.map((b) => b.brokerId);
  const availableBrokers = BROKERS.filter((b) => !connectedIds.includes(b.id));
  const connectedBrokers = BROKERS.filter((b) => connectedIds.includes(b.id));

  return (
    <div className="space-y-6 p-1">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <Plug className="h-6 w-6 text-primary" />
          Broker API Settings
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Connect your broker accounts for live market data and trading. Keys are stored locally in your browser.
        </p>
      </div>

      {/* Security Notice */}
      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardContent className="flex items-start gap-3 py-3">
          <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium text-foreground">Security Notice</p>
            <p className="text-muted-foreground text-xs mt-0.5">
              API keys are stored in your browser's localStorage and are <strong>never sent to our servers</strong>.
              They are passed directly to your broker's API through a secure proxy. For maximum security, use
              read-only API tokens when available.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Connection Status Panel */}
      <ConnectionStatusPanel />

      <NubraAutoLoginPanel
        saved={savedBrokers.find((broker) => broker.brokerId === "nubra")}
        onSaved={() => {
          setSavedBrokers(getSavedBrokers());
          refreshMarketData();
        }}
      />

      {/* Database Manager */}
      <DatabaseManager />

      {/* Chart Data Downloader */}
      <ChartDataDownloader />

      <Tabs defaultValue={connectedBrokers.length > 0 ? "connected" : "available"}>
        <TabsList>
          <TabsTrigger value="connected" className="gap-1.5">
            <Shield className="h-3.5 w-3.5" />
            Connected ({connectedBrokers.length})
          </TabsTrigger>
          <TabsTrigger value="available" className="gap-1.5">
            <Plug className="h-3.5 w-3.5" />
            Available ({availableBrokers.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="connected" className="mt-4">
          {connectedBrokers.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="py-12 text-center">
                <Key className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">No brokers connected yet</p>
                <p className="text-xs text-muted-foreground/60 mt-1">Switch to "Available" tab to add your first broker</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {connectedBrokers.map((broker) => (
                <BrokerCard
                  key={broker.id}
                  broker={broker}
                  saved={savedBrokers.find((s) => s.brokerId === broker.id)}
                  isActive={activeBroker?.brokerId === broker.id}
                  onSave={handleSave}
                  onRemove={handleRemove}
                  onSetActive={handleSetActive}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="available" className="mt-4">
          <div className="grid gap-4 md:grid-cols-2">
            {availableBrokers.map((broker) => (
              <BrokerCard
                key={broker.id}
                broker={broker}
                isActive={false}
                onSave={handleSave}
                onRemove={handleRemove}
                onSetActive={handleSetActive}
              />
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {/* How It Works */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">How It Works</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              { step: "1", title: "Get API Keys", desc: "Sign up for API access on your broker's developer portal" },
              { step: "2", title: "Enter Credentials", desc: "Paste your Client ID, API Key, and Access Token above" },
              { step: "3", title: "Live Data Flows", desc: "Option chain, LTP, Greeks, and OI update in real-time" },
            ].map((s) => (
              <div key={s.step} className="flex gap-3">
                <div className="h-7 w-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-bold shrink-0">
                  {s.step}
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{s.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
