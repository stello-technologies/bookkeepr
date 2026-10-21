# Stage 1: Build & Dependencies
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install all dependencies (including devDependencies required for build/tsx execution)
RUN npm ci

# Copy the rest of the application source code
COPY . .

# Stage 2: Production Runner
FROM node:22-alpine AS runner

WORKDIR /app

# Set environment to production
ENV NODE_ENV=production

# Copy package files and install production-only dependencies for a lean final image
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the built application source files and folders (api, web, etc.) from builder
COPY --from=builder /app ./

# Expose the port (Render / Railway will automatically map your external port to this)
EXPOSE 3000

# Start the application using your npm script
CMD ["npm", "start"]
