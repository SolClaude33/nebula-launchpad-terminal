import type { Metadata } from "next";
import { TokenPicker } from "./picker";

export const metadata: Metadata = { title: "Live · Nébula" };

export default function LiveIndexPage() {
  return <TokenPicker />;
}
