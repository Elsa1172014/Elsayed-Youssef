# Build context: repository root  (docker build -f apps/web/Dockerfile .)
FROM node:22-alpine AS build
WORKDIR /app
# The web app shares the pure playback/repair logic with the API (packages/core/src), imported by relative path.
COPY packages/core ./packages/core
WORKDIR /app/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web ./
# Same-origin API (Caddy proxies /v1 to the api service), so no API base is baked in.
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /app/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
