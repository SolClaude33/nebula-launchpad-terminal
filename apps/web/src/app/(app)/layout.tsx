import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { Toaster } from "@/components/toaster";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-backdrop min-h-dvh">
      <Sidebar />
      <div className="flex min-h-dvh flex-col transition-[padding] duration-200 ease-[var(--ease)]" style={{ paddingLeft: "var(--sidebar-w)" }}>
        <div className="telemetry flex h-6 items-center justify-center gap-2 border-b border-warn/20 bg-[var(--warn-soft)] text-[10px] text-warn">
          Perfil de pruebas · validador local · datos simulados
        </div>
        <Topbar />
        <main className="flex-1">{children}</main>
      </div>
      <Toaster />
    </div>
  );
}
