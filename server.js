// server.js — Take Time (v4) Web Edition
//
// Architecture inherited from v3 (Jester's Court), adapted for the real
// Take Time ruleset (Libellud, by Alexi Piovesan & Julien Prothière).
//
// Game baseline (Ch1 Awakening):
//   - 2-4 players
//   - 24 cards in deck: 12 Solar (yellow/gold) + 12 Lunar (blue/silver), values 1-12
//   - 12 cards dealt total (hand size scales inversely with player count):
//       2P: 6 each   3P: 4 each   4P: 3 each
//   - 6 segments on a clock face (Hand + 5 others, clockwise)
//   - Standard rules (Ch1): each segment ≥ 1 card, ascending clockwise, ≤ 24
//       (the ≤ 24 limit is relaxed for the first 3 Ch1 clocks — the rulebook
//        shows a special symbol; we don't enforce in code, the RulesSheet image
//        is shown to players for self-checking)
//   - Per-clock special rules: shown in RulesSheet image, not enforced in v4
//   - Face-up plays per round = player count
//   - Discussion phase (silent-looking) → Placement phase → Resolution phase
//
// v4 differences from v3:
//   - Card deck is Solar/Lunar (12+12, values 1-12) instead of black/white (2 copies each)
//   - Segments are on a clock-face image (6 pie slices), not 6 horizontal slots
//   - Lobby: chapter picker + clock picker + player count
//   - 2-4 players supported
//   - Hand size and face-up limit derive from player count

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3001;  // v4 uses 3001 to avoid v3's :3000
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const ATTEMPTS_FILE = path.join(DATA_DIR, 'attempts.json');

const app = express();
const server = http.createServer(app);
// Socket.IO production 配置:
//   - pingTimeout/pingInterval 加大: 防止 Render/Cloudflare 中间代理超时导致误断
//   - transports: 优先 websocket, fallback 到 polling (兼容企业代理)
//   - cors: 允许任意源, 上线后建议限制为自家域名
const io = new Server(server, {
  pingTimeout: 60000,         // 60s 等待 pong (默认 20s 太短)
  pingInterval: 25000,        // 25s 发送 ping (默认 25s)
  transports: ['websocket', 'polling'],
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6,     // 1MB, 默认
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));

// ---------------------------------------------------------------------------
// Chapter & Clock definitions
// ---------------------------------------------------------------------------
//
// Segments are 1-indexed in the public state. Segment 1 is always the
// "Hand" segment (where the clock hand points). In TakeTime Ch1, the hand
// always points to segment 1. In later chapters (Ch3+) the hand can be
// positioned on any segment — out of scope for v4 demo.
//
// Per-clock "validators" enforce the per-clock special rules (the icons
// on the physical clock face / rulesheet). The v4 demo enforces the
// subset of validator types below — see VALIDATOR_HELPERS. New types can
// be added without touching the placement/resolution code paths.
// ---------------------------------------------------------------------------

// Validators are declarative objects attached to each clock:
//
//   { type: 'first_card_at',     n: 1, segment: 3 }
//     The Nth card placed by the group must go to `segment` (1-indexed).
//   { type: 'second_card_at',    segment: 2 }
//     The 2nd card placed by the group must go to `segment`.
//   { type: 'segment_count',     segment: 4, count: 1 }
//     `segment` must contain exactly `count` cards at end.
//   { type: 'segment_value_range', segment: 1, min: 1, max: 12 }
//     The sum of cards at `segment` must be in [min, max].
//   { type: 'segment_closest_to', segment: 2, value: 1 }
//     No other segment's sum may be closer to `value` than this one's.
//   { type: 'segment_no_value',  segment: 3, values: [1, 12] }
//     No card at `segment` may have any of the listed values.
//
// All segments are 1-indexed in the validator spec (matches UI / wire).
// In the server-internal code we use 0-indexed (segIdx = segment - 1).

// ---------------------------------------------------------------------------
// Player colors (lobby picker + border color on cards)
// ---------------------------------------------------------------------------
const PLAYER_COLORS = [
  { id: 'gold',   name: '金',   hex: '#d4af37' },
  { id: 'azure',  name: '青',   hex: '#60a5fa' },
  { id: 'rose',   name: '玫',   hex: '#f472b6' },
  { id: 'jade',   name: '翠',   hex: '#34d399' },
];
const PLAYER_COLOR_IDS = PLAYER_COLORS.map(c => c.id);
const PLAYER_COLOR_HEX = Object.fromEntries(PLAYER_COLORS.map(c => [c.id, c.hex]));

const CHAPTERS = {
  ch01_awakening: {
    id: 'ch01_awakening',
    name: 'Chapter I',
    subtitle: 'Awakening · 觉醒',
    description: '基础关卡：把 12 张牌盖放在钟面 6 段上。摆完翻牌，验证每段≥1、顺时针非递增、≤24。每章递增新机制。',
    rulesheet: 'img/rules/ch01_face.png',
    n_segments: 6,
    // Segment labels — clockwise from Hand. We use roman numerals for the
    // "slot" name to mirror the rulebook's segment labelling.
    segment_names_en: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    segment_names_zh: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    // Standard Ch1 rules (apply to every clock in this chapter)
    standard_rules: {
      min_per_segment: 1,
      ascending: true,        // segment[i+1].sum >= segment[i].sum
      max_value: 24,          // hard cap
      max_value_relaxed_clocks: [1, 2, 3],  // Ch1 clocks #1, #2, #3 relax this
    },
    clocks: [
      {
        id: 'c1',
        name: 'Clock I-1',
        subtitle: '第一钟',
        image: 'img/clocks/ch01/Clock_01_C1_face.png',
        rulesheet: 'img/clocks/ch01/Clock_01_C1_face.png',  // 每钟自己的盘面做规则卡
        // 表盘规则 (按本游戏布局: 12点=seg1/Hand, 顺时针 2点=seg2, 4点=seg3, 6点=seg4, 8点=seg5, 10点=seg6):
        //   - 12 点 (seg 1 / Hand): 单张白牌图标 (Lunar) → 恰好 1 张白牌
        //   - 10 点 (seg 6 / VI):    3 张牌堆 → 恰好 3 张
        validators: [
          { type: 'segment_lunar_count', segment: 1, count: 1 },
          { type: 'segment_count', segment: 6, count: 3 },
        ],
      },
      {
        id: 'c2',
        name: 'Clock I-2',
        subtitle: '第二钟',
        image: 'img/clocks/ch01/Clock_01_C2_face.png',
        rulesheet: 'img/clocks/ch01/Clock_01_C2_face.png',
        //   - 4 点 (seg 3 / III): "8-12" 徽章 → 点数和 ∈ [8, 12]
        //   - 6 点 (seg 4 / IV):  3 张牌堆 → 恰好 3 张
        validators: [
          { type: 'segment_value_range', segment: 3, min: 8, max: 12 },
          { type: 'segment_count', segment: 4, count: 3 },
        ],
      },
      {
        id: 'c3',
        name: 'Clock I-3',
        subtitle: '第三钟',
        image: 'img/clocks/ch01/Clock_01_C3_face.png',
        rulesheet: 'img/clocks/ch01/Clock_01_C3_face.png',
        //   - 4 点 (seg 3 / III):  "1" 徽章 → 第 1 张牌放在这里
        //   - 2 点 (seg 2 / II):   "2" 徽章 → 第 2 张牌放在这里
        //   - 10 点 (seg 6 / VI):  "20-30" 徽章 → 点数和 ∈ [20, 30]
        validators: [
          { type: 'first_card_at', segment: 3 },
          { type: 'second_card_at', segment: 2 },
          { type: 'segment_value_range', segment: 6, min: 20, max: 30 },
        ],
      },
      {
        id: 'c4',
        name: 'Clock I-4',
        subtitle: '第四钟',
        image: 'img/clocks/ch01/Clock_01_C4_face.png',
        rulesheet: 'img/clocks/ch01/Clock_01_C4_face.png',
        //   - 12 点 (seg 1 / Hand): "6" 徽章 → 点数和最接近 6
        //   - 6 点 (seg 4 / IV):    双牌图标 (推测: 1 太阳 + 1 月亮)
        validators: [
          { type: 'segment_closest_to', segment: 1, value: 6 },
          { type: 'segment_color_count', segment: 4, solar: 1, lunar: 1 },
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Chapter II — Limitation (限制)
  // -------------------------------------------------------------------------
  // 章节大关规则 (PLACEMENT): "Players cannot place any cards faceup for
  // this test (not even with Bonus tokens when making another attempt after
  // a failure)."  → 所有牌必须盖牌, 整章 `no_faceup_plays: true`
  // 章节小关规则 (RESOLUTION): "No card with any of the depicted values
  // must have been placed next to this segment."  → 每段禁用表盘徽章画
  // 出的 3 个值 (整组禁用, 来自 leaflet 原文 "any of the depicted values")
  // 其他规则与 Chapter I 相同 (段值递增、≤24、每段≥1张), 但 ≤24 全章
  // 都强制 (没有像 Ch1 那样前三钟放松).
  // -------------------------------------------------------------------------
  ch02_limitation: {
    id: 'ch02_limitation',
    name: 'Chapter II',
    subtitle: 'Limitation · 限制',
    description: '限制关卡：本章节所有牌必须盖牌放置（不可明牌传递信息），每段根据表盘徽章禁用若干点数。其他规则与 Chapter I 相同（段值递增、≤24、每段≥1张）。',
    rulesheet: 'img/rules/ch02_face.png',
    n_segments: 6,
    segment_names_en: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    segment_names_zh: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    standard_rules: {
      min_per_segment: 1,
      ascending: true,
      max_value: 24,
      max_value_relaxed_clocks: [],   // Ch02 全章强制 ≤24
      no_faceup_plays: true,          // 大关规则: 整章禁明牌
    },
    clocks: [
      // -------------------------------------------------------------------
      // Clock II-1: 12点(I) / 2点(II) / 4点(III) 三段各禁用 {1,2,3}
      // -------------------------------------------------------------------
      {
        id: 'c1',
        name: 'Clock II-1',
        subtitle: '第一钟',
        image: 'img/clocks/ch02/Clock_02_C1_face.png',
        rulesheet: 'img/clocks/ch02/Clock_02_C1_face.png',
        // 12点(I) / 2点(II) / 4点(III) 各有一个红 X 徽章, 徽章下显示 1,2,3
        // → 这三段都不能放值为 1/2/3 的牌 (任何一张都不行)
        validators: [
          { type: 'segment_no_value', segment: 1, values: [1, 2, 3] },
          { type: 'segment_no_value', segment: 2, values: [1, 2, 3] },
          { type: 'segment_no_value', segment: 3, values: [1, 2, 3] },
        ],
      },
      // -------------------------------------------------------------------
      // Clock II-2: 4点(III) 禁 {7,8,9}; 6点(IV) 禁 {7,8,9}
      // (12点 I 段没有徽章 — 用户纠正: 之前误读成 1,2,3, 实际是空的)
      // -------------------------------------------------------------------
      {
        id: 'c2',
        name: 'Clock II-2',
        subtitle: '第二钟',
        image: 'img/clocks/ch02/Clock_02_C2_face.png',
        rulesheet: 'img/clocks/ch02/Clock_02_C2_face.png',
        validators: [
          { type: 'segment_no_value', segment: 3, values: [7, 8, 9] },
          { type: 'segment_no_value', segment: 4, values: [7, 8, 9] },
        ],
      },
      // -------------------------------------------------------------------
      // Clock II-3: 12点(I) 禁 {1,2,3}; 4点(III) 禁 {4,5,6};
      //             6点(IV) 禁 {7,8,9}; 10点(VI) 禁 {10,11,12}
      // (用户纠正: {10,11,12} 徽章在 10 点位置 → seg 6, 之前误读成 seg 5)
      // -------------------------------------------------------------------
      {
        id: 'c3',
        name: 'Clock II-3',
        subtitle: '第三钟',
        image: 'img/clocks/ch02/Clock_02_C3_face.png',
        rulesheet: 'img/clocks/ch02/Clock_02_C3_face.png',
        validators: [
          { type: 'segment_no_value', segment: 1, values: [1, 2, 3] },
          { type: 'segment_no_value', segment: 3, values: [4, 5, 6] },
          { type: 'segment_no_value', segment: 4, values: [7, 8, 9] },
          { type: 'segment_no_value', segment: 6, values: [10, 11, 12] },
        ],
      },
      // -------------------------------------------------------------------
      // Clock II-4: 表盘中心"红 X 眼" + 4 只红鸟 — 推测为 "全章监视"
      // 主题装饰, 没有额外的段位数值规则. 仅适用章节大关规则 (全盖牌).
      // -------------------------------------------------------------------
      {
        id: 'c4',
        name: 'Clock II-4',
        subtitle: '第四钟',
        image: 'img/clocks/ch02/Clock_02_C4_face.png',
        rulesheet: 'img/clocks/ch02/Clock_02_C4_face.png',
        validators: [],
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Chapter III — As Within, So Without (如其在内如其在外)
  // -------------------------------------------------------------------------
  // 引入 Clock Hand 机制. v4 demo 简化: 章节级 `clock_hand_segment`
  // (固定为 1/I 段, 玩家不能协商), per-clock validators 里再加
  // `lowest_card_at` / `highest_card_at` 来表达"该钟的 Clock Hand 段必须
  // 放最低/最高值卡".
  // 其他规则与 Chapter I 相同.
  // -------------------------------------------------------------------------
  ch03_as_within_so_without: {
    id: 'ch03_as_within_so_without',
    name: 'Chapter III',
    subtitle: 'As Within, So Without · 如其在内如其在外',
    description: '引入 Clock Hand 机制。v4 demo 简化为章节级 clock_hand_segment 固定指向某段（每钟不同），该段必须含全组的最低/最高值卡。其他规则与 Chapter I 相同。',
    rulesheet: 'img/rules/ch03_face.png',
    n_segments: 6,
    segment_names_en: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    segment_names_zh: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    standard_rules: {
      min_per_segment: 1,
      max_per_segment: null,
      ascending: true,
      max_value: 24,
      max_value_relaxed_clocks: [],   // Ch3 全章强制 ≤24
      no_faceup_plays: false,
      clock_hand_segment: 1,           // 默认 Clock Hand 段 (per-clock 可覆盖)
    },
    clocks: [
      // III-1: 12点(I) 是 Clock Hand 段 (紫色+号徽章); 2点(II) 恰好 1 张; 6点(IV) 点数和 ≈ 20
      {
        id: 'c1',
        name: 'Clock III-1',
        subtitle: '第一钟',
        image: 'img/clocks/ch03/Clock_03_C1_face.png',
        rulesheet: 'img/clocks/ch03/Clock_03_C1_face.png',
        // per-clock clock_hand_segment 覆盖章节默认 (1) — 这里 Clock Hand 也在 I 段
        clock_hand_segment: 1,
        validators: [
          { type: 'lowest_card_at', segment: 1 },
          { type: 'segment_count', segment: 2, count: 1 },
          { type: 'segment_closest_to', segment: 4, value: 20 },
        ],
      },
      // III-2: 6点(IV) 是 Clock Hand 段 (compass 指南针徽章)
      {
        id: 'c2',
        name: 'Clock III-2',
        subtitle: '第二钟',
        image: 'img/clocks/ch03/Clock_03_C2_face.png',
        rulesheet: 'img/clocks/ch03/Clock_03_C2_face.png',
        clock_hand_segment: 4,         // Clock Hand 指向 IV
        validators: [
          { type: 'lowest_card_at', segment: 4 },
        ],
      },
      // III-3: 12点(I) 是 Clock Hand 段; 4点(III) 恰好 2 张; 6点(IV) 第 1+2 张牌
      {
        id: 'c3',
        name: 'Clock III-3',
        subtitle: '第三钟',
        image: 'img/clocks/ch03/Clock_03_C3_face.png',
        rulesheet: 'img/clocks/ch03/Clock_03_C3_face.png',
        clock_hand_segment: 1,
        validators: [
          { type: 'lowest_card_at', segment: 1 },
          { type: 'segment_count', segment: 3, count: 2 },
          { type: 'first_card_at', segment: 4 },
          { type: 'second_card_at', segment: 4 },
        ],
      },
      // III-4: 12点(I) 是 Clock Hand 段; 6点(IV) 点数和 ≈ 6; 10点(VI) 1S+1L
      {
        id: 'c4',
        name: 'Clock III-4',
        subtitle: '第四钟',
        image: 'img/clocks/ch03/Clock_03_C4_face.png',
        rulesheet: 'img/clocks/ch03/Clock_03_C4_face.png',
        clock_hand_segment: 1,
        validators: [
          { type: 'lowest_card_at', segment: 1 },
          { type: 'segment_closest_to', segment: 4, value: 6 },
          { type: 'segment_color_count', segment: 6, solar: 1, lunar: 1 },
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Chapter IV — Roar (咆哮)
  // -------------------------------------------------------------------------
  // 整章强制出牌顺序: 玩家每回合必须出 "最大/最小/最左" 的牌.
  // per-clock `forced_play` 字段决定具体哪种. 玩家不能协商, bot 自动遵守.
  // 12 张手牌拿起来后顺序不能改 (按 Discussion Phase 看到的顺序).
  // 其他规则与 Chapter I 相同.
  // -------------------------------------------------------------------------
  ch04_roar: {
    id: 'ch04_roar',
    name: 'Chapter IV',
    subtitle: 'Roar · 咆哮',
    description: '强制出牌顺序：每回合必须出 "最大/最小/最左" 的牌（每钟不同）。手牌顺序在讨论阶段后固定。其他规则与 Chapter I 相同。',
    rulesheet: 'img/rules/ch04_face.png',
    n_segments: 6,
    segment_names_en: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    segment_names_zh: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    standard_rules: {
      min_per_segment: 1,
      max_per_segment: null,
      ascending: true,
      max_value: 24,
      max_value_relaxed_clocks: [],
      no_faceup_plays: false,
    },
    clocks: [
      // IIII-1: 强制出"最左" (中心有指南针/T 标记)
      {
        id: 'c1',
        name: 'Clock IV-1',
        subtitle: '第一钟',
        image: 'img/clocks/ch04/Clock_04_C1_face.png',
        rulesheet: 'img/clocks/ch04/Clock_04_C1_face.png',
        forced_play: 'leftmost',
        validators: [],
      },
      // IIII-2: 强制出"最左" (同样有指南针)
      {
        id: 'c2',
        name: 'Clock IV-2',
        subtitle: '第二钟',
        image: 'img/clocks/ch04/Clock_04_C2_face.png',
        rulesheet: 'img/clocks/ch04/Clock_04_C2_face.png',
        forced_play: 'leftmost',
        validators: [],
      },
      // IIII-3: 强制出"最左"; 12点(I)/4点(III)/8点(V) 各禁 {1,2,3} (3 段红 X/红 +)
      {
        id: 'c3',
        name: 'Clock IV-3',
        subtitle: '第三钟',
        image: 'img/clocks/ch04/Clock_04_C3_face.png',
        rulesheet: 'img/clocks/ch04/Clock_04_C3_face.png',
        forced_play: 'leftmost',
        validators: [
          { type: 'segment_no_value', segment: 1, values: [1, 2, 3] },
          { type: 'segment_no_value', segment: 3, values: [1, 2, 3] },
          { type: 'segment_no_value', segment: 5, values: [1, 2, 3] },
        ],
      },
      // IIII-4: 强制出"最左"; 2点(II) 禁 12; 4点(III) 1S+1L; 8点(V) 恰好 2 张
      {
        id: 'c4',
        name: 'Clock IV-4',
        subtitle: '第四钟',
        image: 'img/clocks/ch04/Clock_04_C4_face.png',
        rulesheet: 'img/clocks/ch04/Clock_04_C4_face.png',
        forced_play: 'leftmost',
        validators: [
          { type: 'segment_no_value', segment: 2, values: [12] },
          { type: 'segment_color_count', segment: 3, solar: 1, lunar: 1 },
          { type: 'segment_count', segment: 5, count: 2 },
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Chapter V — Tranquility (宁静)
  // -------------------------------------------------------------------------
  // 整章每段必须恰好 2 张卡 (12 张 / 6 段 = 2). 用 `max_per_segment: 2` +
  // `min_per_segment: 2` 共同约束.
  // 其他规则与 Chapter I 相同.
  // -------------------------------------------------------------------------
  ch05_tranquility: {
    id: 'ch05_tranquility',
    name: 'Chapter V',
    subtitle: 'Tranquility · 宁静',
    description: '整章每段必须恰好 2 张卡（12 张均匀分配到 6 段）。其他规则与 Chapter I 相同。',
    rulesheet: 'img/rules/ch05_face.png',
    n_segments: 6,
    segment_names_en: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    segment_names_zh: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    standard_rules: {
      min_per_segment: 2,           // 整章每段 ≥ 2 张
      max_per_segment: 2,           // 整章每段 ≤ 2 张 → 恰好 2 张
      ascending: true,
      max_value: 24,
      max_value_relaxed_clocks: [],
      no_faceup_plays: false,
    },
    clocks: [
      // V-1: 纯章节规则 (每段 2 张)
      {
        id: 'c1',
        name: 'Clock V-1',
        subtitle: '第一钟',
        image: 'img/clocks/ch05/Clock_05_C1_face.png',
        rulesheet: 'img/clocks/ch05/Clock_05_C1_face.png',
        validators: [],
      },
      // V-2: 6点(IV) 点数和 ≈ 15
      {
        id: 'c2',
        name: 'Clock V-2',
        subtitle: '第二钟',
        image: 'img/clocks/ch05/Clock_05_C2_face.png',
        rulesheet: 'img/clocks/ch05/Clock_05_C2_face.png',
        validators: [
          { type: 'segment_closest_to', segment: 4, value: 15 },
        ],
      },
      // V-3: 10点(VI) 点数和 ≈ 1; 2点(II) "IV" 罗马 — 推测为 Clock Hand 段 (TBD)
      {
        id: 'c3',
        name: 'Clock V-3',
        subtitle: '第三钟',
        image: 'img/clocks/ch05/Clock_05_C3_face.png',
        rulesheet: 'img/clocks/ch05/Clock_05_C3_face.png',
        validators: [
          { type: 'segment_closest_to', segment: 6, value: 1 },
        ],
      },
      // V-4: 多段规则
      //   2点(II) 点数和 ≈ 3; 4点(III) 1S+1L; 6点(IV) 1S+1L; 8点(V) 点数和 ≈ 2
      {
        id: 'c4',
        name: 'Clock V-4',
        subtitle: '第四钟',
        image: 'img/clocks/ch05/Clock_05_C4_face.png',
        rulesheet: 'img/clocks/ch05/Clock_05_C4_face.png',
        validators: [
          { type: 'segment_closest_to', segment: 2, value: 3 },
          { type: 'segment_color_count', segment: 3, solar: 1, lunar: 1 },
          { type: 'segment_color_count', segment: 4, solar: 1, lunar: 1 },
          { type: 'segment_closest_to', segment: 5, value: 2 },
        ],
      },
    ],
  },

  // ===========================================================================
  // Chapter VI — As Above, So Below (如上，如下)
  // 机制: 段值 = max(段卡) - min(段卡) 差值, 差值顺时针递增. 每段 2 张.
  // 通过 `standard_rules.value_mode: 'diff'` 启用.
  // ===========================================================================
  ch06_as_above_so_below: {
    id: 'ch06_as_above_so_below',
    name: 'Chapter VI',
    subtitle: 'As Above, So Below · 如上，如下',
    description: '每段值不再是卡值总和，而是最大卡减最小卡的差值。差值顺时针递增，其他规则与 Chapter I 相同。',
    rulesheet: 'img/rules/ch06_face.png',
    n_segments: 6,
    segment_names_en: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    segment_names_zh: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    standard_rules: {
      min_per_segment: 2,
      max_per_segment: 2,                  // 每段恰好 2 张
      ascending: true,                      // 差值顺时针递增
      max_value: 24,
      max_value_relaxed_clocks: [1, 2, 3],  // 前 3 钟不强制 ≤24
      no_faceup_plays: false,
      value_mode: 'diff',                   // ← 关键: 用差值代替总和
    },
    clocks: [
      // VI-1: 纯章节规则 (每段 2 张, 差值递增)
      {
        id: 'c1', name: 'Clock VI-1', subtitle: '第一钟',
        image: 'img/clocks/ch06/Clock_06_C1_face.png',
        rulesheet: 'img/clocks/ch06/Clock_06_C1_face.png',
        validators: [],
      },
      // VI-2: 6点(VI) 禁值 {1,2,3} (钟面图 6 点位置有 "1,2,3 + 红 X" 徽章)
      {
        id: 'c2', name: 'Clock VI-2', subtitle: '第二钟',
        image: 'img/clocks/ch06/Clock_06_C2_face.png',
        rulesheet: 'img/clocks/ch06/Clock_06_C2_face.png',
        validators: [
          { type: 'segment_no_value', segment: 6, values: [1, 2, 3] },
        ],
      },
      // VI-3: 6点(VI) 禁 {1,2,3} + 8点(V) 禁 {2,3} + 2点(II) only value 12
      // (钟面图 10 点 (VI=段 6) 有 1,2,3; 8 点 (V=段 5) 有 2,3; 2 点 (II=段 2) 有 12)
      {
        id: 'c3', name: 'Clock VI-3', subtitle: '第三钟',
        image: 'img/clocks/ch06/Clock_06_C3_face.png',
        rulesheet: 'img/clocks/ch06/Clock_06_C3_face.png',
        validators: [
          { type: 'segment_no_value', segment: 6, values: [1, 2, 3] },
          { type: 'segment_no_value', segment: 5, values: [2, 3] },
        ],
      },
      // VI-4: 6点(IV) only value 2 (钟面图 6 点位置有 "二" 罗马数字)
      {
        id: 'c4', name: 'Clock VI-4', subtitle: '第四钟',
        image: 'img/clocks/ch06/Clock_06_C4_face.png',
        rulesheet: 'img/clocks/ch06/Clock_06_C4_face.png',
        validators: [
          // (更多段规则需要更精准解读图; 当前只保留章节机制)
        ],
      },
    ],
  },

  // ===========================================================================
  // Chapter VII — Intrusion (入侵)
  // 机制: 放卡时立即从备牌堆顶部抽 1 张. 通过 `standard_rules.draw_on_play: 1` 启用.
  // ===========================================================================
  ch07_intrusion: {
    id: 'ch07_intrusion',
    name: 'Chapter VII',
    subtitle: 'Intrusion · 入侵',
    description: '在某段放卡时立即从备牌堆顶部抽 1 张牌。其他规则与 Chapter I 相同。',
    rulesheet: 'img/rules/ch07_face.png',
    n_segments: 6,
    segment_names_en: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    segment_names_zh: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    standard_rules: {
      min_per_segment: 1,
      ascending: true,
      max_value: 24,
      max_value_relaxed_clocks: [1, 2, 3],
      no_faceup_plays: false,
      draw_on_play: 1,                      // ← 关键: 放 1 张抽 1 张
    },
    clocks: [
      // VII-1: 2点(II) 禁 {7,8,9} + 6点(IV) 禁 {7,8,9} (钟面图 2 点和 6 点有 "7,8,9 + 红 X" 徽章)
      {
        id: 'c1', name: 'Clock VII-1', subtitle: '第一钟',
        image: 'img/clocks/ch07/Clock_07_C1_face.png',
        rulesheet: 'img/clocks/ch07/Clock_07_C1_face.png',
        validators: [
          { type: 'segment_no_value', segment: 2, values: [7, 8, 9] },
          { type: 'segment_no_value', segment: 4, values: [7, 8, 9] },
        ],
      },
      // VII-2/3/4: 待钟面图精确解读 (placeholder)
      {
        id: 'c2', name: 'Clock VII-2', subtitle: '第二钟',
        image: 'img/clocks/ch07/Clock_07_C2_face.png',
        rulesheet: 'img/clocks/ch07/Clock_07_C2_face.png',
        validators: [],
      },
      {
        id: 'c3', name: 'Clock VII-3', subtitle: '第三钟',
        image: 'img/clocks/ch07/Clock_07_C3_face.png',
        rulesheet: 'img/clocks/ch07/Clock_07_C3_face.png',
        validators: [],
      },
      {
        id: 'c4', name: 'Clock VII-4', subtitle: '第四钟',
        image: 'img/clocks/ch07/Clock_07_C4_face.png',
        rulesheet: 'img/clocks/ch07/Clock_07_C4_face.png',
        validators: [],
      },
    ],
  },

  // ===========================================================================
  // Chapter VIII — Revolution (革命)
  // 机制: 放卡时整个时钟旋转 1 段 (顺时针). 通过 `standard_rules.rotate_on_play: 1` 启用.
  // 部分段通过 `room.forbidden_segments` 标记禁止放卡.
  // ===========================================================================
  ch08_revolution: {
    id: 'ch08_revolution',
    name: 'Chapter VIII',
    subtitle: 'Revolution · 革命',
    description: '在某段放卡时整个时钟旋转 1 段（顺时针），卡和钟保持原位。部分段禁止放卡，只能通过旋转移过去。',
    rulesheet: 'img/rules/ch08_face.png',
    n_segments: 6,
    segment_names_en: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    segment_names_zh: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    standard_rules: {
      min_per_segment: 1,
      ascending: true,
      max_value: 24,
      max_value_relaxed_clocks: [1, 2, 3],
      no_faceup_plays: false,
      rotate_on_play: 1,                    // ← 关键: 放 1 张旋转 1 段
    },
    clocks: [
      // VIII-1: 4点(III) 禁止放卡 + 6点(IV) 段值 16-20 (钟面图 4 点红 +, 6 点 16-20)
      //   段值范围 16-20: 模拟为 segment_value_range, 但当前 validator type 没有 segment_value_range_within
      //   简化: 用 segment_closest_to 18 (16-20 中点)
      {
        id: 'c1', name: 'Clock VIII-1', subtitle: '第一钟',
        image: 'img/clocks/ch08/Clock_08_C1_face.png',
        rulesheet: 'img/clocks/ch08/Clock_08_C1_face.png',
        forbidden_segments: [3],            // 4点(III) 禁止放卡
        validators: [
          { type: 'segment_closest_to', segment: 4, value: 18 },
        ],
      },
      // VIII-2/3/4: 待钟面图精确解读 (placeholder)
      {
        id: 'c2', name: 'Clock VIII-2', subtitle: '第二钟',
        image: 'img/clocks/ch08/Clock_08_C2_face.png',
        rulesheet: 'img/clocks/ch08/Clock_08_C2_face.png',
        validators: [],
      },
      {
        id: 'c3', name: 'Clock VIII-3', subtitle: '第三钟',
        image: 'img/clocks/ch08/Clock_08_C3_face.png',
        rulesheet: 'img/clocks/ch08/Clock_08_C3_face.png',
        validators: [],
      },
      {
        id: 'c4', name: 'Clock VIII-4', subtitle: '第四钟',
        image: 'img/clocks/ch08/Clock_08_C4_face.png',
        rulesheet: 'img/clocks/ch08/Clock_08_C4_face.png',
        validators: [],
      },
    ],
  },

  // ===========================================================================
  // Chapter IX — Unity (统一)
  // 机制:
  //   - 相邻段值必须相等 (六段值全相同)
  //   - 整体 max段值 - min段值 ≤ 4
  // 通过 `standard_rules.adjacent_segments_equal: true` + `overall_max_min_diff: 4` 启用.
  // ===========================================================================
  ch09_unity: {
    id: 'ch09_unity',
    name: 'Chapter IX',
    subtitle: 'Unity · 统一',
    description: '相邻段值必须相等，整体 max段值 − min段值 ≤ 4。其他规则与 Chapter I 相同。',
    rulesheet: 'img/rules/ch09_face.png',
    n_segments: 6,
    segment_names_en: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    segment_names_zh: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    standard_rules: {
      min_per_segment: 1,
      ascending: true,
      max_value: 24,
      max_value_relaxed_clocks: [1, 2, 3],
      no_faceup_plays: false,
      adjacent_segments_equal: true,        // ← 章节机制: 相邻段值相等
      overall_max_min_diff: 4,              // ← 章节机制: 整体 max - min ≤ 4
    },
    clocks: [
      { id: 'c1', name: 'Clock IX-1', subtitle: '第一钟',
        image: 'img/clocks/ch09/Clock_09_C1_face.png',
        rulesheet: 'img/clocks/ch09/Clock_09_C1_face.png',
        validators: [] },
      { id: 'c2', name: 'Clock IX-2', subtitle: '第二钟',
        image: 'img/clocks/ch09/Clock_09_C2_face.png',
        rulesheet: 'img/clocks/ch09/Clock_09_C2_face.png',
        validators: [] },
      { id: 'c3', name: 'Clock IX-3', subtitle: '第三钟',
        image: 'img/clocks/ch09/Clock_09_C3_face.png',
        rulesheet: 'img/clocks/ch09/Clock_09_C3_face.png',
        validators: [] },
      { id: 'c4', name: 'Clock IX-4', subtitle: '第四钟',
        image: 'img/clocks/ch09/Clock_09_C4_face.png',
        rulesheet: 'img/clocks/ch09/Clock_09_C4_face.png',
        validators: [] },
    ],
  },

  // ===========================================================================
  // Chapter X — Cohesiveness (凝聚)
  // 机制:
  //   - Second Hand 秒针: 指向两段对向 (相隔 3 段), 这两段不能放卡
  //   - 每位玩家回合后秒针顺时针旋转 1 段
  //   - 从 Hand 段起, 顺时针每段首张卡必须严格递增
  // 通过 `standard_rules.second_hand: true` + `adjacent_strict_ascending_first: true` 启用.
  //   每钟 `second_hand_initial` 决定秒针初始位置 (1-6, 默认 3).
  // ===========================================================================
  ch10_cohesiveness: {
    id: 'ch10_cohesiveness',
    name: 'Chapter X',
    subtitle: 'Cohesiveness · 凝聚',
    description: '引入秒针，秒针指向的两段不可放卡，每回合后秒针顺时针转 1 段。从 Hand 段起顺时针每段首张卡必须严格递增。',
    rulesheet: 'img/rules/ch10_face.png',
    n_segments: 6,
    segment_names_en: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    segment_names_zh: ['I', 'II', 'III', 'IV', 'V', 'VI'],
    standard_rules: {
      min_per_segment: 1,
      max_value: 24,
      max_value_relaxed_clocks: [1, 2, 3],
      no_faceup_plays: false,
      second_hand: true,                   // ← 章节机制: 秒针禁放两段 + 每回合转
      adjacent_strict_ascending_first: true, // ← 章节机制: 每段首张卡递增
    },
    clocks: [
      { id: 'c1', name: 'Clock X-1', subtitle: '第一钟',
        image: 'img/clocks/ch10/Clock_10_C1_face.png',
        rulesheet: 'img/clocks/ch10/Clock_10_C1_face.png',
        second_hand_initial: 3, validators: [] },
      { id: 'c2', name: 'Clock X-2', subtitle: '第二钟',
        image: 'img/clocks/ch10/Clock_10_C2_face.png',
        rulesheet: 'img/clocks/ch10/Clock_10_C2_face.png',
        second_hand_initial: 1, validators: [] },
      { id: 'c3', name: 'Clock X-3', subtitle: '第三钟',
        image: 'img/clocks/ch10/Clock_10_C3_face.png',
        rulesheet: 'img/clocks/ch10/Clock_10_C3_face.png',
        second_hand_initial: 5, validators: [] },
      { id: 'c4', name: 'Clock X-4', subtitle: '第四钟',
        image: 'img/clocks/ch10/Clock_10_C4_face.png',
        rulesheet: 'img/clocks/ch10/Clock_10_C4_face.png',
        second_hand_initial: 2, validators: [] },
    ],
  },
};

const DEFAULT_CHAPTER = 'ch01_awakening';
function getChapter(id) { return CHAPTERS[id] || CHAPTERS[DEFAULT_CHAPTER]; }

// ---------------------------------------------------------------------------
// Hand size & face-up limit by player count
//
// Rulebook: deal 12 cards total.
//   2P: 6 each (variant: deal 4 each, add 2 mid-game — v4 simplifies to 6 each)
//   3P: 4 each
//   4P: 3 each
// Face-up plays per test = player count (the Reminder token has N symbols).
// ---------------------------------------------------------------------------
function getHandSize(playerCount) {
  return ({ 2: 6, 3: 4, 4: 3 })[playerCount] || 3;
}
function getFaceUpLimit(playerCount) {
  return Math.max(2, Math.min(4, playerCount));
}

// ---------------------------------------------------------------------------
// Pure game logic
// ---------------------------------------------------------------------------

// 24-card deck: 12 Solar (c=1) + 12 Lunar (c=2), values 1-12. Shuffled.
function genDeck() {
  const deck = [];
  for (let v = 1; v <= 12; v++) {
    deck.push({ v, c: 1 });  // Solar
    deck.push({ v, c: 2 });  // Lunar
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function startGame(room) {
  const chapter = room.chapter;
  const clock = room.clock;
  const playerCount = room.players.length;
  const handSize = getHandSize(playerCount);
  const totalCards = handSize * playerCount;  // always 12

  // 取整副 24 张牌, 取前 12 张发牌, 剩余 12 张作为备牌堆 (Ch07 入侵用)
  const fullDeck = genDeck();
  const dealt = fullDeck.slice(0, totalCards);
  room.deck = fullDeck.slice(totalCards);  // 备牌堆 (Ch07 draw_on_play 用)

  room.players.forEach((p, i) => {
    p.hand = dealt.slice(i * handSize, i * handSize + handSize);
    p.connected = p.isBot ? true : !!p.socketId;
    p.ready = false;
  });
  room.segments = Array.from({ length: chapter.n_segments }, () => []);
  room.history = [];
  // 章节级 `no_faceup_plays` (Ch02 Limitation) → 明牌次数直接置 0
  room.face_up_remaining = (chapter.standard_rules && chapter.standard_rules.no_faceup_plays)
    ? 0
    : getFaceUpLimit(playerCount);
  room.first_player_idx = null;
  room.current_player_idx = null;
  room.turn_number = 0;
  // Ch08 革命: 整局时钟旋转次数 (顺时针), 0=未旋转
  room.rotation = 0;
  // Ch08 革命: 复制钟面 forbidden_segments 到 room (每局重置, 旋转中保持不变)
  room.forbidden_segments = Array.isArray(clock.forbidden_segments)
    ? clock.forbidden_segments.slice()
    : [];
  // Ch10 凝聚: 秒针初始位置 (1..n_segments). 每回合后 +1 (mod n_segments).
  if (chapter.standard_rules.second_hand) {
    const init = Number.isInteger(clock.second_hand_initial) ? clock.second_hand_initial : 1;
    room.second_hand = Math.max(1, Math.min(chapter.n_segments, init));
  } else {
    room.second_hand = null;
  }
  room.state = 'rules_intro';
  room.game_result = null;
  room.started_at = Date.now();
}

function applyAction(room, playerIdx, action) {
  const player = room.players[playerIdx];
  // 章节级 / per-clock `forced_play` 强制出牌顺序 (Ch4 Roar).
  // - 'leftmost': 玩家必须出手牌最左 (索引 0)
  // - 'highest':  玩家必须出手牌中最大值的牌
  // - 'lowest':   玩家必须出手牌中最小值的牌
  // 若选择不合法, 在调用方 (play_card handler) 已被拦截, 这里是二次防御.
  const fp = room.clock.forced_play;
  if (fp) {
    const hand = player.hand;
    let needIdx = -1;
    if (fp === 'leftmost') needIdx = 0;
    else if (fp === 'highest') {
      needIdx = hand.reduce((best, c, i) => (c.v > hand[best].v ? i : best), 0);
    } else if (fp === 'lowest') {
      needIdx = hand.reduce((best, c, i) => (c.v < hand[best].v ? i : best), 0);
    }
    if (action.card_idx !== needIdx) {
      const msg = fp === 'leftmost' ? '最左' : (fp === 'highest' ? '最大' : '最小');
      throw new Error(`本章规定必须出${msg}的牌`);
    }
  }
  const card = player.hand[action.card_idx];
  player.hand.splice(action.card_idx, 1);
  let faceUp = !!action.face_up;
  // 章节级 `no_faceup_plays` (Ch02 Limitation): 整章禁止明牌,
  // 双层防御: play_card handler 已拦截, 这里再拦一次防止直接调用绕过
  if (faceUp && room.chapter.standard_rules && room.chapter.standard_rules.no_faceup_plays) {
    throw new Error('本章节禁止明牌');
  }
  if (faceUp) {
    if (room.face_up_remaining <= 0) throw new Error('No face-up plays remaining');
    room.face_up_remaining -= 1;
  }
  // Segments are 1-indexed in the wire protocol; convert to 0-indexed here.
  const segIdx = action.segment - 1;
  room.segments[segIdx].push({
    v: card.v, c: card.c, face_up: faceUp,
    player: playerIdx,  // for client-side color border
  });
  room.history.push({
    turn: room.turn_number,
    player: playerIdx,
    segment: action.segment,
    face_up: faceUp,
    v: card.v, c: card.c,
  });
  room.turn_number += 1;
  room.current_player_idx = (room.current_player_idx + 1) % room.players.length;

  // ---- Ch07 入侵: 放 1 张立即从备牌堆抽 N 张 ----
  //   (玩家每出 1 张, 立即补 1 张, 手牌数维持恒定)
  const drawOnPlay = (room.chapter.standard_rules && room.chapter.standard_rules.draw_on_play) || 0;
  for (let i = 0; i < drawOnPlay; i++) {
    if (!room.deck || room.deck.length === 0) break;
    const drawn = room.deck.pop();
    player.hand.push(drawn);
  }

  // ---- Ch08 革命: 放 1 张立即顺时针旋转 1 段 ----
  //   旋转后, 原本 forbidden 的段在新的视觉位置变成可放, 新的段变成 forbidden
  const rotateOnPlay = (room.chapter.standard_rules && room.chapter.standard_rules.rotate_on_play) || 0;
  for (let i = 0; i < rotateOnPlay; i++) {
    room.rotation = ((room.rotation || 0) + 1) % room.chapter.n_segments;
  }

  // ---- Ch10 凝聚: 每回合后秒针顺时针转 1 段 ----
  //   初始位置在 startGame 设置, 这里每出 1 张就 +1 (mod n_segments)
  if (room.second_hand != null) {
    room.second_hand = (room.second_hand % room.chapter.n_segments) + 1;
  }
}

// ---------------------------------------------------------------------------
// Per-clock validators
// ---------------------------------------------------------------------------
// Each clock declares a `validators` array. Each validator is a small
// declarative object; `checkValidators()` runs them in either 'placement'
// mode (used to reject an illegal `play_card` in real time) or
// 'resolution' mode (used to add detail entries to the end-of-game check).
//
// Supported types (see CHAPTERS for usage examples):
//   { type: 'first_card_at',  segment: N }   — the 1st card placed must
//                                              go to segment N
//   { type: 'second_card_at', segment: N }   — the 2nd card placed must
//                                              go to segment N
//   { type: 'segment_count',     segment: N, count: K }
//   { type: 'segment_value_range', segment: N, min: A, max: B }
//   { type: 'segment_closest_to',  segment: N, value: V }
//   { type: 'segment_no_value',    segment: N, values: [v1, v2, ...] }
//   { type: 'segment_color_count', segment: N, solar: S, lunar: L }
//                                            — exactly S Solar + L Lunar
//                                              cards in segment N
//
// All `segment` values are 1-indexed (matches UI / wire protocol).
// ---------------------------------------------------------------------------

// Resolve a Chinese-friendly label for a segment number (1-indexed, matching
// the public-facing numbering). Falls back to "段 N" if no label is found.
function segLabel(chapter, segment) {
  const arr = chapter.segment_names_zh || chapter.segment_names_en || [];
  return arr[segment - 1] || `段 ${segment}`;
}

// Run all per-clock validators. `mode` is either 'placement' or 'resolution'.
// Each validator decides which mode it cares about; others return null.
function checkValidators(room, mode) {
  const validators = room.clock.validators || [];
  const results = [];
  for (const v of validators) {
    const r = runValidator(v, room, room.chapter, mode);
    if (r) results.push(r);
  }
  return results;
}

function runValidator(v, room, chapter, mode) {
  const label = segLabel(chapter, v.segment);
  switch (v.type) {
    case 'first_card_at': {
      if (mode === 'placement') {
        const n = 1;
        const totalPlaced = room.turn_number;  // cards placed so far
        if (totalPlaced + 1 !== n) return null;
        return { kind: 'placement', segment: v.segment, n, desc: `第 ${n} 张牌必须放在 ${label}` };
      }
      if (mode === 'resolution') {
        // Placement rule — if game finished, the rule was satisfied
        // (server rejects illegal placements at the time they happen).
        return { kind: 'resolution', name: `第 1 张牌放在 ${label}`, passed: true };
      }
      return null;
    }
    case 'second_card_at': {
      if (mode === 'placement') {
        const n = 2;
        const totalPlaced = room.turn_number;
        if (totalPlaced + 1 !== n) return null;
        return { kind: 'placement', segment: v.segment, n, desc: `第 ${n} 张牌必须放在 ${label}` };
      }
      if (mode === 'resolution') {
        return { kind: 'resolution', name: `第 2 张牌放在 ${label}`, passed: true };
      }
      return null;
    }
    case 'segment_count': {
      if (mode !== 'resolution') return null;
      const actual = room.segments[v.segment - 1].length;
      return {
        kind: 'resolution',
        name: `${label} 恰好放 ${v.count} 张牌`,
        passed: actual === v.count,
        actual, expected: v.count,
      };
    }
    case 'segment_value_range': {
      if (mode !== 'resolution') return null;
      const sum = room.segments[v.segment - 1].reduce((s, c) => s + c.v, 0);
      return {
        kind: 'resolution',
        name: `${label} 的点数和在 [${v.min}, ${v.max}] 区间`,
        passed: sum >= v.min && sum <= v.max,
        actual: sum, expected: `${v.min}–${v.max}`,
      };
    }
    case 'segment_closest_to': {
      if (mode !== 'resolution') return null;
      const segIdx = v.segment - 1;
      const mySum = room.segments[segIdx].reduce((s, c) => s + c.v, 0);
      const myDist = Math.abs(mySum - v.value);
      const allWorse = room.segments.every((seg, i) => {
        if (i === segIdx) return true;
        const otherSum = seg.reduce((s, c) => s + c.v, 0);
        return Math.abs(otherSum - v.value) >= myDist;
      });
      return {
        kind: 'resolution',
        name: `${label} 的点数和最接近 ${v.value}`,
        passed: allWorse,
        actual: mySum, expected: `距离 ${v.value} 最近`,
      };
    }
    case 'segment_no_value': {
      if (mode !== 'resolution') return null;
      const segIdx = v.segment - 1;
      const bad = room.segments[segIdx].find(c => v.values.includes(c.v));
      return {
        kind: 'resolution',
        name: `${label} 不能放值为 ${v.values.join(' / ')} 的牌`,
        passed: !bad,
        actual: bad ? bad.v : null,
      };
    }
    case 'segment_color_count': {
      if (mode !== 'resolution') return null;
      const segIdx = v.segment - 1;
      const cards = room.segments[segIdx];
      const solarN = cards.filter(c => c.c === 1).length;
      const lunarN = cards.filter(c => c.c === 2).length;
      const parts = [];
      if (v.solar != null) parts.push(`${v.solar} 太阳`);
      if (v.lunar != null) parts.push(`${v.lunar} 月亮`);
      return {
        kind: 'resolution',
        name: `${label} 恰好 ${parts.join(' + ')}`,
        passed: solarN === (v.solar || 0) && lunarN === (v.lunar || 0),
        actual: `${solarN}太 / ${lunarN}月`,
        expected: parts.join(' + '),
      };
    }
    case 'segment_lunar_count': {
      // "I 段恰好 N 张白牌" (Lunar). 用户原话: 12 点 (Hand) 是"单张白牌图标".
      if (mode !== 'resolution') return null;
      const segIdx = v.segment - 1;
      const lunarN = room.segments[segIdx].filter(c => c.c === 2).length;
      return {
        kind: 'resolution',
        name: `${label} 恰好 ${v.count} 张白牌`,
        passed: lunarN === v.count,
        actual: lunarN,
        expected: v.count,
      };
    }
    // -------- Ch3+ 新机制: 最高/最低值卡必须在某段 --------
    case 'highest_card_at': {
      if (mode !== 'resolution') return null;
      const segIdx = v.segment - 1;
      const allCards = room.segments.flat();
      if (allCards.length === 0) {
        return { kind: 'resolution', name: `${label} 含全组最高值卡`, passed: false };
      }
      const maxV = Math.max(...allCards.map(c => c.v));
      const hasMax = room.segments[segIdx].some(c => c.v === maxV);
      return {
        kind: 'resolution',
        name: `${label} 含全组最高值卡 (${maxV})`,
        passed: hasMax,
      };
    }
    case 'lowest_card_at': {
      if (mode !== 'resolution') return null;
      const segIdx = v.segment - 1;
      const allCards = room.segments.flat();
      if (allCards.length === 0) {
        return { kind: 'resolution', name: `${label} 含全组最低值卡`, passed: false };
      }
      const minV = Math.min(...allCards.map(c => c.v));
      const hasMin = room.segments[segIdx].some(c => c.v === minV);
      return {
        kind: 'resolution',
        name: `${label} 含全组最低值卡 (${minV})`,
        passed: hasMin,
      };
    }
    case 'solar_lowest_card_at': {
      if (mode !== 'resolution') return null;
      const segIdx = v.segment - 1;
      const solarCards = room.segments.flat().filter(c => c.c === 1);
      if (solarCards.length === 0) {
        return { kind: 'resolution', name: `${label} 含最低值太阳卡`, passed: true, skipped: true };
      }
      const minV = Math.min(...solarCards.map(c => c.v));
      const hasMin = room.segments[segIdx].some(c => c.c === 1 && c.v === minV);
      return {
        kind: 'resolution',
        name: `${label} 含最低值太阳卡 (${minV})`,
        passed: hasMin,
      };
    }
    case 'lunar_highest_card_at': {
      if (mode !== 'resolution') return null;
      const segIdx = v.segment - 1;
      const lunarCards = room.segments.flat().filter(c => c.c === 2);
      if (lunarCards.length === 0) {
        return { kind: 'resolution', name: `${label} 含最高值月亮卡`, passed: true, skipped: true };
      }
      const maxV = Math.max(...lunarCards.map(c => c.v));
      const hasMax = room.segments[segIdx].some(c => c.c === 2 && c.v === maxV);
      return {
        kind: 'resolution',
        name: `${label} 含最高值月亮卡 (${maxV})`,
        passed: hasMax,
      };
    }
    case 'last_card_at': {
      if (mode !== 'resolution') return null;
      const segIdx = v.segment - 1;
      if (room.history.length === 0) {
        return { kind: 'resolution', name: `${label} 是最后一张牌的段`, passed: false };
      }
      const lastCardSeg = room.history[room.history.length - 1].segment;
      return {
        kind: 'resolution',
        name: `${label} 是最后一张牌的段`,
        passed: lastCardSeg === v.segment,
      };
    }
    default:
      return null;
  }
}

// Validate a proposed placement against per-clock placement validators.
// Returns null on success, or an error string on failure.
function validatePlacement(room, action) {
  const targetSeg = action.segment;
  const chapter = room.chapter;
  const results = checkValidators(room, 'placement');
  for (const r of results) {
    if (r.segment !== targetSeg) {
      return `第 ${r.n} 张牌必须放在 ${segLabel(chapter, r.segment)}（你选了 ${segLabel(chapter, targetSeg)}）`;
    }
  }
  // Ch08 革命: 钟面有 forbidden_segments, 旋转后位置变.
  //   forbidden 是钟面原始位置 (1-indexed), 旋转 R 次后, 绝对段 (forbidden+R) mod 6 不可放.
  //   反过来说, 玩家想放在绝对段 S, 当且仅当 (S - R) mod 6 不在 forbidden 中才允许.
  const forbidden = room.forbidden_segments || [];
  if (forbidden.length > 0) {
    const rotation = room.rotation || 0;
    const n = chapter.n_segments;
    // 把 absolute target 映射回钟面原始位置
    const originPos = ((targetSeg - 1 - rotation) % n + n) % n + 1;  // 1-indexed
    if (forbidden.includes(originPos)) {
      return `该段被锁定（钟面位置 ${originPos}，旋转 ${rotation} 段后位置 ${targetSeg}），需等旋转过去`;
    }
  }
  // Ch10 凝聚: 秒针指的两段 (相隔 3 段) 不能放卡
  if (room.second_hand != null) {
    const n = chapter.n_segments;
    const opp = ((room.second_hand - 1 + 3) % n) + 1;  // 对向段
    if (targetSeg === room.second_hand || targetSeg === opp) {
      return `秒针指向段 ${room.second_hand} / 对向段 ${opp}, 不可放卡`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolution (Ch1 Awakening standard rules)
// ---------------------------------------------------------------------------
// Pass conditions:
//   1. every segment has ≥ 1 card
//   2. segment values are non-decreasing clockwise from segment 1
//   3. every segment value ≤ 24 (relaxed for clocks 1-3 of Ch1)
// Plus per-clock special rules (declared in clock.validators; see above).
// ---------------------------------------------------------------------------
function checkResolution(room) {
  const chapter = room.chapter;
  const clock = room.clock;
  const rules = chapter.standard_rules;
  const detail = [];

  // Each segment value.
  //   - default: 段内卡值总和 (sum)
  //   - Ch06 As Above So Below: 段内 max - min (差值)
  //   (face-down cards are 0 in the server-side resolution — but the
  //    resolution is only checked after cards are flipped via revealRoom,
  //    so by then all cards are face-up.)
  const valueMode = rules.value_mode || 'sum';
  const segValue = (seg) => {
    if (seg.length === 0) return 0;
    if (valueMode === 'diff') {
      const vs = seg.map(c => c.v);
      return Math.max(...vs) - Math.min(...vs);
    }
    return seg.reduce((s, c) => s + c.v, 0);
  };
  const sums = room.segments.map(segValue);

  // 1. Each segment ≥ 1 card
  const allHaveCards = room.segments.every(seg => seg.length >= rules.min_per_segment);
  detail.push({ name: `每段至少 ${rules.min_per_segment} 张卡`, passed: allHaveCards });

  // 1b. Each segment ≤ max_per_segment (Ch5 Tranquility = 2)
  if (rules.max_per_segment != null) {
    const allUnderMax = room.segments.every(seg => seg.length <= rules.max_per_segment);
    detail.push({ name: `每段最多 ${rules.max_per_segment} 张卡`, passed: allUnderMax });
  }

  // 2. Ascending clockwise
  const valueLabel = (valueMode === 'diff') ? '差值' : '段和';
  let ascending = true;
  for (let i = 1; i < sums.length; i++) {
    if (sums[i] < sums[i - 1]) { ascending = false; break; }
  }
  detail.push({ name: `六段${valueLabel}顺时针非递减`, passed: ascending });

  // 2b. Ch09 Unity: 相邻段值相等 (i.e. 六段值全部相同)
  if (rules.adjacent_segments_equal) {
    let allEqual = true;
    for (let i = 1; i < sums.length; i++) {
      if (sums[i] !== sums[i - 1]) { allEqual = false; break; }
    }
    detail.push({ name: '相邻段值相等', passed: allEqual, actual: sums.join(' = ') });
  }

  // 2c. Ch09 Unity: 整体 max - min ≤ N
  if (rules.overall_max_min_diff != null) {
    const max = Math.max(...sums);
    const min = Math.min(...sums);
    const diff = max - min;
    detail.push({
      name: `整体差值 ≤ ${rules.overall_max_min_diff}`,
      passed: diff <= rules.overall_max_min_diff,
      actual: `max=${max} min=${min} diff=${diff}`,
    });
  }

  // 2d. Ch10 Cohesiveness: 从 Hand 段起, 顺时针每段首张卡严格递增
  if (rules.adjacent_strict_ascending_first) {
    const firstCards = room.segments.map(seg => seg[0] ? seg[0].v : null);
    let asc = true;
    for (let i = 1; i < firstCards.length; i++) {
      if (firstCards[i] == null || firstCards[i - 1] == null || firstCards[i] <= firstCards[i - 1]) {
        asc = false; break;
      }
    }
    detail.push({
      name: '从 Hand 段起每段首张卡顺时针严格递增',
      passed: asc,
      actual: firstCards.map(v => v == null ? '-' : v).join(' < '),
    });
  }

  // 3. Max value 24 — relaxed for some Ch1 clocks
  const maxRelaxed = rules.max_value_relaxed_clocks || [];
  const clockIdx = chapter.clocks.indexOf(clock) + 1;  // 1-indexed
  const maxValueEnforced = !maxRelaxed.includes(clockIdx);
  if (maxValueEnforced) {
    const allUnder = sums.every(s => s <= rules.max_value);
    detail.push({ name: `每段${valueLabel} ≤ ${rules.max_value}`, passed: allUnder });
  } else {
    detail.push({ name: `每段${valueLabel} ≤ ${rules.max_value}（本钟不强制）`, passed: true, skipped: true });
  }

  // Per-clock special rules: enforced via the clock's `validators` array.
  // See runValidator() / checkValidators() below for the schema and
  // supported types. The validators are added at the end of this detail
  // list so the standard rules appear first in the UI.
  const validatorResults = checkValidators(room, 'resolution');
  for (const r of validatorResults) {
    if (r) detail.push(r);
  }

  const won = detail.every(d => d.passed);
  return { won, detail, sums };
}

// Reveal all face-down cards at the end of the game so the resolution is
// computable server-side (and so the public state can show everything).
function revealRoom(room) {
  for (const seg of room.segments) {
    for (const c of seg) c.face_up = true;
  }
}

function checkGameEnd(room) {
  if (room.players.every(p => p.hand.length === 0)) {
    revealRoom(room);
    room.state = 'finished';
    const result = checkResolution(room);
    room.game_result = { won: result.won, detail: result.detail, sums: result.sums };
    // Phase 3: 写入小队尝试记录
    recordAttempt(room);
  }
}

// Phase 3: 小队尝试记录
// 记录每次真实游戏结束 (出完所有手牌) → attempts.json
// "all humans left → 强制结束" 走 leave_room 里的 checkGameEnd 但带 reason, 那里不调用 recordAttempt
function recordAttempt(room) {
  try {
    // 只记至少有一个真人登录的尝试 (匿名玩家无 userId 不参与归集, 但允许匿名)
    // squad 只记登录玩家的 userId (排序后作为 canonical key)
    const squad = room.players
      .filter(p => p.userId)  // 只算登录玩家
      .map(p => p.userId)
      .sort();
    const squad_nicknames = room.players
      .filter(p => p.userId)
      .map(p => p.nickname);
    const attempt = {
      id: 'att_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      started_at: room.started_at || Date.now(),
      ended_at: Date.now(),
      chapter_id: room.chapter.id,
      chapter_name: room.chapter.name,
      clock_id: room.clock.id,
      clock_name: room.clock.name,
      squad,                              // canonical key
      squad_nicknames,                    // 当时快照 (防止改名后失真)
      result: room.game_result && room.game_result.won ? 'won' : 'lost',
      turn_count: room.turn_number || 0,
      duration_seconds: Math.floor(((Date.now() - (room.started_at || Date.now())) / 1000)),
      player_count: room.players.length,
    };
    attempts.attempts.push(attempt);
    saveAttempts();
    console.log(`[history] recorded attempt ${attempt.id} (${attempt.result}, squad=${squad.length} players)`);
  } catch (err) {
    console.error('[history] recordAttempt failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// AI bot: home-range strategy (V3 port, adapted for TakeTime rules)
//
// In TakeTime, smaller cards want smaller segments, larger cards want larger
// segments. The hand segment (segment 1) takes the lowest-value card on
// average. We approximate the official "place as you like" hint by using a
// monotonic home slot: home(seg) where seg = clamp(ceil(v / 2), 1, 6).
// ---------------------------------------------------------------------------
function botPickAction(room, playerIdx) {
  const hand = room.players[playerIdx].hand;
  if (hand.length === 0) return null;

  // Per-clock placement constraints: e.g. "1st card must go to seg 3".
  // The bot must respect these or the server will reject the play.
  const aboutToBeNth = room.turn_number + 1;
  const forcedSeg = (() => {
    for (const v of (room.clock.validators || [])) {
      if (v.type === 'first_card_at' && aboutToBeNth === 1) return v.segment;
      if (v.type === 'second_card_at' && aboutToBeNth === 2) return v.segment;
    }
    return null;
  })();

  // Pick smallest card first (matches the official suggestion "play low cards
  // first to avoid being stuck with a high card at the end").
  const sortedIdx = hand.map((c, i) => ({ c, i })).sort((a, b) => a.c.v - b.c.v);

  // Find home segment (1-indexed)
  const segCounts = room.segments.map(s => s.length);

  // Build a map: segment → Set<forbidden values> from `segment_no_value`
  // validators. The bot skips any segment that forbids its current card,
  // so a Ch02 game doesn't immediately fail at resolution just because
  // the bot randomly dropped a forbidden value somewhere.
  const noValueMap = new Map();
  for (const v of (room.clock.validators || [])) {
    if (v.type === 'segment_no_value' && Array.isArray(v.values)) {
      if (!noValueMap.has(v.segment)) noValueMap.set(v.segment, new Set());
      for (const val of v.values) noValueMap.get(v.segment).add(val);
    }
  }

  // Ch08 革命: 计算当前 rotation 下, 哪些 absolute 段是禁放的
  //   absolute S 不可放 当且仅当 (S-1-R) mod 6 + 1 ∈ forbidden_segments
  const forbiddenAbs = new Set();
  const roomForbidden = room.forbidden_segments || [];
  if (roomForbidden.length > 0) {
    const R = room.rotation || 0;
    const N = room.chapter.n_segments;
    for (let i = 0; i < N; i++) {
      const originPos = ((i - R) % N + N) % N + 1;
      if (roomForbidden.includes(originPos)) forbiddenAbs.add(i + 1);
    }
  }
  // Ch10 凝聚: 秒针指的两段 (相隔 3 段) 禁放
  if (room.second_hand != null) {
    const N = room.chapter.n_segments;
    forbiddenAbs.add(room.second_hand);
    forbiddenAbs.add(((room.second_hand - 1 + 3) % N) + 1);
  }

  // If a placement constraint forces a specific segment, use it. Otherwise
  // pick the segment with the fewest cards, breaking ties by closest to
  // the card's "home" segment. Skip segments where the card is forbidden
  // (Ch02 segment_no_value) or where the segment is currently locked
  // (Ch08 forbidden_segments); if ALL segments forbid the card, fall back
  // to the unfiltered best (the game will fail at resolution, but that's
  // better than the bot refusing to play at all).
  const target = (() => {
    if (forcedSeg) return forcedSeg;
    const card0 = sortedIdx[0].c;
    let best = null, bestCount = Infinity, bestDist = Infinity;
    let anyValid = false;
    for (let i = 0; i < 6; i++) {
      const segN = i + 1;
      if (forbiddenAbs.has(segN)) continue;
      if (noValueMap.has(segN) && noValueMap.get(segN).has(card0.v)) continue;
      anyValid = true;
      const home = Math.min(6, Math.max(1, Math.ceil(card0.v / 2)));
      const dist = Math.min(Math.abs(segN - home), 6 - Math.abs(segN - home));
      if (segCounts[i] < bestCount ||
          (segCounts[i] === bestCount && dist < bestDist)) {
        best = segN; bestCount = segCounts[i]; bestDist = dist;
      }
    }
    if (anyValid) return best;
    // All segments forbid this card — fall back to the unfiltered best.
    best = null; bestCount = Infinity; bestDist = Infinity;
    for (let i = 0; i < 6; i++) {
      const segN = i + 1;
      const home = Math.min(6, Math.max(1, Math.ceil(card0.v / 2)));
      const dist = Math.min(Math.abs(segN - home), 6 - Math.abs(segN - home));
      if (segCounts[i] < bestCount ||
          (segCounts[i] === bestCount && dist < bestDist)) {
        best = segN; bestCount = segCounts[i]; bestDist = dist;
      }
    }
    return best;
  })();

  // If a placement constraint forces a specific segment, the bot should
  // also pick a sensible card (smallest is fine — the rule is about
  // position, not value).
  // Ch4 Roar `forced_play`: bot 必须遵守 per-clock 强制出牌顺序
  let chosenCard;
  const fp = room.clock.forced_play;
  if (fp === 'leftmost') {
    chosenCard = 0;  // hand[0]
  } else if (fp === 'highest') {
    chosenCard = sortedIdx[sortedIdx.length - 1].i;  // 最大值
  } else if (fp === 'lowest') {
    chosenCard = sortedIdx[0].i;  // 最小值
  } else {
    chosenCard = sortedIdx[0].i;  // 默认: 最小值
  }

  // Face-up heuristic: keep face-down for privacy (the bot doesn't reason
  // about reveal timing).
  const faceUp = false;
  return { card_idx: chosenCard, segment: target, face_up: faceUp };
}

function maybeBotAct(room) {
  if (room.state !== 'playing') return;
  const cur = room.current_player_idx;
  const player = room.players[cur];
  if (!player || !player.isBot) return;
  const action = botPickAction(room, cur);
  if (!action) return;
  try {
    applyAction(room, cur, action);
    checkGameEnd(room);
    broadcastRoom(room);
    if (room.state === 'playing') setTimeout(() => maybeBotAct(room), 600);
  } catch (_) { /* skip */ }
}

// ---------------------------------------------------------------------------
// State sanitization (privacy: face-down values never leak during play)
// ---------------------------------------------------------------------------
//   - 终局 (isRevealed): 所有人都看正脸
//   - 翻牌 (c.face_up): 所有人都看正脸
//   - 暗牌: 出牌人自己总是看正脸 (桌游规则: 你自己出的牌对自己是明的),
//           其他玩家看不到数值
function sanitizeCard(c, isRevealed, viewerIdx) {
  if (isRevealed) {
    return { v: c.v, c: c.c, face_up: true, player: c.player };
  }
  // 暗牌但出牌人自己看: 总是正面
  if (viewerIdx != null && viewerIdx === c.player) {
    return { v: c.v, c: c.c, face_up: true, player: c.player };
  }
  if (c.face_up) {
    return { v: c.v, c: c.c, face_up: true, player: c.player };
  }
  // 暗牌 + 其他人看: 隐藏数值
  return { c: c.c, face_up: false, player: c.player };
}
function sanitizeSegment(seg, isRevealed, viewerIdx) {
  return seg.map(c => sanitizeCard(c, isRevealed, viewerIdx));
}
function sanitizeHistoryEntry(h, isRevealed, viewerIdx) {
  if (isRevealed) {
    return { turn: h.turn, player: h.player, segment: h.segment, face_up: true, v: h.v, c: h.c };
  }
  // 出牌人自己的 history entry: 总是看正面
  if (viewerIdx != null && viewerIdx === h.player) {
    return { turn: h.turn, player: h.player, segment: h.segment, face_up: true, v: h.v, c: h.c };
  }
  if (h.face_up) {
    return { turn: h.turn, player: h.player, segment: h.segment, face_up: true, v: h.v, c: h.c };
  }
  return { turn: h.turn, player: h.player, segment: h.segment, face_up: false };
}

function getPublicState(room, viewerIdx) {
  const revealAll = room.state === 'finished';
  return {
    id: room.id,
    state: room.state,
    chapter: {
      id: room.chapter.id,
      name: room.chapter.name,
      subtitle: room.chapter.subtitle,
      description: room.chapter.description,
      rulesheet: room.chapter.rulesheet,
      n_segments: room.chapter.n_segments,
      segment_names_en: room.chapter.segment_names_en,
      segment_names_zh: room.chapter.segment_names_zh,
      standard_rules: room.chapter.standard_rules,
      clocks: room.chapter.clocks,  // include for client-side index lookup
      no_faceup_plays: !!(room.chapter.standard_rules && room.chapter.standard_rules.no_faceup_plays),
    },
    clock: {
      id: room.clock.id,
      name: room.clock.name,
      subtitle: room.clock.subtitle,
      image: room.clock.image,
      rulesheet: room.clock.rulesheet || room.chapter.rulesheet,
      validators: room.clock.validators || [],
      forced_play: room.clock.forced_play || null,
      clock_hand_segment: room.clock.clock_hand_segment || null,
      forbidden_segments: room.clock.forbidden_segments || [],
    },
    players: room.players.map((p, i) => ({
      idx: i,
      nickname: p.nickname,
      color: p.color || null,
      hand_size: p.hand.length,
      connected: p.connected,
      ready: p.isBot ? true : !!p.ready,
      is_first: i === room.first_player_idx,
      is_bot: !!p.isBot,
      is_host: i === room.host_idx,
      userId: p.userId || null,  // 登录用户带 userId, 匿名 null (小队归集用)
    })),
    segments: revealAll ? room.segments : room.segments.map(s => sanitizeSegment(s, revealAll, viewerIdx)),
    history: revealAll ? room.history : room.history.map(h => sanitizeHistoryEntry(h, revealAll, viewerIdx)),
    face_up_remaining: room.face_up_remaining,
    first_player_idx: room.first_player_idx,
    current_player_idx: room.current_player_idx,
    turn_number: room.turn_number,
    game_result: room.game_result,
    created_at: room.created_at,
    n_players: room.players.length,
    hand_size: getHandSize(room.players.length),
    face_up_limit: getFaceUpLimit(room.players.length),
    // Ch08 革命: 整局旋转次数 (顺时针), 0=未旋转
    rotation: room.rotation || 0,
    // Ch08 革命: 钟面禁放段 (钟面原始位置 1-indexed, 旋转中保持不变)
    forbidden_segments: room.forbidden_segments || [],
    // Ch10 凝聚: 秒针位置 (1..n_segments), null 表示无秒针章节
    second_hand: room.second_hand,
    // Ch07 入侵: 备牌堆剩余 (客户端 UI 用)
    deck_remaining: (room.deck || []).length,
    // Ch06 As Above So Below: 段值显示模式 ('sum' | 'diff')
    value_mode: (room.chapter.standard_rules && room.chapter.standard_rules.value_mode) || 'sum',
  };
}

function getRoomListItem(room) {
  return {
    id: room.id,
    state: room.state,
    chapter_id: room.chapter ? room.chapter.id : null,
    chapter_name: room.chapter ? room.chapter.name : null,
    clock_id: room.clock ? room.clock.id : null,
    clock_name: room.clock ? room.clock.name : null,
    player_count: room.players.length,
    connected_count: room.players.filter(p => p.connected).length,
    created_at: room.created_at,
  };
}

function getPlayerView(room, playerIdx) {
  if (playerIdx < 0 || playerIdx >= room.players.length) return null;
  const myHand = room.players[playerIdx].hand;
  const others = room.players.filter((_, i) => i !== playerIdx);
  return {
    my_player_idx: playerIdx,
    hand: myHand,
    hand_size: myHand.length,
    opponent_hand_sizes: others.map(p => p.hand.length),
    opponent_hand_colors: others.map(p => {
      // Legacy field (kept for backward compat with v4 tests)
      const s = p.hand.filter(c => c.c === 1).length;
      const l = p.hand.filter(c => c.c === 2).length;
      return [s, l];
    }),
    // Indexed by player idx (not by "others" position) so client can lookup
    // directly without offset math. Each entry = [solar_count, lunar_count].
    hand_colors_by_idx: room.players.map(p => {
      const s = p.hand.filter(c => c.c === 1).length;
      const l = p.hand.filter(c => c.c === 2).length;
      return [s, l];
    }),
    segment_face_up_cards: room.segments.map(s =>
      // 翻牌的 + 出牌人自己出的未翻牌 (对自己明)
      s.filter(c => c.face_up || c.player === playerIdx).map(c => ({ v: c.v, c: c.c }))
    ),
    segment_face_up_counts: room.segments.map(s =>
      s.filter(c => c.face_up || c.player === playerIdx).length
    ),
    segment_face_down_counts: room.segments.map(s =>
      s.filter(c => !c.face_up && c.player !== playerIdx).length
    ),
    segment_total_counts: room.segments.map(s => s.length),
    face_up_remaining: room.face_up_remaining,
    turn_number: room.turn_number,
    first_player: room.first_player_idx,
    n_players: room.players.length,
    n_segments: room.chapter.n_segments,
    hand_size: getHandSize(room.players.length),
  };
}

function broadcastRoom(room) {
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (p.socketId) {
      io.to(p.socketId).emit('state_update', {
        view: getPlayerView(room, i),
        public: getPublicState(room, i),  // viewerIdx 让出牌人自己看到自己出的牌正脸
      });
    }
  }
}

function broadcastRoomList() {
  const list = [...rooms.values()]
    .filter(r => r.state === 'lobby' && !r.is_private)  // 私人房不出现在列表
    .map(getRoomListItem);
  io.emit('room_list', list);
}

// ---------------------------------------------------------------------------
// Room management
// ---------------------------------------------------------------------------
const rooms = new Map();

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do { id = ''; for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)]; }
  while (rooms.has(id));
  return id;
}

function createRoom(chapterId, clockId, maxPlayers, password) {
  const id = genRoomId();
  const chapter = getChapter(chapterId);
  const clock = chapter.clocks.find(c => c.id === clockId) || chapter.clocks[0];
  const room = {
    id,
    state: 'lobby',
    chapter,
    clock,
    is_private: !!password,
    password: password || null,
    max_players: Math.max(2, Math.min(4, maxPlayers || 4)),
    players: [],
    segments: Array.from({ length: chapter.n_segments }, () => []),
    history: [],
    deck: [],            // 备牌堆, Ch07 入侵章节用
    face_up_remaining: 0,
    first_player_idx: null,
    current_player_idx: null,
    turn_number: 0,
    rotation: 0,         // Ch08 革命: 旋转次数
    forbidden_segments: Array.isArray(clock.forbidden_segments) ? clock.forbidden_segments.slice() : [],
    second_hand: null,    // Ch10 凝聚: 秒针位置 (startGame 时初始化)
    game_result: null,
    host_idx: null,       // 房主 (创建者) 在 players 数组里的 idx, 留 null 玩家加入后设为 0
    created_at: Date.now(),
    started_at: null,
  };
  rooms.set(id, room);
  return room;
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some(p => p.socketId === socketId)) return room;
  }
  return null;
}
function findPlayerInRoom(socketId) {
  const room = findRoomBySocket(socketId);
  if (!room) return { room: null, playerIdx: -1 };
  return { room, playerIdx: room.players.findIndex(p => p.socketId === socketId) };
}

function pickColor(requested, takenColors) {
  if (requested && PLAYER_COLOR_IDS.includes(requested)) {
    if (takenColors.has(requested)) return { error: '该颜色已被占用' };
    return { color: requested };
  }
  // Auto-pick first available
  for (const c of PLAYER_COLOR_IDS) {
    if (!takenColors.has(c)) return { color: c };
  }
  return { error: '所有颜色已被占用' };
}
// ---------------------------------------------------------------------------
// Account system: passphrase-based register/login (no username, no email).
//
// Storage:
//   data/users.json   { users: [{ userId, passphrase_hash, salt, display_name, created_at }] }
//   data/tokens.json  { tokens: [{ token, userId, created_at }] }
//
// Flow:
//   1. Client opens socket with `auth: { token }` if it has one from localStorage.
//   2. io.use middleware below looks up the token; on hit, attaches
//      `socket.data.userId` and `socket.data.displayName`.
//   3. Player objects gain `userId: string | null`. null for anonymous play.
//   4. Anonymous still works — no token means no userId, no displayName.
// ---------------------------------------------------------------------------

function loadJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    // 损坏的 JSON: 备份一份, 从空开始 (数据不会丢, 只是历史从此刻起)
    try {
      if (fs.existsSync(file)) fs.renameSync(file, file + '.bak.' + Date.now());
    } catch (_) {}
    console.error(`[load] ${file} 损坏: ${err.message}, 从空数据启动`);
    return fallback;
  }
}
function saveJsonFile(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

let users = loadJsonFile(USERS_FILE, { users: [] });
let tokens = loadJsonFile(TOKENS_FILE, { tokens: [] });
let attempts = loadJsonFile(ATTEMPTS_FILE, { attempts: [] });

function saveUsers() { saveJsonFile(USERS_FILE, users); }
function saveTokens() { saveJsonFile(TOKENS_FILE, tokens); }
function saveAttempts() { saveJsonFile(ATTEMPTS_FILE, attempts); }

function hashPassphrase(passphrase, salt) {
  return crypto.createHash('sha256').update(salt + passphrase, 'utf8').digest('hex');
}
function genSalt() {
  return crypto.randomBytes(8).toString('hex');  // 16 chars
}
function genToken() {
  return crypto.randomBytes(24).toString('hex');  // 48 chars
}
function genUserId() {
  return crypto.randomUUID();
}

function findUserByPassphrase(passphrase) {
  // 注意: 没法快速反查, 只能 O(N) 遍历. 玩家量 < 1000 完全 OK.
  for (const u of users.users) {
    if (hashPassphrase(passphrase, u.salt) === u.passphrase_hash) return u;
  }
  return null;
}
function findUserById(userId) {
  return users.users.find(u => u.userId === userId) || null;
}
function findToken(tokenStr) {
  return tokens.tokens.find(t => t.token === tokenStr) || null;
}
function issueToken(userId) {
  const t = { token: genToken(), userId, created_at: Date.now() };
  tokens.tokens.push(t);
  saveTokens();
  return t.token;
}
function revokeToken(tokenStr) {
  const i = tokens.tokens.findIndex(t => t.token === tokenStr);
  if (i >= 0) {
    tokens.tokens.splice(i, 1);
    saveTokens();
    return true;
  }
  return false;
}

// io.use middleware: 用 token 找 user, 挂到 socket.data.
// 匿名也放行 (无 token / token 失效), 只是没有 userId.
io.use((socket, next) => {
  const tokenStr = socket.handshake.auth?.token;
  if (!tokenStr || typeof tokenStr !== 'string') return next();
  const t = findToken(tokenStr);
  if (!t) return next();
  const u = findUserById(t.userId);
  if (!u) return next();
  socket.data.userId = u.userId;
  socket.data.displayName = u.display_name;
  socket.data.token = tokenStr;
  next();
});

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);
  socket.emit('room_list', [...rooms.values()].filter(r => r.state === 'lobby' && !r.is_private).map(getRoomListItem));
  // Send chapter + clock catalog to client for the lobby picker
  socket.emit('chapters', Object.values(CHAPTERS).map(ch => ({
    id: ch.id, name: ch.name, subtitle: ch.subtitle, description: ch.description,
    rulesheet: ch.rulesheet, n_segments: ch.n_segments,
    segment_names_en: ch.segment_names_en, segment_names_zh: ch.segment_names_zh,
    standard_rules: ch.standard_rules,
    no_faceup_plays: !!(ch.standard_rules && ch.standard_rules.no_faceup_plays),
    clocks: ch.clocks.map(c => ({ id: c.id, name: c.name, subtitle: c.subtitle, image: c.image, rulesheet: c.rulesheet || ch.rulesheet, validators: c.validators || [], forced_play: c.forced_play || null, clock_hand_segment: c.clock_hand_segment || null, forbidden_segments: c.forbidden_segments || [] })),
  })));
  socket.emit('player_colors', PLAYER_COLORS);
  // Account info: 已登录的话告诉客户端
  if (socket.data.userId) {
    socket.emit('account_info', {
      logged_in: true,
      userId: socket.data.userId,
      display_name: socket.data.displayName,
    });
  } else {
    socket.emit('account_info', { logged_in: false });
  }

  // ---------------- 账号系统 (passphrase) ----------------

  socket.on('register_passphrase', ({ passphrase, display_name }, ack) => {
    ack = typeof ack === "function" ? ack : () => {};
    if (typeof passphrase !== 'string' || passphrase.length < 6) {
      return ack({ error: '暗号至少 6 个字符' });
    }
    if (passphrase.length > 64) {
      return ack({ error: '暗号最多 64 个字符' });
    }
    if (typeof display_name !== 'string' || !display_name.trim()) {
      return ack({ error: '请输入显示名' });
    }
    const dn = display_name.trim().slice(0, 20);
    // 不强制 display_name 唯一 (用户场景: 朋友起名随意)
    const user = {
      userId: genUserId(),
      passphrase_hash: hashPassphrase(passphrase, genSalt()),
      salt: undefined,  // 占位, 下面会重新生成
      display_name: dn,
      created_at: Date.now(),
    };
    user.salt = genSalt();
    user.passphrase_hash = hashPassphrase(passphrase, user.salt);
    users.users.push(user);
    saveUsers();
    const token = issueToken(user.userId);
    // 当前 socket 也直接登入 (避免需要刷一次)
    socket.data.userId = user.userId;
    socket.data.displayName = user.display_name;
    socket.data.token = token;
    socket.emit('account_info', { logged_in: true, userId: user.userId, display_name: user.display_name });
    console.log(`[auth] registered userId=${user.userId} display="${user.display_name}"`);
    ack({ ok: true, userId: user.userId, display_name: user.display_name, token });
  });

  socket.on('login_passphrase', ({ passphrase }, ack) => {
    ack = typeof ack === "function" ? ack : () => {};
    if (typeof passphrase !== 'string' || passphrase.length < 6) {
      return ack({ error: '暗号至少 6 个字符' });
    }
    const u = findUserByPassphrase(passphrase);
    if (!u) return ack({ error: '暗号不正确' });
    // 给这次连接发新 token
    const token = issueToken(u.userId);
    // 当前 socket 也直接登入
    socket.data.userId = u.userId;
    socket.data.displayName = u.display_name;
    socket.data.token = token;
    socket.emit('account_info', { logged_in: true, userId: u.userId, display_name: u.display_name });
    console.log(`[auth] login userId=${u.userId} display="${u.display_name}"`);
    ack({ ok: true, userId: u.userId, display_name: u.display_name, token });
  });

  socket.on('get_my_info', (_, ack) => {
    ack = typeof ack === "function" ? ack : () => {};
    if (socket.data.userId) {
      ack({ logged_in: true, userId: socket.data.userId, display_name: socket.data.displayName });
    } else {
      ack({ logged_in: false });
    }
  });

  socket.on('logout', (_, ack) => {
    ack = typeof ack === "function" ? ack : () => {};
    if (socket.data.token) {
      revokeToken(socket.data.token);
      delete socket.data.userId;
      delete socket.data.displayName;
      delete socket.data.token;
    }
    socket.emit('account_info', { logged_in: false });
    ack({ ok: true });
  });

  // Phase 3: 获取我的历史
  socket.on('get_my_history', (_, ack) => {
    ack = typeof ack === "function" ? ack : () => {};
    if (!socket.data.userId) return ack({ error: '请先登录' });
    const myId = socket.data.userId;
    // 我参与过的 attempt
    const mine = attempts.attempts.filter(a => a.squad.includes(myId));
    // 按时间倒序
    mine.sort((a, b) => b.ended_at - a.ended_at);
    // 统计
    const total = mine.length;
    const wins = mine.filter(a => a.result === 'won').length;
    const losses = total - wins;
    // 当前连胜 (从最新往回数, 第一次断连胜的 attempt 处停下)
    let streak = 0;
    let lastResult = null;
    for (const a of mine) {
      if (lastResult === null) { lastResult = a.result; streak = (a.result === 'won' ? 1 : -1); }
      else if (a.result === lastResult) { streak += (a.result === 'won' ? 1 : -1); }
      else break;
    }
    // 按小队聚合
    const squadMap = new Map();
    for (const a of mine) {
      const key = a.squad.join('|');
      if (!squadMap.has(key)) {
        squadMap.set(key, {
          squad: a.squad,
          squad_nicknames: a.squad_nicknames,
          attempts: [],
        });
      }
      squadMap.get(key).attempts.push(a);
    }
    // 每个小队内部按时间倒序
    const squads = [...squadMap.values()].map(s => {
      s.attempts.sort((a, b) => b.ended_at - a.ended_at);
      const w = s.attempts.filter(x => x.result === 'won').length;
      return {
        ...s,
        total: s.attempts.length,
        wins: w,
        losses: s.attempts.length - w,
      };
    });
    // 按"最近一起玩"时间排序
    squads.sort((a, b) => b.attempts[0].ended_at - a.attempts[0].ended_at);
    // 按章节聚合
    const byChapter = {};
    for (const a of mine) {
      if (!byChapter[a.chapter_id]) byChapter[a.chapter_id] = { chapter_name: a.chapter_name, wins: 0, losses: 0 };
      if (a.result === 'won') byChapter[a.chapter_id].wins++;
      else byChapter[a.chapter_id].losses++;
    }
    ack({
      ok: true,
      attempts: mine,
      stats: {
        total, wins, losses,
        win_rate: total > 0 ? wins / total : null,
        streak,
        by_chapter: byChapter,
      },
      squads,
    });
  });

  socket.on('create_room', ({ nickname, chapter_id, clock_id, max_players, color, password }, ack) => {
    ack = typeof ack === "function" ? ack : () => {};
    if (!nickname || !nickname.trim()) return ack({ error: '请输入昵称' });
    // 私人房密码校验 (空字符串/null 视为无密码, 即公开房)
    if (password != null && password !== '') {
      if (typeof password !== 'string') return ack({ error: '密码格式错误' });
      if (password.length < 4 || password.length > 12) return ack({ error: '密码需 4-12 字符' });
    }
    const effectivePassword = (typeof password === 'string' && password.length > 0) ? password : null;
    const room = createRoom(chapter_id || DEFAULT_CHAPTER, clock_id, max_players, effectivePassword);
    const takenColors = new Set();
    const chosen = pickColor(color, takenColors);
    if (chosen.error) return ack({ error: chosen.error });
    room.players.push({
      socketId: socket.id,
      userId: socket.data.userId || null,  // ← 登录用户带 userId, 匿名 null
      nickname: nickname.trim(),
      hand: [],
      connected: true,
      color: chosen.color,
    });
    socket.join(room.id);
    if (room.host_idx == null) room.host_idx = 0;  // 第一个进房的玩家是房主
    console.log(`[room ${room.id}] created by ${nickname} (color=${chosen.color}, chapter=${room.chapter.id}, clock=${room.clock.id}, max=${room.max_players}, userId=${socket.data.userId || 'anon'})`);
    ack({ room_id: room.id, player_idx: 0, color: chosen.color, chapter: room.chapter.id, clock: room.clock.id, userId: socket.data.userId || null });
    broadcastRoom(room);
    broadcastRoomList();
  });

  socket.on('join_room', ({ room_id, nickname, color, password }, ack) => {
    ack = typeof ack === "function" ? ack : () => {};
    if (!nickname || !nickname.trim()) return ack({ error: '请输入昵称' });
    const room = rooms.get(room_id);
    if (!room) return ack({ error: '房间不存在' });
    if (room.state !== 'lobby') return ack({ error: '游戏已开始' });
    if (room.is_private && room.password !== (password || '')) {
      return ack({ error: '密码错误' });
    }
    if (room.players.length >= room.max_players) return ack({ error: `房间已满（最多 ${room.max_players} 人）` });
    const takenColors = new Set(room.players.map(p => p.color).filter(Boolean));
    const chosen = pickColor(color, takenColors);
    if (chosen.error) return ack({ error: chosen.error });
    room.players.push({
      socketId: socket.id,
      userId: socket.data.userId || null,
      nickname: nickname.trim(),
      hand: [],
      connected: true,
      color: chosen.color,
    });
    socket.join(room.id);
    const idx = room.players.length - 1;
    console.log(`[room ${room.id}] ${nickname} joined as P${idx} (color=${chosen.color}, userId=${socket.data.userId || 'anon'})`);
    ack({ room_id: room.id, player_idx: idx, color: chosen.color, userId: socket.data.userId || null });
    broadcastRoom(room);
    broadcastRoomList();
  });

  socket.on('rejoin_room', ({ room_id, nickname, password }, ack) => {
    ack = typeof ack === "function" ? ack : () => {};
    const room = rooms.get(room_id);
    if (!room) return ack({ error: '房间不存在' });
    if (room.is_private && room.password !== (password || '')) {
      return ack({ error: '密码错误' });
    }
    // 优先按 userId 匹配 (登录玩家), 找不到回退到 nickname 匹配 (匿名玩家)
    let player = null;
    if (socket.data.userId) {
      player = room.players.find(p => p.userId === socket.data.userId);
      if (!player) player = room.players.find(p => p.nickname === nickname);
    } else {
      player = room.players.find(p => p.nickname === nickname);
    }
    if (!player) return ack({ error: '该房间找不到此昵称' });
    if (player.isBot) return ack({ error: '此位置是 AI 机器人' });
    player.socketId = socket.id;
    player.connected = true;
    if (room.state === 'rules_intro') player.ready = false;
    socket.join(room.id);
    const idx = room.players.indexOf(player);
    console.log(`[room ${room.id}] ${nickname} rejoined as P${idx} (userId=${socket.data.userId || 'anon'})`);
    ack({ room_id: room.id, player_idx: idx, reconnected: true });
    broadcastRoom(room);
  });

  socket.on('fill_with_bots', (_, ack) => {
    ack = typeof ack === "function" ? ack : () => {};
    const { room, playerIdx } = findPlayerInRoom(socket.id);
    if (!room) return ack({ error: '未在房间' });
    if (playerIdx !== 0) return ack({ error: '只有房主能加 bot' });
    if (room.state !== 'lobby') return ack({ error: '游戏已开始' });
    const takenColors = new Set(room.players.map(p => p.color).filter(Boolean));
    let added = 0;
    while (room.players.length < room.max_players) {
      const i = room.players.length;
      // 找下一个可用颜色
      let botColor = null;
      for (const c of PLAYER_COLOR_IDS) {
        if (!takenColors.has(c)) { botColor = c; break; }
      }
      if (botColor) takenColors.add(botColor);
      room.players.push({
        socketId: null,
        nickname: `Bot ${i + 1}`,
        hand: [],
        connected: true,
        isBot: true,
        color: botColor,
      });
      added++;
    }
    console.log(`[room ${room.id}] added ${added} bots`);
    ack({ ok: true, added });
    broadcastRoom(room);
    broadcastRoomList();
  });

  socket.on('start_game', (_, ack) => {
    ack = typeof ack === "function" ? ack : () => {};
    const { room, playerIdx } = findPlayerInRoom(socket.id);
    if (!room) return ack({ error: '未在房间' });
    if (room.players.length < 2) return ack({ error: `至少 2 人，当前 ${room.players.length}` });
    if (room.players.length > room.max_players) return ack({ error: `超出房间上限 ${room.max_players}` });
    if (!room.players.every(p => p.connected)) return ack({ error: '有玩家未连接' });
    startGame(room);
    console.log(`[room ${room.id}] game started (chapter=${room.chapter.id}, clock=${room.clock.id}, ${room.players.length}P)`);
    ack({ ok: true });
    broadcastRoom(room);
    broadcastRoomList();
  });

  socket.on('i_am_ready', (_, ack) => {
    ack = typeof ack === "function" ? ack : () => {};
    const { room, playerIdx } = findPlayerInRoom(socket.id);
    if (!room) return ack({ error: '未在房间' });
    if (room.state !== 'rules_intro') return ack({ error: '现在不能准备' });
    const p = room.players[playerIdx];
    if (p.isBot) return ack({ error: 'Bot 不用准备' });
    if (p.ready) return ack({ error: '已经准备好了' });
    p.ready = true;
    console.log(`[room ${room.id}] P${playerIdx} ready`);
    const allReady = room.players.every(p => p.isBot || p.ready);
    if (allReady) {
      room.state = 'ready';
      console.log(`[room ${room.id}] all ready -> state=ready`);
    }
    ack({ ok: true });
    broadcastRoom(room);
  });

  socket.on('declare_first', (_, ack) => {
    ack = typeof ack === "function" ? ack : () => {};
    const { room, playerIdx } = findPlayerInRoom(socket.id);
    if (!room) return ack({ error: '未在房间' });
    if (room.state !== 'ready') return ack({ error: '现在不能抢答（请先在规则页都点"准备好"）' });
    if (room.first_player_idx !== null) return ack({ error: `已被 P${room.first_player_idx} 抢到` });
    room.first_player_idx = playerIdx;
    room.current_player_idx = playerIdx;
    room.state = 'playing';
    console.log(`[room ${room.id}] P${playerIdx} declared first`);
    ack({ ok: true });
    broadcastRoom(room);
    setTimeout(() => maybeBotAct(room), 400);
  });

  socket.on('play_card', (action, ack) => {
    ack = typeof ack === "function" ? ack : () => {};
    const { room, playerIdx } = findPlayerInRoom(socket.id);
    if (!room) return ack({ error: '未在房间' });
    if (room.state !== 'playing') return ack({ error: '游戏未在进行' });
    if (playerIdx !== room.current_player_idx) return ack({ error: '不是你的回合' });

    if (typeof action.card_idx !== 'number' ||
        action.card_idx < 0 ||
        action.card_idx >= room.players[playerIdx].hand.length) {
      return ack({ error: '无效的牌索引' });
    }
    if (typeof action.segment !== 'number' || action.segment < 1 || action.segment > room.chapter.n_segments) {
      return ack({ error: '无效的段' });
    }
    if (action.face_up && room.chapter.standard_rules && room.chapter.standard_rules.no_faceup_plays) {
      return ack({ error: '本章节禁止明牌' });
    }
    if (action.face_up && room.face_up_remaining <= 0) {
      return ack({ error: '明牌次数已用完' });
    }
    // Ch4 Roar: per-clock forced_play (leftmost / highest / lowest) 实时校验
    const fp = room.clock.forced_play;
    if (fp) {
      const hand = room.players[playerIdx].hand;
      let needIdx = -1;
      if (fp === 'leftmost') needIdx = 0;
      else if (fp === 'highest') {
        needIdx = hand.reduce((best, c, i) => (c.v > hand[best].v ? i : best), 0);
      } else if (fp === 'lowest') {
        needIdx = hand.reduce((best, c, i) => (c.v < hand[best].v ? i : best), 0);
      }
      if (action.card_idx !== needIdx) {
        const msg = fp === 'leftmost' ? '最左' : (fp === 'highest' ? '最大' : '最小');
        return ack({ error: `本章规定本回合必须出${msg}的牌` });
      }
    }
    // Per-clock placement validators (e.g. "1st card must go to seg 3")
    const placementErr = validatePlacement(room, action);
    if (placementErr) return ack({ error: placementErr });
    try {
      applyAction(room, playerIdx, action);
      checkGameEnd(room);
      ack({ ok: true });
      broadcastRoom(room);
      if (room.state === 'playing') setTimeout(() => maybeBotAct(room), 600);
    } catch (err) {
      ack({ error: err.message });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    const { room, playerIdx } = findPlayerInRoom(socket.id);
    if (room) {
      const p = room.players[playerIdx];
      p.connected = false;
      p.socketId = null;
      if (!p.isBot && (room.state === 'rules_intro' || room.state === 'ready')) {
        p.ready = false;
      }
      if (room.state === 'lobby') {
        room.players.splice(playerIdx, 1);
        if (room.players.length === 0) rooms.delete(room.id);
      }
      broadcastRoom(room);
      broadcastRoomList();
    }
  });

  // 主动退出房间 (区别于断线: 断线 slot 保留, 可重连; 主动退出 slot 删除)
  socket.on('leave_room', (_, ack) => {
    ack = typeof ack === "function" ? ack : () => {};
    const { room, playerIdx } = findPlayerInRoom(socket.id);
    if (!room) return ack({ ok: true });
    if (playerIdx < 0 || playerIdx >= room.players.length) return ack({ ok: true });
    const p = room.players[playerIdx];
    if (p.isBot) return ack({ error: 'Bot 不能主动退出' });
    if (room.state === 'finished') {
      // 终局: 退出只是离开, 不动游戏状态
      socket.leave(room.id);
      socket.emit('left_room', { reason: 'self_leave' });
      return ack({ ok: true });
    }
    // 调整所有 idx 引用 (在 splice 之前)
    const hostWasLeaving = (room.host_idx != null && room.host_idx === playerIdx);
    const adjustIdx = (ref) => {
      if (ref == null) return null;
      if (ref === playerIdx) return null;       // 退出的就是它 → 重置
      if (ref > playerIdx) return ref - 1;
      return ref;
    };
    if (room.current_player_idx === playerIdx) {
      // 当前玩家退出, 顺延到下一个 (剩余玩家中的下一个)
      const newLen = room.players.length - 1;
      if (newLen > 0) room.current_player_idx = playerIdx % newLen;
      else room.current_player_idx = null;
    } else {
      room.current_player_idx = adjustIdx(room.current_player_idx);
    }
    room.first_player_idx = adjustIdx(room.first_player_idx);
    if (room.host_idx != null) {
      if (hostWasLeaving) room.host_idx = -1;  // 标记, splice 后重新分配
      else if (room.host_idx > playerIdx) room.host_idx -= 1;
    }
    // 删除玩家
    console.log(`[room ${room.id}] ${p.nickname} (P${playerIdx}) left the room`);
    room.players.splice(playerIdx, 1);
    // 房主退出后重新分配 (此时数组已就位)
    if (hostWasLeaving) {
      const nextHost = room.players.findIndex(pl => !pl.isBot);
      room.host_idx = nextHost >= 0 ? nextHost : null;
    }
    // 游戏中: 没有任何非 bot 玩家时, 强制结束
    if (room.state === 'playing' || room.state === 'rules_intro' || room.state === 'ready') {
      const hasHuman = room.players.some(pl => !pl.isBot);
      if (!hasHuman) {
        if (room.state === 'playing') {
          revealRoom(room);
          room.state = 'finished';
          const result = checkResolution(room);
          room.game_result = { won: result.won, detail: result.detail, sums: result.sums };
        } else {
          // waiting 阶段没真人, 房间清空
          rooms.delete(room.id);
          socket.leave(room.id);
          socket.emit('left_room', { reason: 'no_humans' });
          broadcastRoomList();
          return ack({ ok: true });
        }
      }
    }
    // 房间空: 删房间
    if (room.players.length === 0) {
      rooms.delete(room.id);
      socket.leave(room.id);
      socket.emit('left_room', { reason: 'room_empty' });
      broadcastRoomList();
      return ack({ ok: true });
    }
    socket.leave(room.id);
    socket.emit('left_room', { reason: 'self_leave' });
    broadcastRoom(room);
    broadcastRoomList();
    ack({ ok: true });
  });

  // 房主可发: 终局后重新开始 (同 chapter/clock, 重新发牌)
  socket.on('restart_game', (_, ack) => {
    ack = typeof ack === "function" ? ack : () => {};
    const { room, playerIdx } = findPlayerInRoom(socket.id);
    if (!room) return ack({ error: '未在房间' });
    if (room.host_idx !== playerIdx) return ack({ error: '只有房主可以重新开始' });
    if (room.state !== 'finished') return ack({ error: '游戏未结束, 不能重新开始' });
    if (room.players.length < 2) return ack({ error: '人数不足, 不能重新开始' });
    console.log(`[room ${room.id}] host restart_game (chapter=${room.chapter.id}, clock=${room.clock.id})`);
    startGame(room);
    ack({ ok: true });
    broadcastRoom(room);
  });

  // 房主可发: 终局后切到同 chapter 的下一关 (回到第 1 钟时循环)
  socket.on('next_clock', (_, ack) => {
    ack = typeof ack === "function" ? ack : () => {};
    const { room, playerIdx } = findPlayerInRoom(socket.id);
    if (!room) return ack({ error: '未在房间' });
    if (room.host_idx !== playerIdx) return ack({ error: '只有房主可以切下一关' });
    if (room.state !== 'finished') return ack({ error: '游戏未结束, 不能切下一关' });
    if (room.players.length < 2) return ack({ error: '人数不足, 不能切下一关' });
    const clocks = room.chapter.clocks || [];
    if (clocks.length === 0) return ack({ error: '本章没有可切的钟面' });
    const curIdx = clocks.findIndex(c => c.id === room.clock.id);
    const nextIdx = (curIdx + 1) % clocks.length;
    room.clock = clocks[nextIdx];
    // 重置钟面相关 state (forbidden / second_hand 跟钟面走, 重新初始化)
    room.forbidden_segments = Array.isArray(room.clock.forbidden_segments)
      ? room.clock.forbidden_segments.slice()
      : [];
    console.log(`[room ${room.id}] host next_clock -> ${room.clock.id} (chapter=${room.chapter.id})`);
    startGame(room);
    ack({ ok: true, next_clock: room.clock.id });
    broadcastRoom(room);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Take Time v4 server listening on http://0.0.0.0:${PORT}`);
});

// Graceful shutdown — Render / systemd 滚动重启时, 关 HTTP server,
// 等当前请求 + WebSocket 处理完再退出. 默认 SIGTERM 是直接 kill, 玩家会掉线.
const SHUTDOWN_TIMEOUT_MS = 10000;  // 10 秒硬上限, 超时强制退出
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${signal}] received, shutting down (max ${SHUTDOWN_TIMEOUT_MS / 1000}s)...`);
  // 通知所有 socket 客户端即将关闭
  io.emit('server_shutdown', { reason: 'server_restart' });
  // 停接新连接
  server.close((err) => {
    if (err) console.error('server.close error:', err);
    io.close(() => {
      console.log('all sockets closed, exit.');
      process.exit(0);
    });
  });
  // 硬超时
  setTimeout(() => {
    console.error(`shutdown timeout (${SHUTDOWN_TIMEOUT_MS}ms), force exit.`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
