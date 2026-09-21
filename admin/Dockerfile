# Stage 1: Build
FROM node:24.15.0-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Stage 2: Production
FROM node:24.15.0-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d

# Security: Create non-root user with explicit UID/GID
RUN groupadd -g 10002 admin && \
    useradd -r -u 10002 -g admin -d /app -s /sbin/nologin admin

WORKDIR /app

# Copy built application from builder
# Nitro's .output contains all runtime dependencies
COPY --from=builder --chown=admin:admin /app/.output ./.output

# Create tmp and writable TOTP state mount points.
RUN mkdir -p /tmp /var/lib/caconnection-admin && \
    chown -R admin:admin /tmp /var/lib/caconnection-admin

# Switch to non-root user
USER 10002:10002

# Expose port (not published to host)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:3000/admin/api/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

# Set environment variables
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV NITRO_PORT=3000

# Start the application
CMD ["node", ".output/server/index.mjs"]
