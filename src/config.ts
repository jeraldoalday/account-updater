import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  githubToken: process.env.GITHUB_TOKEN || undefined
};
