export default {
  distDir: process.env.PARKEASE_BUILD_DIR || '.next',
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${process.env.API_URL || 'http://127.0.0.1:5001'}/api/:path*` }];
  }
};
