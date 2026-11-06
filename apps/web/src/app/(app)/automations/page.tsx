import type { Metadata } from "next";
import { Suspense } from "react";
import { AutomationsView } from "./automations-view";

export const metadata: Metadata = { title: "Automatizaciones · Nébula" };

export default function AutomationsPage() {
  return (
    <Suspense fallback={<div className="skeleton m-6 h-[50vh]" aria-busy="true" />}>
      <AutomationsView />
    </Suspense>
  );
}
