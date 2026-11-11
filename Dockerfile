# VKM 演示交易所 · 容器部署
FROM node:20-alpine

WORKDIR /app

# 后端服务
COPY backend/server.js backend/package.json ./backend/
# 前端页面（server.js 从上一级目录读取）
COPY 虚拟货币交易网站-云端版.html ./

RUN mkdir -p /app/backend/data

ENV PORT=8080
EXPOSE 8080

CMD ["node", "backend/server.js"]
