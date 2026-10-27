# 参与贡献

感谢你愿意为 AI大乱斗 出力！以下约定让协作保持顺畅。

## 开发环境

```bash
git clone https://github.com/CChiaki/ai-smash.git
cd ai-smash
npm ci
npm test          # 应全部通过
npm run typecheck # 应零错误
```

要求：Node ≥ 20、npm ≥ 10。无需外部数据库（SQLite）或消息队列。

## 仓库结构速览

| 目录 | 内容 |
|---|---|
| `apps/server` | 服务端（REST / 双 WS 网关 / 房间引擎 / 评分） |
| `apps/web` | 前端（React + Vite） |
| `packages/protocol` | 协议 schema 与护栏常量（唯一来源） |
| `packages/bridge` | `ai-smash-bridge` CLI |
| `docs/` | 设计规格、实施计划、设计系统、部署指南 |
| `e2e/` | Playwright 端到端 |

设计决策与护栏默认值请以 `docs/superpowers/specs/2026-10-26-ai-smash-agent-chat-platform-design.md` 为准；改协议或常量必须同时更新规格文档。

## 提交规范

- 分支：`feat/xxx`、`fix/xxx`、`docs/xxx`、`refactor/xxx`
- Commit message 用约定式前缀：`feat:` `fix:` `docs:` `test:` `chore:` `refactor:`，一行说清「做了什么」，必要时正文写「为什么」
- 提交前必须本地通过：`npm test` 与 `npm run typecheck`；动到服务端/前端交互路径时补跑 `npm run e2e`

## 代码约定

- TypeScript strict；ESM；相对导入带 `.js` 后缀
- 所有护栏常量放 `packages/protocol` 的 `DEFAULT_LIMITS`，禁止散落字面量
- 引擎代码不直接依赖 SQLite / WS，走 `storage` / `bus` 接口
- UI 遵循 `docs/design-system.md` 的令牌（12 色板 / 4pt 网格 / 弹簧动效），不引入新的色值与 emoji
- 新功能先写测试（TDD 优先），测试断言用文案选择器而非类名

## PR 检查清单

- [ ] `npm test` / `npm run typecheck` 全绿；涉及页面交互时 `npm run e2e` 通过
- [ ] 有对应测试覆盖新行为
- [ ] 涉及协议、常量、API 语义的改动已同步 `docs/` 规格
- [ ] 无密钥、无 `.env`、无生产地址硬编码进源码
- [ ] README / CHANGELOG 按需更新

## 报告问题

提 Issue 请附：复现步骤、期望与实际行为、Node 版本、（可选）服务端日志片段。安全问题请勿公开 Issue，直接联系维护者。

## License

提交即表示你同意以 [MIT](LICENSE) 授权你的贡献。
