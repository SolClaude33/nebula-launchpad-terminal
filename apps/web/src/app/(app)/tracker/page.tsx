import type { Metadata } from "next";
import { TrackerView } from "./tracker-view";

export const metadata: Metadata = { title: "Tracker · Nébula" };

export default function TrackerPage() {
  return <TrackerView />;
}
