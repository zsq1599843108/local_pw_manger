#!/usr/bin/env bash
# review.sh — 审核 Agent 辅助脚本
# 用法: ./scripts/review.sh feature/<name>
# 作用: 在 review worktree 里同步指定分支引用，打印待审提交清单 + diff 摘要
set -euo pipefail

BRANCH="${1:-}"
if [[ -z "$BRANCH" ]]; then
  echo "用法: ./scripts/review.sh feature/<name>"
  exit 1
fi

REVIEW_DIR="F:/Projects/local_password_manager_review"
cd "$REVIEW_DIR"

echo "=== fetch 最新引用 ==="
git fetch origin 2>/dev/null || echo "(fetch 失败或无 remote，改用本地分支)"

# 解析引用：本地分支优先，其次 origin/<branch>，支持已带 origin/ 前缀的写法
REF=""
if [[ "$BRANCH" == origin/* ]]; then
  REF="$BRANCH"
elif git rev-parse --verify --quiet "$BRANCH" >/dev/null; then
  REF="$BRANCH"                       # 本地分支（本地 worktree 协作，无需 push）
elif git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null; then
  REF="origin/$BRANCH"                # developer 已 push 的远端分支
fi

if [[ -z "$REF" ]]; then
  echo "❌ 找不到分支 $BRANCH（本地和 origin 均无），确认 developer 已建分支/push"
  exit 2
fi

BASE="main"
# 基线优先用本地 main，没有则用 origin/main
git rev-parse --verify --quiet "$BASE" >/dev/null || BASE="origin/main"
echo "=== 待审提交清单 ($BASE..$REF) ==="
git log --oneline "$BASE..$REF"

echo
echo "=== 改动文件摘要 ==="
git diff --stat "$BASE...$REF"

echo
echo "=== 完整 diff（前 300 行）==="
git diff "$BASE...$REF" | head -300

echo
echo ">>> 如需跑测试，参考 reviewer.md 的『跑测试』章节（在主工作区执行）"
echo ">>> 审查报告写到 docs/review/$(echo "$BRANCH" | tr '/' '-').md"
