# JJVUoj 架构文档

本文档描述 JJVUoj 的运行时结构、请求与判题数据流、AI 出题插件设计、权限模型和数据存储，便于后续维护与二次开发。

- 版本基线：HydroOJ 5.0.7、`@hydrooj/ui-default` 4.58.5、`@hydrooj/hydrojudge` 4.0.6、go-judge 1.9.4、MongoDB 6、Node.js 22
- 部署形态：单机 Docker Compose，三个容器
- 项目根目录：`D:\JJVUoj`

---

## 1. 总体架构

```
                    ┌──────────────────────────── 浏览器 / 手机 ────────────────────────────┐
                    │  学生：注册、加入域、做题、提交、看记录、参加比赛/作业                    │
                    │  管理员：题库管理、比赛/作业、AI 出题、系统设置                            │
                    └───────────────────────────────┬───────────────────────────────────────┘
                                                    │ HTTP :8888
                                    ┌───────────────▼────────────────┐
                                    │  oj-backend（HydroOJ 5.0.7）    │
                                    │  ┌──────────────────────────┐  │
                                    │  │ Hydro 路由 / Handler      │  │
                                    │  │ 模板引擎 Nunjucks         │  │
                                    │  │ ui-default 主题           │  │
                                    │  │ ai-problem 插件           │  │
                                    │  └──────────────────────────┘  │
                                    │  pm2-runtime → node hydrooj    │
                                    └──────┬─────────────────┬───────┘
                                           │ Mongo :27017    │ WebSocket /judge/conn
                                           │                 │
                              ┌────────────▼──────┐   ┌──────▼─────────────────────────┐
                              │  oj-mongo          │   │  oj-judge                       │
                              │  MongoDB 6         │   │  HydroJudge 4.0.6（判题守护）   │
                              │  数据 + 配置       │   │  go-judge 1.9.4 沙箱 :5050      │
                              └────────────────────┘   │  gcc/g++/python3/java17         │
                                                       └──────────────┬──────────────────┘
                                                                      │ HTTP /run
                                                       ┌──────────────▼──────────────────┐
                                                       │  沙箱内执行（一次一个进程组）    │
                                                       │  编译 / 运行用户程序 / 跑生成器  │
                                                       └─────────────────────────────────┘
```

补充说明：

- `oj-judge` 是**主动**连接方：启动后连接 `http://oj-backend:8888/judge/conn`（WebSocket），由后端下发评测任务；断线自动重连。
- go-judge 的 5050 端口只暴露在 Compose 内部网络，不映射到宿主机。
- AI 出题插件与 HydroJudge **共用** go-judge 沙箱：插件通过 `AI_SANDBOX_URL=http://oj-judge:5050` 直接调用 `/run`，用于编译标程、运行数据生成器和标程取输出。

---

## 2. 容器与服务

| 服务 | 镜像 | 端口 | 职责 |
| --- | --- | --- | --- |
| `oj-mongo` | `mongo:6` | 内部 27017 | 所有结构化数据与配置持久化 |
| `oj-backend` | `jjvuoj/backend:latest`（基于 `node:22-bookworm` 构建） | `8888:8888` | Web 服务、API、模板渲染、评测调度、AI 出题 |
| `oj-judge` | `jjvuoj/judge:latest` | 内部 5050 | 判题守护进程 + go-judge 沙箱 + 编译器 |

### 2.1 后端镜像

`backend/Dockerfile`：

1. 使用 `node:22-bookworm`，替换阿里云 Debian 源
2. `npm install -g pm2 hydrooj@5.0.7 @hydrooj/ui-default@4.58.5`（registry 使用 npmmirror）
3. 复制 `entrypoint.sh` 与 `seed/`
4. `ENTRYPOINT` 启动 `entrypoint.sh`

`entrypoint.sh` 的启动顺序：

```
写 addon.json（ui-default + /root/.hydro/addons/ai-problem）
→ 写 config.json（Mongo 连接）
→ 若首次初始化（/root/.hydro/first 不存在）：
    创建评测账号 uid=2、管理员 uid=1、域 jjyu、站点设置、开放加入
    执行 seed/seed-demo.js（示例题目/比赛/作业，幂等）
    执行 seed/lang-config.js（分语言时间/内存倍率，幂等）
→ pm2-runtime start hydrooj（监听 0.0.0.0:8888）
```

### 2.2 判题机镜像

`judge/Dockerfile`：

1. `node:22-bookworm` + 阿里云源
2. 安装 `gcc g++ python3 openjdk-17-jdk-headless curl ca-certificates`
3. `npm install -g pm2 @hydrooj/hydrojudge@4.0.6`
4. 下载 go-judge 1.9.4（amd64v3）到 `/usr/bin/sandbox`
5. 符号链接 `/usr/bin/node`

`judge/entrypoint.sh` 用 pm2 同时拉起：

```
sandbox -http-addr 0.0.0.0:5050 -mount-conf /root/.hydro/mount.yaml
hydrojudge            # 读取 /root/.hydro/judge.yaml，连接后端 /judge/conn
```

`judge/judge.yaml` 关键字段：

```yaml
hosts:
  localhost:
    type: hydro
    server_url: http://oj-backend:8888/
    uname: judge
    password: examplepassword   # 必须与后端 JUDGE_PASSWORD 一致
    detail: full
```

`judge/mount.yaml` 定义沙箱挂载与工作目录 `/w`，沙箱以 uid/gid 1536 运行，容器需要 `privileged: true`。

---

## 3. 请求与评测数据流

### 3.1 普通页面请求

```
浏览器 → Hydro Router → Handler（get/post）
      → 读取 Mongo / Storage
      → this.response.body + template
      → Nunjucks 渲染 layout/basic.html（ui-default）
      → HTML
```

- 路由定义在 `hydrooj/src/handler/*.ts` 和插件 `apply(ctx)` 中
- 模板查找顺序：ui-default 内置模板 + 各 addon 的 `templates/`
- 站点级配置通过 `SystemModel` 读写（Mongo 的 `system` 集合）

### 3.2 提交与判题

```
1. 学生 POST /d/jjyu/p/:pid/submit（lang + code）
2. Hydro 创建 record（Mongo），状态 pending
3. 后端通过 WebSocket 把任务推给已连接的 HydroJudge 守护进程
4. HydroJudge 调用 go-judge /run：
     - 按语言取 time_limit_rate / memory_limit_rate，基础时限/内存乘以倍率
     - 编译用户代码（按语言编译命令）
     - 对每个测试点：copyIn 输入 → 运行 → copyOut stdout
     - 与 .out 文件比对
5. 结果（status/score/time/memory）回传后端
6. 后端更新 record，前端轮询/刷新展示
```

倍率来自 `hydrooj.langs` 的 `time_limit_rate` / `memory_limit_rate`（默认值 1）：Java / Kotlin 2×，Python / PyPy3 3×时间 / 2×内存，Node.js 2×，其余 1×。配置在 `backend/seed/lang-config.js`。Java 额外带 `-Xms8m -Xmx4096m -XX:+UseSerialGC`，避免小内存沙箱里 JVM 按宿主机内存预分配导致启动失败。

同一脚本还控制语言可见性：提交页只展示判题镜像实际支持的 C、C++（含 C++11/17）、Java、Python 3，其余 `hidden: true`；工具链缺失的语言再 `disabled: true`，即使题目单独允许也会被 `ProblemSubmitHandler` 拒绝。

go-judge 单次调用的关键参数：`cmd[]`（参数、环境变量、stdin/stdout/stderr 文件、`cpuLimit`/`clockLimit`/`memoryLimit`/`procLimit`）、`copyIn`、`copyOut`、`copyOutCached`；响应包含 `status`、`files`、`fileIds`，临时文件通过 `DELETE /file/:id` 清理。

### 3.3 比赛与作业

两者都基于 `ContestModel`，通过 `rule` 区分：

| 类型 | rule | 入口 | 特性 |
| --- | --- | --- | --- |
| 比赛 | `acm` | `/d/jjyu/contest` | 排名、罚时、赛时提交 |
| 作业 | `homework` | `/d/jjyu/homework` | 截止时间 `penaltySince`、`endAt`、按题计分 |

作业文档必须包含 `penaltySince`、`penaltyRules`、`assign` 字段，否则作业列表渲染会报错（`isExtended` 读取 `penaltySince.getTime()`）。

---

## 4. AI 出题插件

位置：`addons/ai-problem/`，通过 `/root/.hydro/addon.json` 注册为本地插件。

```
addons/ai-problem/
├── package.json          # 插件名 jjyu-ai-problem，入口 index.ts
├── index.ts              # 路由、Handler、模型调用、沙箱调度
├── assets/
│   ├── logo.png          # 站点主 logo（圆形透明底 PNG）
│   └── avatar.jpg        # 首页「开发与维护」GitHub 头像（本地化，避免运行时查询 GitHub）
├── locales/              # zh.yaml / en.yaml
└── templates/
    ├── ai_problem.html   # 页面与结果展示
    ├── layout/
    │   └── html5.html    # 覆盖 ui-default 布局，替换 favicon / og:image
    └── partials/
        ├── footer.html     # 覆盖 ui-default 页脚，「开源」链接指向本仓库
        └── homepage/
            └── bulletin.html  # 覆盖首页公告卡片，在底部加「开发与维护」圆形头像按钮
```

### 4.1 路由与入口

| 路由 | Handler | 权限 |
| --- | --- | --- |
| `GET /d/:domain/ai-problem` | `AiProblemHandler` | `PRIV_EDIT_SYSTEM`（管理员） |
| `POST /d/:domain/ai-problem/generate` | `AiGenerateHandler` | `PRIV_EDIT_SYSTEM` |
| `POST /d/:domain/ai-problem/config` | `AiConfigHandler` | `PRIV_EDIT_SYSTEM` |
| `GET /jjyuoj-logo.png` | `JjyuojLogoHandler` | 公开 |
| `GET /favicon.ico` | `JjyuojLogoHandler` | 公开（供浏览器默认请求） |
| `GET /jjyuoj-logo.svg` | `JjyuojLogoHandler` | 公开（兼容旧地址） |
| `GET /jjyuoj-avatar.jpg` | `JjyuojAvatarHandler` | 公开（首页头像，本地文件） |

`JjyuojLogoHandler` 读取 `assets/logo.png` 并缓存，文件缺失时回退为内置 SVG。
`JjyuojAvatarHandler` 读取 `assets/avatar.jpg` 并缓存（文件缺失返回 404）。
导航栏 logo 由系统设置 `ui-default.nav_logo_dark` 指向 `/jjyuoj-logo.png`；
页面 `<head>` 中的 favicon / apple-touch-icon / `og:image` 通过覆盖的
`templates/layout/html5.html` 指向同一路径。

导航项通过 `ctx.injectUI('Nav', ...)` 注入，同样限制为管理员可见。

### 4.2 配置项

保存在 Mongo `system` 集合，键名：

| 键 | 说明 | 回退值 |
| --- | --- | --- |
| `ai-problem.baseUrl` | OpenAI 兼容接口地址 | `AI_BASE_URL` 环境变量 → `https://api.deepseek.com/v1` |
| `ai-problem.apiKey` | API Key | `AI_API_KEY` 环境变量 |
| `ai-problem.model` | 模型名 | `AI_MODEL` 环境变量 → `deepseek-chat` |

读取优先级：数据库 → 环境变量 → 默认值。

### 4.3 出题流水线

```
用户填写主题/难度/时间/内存/测试点数
        │
        ▼
1. 检查沙箱：GET http://oj-judge:5050/version
        │
        ▼
2. 调用模型：POST {baseUrl}/chat/completions
   - response_format: json_object；若服务不支持则去掉该字段重试
   - 要求返回 JSON：title / statement / tags / difficulty / standardCode / generator / notes
        │
        ▼
3. 编译标程（go-judge /run）
   g++ -O2 -std=c++17 -pipe -o std std.cpp
   copyOutCached: std → 得到 fileId
        │
        ▼
4. 对 seed = 1..N：
   python3 gen.py <seed>            → 输入
   /w/std（copyIn 输入）             → 输出
   任一失败即中止并返回错误
        │
        ▼
5. 用 seed=1 的输入/输出替换题面中的 {{SAMPLE_INPUT}} / {{SAMPLE_OUTPUT}}
        │
        ▼
6. ProblemModel.add 建题 → 写 config.yaml + i.in/i.out → 返回题面预览与日志
```

### 4.4 关键限制

| 项目 | 值 |
| --- | --- |
| 单次生成测试点 | 3–15 |
| 生成整体时限 | 240 秒 |
| 生成器单次运行 | 10 秒 CPU / 20 秒时钟 |
| 标程运行限制 | 题面时间 ×2 / 内存 ×2（有下限） |
| 输入上限 | 8 MB / 测试点 |
| 输出上限 | 16 MB / 测试点 |
| 页面限流 | 每 600 秒最多 5 次生成 |

### 4.5 设计要点

- **后端不执行不可信代码**：模型生成的 C++ 与 Python 全部在 go-judge 沙箱中运行。
- **测试数据可信化**：输出由标程实际运行得到，而不是模型直接给出。
- **模板变量避让全局名**：`layout/basic.html` 等模板依赖全局 `model` 对象，插件传给模板的模型名称使用 `modelName`，避免遮蔽导致 `model.system.get` 报错。同理，`layout/html5.html` 里 `{% import "components/form.html" as form %}` 会把 `form` 占为表单宏命名空间，插件传给模板的表单数据命名为 `genForm`，否则时间/内存/难度等字段会渲染成空。
- **失败可观测**：生成过程日志逐条返回页面，便于判断是模型、编译还是数据生成阶段出错。

---

## 5. 权限与用户模型

| 主体 | uid | 权限 |
| --- | --- | --- |
| `admin` | 1 | 超级管理员：`PRIV_EDIT_SYSTEM`、域所有者 |
| `systemjudge` | 2 | 判题账号：`setJudge`，仅供 HydroJudge 连接 |
| 学生 | 新注册 | 域内普通用户：看题、提交、参加比赛/作业 |

- 域：`jjyu`，所有者 uid 1；域加入方式 `_join.method = 1`（任何人可加入），角色 `default`。
- 管理员密码文件：`data/backend/admin-password.txt`。
- 未配置 SMTP，注册使用邮箱标识 + 令牌直接进入设置密码页面，不发送邮件；找回密码不可用。
- AI 出题限制为 `PRIV_EDIT_SYSTEM`，普通学生即使直接访问路由也会 403。

---

## 6. 数据存储

### 6.1 MongoDB

主要集合（Hydro 5 结构）：

| 集合 | 内容 |
| --- | --- |
| `user` | 用户账号、权限、密码哈希 |
| `domain` / `domain.user` | 域信息与域成员 |
| `document` | 题目、比赛/作业、讨论等文档主体 |
| `document.status` | 用户在文档上的状态（如作业完成情况） |
| `document.sub` | 题目的测试数据元信息等子文档 |
| `record` | 提交记录与评测结果 |
| `system` | 站点配置、AI 模型配置 |
| `token` | 登录/注册等令牌 |
| `oplog` / `message` | 操作日志、站内信 |

### 6.2 文件存储

- 宿主机 `data/file/` → 容器 `/data/file`
- 题目测试数据路径：`problem/{domainId}/{docId}/testdata/{name}`
- 题目附加文件、用户上传文件也在此目录下
- 每个题目包含：`config.yaml`、`1.in`、`1.out` … `N.in`、`N.out`

### 6.3 配置与初始化标记

- `data/backend/config.json`：Mongo 连接
- `data/backend/addon.json`：插件列表
- `data/backend/first`：首次初始化标记，存在则跳过初始化
- `data/backend/admin-password.txt`：管理员初始密码

---

## 7. 网络与端口

| 端口 | 位置 | 用途 | 是否对外 |
| --- | --- | --- | --- |
| 8888 | oj-backend | Web/HTTP | 是（Compose 映射） |
| 27017 | oj-mongo | MongoDB | 否（仅内部网络） |
| 5050 | oj-judge | go-judge HTTP API | 否（仅内部网络） |

容器间通过 Compose 默认网络按服务名解析：`oj-mongo`、`oj-backend`、`oj-judge`。

---

## 8. 目录结构

```
D:\JJVUoj
├── docker-compose.yml          # 服务编排
├── .env.example                # 管理员密码、AI 默认配置
├── README.md                   # 快速上手
├── docs/
│   ├── DEPLOYMENT.md           # 部署与运维文档
│   └── ARCHITECTURE.md         # 本文档
├── backend/
│   ├── Dockerfile
│   ├── entrypoint.sh           # 初始化 + 启动
│   └── seed/                   # 初始化数据（幂等）
│       ├── seed-demo.js        # 示例题目 / 比赛 / 作业 / 首页公告
│       ├── home.md             # 首页公告 Markdown
│       └── lang-config.js      # 分语言时间 / 内存倍率
├── judge/
│   ├── Dockerfile
│   ├── entrypoint.sh
│   ├── judge.yaml              # 判题机连接配置
│   └── mount.yaml              # 沙箱挂载
├── addons/ai-problem/          # AI 出题插件（只读挂载）
└── data/                       # 运行时数据（Mongo/文件/配置）
```

挂载关系：

| 宿主机 | 容器 | 模式 |
| --- | --- | --- |
| `./data/file` | `/data/file` | 读写 |
| `./data/backend` | `/root/.hydro` | 读写 |
| `./addons` | `/root/.hydro/addons` | 只读 |
| `./judge/judge.yaml` | `/root/.hydro/judge.yaml` | 只读 |
| `./judge/mount.yaml` | `/root/.hydro/mount.yaml` | 只读 |

---

## 9. 扩展点

- **新增 Hydro 插件**：在 `addons/<name>/` 放 `package.json` + `index.ts`，加入 `entrypoint.sh` 的 `addon.json` 列表，重启后端。
- **新增编译语言**：在 `judge/Dockerfile` 安装对应工具链，并在 Hydro 语言配置中启用；如需单独的时限/内存倍率，在 `backend/seed/lang-config.js` 的 `RATES` 表加一行。
- **调整语言倍率**：改 `lang-config.js` 后用 `hydrooj cli execute` 写入并重启后端（见 DEPLOYMENT.md「语言时间 / 内存倍率」）。
- **新增站点/域**：`hydrooj cli domain add` 创建，按需配置加入方式。
- **替换模型供应商**：只改 AI 配置的 baseUrl/model，不需要改代码。
- **多判题机**：在 `judge.yaml` 增加 host 条目并部署多个 judge 容器即可横向扩容（当前单机未启用）。
- **自定义 logo**：替换 `addons/ai-problem/assets/logo.png`（建议 64×64 或更大的正方形 PNG）后重启后端即可，导航栏、favicon、`og:image` 会一起更新；如需换路径，同步修改 `JjyuojLogoHandler` 与 `templates/layout/html5.html`。

---

## 10. 已知技术限制与后续可改进项

| 项 | 影响 | 建议 |
| --- | --- | --- |
| 无 SMTP | 无法找回密码、无邮件通知 | 配置 SMTP 或由管理员重置密码 |
| Mongo 单实例 | 无副本集，无自动故障转移 | 数据量/可用性要求高时改副本集 |
| 判题机 privileged | 部分托管平台禁止 | 使用支持特权容器的宿主或裸金属 |
| Windows 文件系统 | 大量小文件读写较慢 | 正式环境部署到 Linux |
| AI 题目质量 | 题面/数据可能不严谨 | 建立人工审核流程，补充边界数据 |
| 判题密码默认值 | 公网部署有风险 | 修改 `judge.yaml` 与 `JUDGE_PASSWORD` 并保持一致 |
