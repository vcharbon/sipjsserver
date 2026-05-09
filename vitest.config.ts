import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Cap each test worker fork at 1 GB so a runaway test cannot starve
    // the rest of WSL. Applies to `npx vitest` as well as `npm run test*`.
    poolOptions: {
      forks: { execArgv: ["--max-old-space-size=1024"] },
    },
  },
})
