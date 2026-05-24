FROM node:22-alpine

WORKDIR /app/server

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/ ./

ENV NODE_ENV=production
EXPOSE 8787 8790

# Default: Mines backend. Override in your platform to run `pvp-server.js`.
CMD ["node", "mines-server.js"]

