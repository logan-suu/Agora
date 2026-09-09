import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['dockerode', '@deepseek-ai/dsh-llm-pi-ai'],
};

export default nextConfig;
