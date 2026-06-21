# 双 Agent 协作流程（Git Worktree 方案）

本项目用两个 Claude Code Agent 协作：**developer** 开发，**reviewer** 审核，靠 Git 分支 + worktree 隔离。

## 角色与工作区

| Agent | 工作区 | 分支 | 权限 |
|-------|--------|------|------|
| developer | `F:\Projects\local_password_manager\` | `feature/<task>`（基线 main） | 可读写源码、commit、push |
| reviewer | `F:\Projects\local_password_manager_review\` | `review`（只用来 hold worktree） | 只读源码、跑测试、出审查报告；通过后 merge feature→main 并 push main |

两个工作区共享同一个 `.git`（worktree 机制），互不踩文件。

## 标准协作闭环

```
1. 用户下任务给 developer
2. developer: git checkout -b feature/<task>  → 改代码 → 跑测试 → commit → push
3. developer 通知 reviewer: "审查 feature/<task>"
4. reviewer: ./scripts/review.sh feature/<task>
            → 按 5 维度审查 → 写 docs/review/feature-<task>.md → commit/push 报告 → 给结论
5a. ✅ 通过 + 用户确认发布: reviewer 执行 git merge --no-ff feature/<task> 到 main → push origin main
5b. ⚠️/❌ 需改: developer 在同一分支新增修复 commit → push → 通知 reviewer 复核
```

## 分支命名
- 开发分支：`feature/<英文-kebab-case>`，如 `feature/usb-pairing`、`feature/fix-utf8-export`
- main 只接审核通过的合并，**禁止直接在 main 上 commit 源码**
- 例外：协作流程配置本身（`AGENTS.md`、`.claude/agents/*`、`scripts/review.sh`）的修订可直接 commit 到 main，不经过 feature 分支
- review 分支是 worktree 占位，不放实质改动

## 审核基线
- reviewer 始终对比 `origin/main...origin/feature/<task>`，看"将要合入的全部改动"。
- 审核基于 commit，不看工作区未提交改动。

## 职责红线
- **reviewer 不改源码本身**（工具层面已禁用 Edit/Write）。可 commit/push 审查报告；审查通过 + 用户确认后，执行 merge feature→main 并 push main。
- **developer 不自行 merge 到 main**，等 reviewer 通过 + 用户确认。
- reviewer 跑测试时临时借主工作区，**完事必须还原**（见 reviewer.md），别污染 developer 的环境。
- 分歧由用户裁决。

## 跑测试
- review worktree **不装 node_modules**（省 F 盘、避免版本漂移）。
- 需要执行测试时，reviewer 按其 md 文档在主工作区临时拉取待审改动跑，跑完还原。
- 日常开发测试由 developer 在主工作区直接 `npm test`。

## 冲突处理
- 两 Agent 不同时改同一文件（worktree 物理隔离）。
- merge feature → main 时若冲突，由 developer 负责解决（reviewer 不介入改代码）。

## 首次设置（已完成）
```bash
git worktree add -b review F:/Projects/local_password_manager_review main
# 产物: .claude/agents/developer.md, .claude/agents/reviewer.md, scripts/review.sh
```
