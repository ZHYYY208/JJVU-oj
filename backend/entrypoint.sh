#!/bin/sh
set -e

ROOT=/root/.hydro
ADDON=/root/.hydro/addons/ai-problem

mkdir -p "$ROOT" /data/file

# 注册默认 UI 和本地 AI 出题插件（每次启动都确保存在）
node -e '
const fs = require("fs");
const p = "/root/.hydro/addon.json";
let list = [];
try { list = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) {}
for (const item of ["@hydrooj/ui-default", "/root/.hydro/addons/ai-problem"]) {
  if (!list.includes(item)) list.push(item);
}
fs.writeFileSync(p, JSON.stringify(list, null, 2));
'

if [ ! -f "$ROOT/config.json" ]; then
  echo '{"host": "oj-mongo", "port": "27017", "name": "hydro"}' > "$ROOT/config.json"
fi

if [ ! -f "$ROOT/first" ]; then
  echo "initialized" > "$ROOT/first"

  JUDGE_PASS="${JUDGE_PASSWORD:-examplepassword}"
  hydrooj cli user create systemjudge@systemjudge.local judge "$JUDGE_PASS" 2 2>/dev/null || true
  hydrooj cli user setJudge 2 2>/dev/null || true

  ADMIN_PASS="${ADMIN_PASSWORD:-}"
  if [ -z "$ADMIN_PASS" ]; then
    ADMIN_PASS="$(node -e 'console.log(require("crypto").randomBytes(9).toString("base64url"))')"
  fi
  hydrooj cli user create admin@jjyu.local admin "$ADMIN_PASS" 1 2>/dev/null || true
  hydrooj cli user setSuperAdmin 1 2>/dev/null || true
  printf '%s\n' "$ADMIN_PASS" > "$ROOT/admin-password.txt"
  chmod 600 "$ROOT/admin-password.txt"

  hydrooj cli domain add jjyu 1 "JJVUoj" "九江职业大学在线评测系统" 2>/dev/null || true
  hydrooj cli execute "await DomainModel.edit('jjyu', { _join: { method: 1, role: 'default' } })" 2>/dev/null || true
  hydrooj cli system set server.host 0.0.0.0 2>/dev/null || true
  hydrooj cli system set server.name "JJVUoj" 2>/dev/null || true
  hydrooj cli system set ui-default.nav_logo_dark "/jjyuoj-logo.png" 2>/dev/null || true

  # 示例题目 / 比赛 / 作业（幂等，失败不阻塞启动）
  SEED_CODE="$(cat /root/seed/seed-demo.js)"
  hydrooj cli execute "$SEED_CODE" 2>/dev/null || true

  # 分语言的时间 / 内存倍率（幂等，失败不阻塞启动）
  LANG_RATES_CODE="$(cat /root/seed/lang-config.js)"
  hydrooj cli execute "$LANG_RATES_CODE" 2>/dev/null || true

  # 站点品牌与头像配置（幂等，失败不阻塞启动）
  SITE_CONFIG_CODE="$(cat /root/seed/site-config.js)"
  hydrooj cli execute "$SITE_CONFIG_CODE" 2>/dev/null || true
fi

echo "[JJVUoj] backend starting, admin password file: ./data/backend/admin-password.txt"
pm2-runtime start hydrooj
