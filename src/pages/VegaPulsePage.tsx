import { VegaPulse } from "@/components/VegaPulse";

export default function VegaPulsePage() {
  return (
    <div className="min-h-[calc(100vh-5.5rem)] space-y-3 animate-fade-in">
      <VegaPulse symbol="NIFTY" height={680} />
    </div>
  );
}
