# Use Debian Bookworm to satisfy the GLIBC requirement for Node 26 + uWS
FROM node:26-bookworm-slim

# Set working directory
WORKDIR /usr/src/app

# Copy package files first (better caching)
COPY package*.json ./

# Install ALL dependencies (including devDependencies like typescript)
RUN npm install

# Copy your tsconfig.json, src folder, and the rest of your code
COPY . .

# Compile TypeScript to JavaScript (outputs to dist/ based on your initial command)
RUN npm run build

# Set environment variables for Render's defaults
ENV PORT=10000
ENV HOST=0.0.0.0

# Expose the port Render expects
EXPOSE 10000

# Start the compiled JavaScript application
CMD [ "node", "dist/index.js" ]