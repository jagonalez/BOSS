# Two stages so the shipped image carries no compiler and no dev dependencies.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The relay holds no secrets and no state, so it runs unprivileged.
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
