import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { Toaster } from "@/components/toaster";
import { VaultGate } from "@/components/shell/vault-gate";
import { ProfileBanner } from "@/components/shell/profile-banner";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-backdrop min-h-dvh">
      <Sidebar />
      <div className="flex min-h-dvh flex-col transition-[padding] duration-200 ease-[var(--ease)]" style={{ paddingLeft: "var(--sidebar-w)" }}>
        <ProfileBanner />
        <Topbar />
        <main className="flex-1">
          <VaultGate>{children}</VaultGate>
        </main>
      </div>
      <Toaster />
    </div>
  );
}
