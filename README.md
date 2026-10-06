# 厂内检修断电挂牌演练系统（Lockout / Tagout Drill）

一个基于 **Node.js + SQLite + 浏览器界面** 的检修断电挂牌（LOTO）演练 Web 应用。
管理员维护电源、开关与设备的有向供电关系；操作员执行“分闸 → 挂牌 / 解牌 → 合闸”
和检修许可的申请、结束；系统按供电路径自动判定设备是否真正断电隔离，
并用全局修订号实现多人并发控制，记录每次成功变更的前后状态。

## 功能与业务规则

### 角色
- **管理员（admin）**：维护供电网络 —— 新增 / 删除 / 重命名电源、开关、设备，
  启用 / 停用电源，架设或拆除有向供电关系（边）。
- **操作员（operator）**：开关分闸、合闸、挂牌、解牌；为设备申请 / 结束检修许可；
  编排并执行**临时操作单**（分闸 → 挂牌 → 申请许可的有序成套操作，支持预演）。

### 开关状态机
1. 合闸位置的开关必须先 **分闸（open）** 才能 **挂牌（tag）**；
2. **挂牌开关不得合闸**：对挂牌开关执行合闸直接拒绝（`SWITCH_TAGGED`）；
3. 解牌（untag）后才允许重新合闸。

### 许可生效条件
- 从 **所有 `enabled=1` 的启用电源** 出发，沿有向供电边到达目标设备的全部路径，
  都必须经过至少一个 **已挂牌开关**（路径在挂牌点被视为切断）。
- 申请时若仍存在未切断路径，返回 `422 PERMIT_NOT_ISOLATED`，并列出未切断
  路径（节点链），界面同步高亮，便于学员找到还需挂牌的开关。
- 停用电源视为无输出，不产生路径；**没有任何启用电源，或所有通路都被挂牌
  切断时，许可仍可正常申请**。

#### 隔离判定与路径枚举分离（枚举触顶不再漏判）
早期版本把“路径枚举”直接当作“隔离判定”：枚举限制每个电源最多收集 200 条
支路、单条路径最多 64 个节点。若同一启用电源的前 200 条支路恰好都在挂牌
开关处被截断、其后仍有支路直达设备，枚举触顶会漏掉带电路径，导致**实际带电
却误判已隔离、许可误生效**。

修复后两者彻底分离：

- **隔离判定走完整可达性分析**（多源 BFS，挂牌开关为不可穿过的屏障），
  **不设数量或长度上限**。申请许可，以及有效许可期间的解牌、启用电源、
  改线（节点/接线）保护，全部以该完整分析为准；任何“枚举未知”都不会被
  当作“已隔离”，存在未切断通路即拒绝。
- **路径枚举仅用于诊断展示**，仍保留数量/长度上限（未切断路径 200 条、
  被挂牌切断路径 200 条、单条 64 节点），但：
  - 未切断与被挂牌切断两类路径**分别计数**，互不挤占名额（再多重叠的挂牌
    支路也不会挤掉带电路径）；
  - 触顶时响应与界面显式返回/显示 `truncated` 截断标记（数量触顶
    `countLimited`、超长触顶 `lengthLimited`，并附上限值）；
  - 因超长未枚举出任何带电路径时，系统会用可达性分析的 **BFS 见证路径**
    补入一条真实带电路径（允许超过展示长度上限）。
- **拒绝响应保证至少返回一条实际带电路径**：申请失败的 `livePaths` 与
  `ISOLATION_VIOLATION` 中每个受影响许可的 `livePaths` 至少含 1 条真实
  未切断路径，浏览器在拒绝提示中展示拒绝原因、该路径及截断说明。

### 许可有效期内的“整体拒绝”
任一有效许可存续期间，下列变更若会使该许可不再满足隔离条件，**整次操作拒绝、
数据库事务回滚、状态与修订号均不变**，并返回受影响许可与重新来电的路径：
- 对挂牌开关 **解牌**（或给挂牌开关合闸）；
- **启用电源**（例如把带旁路的停用电源重新启用）；
- **改动线路 / 节点**（新增绕过挂牌点的接线等）。

> 说明：删除节点或拆除接线只会减少通路，不可能创造新的来电回路，因此这类操作
> 天然不会破坏隔离；删除挂有有效许可的设备本身仍被禁止，需先结束许可。
>
> 边界：上述保护与许可申请共用同一套**完整可达性分析**，不受诊断枚举的
> 200 条 / 64 节点上限影响——即使供电路径数量极多或极长，只要存在一条
> 未切断通路，操作就会被整体拒绝并回滚；拒绝体中的 `truncated` 仅说明
> 附带展示的路径列表被限量截断，不代表隔离结论不确定。

### 临时操作单（编排 — 预演 — 确认）
检修前常需依次“分闸、挂牌并申请许可”。操作员可在浏览器“临时操作单”页（或调用
HTTP API）临时编排一张操作单：

- 步骤按序填写：开关编号 + 动作（`open` 分闸、`tag` 挂牌、`untag` 解牌、
  `close` 合闸），**末步**可填写设备编号执行一次 `permit` 申请许可（许可步只能是
  最后一步；一张单子至多一个许可步）。
- **预演**（`POST /api/orders/preview`）纯只读：展示每一步的动作、前后开关状态、
  成功 / 失败 / 未执行、失败原因；若末步申请许可，同时展示目标设备**当前**隔离
  状态与“按本单前面步骤执行后”的隔离结论。预演**不改变真实网络、有效许可、
  修订号或审计**，响应携带所依据的当前 `revision`。
- **确认**（`POST /api/orders/confirm`）在 `IMMEDIATE` 事务、修订号校验通过后按
  **原顺序原子执行**：每一步都遵守现有开关状态机与有效许可隔离保护；
  **不允许用后续步骤补救前一步违规**——任一步失败即在该步中止，响应返回
  **步骤序号 `step`**、动作名与原因（错误码沿用 `SWITCH_TAGGED`、
  `SWITCH_NOT_OPEN`、`INVALID_STATE`、`ISOLATION_VIOLATION`、
  `PERMIT_NOT_ISOLATED` 等），隔离失败附**实际带电路径**（`livePaths` /
  `violations[].livePaths`）与截断标记，整单回滚、**不落库**（修订号、审计均不变）。
- 确认沿用现有 `actor` / `role`（仅 `operator`）/ `revision` 及 `STALE_REVISION`
  约定：预演后若版本被他人改变，确认返回 `409` 与**当前完整状态**，核对后重试；
  成功时整单**只递增一次修订号**，审计只写**一条** `order.confirm` 记录，
  `detail.steps` 为有序执行清单，`state_before` / `state_after` 为整单前后完整快照。
- 操作单本身是浏览器 / 请求里的临时编排，**不建表、不落库**。

### 多人并发（乐观锁）
- 每次成功变更都会让全局 **修订号 revision + 1**（界面右上角实时显示）。
- 所有写操作必须携带操作者“所见”的 `revision`。
- 提交时若库中修订号已不同，返回 `409 STALE_REVISION` 与 **当前完整状态**，
  前端自动刷新为最新状态，要求核对后重试；过期提交不会落库。

### 审计
每次成功变更记录：时间（UTC）、操作者、角色、动作、参数、
变更前后修订号以及 **变更前后完整网络状态快照**（JSON）。

## 技术栈
- 后端：Node.js + Express
- 存储：SQLite（better-sqlite3，WAL 模式，写操作使用 `IMMEDIATE` 事务）
- 前端：原生 HTML/CSS/JS（无构建步骤），SVG 供电网络图、路径高亮
- 部署：多阶段 Dockerfile + Docker Compose（构建镜像、安装依赖、建库、启动）

## 快速开始（Docker Compose，推荐）

```bash
# 构建镜像 + 安装依赖 + 初始化数据库(空库自动写入演示网络) + 启动
docker compose up -d --build

# 查看日志
docker compose logs -f

# 停止
docker compose stop

# 停止并删除容器(数据保留在卷 loto_loto-data 中)
docker compose down

# 连同数据卷一并清空(恢复初始演示网络)
docker compose down -v
```

访问地址：**http://localhost:3000**
（如修改端口见下文配置）。容器启动命令为
`npm run init-db && node server.js`，即 **先建库后启动**；重复执行安全，
已有数据时初始化脚本只建表、不覆盖数据。

## 本地直接运行（Node 20+）

```bash
npm install          # 安装依赖
npm run init-db      # 建库 + 演示数据(默认 data/loto.db)
npm start            # 启动服务, 默认 http://localhost:3000
```

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 应用监听端口（容器内） |
| `LOTO_DB` | `data/loto.db`（项目目录下） | SQLite 数据库文件路径 |
| `LOTO_PORT` | `3000` | **仅 Compose 使用**：宿主机映射端口，即浏览器访问端口 |

修改访问端口示例：

```bash
# 方式一：环境变量
LOTO_PORT=8080 docker compose up -d --build
# 访问 http://localhost:8080

# 方式二：复制 .env.example 为 .env 后修改 LOTO_PORT
cp .env.example .env
```

数据持久化：Compose 使用命名卷 `loto-data` 挂载到容器 `/app/data`。
重置为初始演示网络：`docker compose down -v && docker compose up -d --build`。

## 浏览器操作指引
1. 右上角填写 **操作者姓名**，选择身份（操作员 / 管理员），身份保存在浏览器本地。
2. **供电网络** 页：点击节点，右侧出现该节点可执行操作；
   - 电源：管理员可启用 / 停用；
   - 开关：操作员可分闸、合闸、挂牌、解牌（图中红色虚边为被挂牌切断的线路）；
   - 设备：操作员可申请许可，或“查看供电路径”（未切断路径橙色高亮）。
3. **临时操作单** 页（操作员）：选择动作与目标逐行加入步骤（可上下移动 / 删除）；
   点“预演”可反复演练，右侧展示各步前后状态、成功/失败/未执行与目标设备当前及
   按单推演后的隔离状态，真实状态不变；预演通过后点“确认执行”，整单原子落库、
   修订号 +1；若预演后他人已提交，确认会收到 `409 STALE_REVISION` 并自动刷新。
4. **检修许可** 页：选择设备申请许可；申请失败时弹窗列出至少一条未切断路径；
   路径数量 / 长度超过诊断上限时，弹窗与许可卡片会用黄色提示标记“仅展示部分
   路径”，但拒绝结论基于完整可达性分析，不受上限影响。有效许可卡片实时显示
   隔离是否满足，可随时结束许可。
5. **拓扑管理** 页（管理员）：维护节点和有向供电关系。
   规则：电源只能作起点、设备只能作终点、不允许自环和重复接线。
6. **变更记录** 页：查看所有成功变更的时间、操作者、动作、前后修订号，
   可展开查看前后完整状态快照。
6. 页面每 10 秒轮询一次修订号；他人提交后会自动刷新。若你的提交过期，
   会收到明确提示并刷新到最新状态。

### 演示网络
初始库内置：`1#主电源 → K1 → K3 → 1#循环水泵`，
`2#备用电源 → K2 → K3 → 1#循环水泵`，以及 `K1 → 2#引风机`。
建议演练流程：
1. 直接对“1#循环水泵”申请许可 → 失败，显示两条未切断路径；
2. K1 分闸 → 挂牌；K2 分闸 → 挂牌；
3. 再申请许可 → 生效；
4. 尝试给 K1/K2 解牌或让管理员架旁路 → 被整体拒绝并显示来电路径；
5. 结束许可后再解牌恢复送电。

## HTTP API 摘要

所有写操作均需 JSON body：`actor`（姓名）、`role`（`admin`/`operator`）、
`revision`（所见修订号）。

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/state` | - | 当前完整状态（修订号、节点、边、有效许可、隔离判定与 `truncated` 诊断截断标记） |
| GET | `/api/health` | - | 健康检查 |
| GET | `/api/devices/:id/paths` | - | 设备供电路径诊断（限量展示未切断 / 被挂牌切断路径，触顶时 `truncated` 标记截断；`isolated` 以完整可达性分析为准） |
| GET | `/api/audit?limit=100` | - | 变更记录（含前后状态快照） |
| POST | `/api/admin/nodes` | admin | 新增节点 `{kind, name}` |
| PATCH | `/api/admin/nodes/:id` | admin | 改名 / 启用停用电源 `{name?, enabled?}` |
| DELETE | `/api/admin/nodes/:id` | admin | 删除节点（级联删除相关边） |
| POST | `/api/admin/edges` | admin | 新增供电关系 `{from_node, to_node}` |
| DELETE | `/api/admin/edges/:id` | admin | 拆除供电关系 |
| POST | `/api/switches/:id/open` | operator | 分闸 |
| POST | `/api/switches/:id/close` | operator | 合闸（挂牌时拒绝） |
| POST | `/api/switches/:id/tag` | operator | 挂牌（须先分闸） |
| POST | `/api/switches/:id/untag` | operator | 解牌（破坏有效许可隔离时拒绝） |
| POST | `/api/permits` | operator | 申请许可 `{device_id}` |
| POST | `/api/permits/:id/end` | operator | 结束许可 |
| POST | `/api/orders/preview` | operator | 临时操作单**预演**（只读，不校验/改变修订号）`{steps:[...]}` |
| POST | `/api/orders/confirm` | operator | 临时操作单**确认执行**（原子，revision +1）`{steps:[...]}` |

错误约定：`400` 参数错误 / `403` 角色不允许 / `404` 不存在 /
`409 STALE_REVISION` 修订号过期（响应含 `current` 当前状态）/
`422` 业务规则不满足（如 `PERMIT_NOT_ISOLATED`、`ISOLATION_VIOLATION`、
`SWITCH_TAGGED`，响应中携带未切断路径）。

拒绝隔离类错误（`PERMIT_NOT_ISOLATED` 及 `ISOLATION_VIOLATION` 的每个
`violations[]`）响应体额外包含：

- `livePaths`：**至少一条**实际未切断供电路径（节点链 / 边链；极端超长
  场景由 BFS 见证路径补足，可超过展示长度上限）；
- `truncated`：诊断列表截断标记
  `{ live:{countLimited,lengthLimited,limit,maxLength},
  blocked:{...} }`，仅表示附带展示被限量，不影响拒绝结论。
`/api/state` 中每个有效许可的 `isolation`、`/api/devices/:id/paths`
同样携带 `truncated`。接口路径、请求字段、错误码、角色校验、revision
冲突处理、事务回滚与审计快照约定均保持不变。

#### 临时操作单 API 示例

步骤对象：开关步 `{"action":"open|tag|untag|close","node_id":3}`；
许可步（仅末步）`{"action":"permit","device_id":6}`。

```bash
# 1) 预演: 分闸 K1→挂牌 K1→分闸 K2→挂牌 K2→为 1#循环水泵 申请许可
curl -s -X POST http://localhost:3000/api/orders/preview \
  -H 'Content-Type: application/json' \
  -d '{
    "actor": "张三", "role": "operator", "revision": 1,
    "steps": [
      {"action":"open","node_id":3}, {"action":"tag","node_id":3},
      {"action":"open","node_id":4}, {"action":"tag","node_id":4},
      {"action":"permit","device_id":6}
    ]
  }'
# -> { ok:true, kind:"order.preview", revision:1, success:true, failedStep:null,
#      steps:[ {step:1,action:"open",ok:true,before:{open_pos:false,tagged:false},
#               after:{open_pos:true,tagged:false},message:"分闸完成（分闸）"},
#              ...,
#              {step:5,action:"permit",ok:true,isolation:{isolated:true,...}} ],
#      permitIsolation:{ device_id:6, device_name:"1#循环水泵", isolated:false,
#                        livePaths:[...] } }   # 目标设备“当前”隔离状态(执行前)
# 预演不写任何数据; failedStep 非空时该步含 error, 其后各步 skipped:true。

# 2) 确认执行: 携带所见 revision; 成功整单只 +1 并写一条 order.confirm 审计
curl -s -X POST http://localhost:3000/api/orders/confirm \
  -H 'Content-Type: application/json' \
  -d '{
    "actor": "张三", "role": "operator", "revision": 1,
    "steps": [
      {"action":"open","node_id":3}, {"action":"tag","node_id":3},
      {"action":"open","node_id":4}, {"action":"tag","node_id":4},
      {"action":"permit","device_id":6}
    ]
  }'
# -> 200 { ok:true, action:"order.confirm",
#         steps:[{step:1,action:"open",node_id:3}, ...,
#                {step:5,action:"permit",device_id:6,permit_id:1}],
#         permit_id:1, revision:2, snapshot:{...当前完整状态...} }
#
# 任一步失败 -> 422 { ok:false, step:3, step_name:"挂牌",
#                     error:{code:"SWITCH_NOT_OPEN",message:"第 3 步执行失败: ..."},
#                     step_results:[...各步结果...],
#                     livePaths|violations:[...实际带电路径...], truncated:{...} }
# 整单回滚不落库; 修订号过期 -> 409 STALE_REVISION + current(当前完整状态)。
```

预演请求也需带 `actor` 与 `role:operator`（仅做身份展示与鉴权），但 `revision`
不参与校验——预演永远基于当前状态推演。

## 目录结构

```
.
├── Dockerfile              # 多阶段构建(编译 better-sqlite3 原生模块)
├── docker-compose.yml      # 构建、init-db 建库、启动、数据卷、健康检查
├── .env.example            # 端口配置示例
├── server.js               # Express 服务与全部 API / 事务 / 并发控制
├── src/
│   ├── db.js               # SQLite 连接、表结构、演示数据
│   ├── graph.js            # 完整可达性隔离判定(无上限) + 限量诊断路径枚举
│   ├── orders.js           # 临时操作单: 结构校验 + 纯内存预演 + 按序原子提交
│   └── init-db.js          # 建库脚本(npm run init-db)
├── public/                 # 浏览器界面(原生 JS + SVG)
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── test/
    ├── smoke.js            # 端到端业务规则冒烟测试(HTTP)
    ├── orders.e2e.js       # 临时操作单预演/确认/原子回滚/STALE_REVISION 的 HTTP 回归
    ├── graph.test.js       # 隔离判定单元测试(枚举触顶/超长/环路)
    └── truncation.e2e.js   # 200 条挂牌支路挤掉带电路径的 HTTP 回归(手动)
```

## 测试

```bash
# 单元测试(无需起服务, 无需数据库)
npm run test:graph

# 端到端冒烟(终端1 起服务, 终端2 跑测试; 使用独立 DB 避免污染演示库)
LOTO_DB=/tmp/loto-test.db PORT=3100 node server.js
node test/smoke.js

# 临时操作单回归(预演只读/确认原子/逐步失败不可补救/整单回滚/单次修订号/409)
BASE=http://127.0.0.1:3100 node test/orders.e2e.js

# 枚举触顶回归(同样打到 PORT=3100 的服务; 结束会清理临时拓扑)
node test/truncation.e2e.js
```

也可以按原方式运行：

```bash
npm run init-db && PORT=3100 node server.js   # 终端1
node test/smoke.js                            # 终端2
```

冒烟测试覆盖：路径枚举与申请失败、挂牌合闸互锁、隔离保护整体拒绝与回滚、
乐观锁 409、角色控制、拓扑约束、审计快照等共 46 项断言。
`graph.test.js` 覆盖：完整可达性判定、无启用电源 / 全挂牌可申请、
“前 200 条支路均在挂牌处截断、其后直达设备”的核心回归、超长路径
（>64 节点）见证路径、含环图、243 条路径数量触顶、违规许可的截断信息，
共 31 项断言。
