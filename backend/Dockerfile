FROM node:24-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY backend/package.json backend/package.json
RUN npm ci --workspaces --if-present

COPY shared/ shared/
COPY backend/ backend/

# Drop root privileges — node:alpine ships a non-root `node` user (uid 1000).
RUN chown -R node:node /app
USER node

EXPOSE 3001

CMD ["npm", "run", "start", "--workspace", "@muse/backend"]
