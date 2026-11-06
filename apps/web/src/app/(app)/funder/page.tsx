import type { Metadata } from "next";
import { WalletsView } from "@/components/wallets/wallets-view";

export const metadata: Metadata = { title: "Funder · Nébula" };

export default function FunderPage() {
  return <WalletsView kind="funder" />;
}
