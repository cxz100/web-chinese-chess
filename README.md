# 网页版中国象棋

可上线部署的网页中国象棋对弈平台：支持**人机对战**与**在线人人对战**，
计时制为 **5 / 10 / 15 分钟 + 每步加 3 秒**（菲舍尔加秒制）。

## 功能

- **人机对战**：内置 α-β 搜索引擎（Web Worker 运行，不卡界面），三档难度（简单 / 中等 / 困难），可选执红、执黑或随机，支持悔棋
- **人人对战**：
  - 快速匹配（按时间档位自动配对）
  - 创建房间 + 房号邀请好友
  - 服务器权威走法校验与计时（防作弊）
  - 断线 60 秒内可重连（刷新页面自动恢复对局）
  - 认输、求和、再来一局（自动换边）
- **完整规则**：将军 / 绝杀 / 困毙（无子可动判负）/ 白脸将（王不见王）/ 蹩马腿 / 塞象眼 / 过河兵横走；三次重复局面判和
- **计时**：5 / 10 / 15 分钟包干 + 每步 3 秒加秒，超时判负；联机模式由服务器计时
- 中文着法记谱（如「炮二平五」）、最后一步高亮、将军提示、移动端自适应

## 本地运行

```bash
npm install
npm start          # 默认 http://localhost:3000，可用 PORT 环境变量修改端口
```

## 测试

```bash
npm test                                 # 规则引擎：perft(1-4) + 规则场景
node test/pvp.test.js ws://localhost:3000/ws   # 联机服务器集成测试（需先启动服务）
```

## 部署上线

应用是单个 Node 进程（Express 静态资源 + 同端口 WebSocket），无数据库，
任何支持 Node.js 或 Docker 的平台均可直接部署。

### Docker

```bash
docker build -t xiangqi .
docker run -d -p 80:3000 --restart unless-stopped xiangqi
```

### Render / Railway / Fly.io 等 PaaS

- Build 命令：`npm install`
- Start 命令：`npm start`
- 平台注入的 `PORT` 环境变量会被自动读取
- 健康检查端点：`GET /healthz`

### 自有服务器（Nginx 反向代理示例）

```nginx
server {
    listen 443 ssl;
    server_name chess.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WebSocket 必需
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

启用 HTTPS 后客户端自动使用 `wss://`，无需额外配置。

## 项目结构

```
server/server.js      # Express + WebSocket 服务：房间、匹配、计时、校验
shared/xiangqi.js     # 规则引擎（前后端共用）：走法生成、将军、终局判定
public/               # 前端（原生 JS，无构建步骤）
  js/main.js          #   页面与对局控制器
  js/board.js         #   Canvas 棋盘渲染与交互
  js/ai-worker.js     #   AI 引擎（迭代加深 α-β + 静态搜索）
  js/net.js           #   WebSocket 客户端（自动重连 + 会话恢复）
test/                 # 引擎单元测试 + 联机集成测试
```
