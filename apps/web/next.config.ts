import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@meta-game/config", "@meta-game/contracts", "@meta-game/db"],
};

export default nextConfig;
