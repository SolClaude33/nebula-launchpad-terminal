import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { readSessionToken } from "@/lib/server/session";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Nébula",
  description: "Terminal local para lanzar y operar tokens de Pump.fun.",
};

// El token cambia en cada arranque de la API: nunca cachear el HTML.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: LayoutProps<"/">) {
  const token = readSessionToken();
  return (
    <html
      lang="es"
      data-theme="dark"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <meta name="nebula-session" content={token} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
