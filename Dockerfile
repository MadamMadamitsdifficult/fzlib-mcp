# 魔搭创空间 / 通用容器部署
FROM node:22-slim

WORKDIR /app

# 先装依赖，利用镜像层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# 创空间只认 7860，且必须绑 0.0.0.0 才能被外部访问
ENV FZLIB_HTTP_HOST=0.0.0.0 \
    FZLIB_HTTP_PORT=7860 \
    NODE_ENV=production

EXPOSE 7860

# 令牌不要写进镜像，放平台的环境变量 FZLIB_HTTP_TOKEN
CMD ["node", "src/http.js"]
