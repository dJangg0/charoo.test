FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY apps apps
COPY packages packages
RUN npm run build && npm prune --omit=dev
FROM node:22-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["sh", "-c", "node --import tsx apps/api/src/migrate.ts && node --import tsx apps/api/src/server.ts"]
