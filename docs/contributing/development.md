# 本地开发

## 安装依赖

```bash
npm install
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run check` | 语法检查（`typescript-language-server` 不可用时作为 LSP 诊断替代） |
| `npm run test:stable` | 稳定测试集（自动扫描 `tests/*.mjs`） |
| `npm run test:p0` | P0 主回归 |
| `npm run test:persistence-matrix` | 持久化矩阵（p0 + runtime-history + graph-persistence + indexeddb） |
| `npm run test:index-slicing-ratchet` | 防止测试切片 `index.js` 的防线 |
| `npm run test:runtime-deps` | 依赖注入完整性守卫 |
| `npm run build:native:wasm` | 构建 Native WASM |
| `npm run version:bump-manifest` | 更新 manifest 版本 |

控制面/数据格式专项测试见 [`testing.md`](testing.md)。

## 完整脚本参考

控制面与数据格式专项：

```bash
npm run test:identity-resolver
npm run test:persistence-reducer
npm run test:runtime-deps
npm run test:vector-gate
npm run test:generation-context
npm run test:graph-snapshot-schema
npm run test:graph-snapshot-upgrade
npm run test:snapshot-forward-compat
npm run test:luker-snapshot-forward-compat
```

持久化矩阵：

```bash
npm run test:persistence-matrix
```

IndexedDB 专项：

```bash
npm run test:indexeddb
```

Native / 性能相关：

```bash
npm run test:native-layout-parity
npm run bench:graph-layout
npm run bench:persist-delta
npm run bench:persist-load
npm run bench:load-preapply
```

构建 Native WASM：

```bash
npm run build:native:wasm
```

更新 manifest 版本：

```bash
npm run version:bump-manifest
```

## 提交前

至少运行：

```bash
npm run check
npm run test:stable
```

涉及具体子系统时，额外跑对应专项测试。

## 分支工作流

- 功能开发推到 `dev` 分支，不直接推 `main`。
- 合并带 `manifest.json` 版本冲突的分支时，保留更高的版本号。
- 远端 `dev` 常有自动版本 bump，merge 时按上面规则处理，不要 force push。

## 环境提示

- `typescript-language-server` 在当前环境未安装，用 `npm run check` 作为 LSP 诊断替代。
- git 身份缺失时，按命令注入 `GIT_AUTHOR_*` / `GIT_COMMITTER_*` 环境变量，不要改 git config。
