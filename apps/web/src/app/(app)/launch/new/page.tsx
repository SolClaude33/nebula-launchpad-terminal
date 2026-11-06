import type { Metadata } from "next";
import { LaunchWizard } from "@/components/launch/wizard";

export const metadata: Metadata = { title: "Nuevo lanzamiento · Nébula" };

export default function NewLaunchPage() {
  return <LaunchWizard />;
}
