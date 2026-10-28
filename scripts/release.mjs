#!/usr/bin/env node
/**
 * npm run release —— 组装发布产物到仓库根 dist/
 *
 * 产出结构（每个目录即一个可直接 `npm publish` 的包）：
 *   dist/protocol/   @ai-smash/protocol（package.json 已切换为 dist exports）
 *   dist/sdk/        @ai-smash/sdk（同上）
 *
 * 用法：cd dist/sdk && npm publish --access public（先发 protocol）
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'dist');
const PACKAGES = ['protocol', 'sdk']; // 依赖顺序：protocol 先构建

function sh(cmd, cwd = ROOT) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
}

function stagePackage(name) {
  const pkgDir = join(ROOT, 'packages', name);
  const outDir = join(OUT, name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 编译产物
  cpSync(join(pkgDir, 'dist'), join(outDir, 'dist'), { recursive: true });

  // package.json：应用 publishConfig（exports/main/types → ./dist），剥离发布无关字段
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const pub = pkg.publishConfig ?? {};
  delete pkg.publishConfig;
  if (pub.exports) pkg.exports = pub.exports;
  if (pub.main) pkg.main = pub.main;
  if (pub.types) pkg.types = pub.types;
  delete pkg.scripts;
  delete pkg.devDependencies;
  writeFileSync(join(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  // 文档与许可
  for (const f of ['README.md', 'LICENSE']) {
    const src = join(pkgDir, f);
    if (existsSync(src)) cpSync(src, join(outDir, f));
  }
  if (!existsSync(join(outDir, 'LICENSE'))) {
    cpSync(join(ROOT, 'LICENSE'), join(outDir, 'LICENSE'));
  }

  const files = readdirSync(outDir).join(', ');
  console.log(`  ✓ dist/${name}/ (${files})`);
}

// 1. 清理并构建
rmSync(OUT, { recursive: true, force: true });
for (const name of PACKAGES) {
  sh(`npx tsc -p packages/${name}/tsconfig.build.json`);
}

// 2. 组装
mkdirSync(OUT, { recursive: true });
for (const name of PACKAGES) {
  stagePackage(name);
}

console.log(`
发布产物已组装到 ${OUT}/
  发布：cd dist/protocol && npm publish --access public
        cd dist/sdk && npm publish --access public   （依赖 protocol 已发布）
`);
