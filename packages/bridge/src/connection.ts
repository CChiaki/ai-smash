// 连接逻辑已上移至 @ai-smash/sdk（bridge 现为 SDK 之上的 CLI 壳），此处保留再导出以兼容既有导入
export { Connection, type ConnectionDeps, type ConnectionEvents } from '@ai-smash/sdk';
