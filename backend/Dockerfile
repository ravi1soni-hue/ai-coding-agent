# Dockerfile for Railway, placed at repo root, using backend/package.json
FROM node:22
WORKDIR /app
COPY backend/package*.json ./
WORKDIR /app/backend
RUN npm install
WORKDIR /app
COPY backend ./backend
WORKDIR /app/backend
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/index.js"]
