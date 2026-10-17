FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY index.html vite.config.js ./
COPY src ./src
COPY public ./public
COPY assets ./assets
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4180 DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src/data.js src/domain.js src/workflow-domain.js ./src/
COPY server ./server
COPY runner/archive.mjs ./runner/archive.mjs
COPY scripts/init-volume.mjs scripts/stage-secrets.mjs ./scripts/
USER node
EXPOSE 4180
CMD ["node","server/index.js"]
