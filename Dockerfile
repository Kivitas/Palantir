# OPTIONAL SELF-HOST ONLY. Not used by the Cloudflare Pages deployment (see docs/CLOUDFLARE.md).
# Builds the static app and serves it with nginx, proxying /osiris to a sidecar.
# Stage 1: build the Vite SPA
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: serve the static bundle with nginx (also proxies /osiris/ to the osiris service)
FROM nginx:1.27-alpine
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
