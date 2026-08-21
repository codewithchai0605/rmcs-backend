# Use the official Bun image
FROM oven/bun:latest

# Set working directory
WORKDIR /usr/src/app

# Copy package files first
COPY package.json bun.lockb* ./

# Install dependencies
RUN bun install

# Copy source code
COPY . .

# Render defaults
ENV PORT=10000
ENV HOST=0.0.0.0

EXPOSE 10000

CMD [ "bun", "run", "dist/index.js" ]