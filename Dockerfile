# Bun-based image. Bun runs the TypeScript entrypoint directly (no build step),
# so the runtime just needs the source + production dependencies.
FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Install production dependencies against the committed lockfile (reproducible).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# App source (Bun executes src/http.ts directly).
COPY src ./src
COPY tsconfig.json ./

ENV MCP_HTTP_PORT=8080
EXPOSE 8080
USER bun

# Health check hits the unauthenticated /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD \
  bun -e "fetch('http://127.0.0.1:'+(process.env.MCP_HTTP_PORT||8080)+'/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/http.ts"]
