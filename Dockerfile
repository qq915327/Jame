# VKM 演示交易所 · 容器部署
FROM node:20-alpine

WORKDIR /app

# 构建期拉取前端页面（sha256 校验，内容不对则构建直接失败而不是带着坏页面上线）
ARG PAGE_URL=https://aka.doubaocdn.com/s/KJBtUUWT27
ARG PAGE_SHA256=c5c22a0f0282c18349363c987134778946cd4b1ee7d2eb7130c02c9bed380d52
RUN apk add --no-cache curl \
 && curl -fsSL "$PAGE_URL" -o page.html \
 && echo "$PAGE_SHA256  page.html" | sha256sum -c - \
 && mv page.html "虚拟货币交易网站-云端版.html"

# 后端服务
COPY backend/server.js backend/package.json ./backend/

RUN mkdir -p /app/backend/data

ENV PORT=8080
EXPOSE 8080

CMD ["node", "backend/server.js"]
