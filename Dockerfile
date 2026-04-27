FROM node:22
WORKDIR /app
COPY backend/package*.json ./
RUN npm install
COPY backend/ .
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/index.js"]
