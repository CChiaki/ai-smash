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

function stagePackage(name, versions) {
  const pkgDir = join(ROOT, 'packages', name);
  const outDir = join(OUT, name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 编译产物
  cpSync(join(pkgDir, 'dist'), join(outDir, 'dist'), { recursive: true });

  // package.json：应用 publishConfig（exports/main/types → ./dist），剥离发布无关字段；
  // workspace 内部依赖（*）钉到本次实际发布版本，避免线上解析到未知未来版本
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  if (pkg.dependencies) {
    for (const dep of Object.keys(pkg.dependencies)) {
      const depName = dep.replace('@ai-smash/', '');
      if (versions[depName]) pkg.dependencies[dep] = `^${versions[depName]}`;
    }
  }
  const pub = pkg.publishConfig ?? {};
  delete pkg.publishConfig;
  for (const key of ['exports', 'main', 'types', 'access', 'bin', 'directories']) {
    if (pub[key] !== undefined) pkg[key] = pub[key];
  }
  delete pkg.scripts;
  delete pkg.devDependencies;
  writeFileSync(join(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  // 文档与许可：包内 README 供 npm 页面展示，仓库 CHANGELOG 随包发布供查阅更新历史
  for (const f of ['README.md', 'LICENSE']) {
    const src = join(pkgDir, f);
    if (existsSync(src)) cpSync(src, join(outDir, f));
  }
  if (existsSync(join(ROOT, 'CHANGELOG.md'))) {
    cpSync(join(ROOT, 'CHANGELOG.md'), join(outDir, 'CHANGELOG.md'));
  }

  // scope 路由：在发布包目录内也能命中官方源（npm 的 .npmrc 查找止于最近的 package.json）
  writeFileSync(join(outDir, '.npmrc'), '@ai-smash:registry=https://registry.npmjs.org/\n');
  if (!existsSync(join(outDir, 'LICENSE'))) {
    cpSync(join(ROOT, 'LICENSE'), join(outDir, 'LICENSE'));
  }

  const files = readdirSync(outDir).join(', ');
  console.log(`  ✓ dist/${name}/ (${files})`);
}

// 1. 清理并构建
rmSync(OUT, { recursive: true, force: true });
const versions = {};
for (const name of PACKAGES) {
  versions[name] = JSON.parse(readFileSync(join(ROOT, 'packages', name, 'package.json'), 'utf8')).version;
  sh(`npx tsc -p packages/${name}/tsconfig.build.json`);
}

// 2. 组装
mkdirSync(OUT, { recursive: true });
for (const name of PACKAGES) {
  stagePackage(name, versions);
}

console.log(`
发布产物已组装到 ${OUT}/
  发布：cd dist/protocol && npm publish --access public
        cd dist/sdk && npm publish --access public   （依赖 protocol 已发布）
  注意：dist/ 已整棵重建，停留在旧 dist 目录里的终端请重新 cd 进去再执行 npm 命令
`);
