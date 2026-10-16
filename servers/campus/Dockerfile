# ビルドコンテキストはリポジトリのルート:  docker build -f servers/campus/Dockerfile .
FROM node:26-slim AS build
RUN npm i -g pnpm@11.25.0
ENV CI=true
WORKDIR /app
COPY . .
ARG VITE_ENDPOINTS=""
ARG VITE_VAPID_PUBLIC_KEY=""
ARG VITE_RP_ID=""
RUN pnpm install --frozen-lockfile \
 && VITE_ENDPOINTS="$VITE_ENDPOINTS" VITE_VAPID_PUBLIC_KEY="$VITE_VAPID_PUBLIC_KEY" VITE_RP_ID="$VITE_RP_ID" pnpm -F @knct-log/pwa build \
 && pnpm install --frozen-lockfile --prod --filter @knct-log/server-campus...

FROM node:26-slim
WORKDIR /app
COPY --from=build /app /app
ENV DATA_DIR=/data STATIC_DIR=/app/apps/pwa/dist PORT=3000
VOLUME /data
EXPOSE 3000
WORKDIR /app/servers/campus
CMD ["node", "src/main.ts"]
