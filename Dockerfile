# pr-rla and pr-rla-mcp in one image, built from this repository (no npm registry needed).
#
#   docker build -t pr-rla .
#   docker run --rm -v "$PWD:/audit" -w /audit -e GITHUB_TOKEN pr-rla status
#   docker run --rm -i -v "$PWD:/audit:ro" --entrypoint pr-rla-mcp pr-rla --root /audit   # the read-only MCP server
#
# docs/docker.md has the details: tokens, keys, file ownership and the MCP configuration for assistants.

# The base image, pinned by digest (the multi-architecture index of node:22-bookworm-slim, Node 22.23.5).
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.build.json tsconfig.sdk.json ./
COPY scripts/clean-dist.mjs scripts/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src src
RUN npm run build
COPY packages/pr-rla-mcp packages/pr-rla-mcp
RUN cd packages/pr-rla-mcp && npm ci --ignore-scripts --no-audit --no-fund && npm run build
# Production dependencies only, for the runtime stage.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && cd packages/pr-rla-mcp && npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE}
# git reads the git-file ledger's history; ssh-keygen signs and checks verdicts (record --sign, verify).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # An audit repository is mounted from the host and owned by another user: let git read it.
 && git config --system --add safe.directory '*'
WORKDIR /opt/pr-rla
COPY --from=build /src/package.json /src/package-lock.json ./
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/dist dist
COPY --from=build /src/packages/pr-rla-mcp/package.json packages/pr-rla-mcp/
COPY --from=build /src/packages/pr-rla-mcp/node_modules packages/pr-rla-mcp/node_modules
COPY --from=build /src/packages/pr-rla-mcp/dist packages/pr-rla-mcp/dist
COPY LICENSE README.md ./
RUN ln -s /opt/pr-rla/dist/cli.js /usr/local/bin/pr-rla \
 && ln -s /opt/pr-rla/packages/pr-rla-mcp/dist/bin.js /usr/local/bin/pr-rla-mcp \
 && chmod +x dist/cli.js packages/pr-rla-mcp/dist/bin.js
LABEL org.opencontainers.image.title="pr-rla" \
      org.opencontainers.image.description="Risk-limiting audits for code that reached a default branch without human review" \
      org.opencontainers.image.source="https://github.com/naren-ambati/pr-rla" \
      org.opencontainers.image.licenses="Apache-2.0"
USER node
WORKDIR /audit
ENTRYPOINT ["pr-rla"]
CMD ["--help"]
