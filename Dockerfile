FROM node:22-alpine
# eMudhra CA distrust (Oct 2026): current CA bundle, and make Node trust it instead of its bundled root list
RUN apk add --no-cache --upgrade ca-certificates-bundle
ENV NODE_OPTIONS="--use-openssl-ca"
RUN apk add --no-cache curl
WORKDIR /app
COPY --chown=node:node server.mjs ./
COPY --chown=node:node artifact-assets/ ./artifact-assets/
COPY --chown=node:node enc/ ./enc/
USER node
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Structured JSON logs + request ids (logging standard, AGENTS.md; logkit/README.md). No IPs or user agents.
COPY logkit ./logkit
ENV LOG_APP=launch-thread-private-20261011 LOG_IP=0 LOG_UA=0
CMD ["node", "-r", "./logkit/logkit-preload.cjs", "server.mjs"]