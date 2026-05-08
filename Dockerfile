FROM node:22

COPY backend/package*.json ./

RUN npm install

COPY backend/ ./

COPY frontend/ ./frontend

RUN npm --prefix frontend install
RUN npm --prefix frontend run build

RUN rm -rf dist && npm run build && test -d dist/templates/frontend && test -d dist/templates/backend

EXPOSE 3000

CMD ["node", "dist/index.js"]