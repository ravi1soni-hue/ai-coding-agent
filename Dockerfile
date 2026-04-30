<<<<<<< HEAD
FROM node:22

=======
>>>>>>> d5580f5 (fix: re-init repo and force update Dockerfile)
COPY backend/package*.json ./

RUN npm install

COPY backend/ ./

COPY frontend/ ./frontend

RUN rm -rf dist && npm run build

EXPOSE 3000

<<<<<<< HEAD
CMD ["node", "dist/index.js"]


=======
CMD ["node", "dist/index.js"]
>>>>>>> d5580f5 (fix: re-init repo and force update Dockerfile)
