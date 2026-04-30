FROM node:22
WORKDIR /app

# Install backend dependencies
COPY backend/package*.json ./
RUN npm install

# Copy backend and frontend code
COPY backend/ ./
COPY frontend/ ./frontend

# Remove old dist and build backend
RUN rm -rf dist && npm run build

# Expose only backend port (serves both API and frontend)
EXPOSE 3000

# Start backend (serves API and static frontend)
CMD ["node", "dist/index.js"]
