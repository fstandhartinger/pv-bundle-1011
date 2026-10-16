FROM node:22-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY --chown=node:node server.mjs ./
COPY --chown=node:node enc/ ./enc/
USER node
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
