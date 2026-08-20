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
# Which of the desktop's shared files the relay needs, named in ONE place:
# relay/shared-files.txt, read by both `npm run sync` and the line below.
#
# It used to be a list here AND in the sync script. When identity.ts joined the
# script, this file kept its old two-file list, and the image compiled a
# server.ts importing a module the container did not have. The deploy failed
# on it.
#
# Copying all of src/shared instead does NOT work: the desktop's other shared
# files import without file extensions, which this package's node16 resolution
# rejects, and "include": ["src/**/*.ts"] compiles whatever is present.
COPY relay/shared-files.txt ./
COPY src/shared /tmp/desktop-shared
RUN mkdir -p src/shared && while read -r f; do \
      [ -n "$f" ] && cp "/tmp/desktop-shared/$f" src/shared/; \
    done < shared-files.txt && rm -rf /tmp/desktop-shared
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
