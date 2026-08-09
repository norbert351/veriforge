/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  async rewrites() {
    // Proxy API calls through the web origin so the app works from any
    // browser with a single URL (no CORS, no baked localhost base).
    return [
      { source: "/health", destination: `${process.env.API_ORIGIN || "http://localhost:4000"}/health` },
      { source: "/v1/:path*", destination: `${process.env.API_ORIGIN || "http://localhost:4000"}/v1/:path*` },
    ];
  },
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      "pino-pretty": false,
      "accounts": false,
      "@react-native-async-storage/async-storage": false,
      "@metamask/connect-evm": false,
    };
    return config;
  },
};

export default nextConfig;
