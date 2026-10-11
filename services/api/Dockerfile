# Build context: repository root (docker build -f services/api/Dockerfile .)
FROM node:22-alpine
WORKDIR /app
COPY packages/core ./packages/core
COPY services/api ./services/api
WORKDIR /app/services/api
RUN npm ci
ENV NODE_ENV=production
EXPOSE 3000
# Required env: DATABASE_URL, SECRET_KEY (see .env.example). Serve behind HTTPS only.
CMD ["npx", "tsx", "src/server.ts"]
