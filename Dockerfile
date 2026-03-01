FROM node:20-slim

LABEL description="Streamy — touch-friendly YouTube Music jukebox with RTSP video stream"

# ── System deps: ffmpeg, yt-dlp, curl, python3
RUN apt-get update -qq && apt-get install -y -qq \
      ffmpeg curl python3 python3-pip xz-utils tar ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ── yt-dlp
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# ── mediamtx (RTSP server)
ARG MEDIAMTX_VERSION=1.9.1
ARG TARGETARCH
RUN set -e; \
    case "$(uname -m)" in \
      x86_64)        MTXARCH=amd64      ;; \
      aarch64|arm64) MTXARCH=arm64v8    ;; \
      armv7l)        MTXARCH=armv7      ;; \
      *)             MTXARCH=amd64      ;; \
    esac; \
    curl -fsSL \
      "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_${MTXARCH}.tar.gz" \
      -o /tmp/mediamtx.tar.gz \
    && tar -xzf /tmp/mediamtx.tar.gz -C /usr/local/bin mediamtx \
    && chmod +x /usr/local/bin/mediamtx \
    && rm /tmp/mediamtx.tar.gz

WORKDIR /app

# ── npm install (cached layer)
COPY package*.json ./
RUN npm install --omit=dev --silent

# ── Copy source
COPY . .

# ── Ports: 3000 (HTTP/WS) | 8554 (RTSP) | 8555 (RTSP UDP)
EXPOSE 3000 8554 8554/udp 8555/udp

ENV NODE_ENV=production \
    PORT=3000 \
    RTSP_PORT=8554 \
    RTSP_WIDTH=1280 \
    RTSP_HEIGHT=720 \
    RTSP_BITRATE=2M

CMD ["node", "src/server.js"]
