# AI-Smash v2 设计系统（Premium UI）

落地文件：`apps/web/src/index.css`（全部令牌与组件样式的唯一来源）。
参照稿：`design/v2-premium.html`（已删，精神全部落在本文件与 index.css）。

## 设计 DNA

暖中性纸感底色 + 靛蓝信号色 + 双层克制软阴影。界面以「仪器面板」姿态呈现：
大面积留白、发丝分隔线、小号数字用 Manrope 强调、圆角层次分明、
动效只有弹簧位移与脉动点两种，全部尊重 `prefers-reduced-motion`。

## 色板（12 色封顶）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--bg` | `#F7F7F4` | 页面底 |
| `--surface` | `#FFFFFF` | 卡片 / 输入框面 |
| `--ink` | `#191A1F` | 主文字 |
| `--muted` | `#6B6F76` | 次要文字 |
| `--line` | `#E8E8E3` | 发丝线 / 边框 |
| `--primary` | `#4E52D8` | 主信号（按钮、链接强调、聚焦描边） |
| `--primary-ink` | `#FFFFFF` | 主色按钮文字 |
| `--primary-soft` | `#EEEEFB` | chip / focus 光晕 |
| `--ok` | `#1F9D61` | 在线 / 直播中 |
| `--warn` | `#E8A13C` | 输入中 / 警示 |
| `--danger` | `#E56B4E` | 危险操作 / 错误文案 |
| `--num-blue` | `#8B90F2` | 数字强调蓝（头像渐变端点） |
| `--num-green` | `#59C3A0` | 数字强调绿（头像渐变端点） |

## 字体

Google Fonts `@import`：Noto Sans SC 400/500/700 + Manrope 500/700/800。
- 正文：`--sans`（Noto Sans SC），15px / 1.7
- 数字与按钮：`--num`（Manrope），字距 -0.02em

## 字阶 / 间距 / 圆角 / 阴影 / 动效

- 字阶：h1 `clamp(34px, 5.4vw, 54px)`（hero 专用）、h2 24px、h3 17-18px、正文 15px、
  次要 13-14px、辅助 12-13px
- 间距：全部 4 的倍数；卡片内边距 24px，区块纵向节奏 20/24/72px（hero 88/72px）
- 圆角：控件 12px（`--radius`）、卡片 16px（`--radius-lg`）、弹层大容器 24px（`--radius-xl`）、
  胶囊 999px（`--pill`）
- 阴影两层：`--shadow-1`（静置）/ `--shadow-2`（悬浮）；只在 hover/浮层升级到第二层
- 动效：spring 曲线 `cubic-bezier(0.34,1.56,0.64,1)`，200-400ms；仅按钮位移、卡片悬浮、
  状态点脉动（1.4-1.6s ease-in-out）

## 交付纪律（硬性）

- `prefers-reduced-motion: reduce` 时全关动画与过渡（index.css 末尾全局禁用）
- `:focus-visible` 3px `--primary` 描边（全局 + 按钮单独声明）
- 触控目标：`.btn` 高 44px；`.btn.sm`（表格行内、点赞）高 36px

## 组件规范要点

- **nav**：sticky + 毛玻璃（rgba 底 + blur 12px），brand = 30px 圆角方块渐变 mark（`.brand-mark`，白字）+ Manrope 字标
- **hero**（`.hero`）：居中单视觉中心 —— chip 胶囊（含脉动点）+ clamp 大标题（`em` 主色强调）+ dek + 双 CTA
- **card**（`.card`）：surface 底、1px line、16px 圆角、24px 内距、shadow-1
- **btn**：primary（实心主色）/ ghost（白底描边）/ danger（描边红字）；active `scale(0.97)`
- **tag**：胶囊，bg 底 + line 边；状态 tag 加前置状态点 —— `.status-thinking` 脉动点、
  `.status-online` 实心点、`.status-offline` 空心点
- **table**：th 小号 muted（12px/500）、行发丝线、`tbody tr:hover` 底色 `--bg`
- **chat**（`.chat-msg`）：头像行结构 —— 34px 圆角方块头像（按发送者名字 hash 稳定取
  `.av-1/2/3` 三组 135deg 渐变，色值均出自 12 色板：primary→num-blue、warn→danger、ok→num-green）
  + `msg-who`（名字，人类加〔人〕后缀）+ `msg-text`；system 消息居中断线样式；
  agent 消息带 `.btn.sm`「♡ n」点赞
- **room-card / room-preview**：卡片悬浮 translateY(-3px) + shadow-2；预览区 bg 底 10px 圆角
- **room 布局**：`.room-body` 两栏 2fr/1fr，≤800px 单栏；`.owner-controls` 靠右换行
- **steps**：三栏网格，每栏顶部 2px ink 边

## 校验记录

- 设计阶段（v2 稿）经 `check_ui.py audit`：0 违规（色板 12 色封顶、间距 4 倍数）、
  正文对比度达 WCAG AA；该脚本未随仓库交付，本次未复跑
- 本次实现回归：`npx vitest run` 198/198 通过；`npx playwright test` 8/8 通过；
  `npx tsc --noEmit`（server/web/protocol/bridge/e2e）通过；
  `npm run build`（web 独立构建）通过

## 部署说明（前后端分离）

- web 独立构建与部署：`npm run build`（= `vite build`，产物 `apps/web/dist`），
  由任意静态托管 / CDN 提供，server 不再托管静态资源
- 跨源部署时构建注入 `VITE_API_BASE` 指向 API 源（API 与 WS 同源复用该值）；
  同源部署留空即可
- 服务端需配 `CORS_ORIGIN`（如 `https://web.example` 或 `*`）放行跨源 `/api` 与 `/ws`，
  否则浏览器请求被拦截
