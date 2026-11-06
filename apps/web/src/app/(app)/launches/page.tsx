import type { Metadata } from "next";
import { LaunchesView } from "./launches-view";

export const metadata: Metadata = { title: "Lanzamientos · Nébula" };

export default function LaunchesPage() {
  return <LaunchesView tab="launches" />;
}
