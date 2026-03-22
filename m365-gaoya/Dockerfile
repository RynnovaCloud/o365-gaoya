# 使用轻量级的 Node.js 18 镜像
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 先复制 package.json，利用 Docker 缓存加速依赖安装
COPY package*.json ./

# 安装生产环境依赖，并编译 sqlite3
RUN npm install --production

# 复制所有源代码到容器内
COPY . .

# 暴露 3000 端口
EXPOSE 3000

# 启动服务
CMD ["node", "server.js"]