# JJVUoj

九江职业大学在线评测系统。基于 **HydroOJ 5** 搭建，自带判题机与 **AI 出题**插件，支持：

- 注册 / 登录、题库浏览、在线提交与自动评测
- 创建比赛（ACM 赛制）与作业（Assignment）
- AI 出题：填写主题后由大模型生成题面、C++17 标程和 Python 数据生成器，系统在判题沙箱里跑出测试数据并自动建题

> 本仓库是**可直接启动的完整 Docker 栈**：MongoDB + Hydro 后端 + HydroJudge/go-judge 判题机。

## 文档

- [部署文档](docs/DEPLOYMENT.md)：本机试跑、服务器部署、HTTPS、备份恢复、故障排查
- [架构文档](docs/ARCHITECTURE.md)：容器拓扑、判题数据流、AI 出题流水线、权限与数据模型

## 目录结构

```
.
├── docker-compose.yml        # 三个服务：oj-mongo / oj-backend / oj-judge
├── .env.example              # 管理员密码、AI 模型默认配置
├── docs/                     # 部署文档、架构文档
├── backend/                  # HydroOJ 后端镜像
│   ├── Dockerfile
│   ├── entrypoint.sh         # 首次启动初始化：管理员、评测账号、域名、示例数据
│   └── seed/                 # 首次初始化写入的数据
│       ├── seed-demo.js      # 示例题目 / 比赛 / 作业
│       ├── home.md           # 首页公告（Markdown，含 GitHub 链接）
│       ├── lang-config.js    # 分语言时间 / 内存倍率
│       └── site-config.js    # 根域改名 / 头像镜像 / 域头像
├── judge/                    # 判题机镜像
│   ├── Dockerfile            # HydroJudge + go-judge 沙箱 + gcc/python3/java
│   ├── entrypoint.sh
│   ├── judge.yaml            # 判题机连接后端的账号密码
│   └── mount.yaml            # 沙箱挂载配置
├── addons/ai-problem/        # AI 出题插件（Hydro 插件，只读挂载进容器）
└── data/                     # 运行后生成：Mongo 数据、上传文件、Hydro 配置
```

## 一、启动

环境要求：Windows/macOS/Linux + Docker Desktop（或 Docker Engine + Compose v2），建议至少 4 GB 可用内存。

```bash
# 在项目根目录
cp .env.example .env      # 可选：先填 ADMIN_PASSWORD / AI_API_KEY
docker compose up -d --build
```

首次构建会下载 node、mongo 镜像并 npm 安装 Hydro，视网络情况约 10–30 分钟。启动完成后访问：

```
http://localhost:8888/d/jjyu/
```

后端健康检查通过（`curl http://localhost:8888/status`）后，判题机才会启动；判题机启动时会自检各语言编译器，日志里出现 `judge [I] End: { status: 1, score: 100 ... }` 表示判题正常。

### 管理员账号

- 用户名：`admin`
- 密码：首次启动时生成，保存在宿主机 `data/backend/admin-password.txt`

也可以在 `.env` 里设置 `ADMIN_PASSWORD` 后首次启动（仅在数据目录为空、首次初始化时生效）。忘记密码时可用下面的命令重置：

```bash
docker exec jjvuoj-backend hydrooj cli user setPassword 1 '新密码'
```

## 二、学生怎么用

1. 打开 `http://<服务器地址>:8888/d/jjyu/register`，按提示注册（当前未配置 SMTP，邮箱只作为账号标识，不会发信）。
2. 注册后第一次进入题库会提示「加入」本域，点一下即可（已设为任何人可加入）。
3. 进入题目 → 写代码 → 提交，右侧「记录」可看评测结果。

注册入口、导航、题目/比赛/作业列表都是网页，安卓手机浏览器直接可用，无需安装 App。

### 让手机访问

- 手机和电脑连同一个 Wi-Fi，访问 `http://电脑局域网IP:8888/d/jjyu/`。
- Windows 需在防火墙放行 8888 端口（首次运行 Docker 时允许专用网络即可）。
- 正式给同学长期使用，建议部署到有公网 IP 的云服务器，并用 Nginx/Caddy 配置 HTTPS 反向代理到 8888。

## 三、AI 出题

管理员登录后，顶部导航会出现 **AI 出题**（普通学生看不到，避免误用付费 Key）。

1. 右侧「模型配置」填写 OpenAI 兼容接口：
   - DeepSeek：`https://api.deepseek.com/v1` + `deepseek-chat`
   - 通义千问：`https://dashscope.aliyuncs.com/compatible-mode/v1` + `qwen-plus`
   - 其他任何兼容 `/chat/completions` 的服务同理
2. 填写题目主题（越具体越好，写清数据范围与考点），选择难度 / 时间 / 内存 / 测试点数量。
3. 点击「开始生成」，通常 1–3 分钟。系统会：
   - 让模型返回 JSON（题面、标程、数据生成器）
   - 在 go-judge 沙箱中编译标程
   - 用生成器按 seed=1..N 生成输入，再跑标程得到输出
   - 自动创建题目并上传 `config.yaml` 与测试数据
4. 生成结束后请务必人工检查题面和数据，再用于比赛/作业。

模型 Key 保存在站点数据库的 `system` 集合中，仅管理员可改；也可以用 `.env` 的 `AI_*` 变量给默认值。

## 四、判题机

- 判题机镜像内置 **gcc/g++、Python 3、OpenJDK 17**，go-judge 以 `privileged` 模式运行沙箱。
- 后端与判题机之间的账号在 `judge/judge.yaml`：默认 `judge / examplepassword`，**正式部署请修改**。
- 修改密码时同步两处：`judge/judge.yaml` 的 `password`，以及后端环境变量 `JUDGE_PASSWORD`（可在 `docker-compose.yml` 的 `oj-backend.environment` 里加），然后 `docker compose up -d` 重建两个容器。
- 判题机依赖后端健康后才启动；后端重启时判题机会自动重连。

## 五、数据与备份

所有持久化数据都在 `data/`：

| 路径 | 内容 |
| --- | --- |
| `data/mongo/` | MongoDB 数据（用户、题目、提交记录等） |
| `data/backend/` | Hydro 配置、`addon.json`、管理员密码文件 |
| `data/file/` | 测试数据、上传文件 |

备份：停止服务后直接复制整个 `data/` 目录。

```bash
docker compose down       # 停止（数据保留）
docker compose up -d      # 再次启动
```

> 警告：`docker compose down -v` 或删除 `data/` 会清空所有数据。示例题目只在**首次初始化**时创建。

## 六、常用运维命令

```bash
docker compose ps                      # 查看状态
docker compose logs -f oj-backend      # 后端日志
docker compose logs -f oj-judge        # 判题日志
docker compose restart oj-backend      # 改插件代码后重启
docker compose up -d --build           # 修改 Dockerfile 后重建
```

插件代码在 `addons/ai-problem/`（只读挂载），修改后执行 `docker compose restart oj-backend` 生效。

## 七、已知限制

- **AI 生成的题目必须人工审核**：题面可能不严谨，数据可能偏弱，建议先自己提交一遍标程并补充边界数据。
- 未配置 SMTP：注册可用，但「忘记密码」不可用；需要管理员用 `hydrooj cli user setPassword <uid> <密码>` 重置。
- 本机 Docker Desktop 适合试跑和同 Wi-Fi 内使用；长期对外服务请放到 Linux 服务器并配置 HTTPS、定期备份 `data/`。
- 判题机需要 `privileged` 权限运行沙箱，部署平台需允许特权容器。
