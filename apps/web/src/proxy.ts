import { NextResponse, type NextRequest } from "next/server";

// NFR-SEC-003 en el lado de Next: el HTML lleva el token de sesión, así que una página con
// DNS rebinding (Host ajeno que resuelve a 127.0.0.1) no debe recibir nada.
const ALLOWED = new Set(["127.0.0.1:4317", "localhost:4317"]);

/**
 * NFR-SEC-005: CSP estricta con nonce por petición y sin scripts de terceros.
 * - `style-src-attr 'unsafe-inline'`: los atributos `style` que React renderiza no admiten nonce.
 * - Sin `upgrade-insecure-requests`: la app vive en http://127.0.0.1.
 * - Solo en desarrollo: `'unsafe-eval'`, `<style>` en línea y el WebSocket de recarga en caliente.
 */
function csp(nonce: string, host: string) {
  const dev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // En desarrollo la recarga en caliente inyecta <style> sin nonce; en producción solo nonce
    dev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "font-src 'self'",
    `connect-src 'self'${dev ? ` ws://${host}` : ""}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  if (!ALLOWED.has(host)) return new NextResponse("Host no permitido", { status: 403 });
  if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.next();

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = csp(nonce, host);
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", policy);
  return res;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)" }],
};
