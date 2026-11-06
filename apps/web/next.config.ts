import type { NextConfig } from "next";

// Herramienta local de un solo operador: sin Cache Components ni prerender parcial,
// todo se renderiza en 127.0.0.1 bajo demanda.
const nextConfig: NextConfig = {
  poweredByHeader: false,
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
