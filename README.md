# pair-wise-yf-55 动态表单规则编排和版本迁移模拟器

## 源提示词摘要
业务人员拖拽字段、设置分组、联动条件、计算规则、必填逻辑和多语言文案；发布前模拟旧数据在新结构下的迁移。系统比较版本差异，警告失效规则、循环依赖和引用删除，同时按历史版本解释过去提交的数据。

## 技术栈
React 19 + TypeScript + Vite + MUI + Redux Toolkit + React Router + React Hook Form + dnd-kit。

## 版本账闭环
- **两本账分离**：已发布基线（`yf55-baseline-v2`，localStorage，跨标签页共享、带 `revision`）与草稿（sessionStorage，按标签页隔离）；草稿编辑不触碰任何已发布版本。旧账 `yf55-schema-state` 首次启动自动迁移（历史快照 → 缺规则版本的待归类申请）。
- **草稿影响预演**：发布前对最新基线预演，分组列出
  - 字段下线（按字段是否有值圈定受影响存量申请）；
  - 规则改向 / 删除 / 引用字段下线（同 id 规则触发字段、算符、取值、效果、目标任一变化）；
  - 计算依赖成环（DFS，环检测命中即阻断发布）；
  - 新增必填字段的迁移缺口。
- **确认后冻结发布**：确认后才生成不可变冻结版本（字段、联动规则、计算规则整体快照），冻结先落账并推进 `revision`，再给受影响存量申请逐项追加影响戳记。
- **写入可重试**：发布任务带逐项写入清单（冻结、每张单据的影响登记）；任何一项失败都保留整单，重试只处理 `pending/failed` 项，已完成项幂等不重复。
- **并发发布**：两个标签页同时提交时，后提交者按最新基线 `revision` 检测冲突；冲突时草稿保留、已发布版本不被覆盖，需按最新基线重新预演后再确认。跨标签页通过 `storage` 事件感知。
- **运行态冻结提交**：提交始终按当前已发布冻结版本执行，保存当时的规则版本号、规则快照与逐条校验解释（通过 / 拦截均保存）；后续发布只追加影响戳记，绝不改写旧解释。
- **历史数据兼容**：缺少规则版本的存量申请标为「待归类」，按原表单字段兼容读取（只给读数，不重算）；人工归类只补充解释与映射版本，不回填、不重算原校验结果。

## 验证
```bash
# 领域语义断言（成环 / 预演 / 冻结求值 / 兼容读取）
npx esbuild scripts/verify-domain.ts --bundle --platform=node --format=esm --outfile=/tmp/d.mjs && node /tmp/d.mjs
# 发布账断言（冲突 / 失败保留 / 重试幂等 / 归类不重算）
npx esbuild scripts/verify-store.ts scripts/store-bundle.ts --bundle --platform=node --format=esm --outdir=/tmp/sb --entry-names=[name] && node /tmp/sb/verify-store.js
```

## 启动
```bash
npm install
npm run dev
```
开发端口：62020
