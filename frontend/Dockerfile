FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html ./
COPY src ./src
ARG VITE_MAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
ENV VITE_MAP_TILE_URL=$VITE_MAP_TILE_URL
RUN npm run build

FROM nginx:1.28-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY proxy.inc /etc/nginx/lab3-proxy.inc
COPY --from=build /app/dist /usr/share/nginx/html
