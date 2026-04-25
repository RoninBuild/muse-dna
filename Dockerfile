## All-in-one Dockerfile — runs backend + 4 agent services in a single
## container. Used for cost-conscious deployments (Render free tier, etc).
## See scripts/start-all-in-one.mjs for the in-container topology.

FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Workspace metadata first so Docker can cache the npm install layer.
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY backend/package.json backend/package.json
COPY agents/strategy/package.json agents/strategy/package.json
COPY agents/fast-search/package.json agents/fast-search/package.json
COPY agents/copywriter/package.json agents/copywriter/package.json
COPY agents/image/package.json agents/image/package.json

RUN npm ci --workspaces --include-workspace-root --omit=dev

# Source.
COPY shared/ shared/
COPY backend/ backend/
COPY agents/ agents/
COPY scripts/start-all-in-one.mjs scripts/start-all-in-one.mjs

# Drop root.
RUN chown -R node:node /app
USER node

# Render injects $PORT — backend reads it, agents are loopback-only.
EXPOSE 3001

CMD ["node", "scripts/start-all-in-one.mjs"]
