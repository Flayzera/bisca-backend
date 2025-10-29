# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Update packages for security patches
RUN apk update && apk upgrade

# Copy package files
COPY package*.json ./

# Install ALL dependencies (don't skip devDependencies)
RUN npm ci || npm install

# Copy tsconfig and source
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript using npm script (uses local typescript from node_modules)
RUN npm run build || ./node_modules/.bin/tsc -p tsconfig.json

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

