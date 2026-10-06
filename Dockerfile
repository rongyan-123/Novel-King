FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY *.js *.mjs demo-data.json ./
COPY ai ./ai
COPY accounts ./accounts
COPY public ./public
COPY harness-plugins ./harness-plugins
COPY docs ./docs
COPY licenses ./licenses
COPY scripts/reset-account-password.mjs ./scripts/reset-account-password.mjs
RUN mkdir -p /var/lib/novel-king && chown node:node /var/lib/novel-king
USER node
ENV NODE_ENV=production NOVELKING_BIND=0.0.0.0 NOVELKING_ACCOUNT_ROOT=/var/lib/novel-king PORT=3741
EXPOSE 3741
CMD ["node", "account-server.mjs"]
