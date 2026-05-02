import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the bookmarklet (running on third-party origins) to load /embed.
  async headers() {
    return [
      {
        source: "/connector.js",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      },
    ];
  },
};

export default nextConfig;
