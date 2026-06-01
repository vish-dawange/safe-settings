
// Normalize URL prefix: add leading '/' if missing, treat '/' as empty for root
const normalizePrefix = (prefix) => {
  if (!prefix || prefix === '/') return '';
  return prefix.startsWith('/') ? prefix : `/${prefix}`;
};

const basePath = normalizePrefix(process.env.SAFE_SETTINGS_HUB_URL_PREFIX || '/safe-settings');

const nextConfig = {
  output: "export",
  basePath: basePath,
  // Disable Next.js ESLint checks during builds
  eslint: {
    ignoreDuringBuilds: true,
  },
  async redirects() {
    return [
      {
        source: '/',
        destination: '/dashboard',
        permanent: false,
      },
    ];
  },
};

module.exports = nextConfig;
