import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dashboard is a pure client of the SpanoAI API; no server secrets here.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000",
  },
  // No ESLint config in this workspace; don't block builds on it (types are
  // still checked).
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
