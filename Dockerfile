# Drop "bookworm" so Docker pulls the latest OS for Node 26 (which has the newer GLIBC)
FROM node:26

# Set working directory
WORKDIR /usr/src/app

# Copy package files first
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# Render defaults
ENV PORT=10000
ENV HOST=0.0.0.0

EXPOSE 10000

CMD [ "node", "dist/index.js" ]