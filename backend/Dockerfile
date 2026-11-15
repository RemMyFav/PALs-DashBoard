FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node test ./test
RUN npm test
COPY --chown=node:node integration ./integration
USER node
EXPOSE 4000
CMD ["node", "src/server.js"]
