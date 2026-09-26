import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A stray package-lock.json in the home folder makes Next guess the wrong root.
  turbopack: { root: __dirname },
  devIndicators: false, // hide the "N" badge so the dev preview matches the design
};

export default nextConfig;
