# syntax=docker/dockerfile:1
# The build output is static, so build it on the native platform even when the image is for another one.
FROM --platform=$BUILDPLATFORM node:26.13.1-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY index.html ./
COPY src ./src
RUN npm run build

FROM caddy:2.11.9-alpine AS runtime
# The binary may bind 80/443 without root. It only needs to own its cert and config dirs.
RUN adduser -S -D -H caddy && chown -R caddy /data /config
COPY --from=build /app/dist /srv
USER caddy
