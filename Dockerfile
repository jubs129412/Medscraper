FROM node:20-alpine

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci

COPY . .

ENV NODE_OPTIONS="--max-old-space-size=4096"

CMD ["node","server.js"]