# Use a lightweight Node.js version (pinned for reproducibility)
FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Create non-root user for security (prevent privilege escalation)
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# Copy package files first to leverage Docker layer caching
COPY --chown=nodejs:nodejs package*.json ./

# Install production dependencies only to keep image small
# Use 'npm ci' for deterministic installs (respects package-lock.json)
# Use '--omit=dev' (npm 8+) instead of deprecated '--only=production'
RUN npm ci --omit=dev

# Copy the rest of the application source code
COPY --chown=nodejs:nodejs . .

# Switch to non-root user
USER nodejs

# Expose the API port
EXPOSE 3000

# Define command to run the app
CMD [ "npm", "start" ]
