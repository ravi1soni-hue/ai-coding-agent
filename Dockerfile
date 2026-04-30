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

# Install a simple static server for frontend
RUN npm install -g http-server

# Expose backend and frontend ports
EXPOSE 3000 8080

# Start both backend and frontend servers
CMD ["sh", "-c", "node dist/index.js & http-server ./frontend -p 8080"]
