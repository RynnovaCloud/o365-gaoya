这份 README 已经为你量身定制完毕，结合了你**“已推送到 Docker Hub”**的实际情况，去掉了所有冗余的源码编译步骤，主打一个“开箱即用”。

我还顺手帮你加了几个顶部的技术徽章（Badges），这会让你的 GitHub 仓库主页看起来非常专业。

你可以直接点击代码块右上角的“复制”按钮，粘贴到你的 `README.md` 文件中：

***

```markdown
# 🚀 Microsoft 365 Automation Console

![Node.js](https://img.shields.io/badge/Node.js-18.x-43853D?style=flat-square&logo=node.js)
![SQLite](https://img.shields.io/badge/SQLite-3-003B57?style=flat-square&logo=sqlite)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker)
![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)

本项目是一个基于 Node.js + SQLite 开发的 Microsoft 365 自动化账号配置与分发系统。系统已全面容器化，支持通过 Docker 一键拉取部署。内置“阅后即焚”的安全安装锁与全动态配置的管理后台，专为高效、安全的 M365 租户管理而设计。

## ✨ 核心特性

- **🎨 现代响应式 UI**：基于原生 JS 与 CSS 实现的类 Windows 11 Fluent Design 风格，包含平滑阻尼动画、Canvas 粒子背景与交互反馈。
- **⚡️ 零配置动态渲染**：前台站点的名称、可用域名列表下拉框均由后端 API 动态下发，修改配置无需触碰任何前端代码。
- **🛡️ 军工级安全锁**：首次部署初始化后，`/setup` 安装通道将从物理层面永久锁定，强制拦截一切越权篡改行为。
- **⚙️ 一站式管理后台**：内置独立的 `/admin` 控制台，支持随时热更新网站品牌、允许注册的域名以及访问邀请码。
- **📦 极致轻量部署**：无需编译源码，无需配置 Web 服务器，只需一个 Docker 镜像与一个 SQLite 数据库文件即可运行。

---

## 🛠️ 部署指南 (基于 1Panel / Docker)

由于项目核心代码已封装至 Docker 镜像，只需几步即可在任何支持 Docker 的面板（如 1Panel、宝塔）或 Linux 终端中拉取运行。

### 1. 准备宿主机目录与持久化文件
为了保证系统重启或升级后，你的**管理员账号、微软 API 密钥以及用户注册记录**不丢失，我们需要在宿主机创建一个空的数据库文件用于挂载。

```bash
# 1. 创建项目根目录
mkdir -p /opt/1panel/apps/m365-console
cd /opt/1panel/apps/m365-console

# 2. 创建一个空的数据库文件 (⚠️ 非常重要)
touch database.db
```
*(如果你使用 1Panel 面板，可以直接在【主机】->【文件】中手动新建文件夹和这个名为 `database.db` 的空文件)*

### 2. 创建 Docker Compose 编排文件
在刚才创建的 `m365-console` 目录下，新建 `docker-compose.yml` 文件，填入以下配置：

```yaml
version: '3.8'
services:
  m365-server:
    image: your-dockerhub-username/m365-app:latest  # ⚠️ 部署前请务必替换为你自己的 Docker Hub 镜像地址
    container_name: m365-console
    ports:
      - "3000:3000"  # 宿主机端口:容器内端口
    volumes:
      - ./database.db:/app/database.db  # 挂载数据库以实现数据持久化
    restart: always
```

### 3. 一键启动服务
**通过 1Panel 面板启动：**
1. 进入左侧菜单 **【容器】 -> 【编排】 -> 【创建编排】**。
2. 路径选择刚才创建的 `m365-console` 目录，确认读取到 YAML 文件后点击启动。

**通过 SSH 终端启动：**
```bash
docker-compose up -d
```

*(如需绑定域名并开启 HTTPS，请在 1Panel 的【网站】中创建一个反向代理站点，目标地址指向 `http://127.0.0.1:3000` 即可。)*

---

## 📖 运行与使用流图

### 阶段一：系统初始化 (First Run)
容器成功启动后，首次访问你的域名或 IP：
1. 系统会检测到数据库为空，自动拦截并将你重定向至安装向导：`http://your-domain.com/setup`。
2. 填写**站点显示名称**、**允许注册的域名**（多个用逗号隔开）、**系统邀请码**以及你的 **Microsoft 365 Graph API 凭据**（Tenant ID, Client ID, Secret）。
3. 提交成功后，系统即刻生效并施加安全锁，`/setup` 路径永久失效。

### 阶段二：日常运营 (User Portal)
- 用户访问首页 `http://your-domain.com`，系统会自动拉取你刚才配置的站点名称和域名列表。
- 用户输入合法信息与邀请码后，系统通过 API 实时在 M365 后台创建用户并分配订阅许可证 (SKU)。

### 阶段三：管理与维护 (Admin Dashboard)
- 访问后台入口：`http://your-domain.com/admin`。
- 使用在 `/setup` 阶段设置的超级管理员账号和密码登录。
- 在控制台中，你可以随时无缝修改：
  - `Site Name` (前台大标题)
  - `Allowed Domains` (下拉菜单里的域名选项)
  - `Access Token` (前台注册所需的邀请码，修改后旧码立即失效)

---

## 🚑 灾难恢复与系统重置
如果你忘记了管理员密码，或者更换了 M365 租户需要彻底重置系统配置，请按照以下步骤操作：
1. 在 1Panel 面板或终端中，停止当前运行的 `m365-console` 容器。
2. 清空宿主机 `m365-console` 目录下的 `database.db` 文件内容（或直接删除该文件后，重新 `touch database.db` 创建一个空文件）。
3. 重新启动容器。
4. 系统状态将重置为“未初始化”，你可以重新访问 `/setup` 进行全新部署。
