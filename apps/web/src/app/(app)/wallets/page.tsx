import type { Metadata } from "next";
import { WalletsView } from "@/components/wallets/wallets-view";

export const metadata: Metadata = { title: "Wallets · Nébula" };

export default function WalletsPage() {
  return <WalletsView kind="wallet" />;
}
