import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://127.0.0.1:8000/api/:path*',
      },
      {
        source: '/ws/:path*',
        // CHANGE BACK TO HTTP (Next.js handles the WS upgrade internally)
        destination: 'http://127.0.0.1:8000/ws/:path*', 
      },
    ];
  },
};

export default nextConfig;
