FROM node:24-alpine
WORKDIR /app
ARG SERVICE
COPY --chown=node:node services/${SERVICE}/src ./src
ENV PORT=3000
USER node
EXPOSE 3000
CMD ["node", "src/server.mjs"]
