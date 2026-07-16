# --- build stage -----------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# --- runtime stage ---------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

ENV MCP_HTTP_PORT=8080
EXPOSE 8080
USER node

# Health check hits the unauthenticated /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD \
  node -e "require('http').get('http://127.0.0.1:'+(process.env.MCP_HTTP_PORT||8080)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/http.js"]
