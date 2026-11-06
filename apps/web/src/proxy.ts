import { NextResponse, type NextRequest } from "next/server";

// NFR-SEC-003 en el lado de Next: el HTML lleva el token de sesión, así que una página con
// DNS rebinding (Host ajeno que resuelve a 127.0.0.1) no debe recibir nada.
const ALLOWED = new Set(["127.0.0.1:4317", "localhost:4317"]);

export function proxy(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  if (!ALLOWED.has(host)) return new NextResponse("Host no permitido", { status: 403 });
  return NextResponse.next();
}

export const config = { matcher: "/:path*" };
