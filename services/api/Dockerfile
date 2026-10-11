# Build context: repository root (docker build -f services/api/Dockerfile .)
FROM node:22-alpine
WORKDIR /app
COPY packages/core ./packages/core
COPY services/api ./services/api
WORKDIR /app/services/api
RUN npm ci
ENV NODE_ENV=production
EXPOSE 3000
# NOTE: production start is blocked until real auth replaces devAuthenticator
# (see docs/DEPLOYMENT.md); the server refuses to boot with the dev authenticator.
CMD ["npx", "tsx", "src/server.ts"]
