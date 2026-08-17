# Build from the REPOSITORY ROOT, not from relay/:
#   fly deploy --config relay/fly.toml --dockerfile relay/Dockerfile
# The relay serves the same phone page the desktop does, and that page lives in
# src/shared, so the build context has to span both trees. One copy means the
# two can never drift.
#
# Two stages so the shipped image carries no compiler and no dev dependencies.
FROM node:22-alpine AS build
WORKDIR /app/relay
COPY relay/package.json relay/package-lock.json* ./
RUN npm install
COPY relay/tsconfig.json ./
COPY relay/src ./src
COPY src/shared/mobile-page.ts src/shared/pwa-assets.ts /app/src/shared/
RUN npm run build

FROM node:22-alpine
WORKDIR /app/relay
ENV NODE_ENV=production
COPY relay/package.json relay/package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/relay/dist ./dist
# The relay holds no secrets and no state, so it runs unprivileged.
USER node
EXPOSE 8080
CMD ["node", "dist/relay/src/server.js"]
