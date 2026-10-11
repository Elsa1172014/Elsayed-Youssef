# Build context: repository root  (docker build -f apps/web/Dockerfile .)
FROM node:22-alpine AS build
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web ./
# Same-origin API (Caddy proxies /v1 to the api service), so no API base is baked in.
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /app/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
