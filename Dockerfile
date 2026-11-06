# syntax=docker/dockerfile:1

# 1. Base image using Node.js 22 LTS Alpine for a minimal, secure footprint
FROM node:22-alpine

# Set default production environment
ENV NODE_ENV=production
ENV PORT=3000

# Set working directory
WORKDIR /app

# Ensure proper permissions for the default non-root user
RUN chown -R node:node /app

# Switch to non-root user for security (Aikido & CIS Docker compliance)
USER node

# Copy package dependency manifests first to leverage Docker layer caching
COPY --chown=node:node package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source code
COPY --chown=node:node . .

# Expose the API server port
EXPOSE 3000

# Container healthcheck querying the public /health route
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

# Launch the server
CMD ["node", "index.js"]
