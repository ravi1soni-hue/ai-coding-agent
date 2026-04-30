FROM node:22
WORKDIR /app

# Install backend dependencies
COPY backend/package*.json ./
RUN npm install

# Copy backend and frontend code
COPY backend/ ./
COPY frontend/ ./frontend

# Always force a fresh dist build
RUN rm -rf dist && npm run build

EXPOSE 3000
CMD ["node", "dist/index.js"]
