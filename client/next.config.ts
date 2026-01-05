import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // --- NEW: Hide the "N" Icon (Dev Indicators) ---
  devIndicators: {
    buildActivity: false,
    appIsrStatus: false,
  },

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
