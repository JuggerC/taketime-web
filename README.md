# Take Time Web — 部署指南

> 4 人在线卡牌游戏 · Ch1–10 已实现 · 准备上线给小圈子玩

## 0. 当前文件状态

```
.
├── server.js              # Node + Express + Socket.IO 后端 (单文件)
├── public/                # 静态前端 (HTML/CSS/JS/图片/钟面图)
│   ├── index.html
│   ├── style.css
│   ├── client.js
│   ├── sounds.js
│   └── img/               # 自包含, 无外链
├── package.json           # npm start 启动
├── render.yaml            # Render 部署配置 (一键 Blueprint)
├── .gitignore             # 排除 node_modules/HANDOFF/logs
├── README.md              # 本文件
└── test_*.js              # 7 个 e2e 测试 (开发用, 不影响生产)
```

无数据库. 状态全在内存 (`Map`), 重启 = 房间全丢. 对小圈子玩 OK.

---

## 1. 推代码到 GitHub (5 分钟)

```bash
cd /Users/cookie/.mavis/workspace/card_game_web_v4
git init
git add .
git commit -m "init: Ch1-10 ready for deploy"

# 方案 A: 已有 GitHub repo
git remote add origin git@github.com:你的用户名/taketime-web.git
git push -u origin main

# 方案 B: 没 repo, 在 github.com 网页上 "New repository" 叫 taketime-web (不要勾 README/.gitignore)
# 拿到 URL 后再 push
```

---

## 2. 部署到 Render (10 分钟)

### 方式 A: 用 render.yaml 一键 Blueprint

1. 打开 https://dashboard.render.com → 注册 (用 GitHub 登录最快, 30 秒)
2. 顶部 "New" → "Blueprint"
3. 选你的 GitHub repo
4. Render 自动读 `render.yaml` 创建 Web Service
5. 第一次部署要 2-3 分钟 (npm install)
6. 部署完会得到一个 URL: `https://taketime-web-xxxx.onrender.com`

### 方式 B: 手动创建

- "New" → "Web Service" → 选 repo
- Runtime: Node
- Build: `npm install`
- Start: `npm start`
- Instance Type: Free
- Region: Oregon
- Health Check Path: `/`

### Free tier 注意事项

- **15 分钟无活动会休眠**, 朋友第一次访问要等 10-30 秒冷启动
- 之后: 朋友分享 URL, 直接进 lobby
- 想要永远在线: 升级到 Starter $7/月, 或套 UptimeRobot 每 14 分钟 ping 一次保活

---

## 3. 加自定义域名 + Cloudflare (10 分钟)

### 3.1 找你的域名

进 Cloudflare 后台 (dash.cloudflare.com) → 左边 **"Websites"** 找你之前 Pages 部署过的域名.
如果没有, 进 **"Account Home" → "Register Domains"** 买一个 (几美元/年).

### 3.2 在 Render 加自定义域名

- 进你的 Web Service → "Settings" → "Custom Domains"
- 加 `taketime.你的域名.com` (或根域名, 见下)
- Render 会给你一个 `taketime-web-xxxx.onrender.com` 的 CNAME target

### 3.3 在 Cloudflare 加 DNS

进 Cloudflare → 你的域名 → DNS → Records:

| Type | Name | Target | Proxy |
|------|------|--------|-------|
| CNAME | taketime (或 @) | taketime-web-xxxx.onrender.com | Proxied (橙色云) |

**Proxy 一定要开**, Cloudflare 会:
- 自动 HTTPS (免费证书)
- WebSocket 支持 (默认开, 不用配)
- 隐藏 Render 真实 IP
- 国内访问稍有改善 (CF 边缘节点)

### 3.4 回到 Render 点 "Verify"

- 等 1-2 分钟 CF DNS 生效
- Render 会自动签 SSL 证书
- 完成

---

## 4. 验证清单

部署完测试这些:

- [ ] 打开 `https://taketime.你的域名.com` 看到 lobby
- [ ] 开 4 个浏览器窗口 (隐身) 进同一房间, 4 个 bot 玩一局
- [ ] 试 Ch1, Ch6 (差值), Ch7 (抽卡), Ch8 (旋转), Ch10 (秒针)
- [ ] 锁屏 20 分钟回来再开 → 验证冷启动 (free tier)
- [ ] 移动 4G 网络下测一下延迟

---

## 5. 常见坑

- **WebSocket 断连频繁**: 99% 是 Cloudflare 开了 "Under Attack Mode" 误伤. 关掉.
- **Render 显示 "Service Unavailable"**: 冷启动中, 等 30 秒.
- **移动网络连不上**: 部分企业代理会断 WebSocket, 自动 fallback 到 polling (server.js 已配).
- **忘了 NS 解析**: 域名在别的注册商, 要先把 NS 切到 Cloudflare.

---

## 6. 后续要不要做的

- [ ] 加数据库持久化 (房间/战绩), 不重启丢数据
- [ ] 加 rejoin token, 刷新页面不丢游戏
- [ ] 加 monitor (Sentry / log tail)
- [ ] CI 跑 test_*.js 自动验证
- [ ] 多实例 + sticky session (50+ 人玩再考虑)
- [ ] 套 UptimeRobot 防冷启动
- [ ] Ch11/Ch12 章节

先上线再说. 出问题喊我.
