FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]