FROM node:22

COPY backend/package*.json ./

RUN npm install

COPY backend/ ./

COPY frontend/ ./frontend

RUN rm -rf dist && npm run build

EXPOSE 3000

CMD ["node", "dist/index.js"]
