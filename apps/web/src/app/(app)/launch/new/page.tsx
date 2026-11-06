import type { Metadata } from "next";
import { Suspense } from "react";
import { LaunchWizard } from "@/components/launch/wizard";

export const metadata: Metadata = { title: "Nuevo lanzamiento · Nébula" };

export default function NewLaunchPage() {
  return (
    <Suspense fallback={<div className="skeleton m-6 h-[70vh]" aria-busy="true" />}>
      <LaunchWizard />
    </Suspense>
  );
}
