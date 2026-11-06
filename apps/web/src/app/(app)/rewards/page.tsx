import type { Metadata } from "next";
import { RewardsView } from "./rewards-view";

export const metadata: Metadata = { title: "Comisiones · Nébula" };

export default function RewardsPage() {
  return <RewardsView />;
}
