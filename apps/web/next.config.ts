import type { NextConfig } from "next";

const API = `http://127.0.0.1:${process.env.NEBULA_API_PORT ?? 4318}`;

// Herramienta local de un solo operador: sin Cache Components ni prerender parcial,
// todo se renderiza en 127.0.0.1 bajo demanda.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@nebula/shared"],
  // La API local vive en otro puerto; el navegador solo habla con el mismo origen.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
