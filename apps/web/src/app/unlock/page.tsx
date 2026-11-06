import type { Metadata } from "next";
import { UnlockScreen } from "./unlock-screen";

export const metadata: Metadata = { title: "Desbloquear · Nébula" };

export default function UnlockPage() {
  return <UnlockScreen />;
}
