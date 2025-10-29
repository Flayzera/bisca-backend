# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Update packages for security patches
RUN apk update && apk upgrade

# Copy package files
COPY package*.json ./

# Install ALL dependencies (don't skip devDependencies)
RUN npm ci || npm install

# Verify TypeScript is installed
RUN npx tsc --version || (echo "TypeScript not found!" && exit 1)

# Copy tsconfig and source
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript using npx to ensure it's found
RUN npx tsc -p tsconfig.json

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

