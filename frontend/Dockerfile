FROM node:24-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --workspaces --if-present

COPY shared/ shared/
COPY frontend/ frontend/

# next start requires a build artefact — without this step the container
# would fail with "Could not find a production build" on boot.
RUN npm run build --workspace @muse/frontend

RUN chown -R node:node /app
USER node

EXPOSE 3000

CMD ["npm", "run", "start", "--workspace", "@muse/frontend"]
