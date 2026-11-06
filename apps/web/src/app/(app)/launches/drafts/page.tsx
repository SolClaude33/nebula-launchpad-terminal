import type { Metadata } from "next";
import { LaunchesView } from "../launches-view";

export const metadata: Metadata = { title: "Borradores · Nébula" };

export default function DraftsPage() {
  return <LaunchesView tab="drafts" />;
}
