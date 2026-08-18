# Build from the REPOSITORY ROOT, not from relay/:
#
#   fly deploy . --config relay/fly.toml --dockerfile relay/Dockerfile
#
# fly takes the build context from deploy's first argument. The image needs the
# phone page from src/shared as well as relay/, so a context of relay/ alone
# fails on "/relay/tsconfig.json": not found.
#
# The page is copied INTO relay/src/shared rather than imported from ../src,
# which is what `npm run sync` does locally. Importing across trees made tsc's
# rootDir span two roots, and the emitted layout then depended on where the
# build ran — the container produced dist/relay/src/server.js importing a
# module that resolved but exported nothing.
#
# Two stages so the shipped image carries no compiler and no dev dependencies.
FROM node:22-alpine AS build
WORKDIR /app
COPY relay/package.json relay/package-lock.json* ./
RUN npm install
COPY relay/tsconfig.json ./
COPY relay/src ./src
# Same copy `npm run sync` performs, done here because the image has no ../src.
COPY src/shared/mobile-page.ts ./src/shared/mobile-page.ts
COPY src/shared/pwa-assets.ts ./src/shared/pwa-assets.ts
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY relay/package.json relay/package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The relay holds no secrets and no state, so it runs unprivileged.
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
