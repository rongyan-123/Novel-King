FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY ai/research/rankings.mjs ai/research/ranking-reader.mjs ./ai/research/
USER node
ENV HOST=0.0.0.0 PORT=3798 NOVELKING_CHROMIUM_PATH=/usr/bin/chromium NOVELKING_BROWSER_CONTAINER=1 HOME=/tmp
CMD ["node", "ai/research/ranking-reader.mjs"]
