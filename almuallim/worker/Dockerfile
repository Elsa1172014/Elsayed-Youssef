# Ingestion worker image. Build context = repository subfolder `almuallim/`.
#   docker build -f worker/Dockerfile -t almuallim-worker .
# Deploy to any container host (Fly.io, Railway, Render, ECS…). Needs egress to Supabase and OpenAI.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils fonts-noto-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY worker ./worker
ENV NODE_ENV=production
# Run as an unprivileged user
USER node
CMD ["npx", "tsx", "--tsconfig", "tsconfig.json", "worker/index.ts"]
