# Stage 1: Build & Dependencies
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests and lockfile
COPY package*.json ./

# Install all dependencies (including devDependencies for tsx)
RUN npm ci

# Copy the rest of the application source code
COPY . .

# Stage 2: Production Runner
FROM node:22-alpine AS runner

WORKDIR /app

# Set environment to production
ENV NODE_ENV=production

# Copy package files and lockfile
COPY package*.json ./

# Install all dependencies (or keep devDependencies since tsx is needed for npm start)
RUN npm ci

# Copy the application source files from builder
COPY --from=builder /app ./

# Expose the port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]