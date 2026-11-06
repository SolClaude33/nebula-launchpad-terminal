import type { Metadata } from "next";
import { Suspense } from "react";
import { UnlockScreen } from "./unlock-screen";

export const metadata: Metadata = { title: "Desbloquear · Nébula" };

export default function UnlockPage() {
  return (
    <Suspense>
      <UnlockScreen />
    </Suspense>
  );
}
