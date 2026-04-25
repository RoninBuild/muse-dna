FROM node:24-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY agents/strategy/package.json agents/strategy/package.json
RUN npm ci --workspaces --if-present

COPY shared/ shared/
COPY backend/services/microeconomy.js backend/services/microeconomy.js
COPY backend/services/x402protocol.js backend/services/x402protocol.js
COPY agents/strategy/ agents/strategy/

RUN chown -R node:node /app
USER node

EXPOSE 3101

CMD ["npm", "run", "start", "--workspace", "@muse/strategy-agent"]
