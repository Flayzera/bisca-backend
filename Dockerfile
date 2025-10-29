# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Update packages for security patches
RUN apk update && apk upgrade

# Copy package files
COPY package*.json ./

# Install ALL dependencies (don't skip devDependencies)
RUN npm install

# Verify TypeScript is installed
RUN ls -la node_modules/.bin/tsc || echo "TypeScript binary not found"

# Copy tsconfig and source
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript - use direct path to tsc
RUN node_modules/.bin/tsc -p tsconfig.json || npm run build || exit 1

# Production stage
FROM node:20-alpine

WORKDIR /app

# Update packages for security patches
RUN apk update && apk upgrade

# Copy package files
COPY package.json package-lock.json* ./

# Install only production dependencies
RUN npm install --only=production

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# Expose port
EXPOSE 3000

# Start server
CMD ["npm", "start"]

