FROM node:22

WORKDIR /app

COPY backend/package*.json ./

RUN npm install

COPY backend/src ./src
COPY backend/tsconfig.json ./

COPY frontend/ ./frontend

RUN npm --prefix frontend install
RUN npm --prefix frontend run build

RUN npm run build && cp -r src/templates dist/templates

EXPOSE 3000

CMD ["node", "dist/index.js"]