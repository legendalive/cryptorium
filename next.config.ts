/** @type {import('next').NextConfig} */
const isGithubActions = process.env.GITHUB_ACTIONS || false;

let repo = '';
if (isGithubActions && process.env.GITHUB_REPOSITORY) {
  repo = '/' + process.env.GITHUB_REPOSITORY.replace(/.*?\//, '');
}

const nextConfig = {
  output: 'export',
  trailingSlash: true, // REQUIRED for GitHub Pages static routing
  images: {
    unoptimized: true,
  },
  basePath: repo,
  assetPrefix: repo,
};

export default nextConfig;
