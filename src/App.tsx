import { lazy, Suspense, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import DashboardLayout from "@/components/DashboardLayout";
import { DashboardSkeleton } from "@/components/LoadingSkeletons";

// Route-based code splitting for optimal initial load
const Index = lazy(() => import("./pages/Index"));
const OptionChain = lazy(() => import("./pages/OptionChain"));
const OIAnalysis = lazy(() => import("./pages/OIAnalysis"));
const Watchlist = lazy(() => import("./pages/Watchlist"));
const StrategyBuilder = lazy(() => import("./pages/StrategyBuilder"));
const PositionTracker = lazy(() => import("./pages/PositionTracker"));
const AutoRollingStraddle = lazy(() => import("./pages/AutoRollingStraddle"));
const VegaPulsePage = lazy(() => import("./pages/VegaPulsePage"));
const BrokerSettings = lazy(() => import("./pages/BrokerSettings"));
const NotFound = lazy(() => import("./pages/NotFound"));

const queryClient = new QueryClient();

function PageSuspense({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <ErrorBoundary fallbackMessage="This page encountered an error. Try refreshing.">
        {children}
      </ErrorBoundary>
    </Suspense>
  );
}

function LiveToolsKeepAlive() {
  const { pathname } = useLocation();
  const showAuto = pathname === "/auto-rolling-straddle";
  const showVega = pathname === "/vega-pulse";
  const [visited, setVisited] = useState({ auto: showAuto, vega: showVega });

  useEffect(() => {
    setVisited((prev) => ({
      auto: prev.auto || showAuto,
      vega: prev.vega || showVega,
    }));
  }, [showAuto, showVega]);

  return (
    <>
      {visited.auto && (
        <div className={showAuto ? "block" : "hidden"} aria-hidden={!showAuto}>
          <PageSuspense><AutoRollingStraddle /></PageSuspense>
        </div>
      )}
      {visited.vega && (
        <div className={showVega ? "block" : "hidden"} aria-hidden={!showVega}>
          <PageSuspense><VegaPulsePage /></PageSuspense>
        </div>
      )}
    </>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route element={<DashboardLayout />}>
            <Route path="/" element={<PageSuspense><Index /></PageSuspense>} />
            <Route path="/option-chain" element={<PageSuspense><OptionChain /></PageSuspense>} />
            <Route path="/oi-analysis" element={<PageSuspense><OIAnalysis /></PageSuspense>} />
            <Route path="/watchlist" element={<PageSuspense><Watchlist /></PageSuspense>} />
            <Route path="/strategy-builder" element={<PageSuspense><StrategyBuilder /></PageSuspense>} />
            <Route path="/position-tracker" element={<PageSuspense><PositionTracker /></PageSuspense>} />
            <Route path="/auto-rolling-straddle" element={<LiveToolsKeepAlive />} />
            <Route path="/vega-pulse" element={<LiveToolsKeepAlive />} />
            <Route path="/broker-settings" element={<PageSuspense><BrokerSettings /></PageSuspense>} />
          </Route>
          <Route path="*" element={<Suspense fallback={null}><NotFound /></Suspense>} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;

