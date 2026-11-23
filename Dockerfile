FROM node:24-alpine
WORKDIR /app
ARG SERVICE
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node services/shared ./shared
COPY --chown=node:node services/${SERVICE}/src ./src
ENV PORT=3000
USER node
EXPOSE 3000
CMD ["node", "src/server.mjs"]
