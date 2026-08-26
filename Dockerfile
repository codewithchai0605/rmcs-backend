# Official Bun image. Bun runs TypeScript directly, so there's no separate
# tsc build/dist step anymore - the app runs straight from src/.
FROM oven/bun:latest

# Set working directory
WORKDIR /usr/src/app

# Copy package files first (better layer caching - deps only reinstall
# when package.json actually changes)
COPY package.json ./

# Install dependencies. --production skips devDependencies (typescript,
# vitest, @types/*) - none of them are needed at runtime since Bun executes
# TypeScript natively. If you commit a bun.lock, copy it above alongside
# package.json and add --frozen-lockfile here for reproducible installs.
RUN bun install --production

# Copy source
COPY . .

# Render defaults
ENV PORT=10000
ENV HOST=0.0.0.0o

EXPOSE 10000

CMD ["bun", "src/index.ts"]
