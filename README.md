# Take Time Web

> 合作解谜卡牌《时之旅》(Take Time, by Libellud) 的网页联机版 — 2–4 人在线合作, 10 章节 / 40 钟面全可玩.

**在线玩**: [taketime-web.onrender.com](https://taketime-web.onrender.com)

---

## 关于这个项目

《时之旅》是一款由 Libellud 发行的法式合作解谜桌游: 2–4 名玩家在时间魔法师的引导下, 通过 12 张牌 + 6 段位 + 钟面图, 协作破解 10 个章节 / 40 个时间谜题. 桌面版需要主持人和实体配件, 门槛高.

**Take Time Web** 把这套机制完整搬到网页上:

- 朋友间开房即玩, 无需下载/注册/主持
- 章节规则由服务端 validator 严格判定, 不靠人脑
- 10 章节 / 40 钟面全实现, 包含 Ch6 差值 / Ch7 抽卡 / Ch8 旋转 / Ch9 相等 / Ch10 秒针 等进阶机制
- 玩家有稳定账号 (暗号制) + 私人房 + 小队战绩, 跨设备延续身份

目标: 让一桌 4 个朋友, 浏览器打开就能开始一局, 像玩 BGA (Board Game Arena) 一样轻量.

---

## 核心功能

### 游戏机制
- ✅ 10 章节全实现 (Ch1 觉醒 → Ch10 凝聚)
- ✅ 40 个独立钟面图, 每个有专属 validator
- ✅ 13 种 validator 类型, placement + resolution 双阶段
- ✅ 6 段圆桌布局 + 罗马数字时刻
- ✅ 自己的牌对自己明, 别人的牌保持隐藏 (符合原版桌游规则)

### 社交 / 账号
- ✅ **暗号账号系统** (passphrase): 朋友间用同一暗号就是同一人, 跨设备登入
- ✅ **私人房间** (4-12 字符密码), 不出现在公开大厅
- ✅ **小队历史**: 按小队聚合的战绩 + 胜率 + 连续
- ✅ **房主带队换关**: 终局后房主可一键切换章节/钟面, squad 一起换
- ✅ 4 人房 / 2-4 人动态 / 一键 bot 补齐

### 技术 / 体验
- ✅ **Turso 持久化**: 账号/历史跨重启保留 (Render free tier 文件 ephemeral)
- ✅ 实时同步 (WebSocket, Socket.IO)
- ✅ 13 个 e2e 测试全过, ~30s 跑完
- ✅ 桌面优先, 移动端可用但未深度优化
- ✅ 视觉风格: 深紫星空 + 金色罗盘 + 12 罗马数字 (TTS MOD 风)

---

## 技术栈

| 层 | 选型 | 为什么 |
|---|---|---|
| 后端 | Node.js + Express + Socket.IO | 实时多玩家同步; WebSocket 友好 |
| 前端 | Vanilla JS + CSS (无框架) | 项目体量 ~1500 行, 框架反而重; 不打包, 改完即用 |
| 持久化 | libSQL (Turso) | SQLite 兼容; 免费档 9GB; Render 文件 ephemeral 必选外部 DB |
| 部署 | Render (Blueprint) | 推 GitHub 自动 redeploy; 免费档够小圈子 |
| DNS / 代理 | Cloudflare | 免费 HTTPS + WebSocket + 隐藏源 IP |
| 测试 | socket.io-client + 自写 runner | 不引入 mocha/jest, 13 个文件共 ~30s |

---

## 快速开始 (本地)

```bash
# 1. 装依赖
npm install

# 2. 启动
npm start
# → http://localhost:3001

# 3. (可选) 跑测试
npm test
# → 13/13 e2e 全过
```

无任何环境变量需求 — 本地自动用 SQLite 文件 `data/dev.db` (gitignored).

---

## 玩法

1. 打开在线链接, 4 个朋友各自浏览器登录
2. 房主创房, 选章节 (10 选 1) + 钟面 (每章 4 选 1)
3. 其他人用房间号加入 (或开私人房, 4-12 字符密码)
4. ≥2 人后房主点 "开启迷局", 进入规则页
5. 每个玩家选 "我已就位", 全员就位后游戏开始
6. 轮流从手牌出 1 张到 6 段之一 (可盖牌), 12 张全出完判定胜负
7. 终局后房主可: 重新开始 / 换关卡 / 回首页

每章规则速查 (详细见代码 `server.js` 的 `CHAPTERS`):
- Ch1 觉醒 (基础) / Ch2 限制 (禁明牌) / Ch3 内外 (最高最低) / Ch4 咆哮 (强制顺序) / Ch5 宁静 (每段 1 张)
- Ch6 如上如下 (差值) / Ch7 入侵 (抽卡) / Ch8 革命 (旋转 + 禁段) / Ch9 统一 (全相等) / Ch10 凝聚 (秒针)

---

## 部署

代码已经在 GitHub, Render 监听 `main` 分支自动 redeploy, 无需手动操作.

### 首次部署 (一次性)
1. https://dashboard.render.com → 用 GitHub 登录
2. "New" → "Blueprint" → 选 `JuggerC/taketime-web` repo
3. Render 读 `render.yaml` 自动建 Web Service, 首次 `npm install` 约 2-3 分钟
4. 拿到 `https://taketime-web-xxxx.onrender.com` URL

### 之后改代码
本地 commit → GitHub Desktop push → Render 自动 redeploy (1-2 分钟).

### Turso 持久化 (账号 + 历史)

不配置时, server 用本地 SQLite; 但 Render 文件系统是 ephemeral, 所以**线上必须配 Turso**:

```bash
brew install tursodatabase/tap/turso
turso auth login
turso db create taketime
turso db show taketime --url              # → libsql://taketime-xxx.turso.io
turso db tokens create taketime           # → eyJ... 那一长串
```

然后到 Render 服务页 → Environment → 加:
- `TURSO_DATABASE_URL` = 上面的 URL
- `TURSO_AUTH_TOKEN` = 上面的 token

保存后自动 redeploy. 之后账号和历史跨重启保留.

### 自定义域名 (可选)

Render 服务页 → Settings → Custom Domains → 加 `taketime.你的域名.com` → Cloudflare 加 CNAME 记录 (Proxy 一定要开, 不然 WebSocket 可能断).

---

## 架构概览

```
┌─────────────────┐         ┌──────────────────────┐         ┌─────────────┐
│  浏览器 (玩家)  │ ◄─WS─► │  server.js (Express)  │ ◄─SQL─► │  Turso DB   │
│                 │         │                      │         │             │
│  index.html     │         │  • 房间状态机 (in-mem)│         │  users      │
│  client.js      │         │  • 16 个 socket hdlr │         │  tokens     │
│  style.css      │         │  • 13 种 validator   │         │  attempts   │
│  sounds.js      │         │  • Ch1-10 机制       │         │             │
└─────────────────┘         │  • 牌洗 / 发 / 结算  │         └─────────────┘
                            │  • bot AI            │
                            └──────────┬───────────┘
                                       │ (本地无 Turso 时)
                                       ▼
                            ┌──────────────────────┐
                            │  data/dev.db (SQLite) │
                            └──────────────────────┘
```

**状态机**: `lobby → waiting → rules_intro → ready → playing → finished`

**16 个 socket handler** (详见代码注释):
- 核心 11: `create_room` / `join_room` / `rejoin_room` / `fill_with_bots` / `start_game` / `i_am_ready` / `declare_first` / `play_card` / `disconnect` / `leave_room` / `restart_game` / `next_clock`
- 账号 4: `register_passphrase` / `login_passphrase` / `get_my_info` / `logout`
- 历史 1: `get_my_history`
- 换关 1: `change_level`

---

## 测试

13 个 e2e 测试, 覆盖章节机制 + 房主逻辑 + 账号 + 私人房 + 历史 + 换关:

```bash
npm test
# 期望: 13/13 全过 (~30s)
```

测试用 `socket.io-client` 直连 `http://127.0.0.1:3001`, 需要先 `npm start` 起服务.

---

## 开发历史

| 版本 | 日期 | 重要变更 |
|---|---|---|
| v0.4.0 | 2026-08-04 | 初始 Ch1–10 全部可玩 + Render 部署 |
| v0.4.x | 2026-08-04 | 自己的牌对自己明, 房主/leave/restart 逻辑, 终局按钮, 段位 hover tooltip |
| v0.5.0 | 2026-08-05 | **接入 Turso** (libSQL), 账号/历史跨重启保留 |
| v0.6.0 | 2026-08-05 | **Phase 1**: 暗号账号系统 + **Phase 2**: 私人房间 + **Phase 3**: 小队历史 |
| v0.6.x | 2026-08-05 | 登录面板改模态, 密码眼睛图标, UI 微调 |
| v0.7.0 | 2026-08-05 | **Phase 4**: 房主带队换关 + 死重资源清理 (42.7MB) |

24 个 commit, 1.5 天集中开发 (2026-08-04 → 2026-08-05).

---

## 路线图

### 短期 (接下来)
- [ ] Ch11 Regrets / Ch12 Rebirth (资源已就位, validator 待分析)
- [ ] Render free tier 冷启动优化 (UptimeRobot / 升 Starter)
- [ ] 启用 `sounds.js` (158 行 Web Audio 已写好, 等待 wire)

### 中期
- [ ] 移动端深度适配
- [ ] 旁观者模式
- [ ] Sentry / log tail 错误监控
- [ ] CI 自动跑测试

### 长期
- [ ] 自定义域名 + Cloudflare 全套
- [ ] 多实例 sticky session (50+ 人)
- [ ] AI 提示系统 (给真人玩家建议)

---

## 致谢

- **原作**: *Take Time* 桌游 by **Libellud** (法国, 2020)
- **图片资源**: 24 张牌 / 40 个钟面图为本项目原创, 风格参考 TTS (Tabletop Simulator) MOD
- **背景 / 装饰**: 本项目原创, 用 image generation 生成
- **部署平台**: [Render](https://render.com) free tier
- **数据库**: [Turso](https://turso.tech) free tier
- **DNS**: [Cloudflare](https://cloudflare.com) free tier

---

## License

个人项目, 仅供学习交流. 桌游机制版权归 Libellud 所有. 商业使用请先获得原作者授权.

代码部分如有引用需求请先联系作者.
