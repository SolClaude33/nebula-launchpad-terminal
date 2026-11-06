import type { Metadata } from "next";
import { SetupScreen } from "./setup-screen";

export const metadata: Metadata = { title: "Crear bóveda · Nébula" };

export default function SetupPage() {
  return <SetupScreen />;
}
