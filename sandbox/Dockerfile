FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS node
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /opt/deps
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && chmod -R a-w /opt/deps
COPY checker.mjs /opt/checker/checker.mjs
COPY execute.mjs /opt/deps/execute.mjs
RUN chmod 700 /opt/checker && chmod 600 /opt/checker/checker.mjs && mkdir /candidate && chmod 777 /candidate
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright NODE_NO_WARNINGS=1
WORKDIR /candidate
ENTRYPOINT ["node", "/opt/checker/checker.mjs"]
