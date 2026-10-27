# JJVUoj 部署文档

本文档面向第一次部署 JJVUoj 的同学/管理员，覆盖 Windows 本机试跑、Linux 服务器正式部署、日常运维、备份迁移和常见故障。

- 项目目录（当前）：`D:\JJVUoj`
- 默认访问地址：`http://localhost:8888/d/jjyu/`
- 技术栈：Docker Compose + MongoDB 6 + HydroOJ 5.0.7 + HydroJudge 4.0.6 + go-judge 1.9.4

---

## 1. 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10/11（WSL2）、Linux、macOS |
| Docker | Docker Desktop 或 Docker Engine + Compose v2 |
| 内存 | 建议 ≥ 4 GB 可用（后端 + 判题机 + Mongo） |
| 磁盘 | 镜像约 7 GB，数据目录按使用量增长 |
| 网络 | 首次构建需访问 npm 源（已在 Dockerfile 中使用 npmmirror）；判题机镜像需要下载 go-judge |

检查环境：

```bash
docker --version
docker compose version
```

---

## 2. 首次部署（Windows 本机）

### 2.1 准备配置

```bash
cd /d/JJVUoj
cp .env.example .env
```

按需编辑 `.env`：

```ini
# 管理员初始密码，留空则自动生成
ADMIN_PASSWORD=

# AI 出题的默认模型（也可以启动后在网页里改）
AI_BASE_URL=https://api.deepseek.com/v1
AI_MODEL=deepseek-chat
AI_API_KEY=
```

> `.env` 只在**首次初始化**（`data/` 为空）时决定管理员密码和默认模型；之后修改不会覆盖数据库里的值。

### 2.2 构建并启动

```bash
docker compose up -d --build
```

首次构建需要下载基础镜像并通过 npm 安装 Hydro，通常 10–30 分钟。完成后检查：

```bash
docker compose ps                 # 三个服务都应为 Up，backend/mongo 为 healthy
curl http://localhost:8888/status # 返回 200
docker compose logs -f oj-judge   # 出现 "End: { status: 1, score: 100 ... }" 即判题机自检通过
```

浏览器打开：

```
http://localhost:8888/d/jjyu/
```

### 2.3 获取管理员密码

```bash
cat data/backend/admin-password.txt
```

- 用户名固定为 `admin`
- 密码也可通过在 `.env` 中设置 `ADMIN_PASSWORD` 预先指定
- 忘记密码时重置：

```bash
docker exec jjvuoj-backend hydrooj cli user setPassword 1 '新密码'
```

### 2.4 首次启动自动完成的内容

`backend/entrypoint.sh` 在数据目录为空时自动执行：

1. 注册 Hydro 扩展：`@hydrooj/ui-default` 和本地插件 `/root/.hydro/addons/ai-problem`
2. 写入 Mongo 连接配置
3. 创建评测账号 `systemjudge`（uid 2）并授予判题权限
4. 创建管理员 `admin`（uid 1），密码写入 `data/backend/admin-password.txt`
5. 创建域 `jjyu`（名称 JJVUoj，所有者 admin）
6. 设置站点名、Logo、监听地址
7. 开放域加入：任何已登录用户可直接加入 `jjyu`
8. 创建示例题目、示例比赛和示例作业（幂等，重复执行不会重复创建）

---

## 3. 学生使用流程

1. 打开 `/d/jjyu/register`
2. 填写邮箱（仅作账号标识，未配置 SMTP 不会发信）→ 下一步设置用户名和密码
3. 首次进入题库时点击「加入」，加入 `jjyu` 域
4. 选题 → 提交代码 → 在「记录」中查看评测结果

安卓手机浏览器可直接使用，不需要安装 App。

---

## 4. 局域网 / 手机访问

1. 查看电脑局域网 IP：

   ```bash
   ipconfig | findstr IPv4
   ```

2. 手机与电脑连接同一 Wi-Fi，访问：

   ```
   http://<电脑IP>:8888/d/jjyu/
   ```

3. Windows 防火墙放行 8888 端口（首次运行 Docker 时选择允许「专用网络」即可）。
4. 若使用校园网/公司网络，确认 AP 隔离（AP Isolation）未开启，否则手机无法访问电脑。

> Docker Desktop 的端口映射默认监听 `0.0.0.0`，无需额外配置。

---

## 5. 正式部署到 Linux 服务器

推荐配置：2 核 4 GB 以上，Ubuntu 22.04/24.04。

### 5.1 安装 Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # 重新登录后生效
```

### 5.2 上传项目并配置

```bash
# 在服务器上
git clone <你的仓库> /opt/JJVUoj   # 或 scp 整个目录
cd /opt/JJVUoj
cp .env.example .env
vi .env    # 设置 ADMIN_PASSWORD、AI_BASE_URL、AI_MODEL、AI_API_KEY
```

### 5.3 修改判题密码

默认判题账号是 `judge / examplepassword`，公网部署必须修改：

1. 编辑 `judge/judge.yaml` 的 `password`
2. 在 `docker-compose.yml` 的 `oj-backend.environment` 中加入：

   ```yaml
   JUDGE_PASSWORD: 你的新密码
   ```

3. 重新启动：

   ```bash
   docker compose up -d
   ```

> 两处必须一致，否则判题机连不上后端，提交会一直排队。

### 5.4 启动

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8888/status
```

### 5.5 配置 HTTPS 反向代理

不建议直接把 8888 暴露到公网，建议用 Caddy 或 Nginx 反向代理。

**Caddy（自动申请证书）**

```caddyfile
oj.example.com {
    reverse_proxy 127.0.0.1:8888
}
```

**Nginx**

```nginx
server {
    listen 443 ssl http2;
    server_name oj.example.com;

    ssl_certificate     /etc/letsencrypt/live/oj.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/oj.example.com/privkey.pem;

    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:8888;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

配置完成后建议在站点里把 `server.url` 设置为公网地址（管理员 → 系统设置），保证邮件/回调等链接正确。

### 5.6 安全清单

- [ ] 修改默认管理员密码
- [ ] 修改默认判题密码，并同步 `judge/judge.yaml` 与 `JUDGE_PASSWORD`
- [ ] 不要把 Mongo（27017）和 go-judge（5050）映射到公网
- [ ] 使用 HTTPS
- [ ] 定期备份 `data/`
- [ ] 确认 AI 出题仅管理员可见（默认已是 `PRIV_EDIT_SYSTEM`）
- [ ] 及时更新系统与镜像

---

## 6. 数据、备份与恢复

所有持久化数据都在 `data/`：

| 路径 | 内容 |
| --- | --- |
| `data/mongo/` | MongoDB 数据（用户、题目、提交、比赛） |
| `data/backend/` | Hydro 配置、`addon.json`、管理员密码文件 |
| `data/file/` | 测试数据、上传文件 |

### 6.1 备份

```bash
docker compose down          # 必须先停，避免 Mongo 写坏
tar -czf jjvuoj-backup-$(date +%F).tar.gz data/
docker compose up -d
```

> 不要在容器运行时直接复制 `data/mongo`。

### 6.2 恢复

```bash
docker compose down
mv data data.old
tar -xzf jjvuoj-backup-2026-10-27.tar.gz   # 解压出 data/
docker compose up -d
```

确认无误后再删除 `data.old`。

### 6.3 迁移到新目录 / 新机器

```bash
# 旧机器
docker compose down
# 复制整个项目目录（含 data/）到新位置 / 新机器

# 新位置
cd /d/JJVUoj        # 或新机器上的目录
docker compose up -d
```

镜像不需要重新构建；Compose 会按新目录的相对路径重新创建容器和数据挂载。

---

## 7. 日常运维命令

```bash
docker compose ps                     # 服务状态
docker compose logs -f oj-backend     # 后端日志
docker compose logs -f oj-judge       # 判题日志
docker compose restart oj-backend     # 修改插件代码后重启后端
docker compose up -d --build          # 修改 Dockerfile 后重建镜像
docker compose down                   # 停止（保留数据）
docker compose down -v                # 停止并删除卷（危险）
```

### 常用 Hydro CLI

```bash
docker exec jjvuoj-backend hydrooj cli user setPassword 1 '新密码'
docker exec jjvuoj-backend hydrooj cli user setSuperAdmin <uid>
docker exec jjvuoj-backend hydrooj cli system get server.name
docker exec jjvuoj-backend hydrooj cli domain add <domainId> 1 "名称" "简介"
```

### 修改首页内容

首页正文来自域的公告（`bulletin`），默认内容在 `backend/seed/home.md`，首次启动时写入 `system`（站点根路径 `/`）和 `jjyu`（`/d/jjyu/`）两个域。修改有两种方式：

- **在线改**：管理员进入对应域 → 管理域 → 编辑域资料，直接编辑公告。
- **改文件后重建**：编辑 `backend/seed/home.md`，执行 `docker compose up -d --build oj-backend`。注意该文件只在首次初始化时自动写入，已有数据的环境需要执行下面的命令手动刷新：

```bash
docker exec jjvuoj-backend hydrooj cli execute \
  "const c=require('fs').readFileSync('/root/seed/home.md','utf8'); await DomainModel.edit('system',{bulletin:c}); await DomainModel.edit('jjyu',{bulletin:c})"
```

> 首页公告支持 Markdown，可以放站内入口链接和外部链接（例如 GitHub 主页）。

公告卡片底部的「开发与维护」圆形头像按钮不在 Markdown 里，而是由插件覆盖的模板
`addons/ai-problem/templates/partials/homepage/bulletin.html` 渲染（Markdown 的 XSS 白名单不允许
`border-radius` 和 `:hover`，做不了圆形按钮 + 悬浮提示）。要换头像 / 名字 / 链接，直接改这个文件里的
`href`、`img src` 和 `.jjyuoj-dev__tip` 文本，然后 `docker compose restart oj-backend`。

### 站点品牌与头像

顶部导航里显示的域名默认是「Hydro」（根域 `system` 的名称），且用户头像默认走 Gravatar
（`cn.gravatar.com`，国内打不开，会显示破图）。这两处由 `backend/seed/site-config.js` 处理，
**头像、背景图全部本地化，不访问任何外网**：

- 把根域名称改成 `JJVUoj`；
- 把 Gravatar 地址改成本站自己的路由 `/jjyuoj-avatar/`（插件 `JjyuojDefaultAvatarHandler`
  返回本地默认头像 SVG，任何头像请求都不再出网）；
- 把 `system`、`jjyu` 两个域的域头像指向本地 `/jjyuoj-logo.png`（`url:` 前缀表示直接用该地址）。

用户个人主页的背景图（`/components/profile/backgrounds/*.jpg`）本来就由站点本地提供，无需处理。

该脚本幂等，首次启动自动执行。**已部署的环境**手动执行一次即可（然后重启后端）：

```bash
docker exec jjvuoj-backend hydrooj cli execute \
  "await SystemModel.set('avatar.gravatar_url','/jjyuoj-avatar/'); await DomainModel.edit('system',{name:'JJVUoj',avatar:'url:/jjyuoj-logo.png'}); await DomainModel.edit('jjyu',{avatar:'url:/jjyuoj-logo.png'})"
docker compose restart oj-backend
```

### 语言时间 / 内存倍率

题目里填的 `time` / `memory` 是基础限制，判题时会乘以该语言的倍率（HydroJudge 的 `time_limit_rate` / `memory_limit_rate`）。默认配置在 `backend/seed/lang-config.js`，首次初始化写入 `hydrooj.langs`：

| 语言 | 时间倍率 | 内存倍率 |
| --- | --- | --- |
| Java / Kotlin | 2 | 2 |
| Python / Python3 / PyPy3 | 3 | 2 |
| Node.js | 2 | 2 |
| C / C++ 及其他 | 1 | 1 |

例：题目写 1000ms / 64MB，Java 实际可用 2000ms / 128MB，Python 3000ms / 128MB，C++ 仍为 1000ms / 64MB。

注意事项：

- 修改 `lang-config.js` 的 `RATES` 表后，用下面的命令写入，然后**必须重启后端**（`docker compose restart oj-backend`），判题机重连时才会拿到新配置：

```bash
docker exec jjvuoj-backend hydrooj cli execute "$(cat backend/seed/lang-config.js)"
docker compose restart oj-backend
```

- 通过 CLI / `SystemModel.set` 改 `hydrooj.langs` 不会热更新正在运行的后端：设置推送只带键 `hydrooj.langs`，而后端在 `system/setting` 事件里读的是 `args.hydrooj.langs`（嵌套路径），两者对不上，重启是必要的；在管理后台「系统设置 → 语言设置」里改则会即时推送。
- Java 在沙箱的小内存限制下，JVM 默认按宿主机内存推算初始堆，容易直接启动失败（表现为提交立刻 RE、退出码 1、耗时几十毫秒）。`lang-config.js` 已给 `java.execute` 加上 `-Xms8m -Xmx4096m -XX:+UseSerialGC`：固定很小的初始堆，堆再按 cgroup 限制按需增长。若手动改过 Java 命令，请保留类似参数。

### 可见语言

判题镜像里实际只装了 gcc/g++、javac/java、python3、node。提交页默认只展示：

| 语言 | 语言键 |
| --- | --- |
| C | `c` |
| C++（C++14） | `cc` |
| C++11 | `cc.cc11` |
| C++17 | `cc.cc17` |
| Java | `java` |
| Python 3 | `py.py3` |

其余语言由 `lang-config.js` 统一设成 `hidden: true`；其中工具链缺失的（Pascal、Kotlin、PyPy3、PHP、Rust、Haskell、Go、Ruby、C#、R）再设 `disabled: true`，即使题目单独允许也拒绝提交。Node.js、Bash、Python（无版本号的 `py`）只是隐藏，仍可通过题目/域的语言列表单独放开。

调整方法：改 `lang-config.js` 顶部的 `VISIBLE` / `MISSING` 两个集合，执行第 330 行的写入命令并重启后端。如果要在判题镜像里补装某个语言，先改 `judge/Dockerfile` 安装工具链，再把语言键加进 `VISIBLE`（并从 `MISSING` 移除）。

---

## 8. AI 出题配置

1. 管理员登录 → 顶部导航「AI 出题」
2. 右侧「模型配置」填写：

   | 服务 | Base URL | 模型名 |
   | --- | --- | --- |
   | DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
   | 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
   | 其他 OpenAI 兼容服务 | 对应 `/v1` 地址 | 对应模型名 |

3. 保存后填写题目主题，选择难度/时间/内存/测试点数量，点击「开始生成」
4. 生成成功后务必人工检查题面和测试数据

相关限制：

- 单次生成最多 15 个测试点，整体时限 240 秒
- 生成测试数据时会在 go-judge 沙箱内运行标程与生成器，不执行不可信代码于后端
- API Key 保存在 Mongo 的 `system` 集合中，仅管理员可修改

---

## 9. 故障排查

| 现象 | 排查方向 |
| --- | --- |
| 构建时 npm 超时 | Dockerfile 已使用 npmmirror；检查网络/代理，或改用其他 registry |
| 镜像拉取失败 | 检查 Docker Desktop 代理与镜像加速；`docker pull` 单独测试 |
| 后端启动后 500 / 模板报错 | `docker compose logs oj-backend`；确认 ui-default 与 Hydro 版本匹配 |
| 登录 POST 403 | 表单字段为 `uname`/`password`，不是 `username`；确认用户存在 |
| 提交一直排队 | 判题机未连上：检查 `judge/judge.yaml` 与 `JUDGE_PASSWORD` 是否一致，看 oj-judge 日志 |
| 判题机自检失败 | 容器需 `privileged: true`；确认宿主机支持；看缺失的编译器 |
| 新用户看不到题目 | 未加入 `jjyu` 域，访问 `/domain/join?target=jjyu` 加入 |
| 作业列表 500 | 作业缺少 `penaltySince`/`penaltyRules`，通过正常作业创建流程创建 |
| Java 提交秒 RE（退出码 1，耗时几十毫秒） | 小内存下 JVM 默认堆策略启动失败；确认 `java.execute` 带有 `-Xms8m -Xmx4096m -XX:+UseSerialGC` |
| 改了语言倍率不生效 | CLI 修改 `hydrooj.langs` 后必须 `docker compose restart oj-backend` |
| AI 页面 500 | 插件模板变量不要命名为 `model`（会遮蔽 Hydro 全局 `model` 对象） |
| 顶部域名显示「Hydro」、头像破图 | 根域默认名未改 + Gravatar 被墙。执行 `backend/seed/site-config.js`（见「站点品牌与头像」） |
| AI 页面难度/时间/内存字段为空 | 插件传给模板的表单数据不能用 `form`（`layout/html5.html` 已把 `form` 用作表单宏命名空间），应命名 `genForm` |
| AI 生成报“判题沙箱不可用” | 确认 `oj-judge` 已启动且后端能访问 `http://oj-judge:5050` |
| 磁盘不足 | `docker system df`、`docker image prune`、清理旧数据 |

---

## 10. 已知限制

- 未配置 SMTP：注册可用，但找回密码不可用
- 单机部署，Mongo 未启用副本集，不支持多后端横向扩展
- 判题机以特权容器运行沙箱，部分托管平台可能禁止
- Windows 下 `data/` 走 WSL2 文件系统，性能低于 Linux 原生
- AI 生成的题目质量取决于模型，必须人工审核
