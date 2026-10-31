# pi-remote hub image (docs/SPEC.md §10).
# Build from the REPO ROOT (shared/ must sit next to hub/):
#   docker build -f hub/Dockerfile .
# or just use hub/docker-compose.yml, which sets the context to "..".

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Copy the hub (server + package.json + web/ when present) and install
# production deps. npm wipes a stale copied node_modules, so a local
# dev install cannot leak into the image.
COPY hub/ ./
RUN npm install --omit=dev && npm cache clean --force

# server.mjs imports "../shared/protocol.mjs"; in dev that resolves to the
# repo-root shared/, in the image to /shared.
COPY shared/ /shared/

# /data is a mounted volume; pre-create it owned by the runtime user so the
# named volume initializes with node-writable permissions (tokens file).
RUN mkdir -p /data && chown node:node /data

# Run as the unprivileged "node" user (uid 1000). /data is a mounted volume
# and must be readable by uid 1000.
USER node

EXPOSE 8787

CMD ["node", "server.mjs"]
