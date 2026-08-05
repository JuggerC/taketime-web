# Take Time Web

> Libellud 合作解谜卡牌《时之旅》的网页联机版, 2–4 人, 10 章节全可玩, 账号 / 私人房 / 小队历史走 Turso 持久化.

在线: [taketime-web.onrender.com](https://taketime-web.onrender.com)

---

## 本地开发

```bash
npm install
npm start          # → http://localhost:3001
npm test           # 13 个 e2e 测试
```

无 Turso 环境变量时, server 自动用本地 SQLite `data/dev.db`. 房间状态在内存, 重启即丢 — 账号/历史不会丢.

---

## 部署 (Render)

代码已经在 GitHub, Render 监听 `main` 分支自动 redeploy, 不用手动操作.

首次部署 (一次性):
1. https://dashboard.render.com → 用 GitHub 登录
2. "New" → "Blueprint" → 选 `taketime-web` repo
3. Render 读 `render.yaml` 自动建 Web Service, 第一次 `npm install` 约 2-3 分钟
4. 拿到 `https://taketime-web-xxxx.onrender.com` URL

之后改代码: 本地 commit → GitHub Desktop push → Render 自动 redeploy, 1-2 分钟.

**Free tier 限制**: 15 分钟无活动会休眠, 朋友第一次访问要等 10-30 秒冷启动.

---

## Turso 持久化 (账号 + 小队历史)

Render free tier 文件系统是 ephemeral 的, 每次 deploy / restart 全清. 所以账号和历史走外部 [Turso](https://turso.tech) (libSQL 兼容, 免费档 9GB).

**本地**: 不设环境变量就行, 走 `data/dev.db`.

**Render**: 服务页 Environment 加两条:
- `TURSO_DATABASE_URL` — `libsql://taketime-xxx.turso.io`
- `TURSO_AUTH_TOKEN` — Turso 创的 token

拿这俩值的方法:
```bash
brew install tursodatabase/tap/turso
turso auth login
turso db create taketime
turso db show taketime --url              # 抄 URL
turso db tokens create taketime           # 抄 token
```

加完 env var 后 Render 自动 redeploy, 之后账号和历史跨重启保留.

---

## 自定义域名 (可选, 10 分钟)

1. Render 服务页 → "Settings" → "Custom Domains" → 加 `taketime.你的域名.com`
2. Cloudflare → 域名 → DNS → Records → 加 CNAME 指向 Render 给的 target
3. 回到 Render 点 "Verify", 等 1-2 分钟

**Cloudflare Proxy 一定要开** (橙色云), 不然 WebSocket 可能断.

---

## 验证 + 常见坑

部署完测这些:
- [ ] 打开 URL 看到 lobby
- [ ] 4 个浏览器窗口 (隐身) 进同一房, 4 bot 玩一局
- [ ] 注册暗号 → 关浏览器再开 → 自动登入 (验证 Turso)
- [ ] 锁屏 20 分钟回来再开 (验证冷启动)
- [ ] 移动 4G 测延迟

常见坑:
- **WebSocket 断连频繁** → 99% 是 Cloudflare "Under Attack Mode" 误伤, 关掉
- **Service Unavailable** → 冷启动中, 等 30 秒
- **移动网络连不上** → 部分企业代理会断 WebSocket, 已配 polling fallback
- **域名在别的注册商** → 先把 NS 切到 Cloudflare

---

## 玩法

进入 lobby → 选章节/钟 (10 章 × 4 钟) → 创房或加房 → 2-4 人 → 一局 12 张牌, 6 段每段 2 张, 出完看胜负. 详细章节机制看 [HANDOFF.md](./HANDOFF.md) § 8 (本仓库 gitignore, 留本地).
