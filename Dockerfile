FROM node:22-bookworm-slim

WORKDIR /app

# Install dependencies first for better Docker layer caching
COPY package*.json ./

RUN npm ci

# Copy application source
COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]