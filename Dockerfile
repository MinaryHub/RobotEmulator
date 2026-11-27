FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /data && chown -R node:node /app /data

USER node
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    ROBOT_EMU_DATA_DIR=/data

VOLUME ["/data"]

EXPOSE 3000 502 1502 4840 7000 8080 8888 10023 10040/udp 10041/udp 12345 29999 30004 44818 61450/udp

HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/index.js", "--host", "0.0.0.0", "--data-dir", "/data", "--headless"]
