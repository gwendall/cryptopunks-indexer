# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev

COPY src ./src
COPY .env.example ./
COPY README.md ./

# Ensure data dir exists for bind/volume mounts
RUN mkdir -p /app/data

# Default command indexes once. Override with env TAIL=1 to keep polling.
ENV NODE_ENV=production
CMD ["node", "src/index.js", "sync"]

