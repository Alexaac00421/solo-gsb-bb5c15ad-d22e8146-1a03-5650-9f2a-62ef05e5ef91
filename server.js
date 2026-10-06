'use strict';

const express = require('express');
const path = require('path');
const { openDb, initSchema, seedDemo } = require('./src/db');
const {
  evaluateIsolation,
  validateActivePermits,
  serializePath
} = require('./src/graph');
const {
  OrderError,
  ACTION_LABEL,
  normalizeSteps,
  simulateOrder,
  commitOrder
} = require('./src/orders');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.LOTO_DB || path.join(__dirname, 'data', 'loto.db');

const db = openDb(DB_PATH);
initSchema(db);
seedDemo(db);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// 状态读取
// ---------------------------------------------------------------------------
function currentRevision() {
  return parseInt(db.prepare(`SELECT value FROM meta WHERE key='revision'`).get().value, 10);
}

function loadGraph() {
  const nodes = db.prepare(`SELECT * FROM nodes ORDER BY id`).all().map((n) => ({
    ...n,
    enabled: !!n.enabled,
    open_pos: !!n.open_pos,
    tagged: !!n.tagged
  }));
  const edges = db.prepare(`SELECT id, from_node AS "from", to_node AS "to", from_node, to_node, created_at
                            FROM edges ORDER BY id`).all();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const outAdj = new Map();
  for (const e of edges) {
    if (!outAdj.has(e.from_node)) outAdj.set(e.from_node, []);
    outAdj.get(e.from_node).push(e);
  }
  return { nodes, edges, nodeById, outAdj };
}

function activePermits() {
  return db.prepare(
    `SELECT p.*, n.name AS device_name
       FROM permits p JOIN nodes n ON n.id = p.device_id
      WHERE p.status = 'active'
      ORDER BY p.id`
  ).all();
}

function buildSnapshot() {
  const graph = loadGraph();
  const permits = activePermits();
  const isolation = {};
  for (const p of permits) {
    const r = evaluateIsolation(graph, p.device_id);
    isolation[p.device_id] = {
      isolated: r.isolated,
      livePaths: r.livePaths.map((pa) => serializePath(graph, pa)),
      blockedPathCount: r.blockedPaths.length,
      // 诊断枚举若触顶会标记截断; isolated 由完整可达性分析得出, 与此标志无关
      truncated: r.truncated
    };
  }
  return {
    revision: currentRevision(),
    nodes: graph.nodes,
    edges: graph.edges,
    permits,
    isolation
  };
}

function bumpRevision() {
  db.prepare(`UPDATE meta SET value = value + 1 WHERE key='revision'`).run();
}

const insertAudit = db.prepare(
  `INSERT INTO audit_logs(actor, role, action, detail, rev_before, rev_after, state_before, state_after)
   VALUES (@actor, @role, @action, @detail, @rev_before, @rev_after, @state_before, @state_after)`
);

/**
 * 统一的变更处理:
 *  1. 校验操作者/角色/修订号
 *  2. IMMEDIATE 事务内执行业务变更
 *  3. 对全部有效许可复查隔离条件(可通过 skipPermitCheck 跳过, 如申请/结束许可)
 *  4. 提交后写审计(前后状态快照)并递增修订号
 * 修订号过期 -> 409 + 当前状态; 业务规则不满足 -> 422, 事务回滚, 状态不变。
 */
function runMutation(res, options) {
  const {
    body,
    action,
    requireRole,
    skipPermitCheck = false,
    mutate
  } = options;

  const actor = typeof body.actor === 'string' ? body.actor.trim() : '';
  const role = body.role;
  const baseRev = Number(body.revision);

  if (!actor) throw new ApiError(400, 'ACTOR_REQUIRED', '必须填写操作者姓名');
  if (role !== 'admin' && role !== 'operator') {
    throw new ApiError(400, 'ROLE_REQUIRED', '角色必须是 admin 或 operator');
  }
  if (requireRole && role !== requireRole) {
    throw new ApiError(403, 'FORBIDDEN', `该操作仅允许 ${requireRole} 执行`);
  }
  if (!Number.isInteger(baseRev) || baseRev < 1) {
    throw new ApiError(400, 'REVISION_REQUIRED', '必须携带所见修订号 revision(正整数)');
  }

  const detail = {};
  let result = {};

  const tx = db.transaction(() => {
    const revBefore = currentRevision();
    if (revBefore !== baseRev) {
      throw new ApiError(409, 'STALE_REVISION',
        `修订号已过期: 你基于 ${baseRev}, 当前为 ${revBefore}`,
        { current: buildSnapshot() });
    }
    const stateBefore = buildSnapshot();

    mutate({ graph: loadGraph(), detail, result });

    if (!skipPermitCheck) {
      const afterGraph = loadGraph();
      const violations = validateActivePermits(afterGraph, activePermits());
      if (violations.length > 0) {
        throw new ApiError(422, 'ISOLATION_VIOLATION',
          '操作被拒绝: 会使有效检修许可失去断电隔离',
          {
            violations: violations.map((v) => ({
              permit_id: v.permit.id,
              device_id: v.permit.device_id,
              device_name: v.permit.device_name,
              livePaths: v.livePaths.map((p) => serializePath(afterGraph, p)),
              truncated: v.truncated
            }))
          });
      }
    }

    bumpRevision();
    const revAfter = currentRevision();
    const stateAfter = buildSnapshot();
    insertAudit.run({
      actor, role, action,
      detail: JSON.stringify(detail),
      rev_before: revBefore,
      rev_after: revAfter,
      state_before: JSON.stringify(stateBefore),
      state_after: JSON.stringify(stateAfter)
    });
    result.snapshot = stateAfter;
  });

  tx.immediate();
  res.status(200).json({ ok: true, action, ...result, revision: result.snapshot.revision });
}

// ---------------------------------------------------------------------------
// 查询接口
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true, revision: currentRevision() }));

app.get('/api/state', wrap((req, res) => {
  res.json(buildSnapshot());
}));

// 只读路径诊断: 查看某设备当前全部供电路径与隔离状态
app.get('/api/devices/:id/paths', wrap((req, res) => {
  const id = parseInt(req.params.id, 10);
  const graph = loadGraph();
  const node = graph.nodeById.get(id);
  if (!node || node.kind !== 'device') throw new ApiError(404, 'NOT_FOUND', '设备不存在');
  const r = evaluateIsolation(graph, id);
  res.json({
    device_id: id,
    device_name: node.name,
    isolated: r.isolated,
    // 诊断路径限量展示; 触顶时 truncated 显式标记, isolated 以完整可达性为准
    livePaths: r.livePaths.map((p) => serializePath(graph, p)),
    blockedPaths: r.blockedPaths.map((p) => serializePath(graph, p)),
    truncated: r.truncated
  });
}));

app.get('/api/audit', wrap((req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
  const rows = db.prepare(
    `SELECT id, ts, actor, role, action, detail, rev_before, rev_after,
            state_before, state_after
       FROM audit_logs ORDER BY id DESC LIMIT ?`
  ).all(limit);
  res.json({ logs: rows.map((r) => ({
    ...r,
    detail: r.detail ? JSON.parse(r.detail) : null,
    state_before: r.state_before ? JSON.parse(r.state_before) : null,
    state_after: r.state_after ? JSON.parse(r.state_after) : null
  })) });
}));

// ---------------------------------------------------------------------------
// 拓扑管理 —— 仅管理员
// ---------------------------------------------------------------------------
const KIND_LABEL = { source: '电源', switch: '开关', device: '设备' };

app.post('/api/admin/nodes', wrap((req, res) => {
  const { kind, name } = req.body || {};
  if (!KIND_LABEL[kind]) throw new ApiError(400, 'INVALID_KIND', '节点类型必须是 source/switch/device');
  if (typeof name !== 'string' || !name.trim()) throw new ApiError(400, 'NAME_REQUIRED', '必须填写名称');

  runMutation(res, {
    body: req.body, action: 'node.create', requireRole: 'admin',
    mutate: ({ detail }) => {
      const info = db.prepare(
        `INSERT INTO nodes(kind, name, enabled, open_pos, tagged) VALUES (?, ?, 1, 0, 0)`
      ).run(kind, name.trim());
      detail.node_id = info.lastInsertRowid;
      detail.kind = kind;
      detail.name = name.trim();
    }
  });
}));

app.patch('/api/admin/nodes/:id', wrap((req, res) => {
  const id = parseInt(req.params.id, 10);
  runMutation(res, {
    body: req.body, action: 'node.update', requireRole: 'admin',
    mutate: ({ graph, detail }) => {
      const node = graph.nodeById.get(id);
      if (!node) throw new ApiError(404, 'NOT_FOUND', '节点不存在');

      const nextName = typeof req.body.name === 'string' && req.body.name.trim()
        ? req.body.name.trim() : node.name;
      let nextEnabled = node.enabled;
      if (req.body.enabled !== undefined) {
        if (node.kind !== 'source') {
          throw new ApiError(400, 'ONLY_SOURCE_ENABLED', '只有电源可以启用/停用');
        }
        nextEnabled = !!req.body.enabled;
      }
      db.prepare(`UPDATE nodes SET name=?, enabled=? WHERE id=?`).run(
        nextName, nextEnabled ? 1 : 0, id
      );
      detail.node_id = id;
      detail.changes = { name: nextName, ...(node.kind === 'source' ? { enabled: nextEnabled } : {}) };
    }
  });
}));

app.delete('/api/admin/nodes/:id', wrap((req, res) => {
  const id = parseInt(req.params.id, 10);
  runMutation(res, {
    body: req.body, action: 'node.delete', requireRole: 'admin',
    mutate: ({ graph, detail }) => {
      const node = graph.nodeById.get(id);
      if (!node) throw new ApiError(404, 'NOT_FOUND', '节点不存在');
      const activeOnDevice = activePermits().some((p) => p.device_id === id);
      if (node.kind === 'device' && activeOnDevice) {
        throw new ApiError(422, 'DEVICE_HAS_ACTIVE_PERMIT',
          '该设备存在有效检修许可, 不能删除; 请先结束许可');
      }
      db.prepare(`DELETE FROM nodes WHERE id=?`).run(id); // 关联边 ON DELETE CASCADE
      detail.node_id = id;
      detail.name = node.name;
    }
  });
}));

app.post('/api/admin/edges', wrap((req, res) => {
  const from = parseInt(req.body?.from_node, 10);
  const to = parseInt(req.body?.to_node, 10);
  runMutation(res, {
    body: req.body, action: 'edge.create', requireRole: 'admin',
    mutate: ({ graph, detail }) => {
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        throw new ApiError(400, 'INVALID_EDGE', '必须提供 from_node 与 to_node');
      }
      if (from === to) throw new ApiError(400, 'INVALID_EDGE', '不允许自环供电');
      const a = graph.nodeById.get(from);
      const b = graph.nodeById.get(to);
      if (!a || !b) throw new ApiError(404, 'NOT_FOUND', '起点或终点节点不存在');
      if (a.kind === 'device') throw new ApiError(400, 'INVALID_EDGE', '设备是供电末端, 不能作为供电起点');
      if (b.kind === 'source') throw new ApiError(400, 'INVALID_EDGE', '电源是供电起点, 不能作为供电终点');
      if (graph.edges.some((e) => e.from_node === from && e.to_node === to)) {
        throw new ApiError(400, 'EDGE_EXISTS', '该供电关系已存在');
      }
      const info = db.prepare(`INSERT INTO edges(from_node, to_node) VALUES (?, ?)`).run(from, to);
      detail.edge_id = info.lastInsertRowid;
      detail.from_node = from;
      detail.to_node = to;
    }
  });
}));

app.delete('/api/admin/edges/:id', wrap((req, res) => {
  const id = parseInt(req.params.id, 10);
  runMutation(res, {
    body: req.body, action: 'edge.delete', requireRole: 'admin',
    mutate: ({ graph, detail }) => {
      const edge = graph.edges.find((e) => e.id === id);
      if (!edge) throw new ApiError(404, 'NOT_FOUND', '供电关系不存在');
      db.prepare(`DELETE FROM edges WHERE id=?`).run(id);
      detail.edge_id = id;
      detail.from_node = edge.from_node;
      detail.to_node = edge.to_node;
    }
  });
}));

// ---------------------------------------------------------------------------
// 开关操作 —— 仅操作员
// ---------------------------------------------------------------------------
app.post('/api/switches/:id/open', wrap((req, res) => {
  const id = parseInt(req.params.id, 10);
  runMutation(res, {
    body: req.body, action: 'switch.open', requireRole: 'operator',
    mutate: ({ graph, detail }) => {
      const node = graph.nodeById.get(id);
      if (!node || node.kind !== 'switch') throw new ApiError(404, 'NOT_FOUND', '开关不存在');
      if (node.open_pos) throw new ApiError(422, 'INVALID_STATE', '开关已在分闸(断开)位置');
      db.prepare(`UPDATE nodes SET open_pos=1 WHERE id=?`).run(id);
      detail.node_id = id;
      detail.name = node.name;
    }
  });
}));

app.post('/api/switches/:id/close', wrap((req, res) => {
  const id = parseInt(req.params.id, 10);
  runMutation(res, {
    body: req.body, action: 'switch.close', requireRole: 'operator',
    mutate: ({ graph, detail }) => {
      const node = graph.nodeById.get(id);
      if (!node || node.kind !== 'switch') throw new ApiError(404, 'NOT_FOUND', '开关不存在');
      if (node.tagged) {
        throw new ApiError(422, 'SWITCH_TAGGED', '挂牌开关不得合闸, 请先解牌');
      }
      if (!node.open_pos) throw new ApiError(422, 'INVALID_STATE', '开关已在合闸位置');
      db.prepare(`UPDATE nodes SET open_pos=0 WHERE id=?`).run(id);
      detail.node_id = id;
      detail.name = node.name;
    }
  });
}));

app.post('/api/switches/:id/tag', wrap((req, res) => {
  const id = parseInt(req.params.id, 10);
  runMutation(res, {
    body: req.body, action: 'switch.tag', requireRole: 'operator',
    mutate: ({ graph, detail }) => {
      const node = graph.nodeById.get(id);
      if (!node || node.kind !== 'switch') throw new ApiError(404, 'NOT_FOUND', '开关不存在');
      if (node.tagged) throw new ApiError(422, 'INVALID_STATE', '该开关已经挂牌');
      if (!node.open_pos) {
        throw new ApiError(422, 'SWITCH_NOT_OPEN', '挂牌前必须先将开关分闸(断开)');
      }
      db.prepare(`UPDATE nodes SET tagged=1 WHERE id=?`).run(id);
      detail.node_id = id;
      detail.name = node.name;
    }
  });
}));

app.post('/api/switches/:id/untag', wrap((req, res) => {
  const id = parseInt(req.params.id, 10);
  runMutation(res, {
    body: req.body, action: 'switch.untag', requireRole: 'operator',
    mutate: ({ graph, detail }) => {
      const node = graph.nodeById.get(id);
      if (!node || node.kind !== 'switch') throw new ApiError(404, 'NOT_FOUND', '开关不存在');
      if (!node.tagged) throw new ApiError(422, 'INVALID_STATE', '该开关未挂牌');
      db.prepare(`UPDATE nodes SET tagged=0 WHERE id=?`).run(id);
      detail.node_id = id;
      detail.name = node.name;
    }
    // 解牌后统一复查有效许可(默认执行), 若重新来电则整次操作拒绝
  });
}));

// ---------------------------------------------------------------------------
// 检修许可 —— 仅操作员
// ---------------------------------------------------------------------------
app.post('/api/permits', wrap((req, res) => {
  const deviceId = parseInt(req.body?.device_id, 10);
  runMutation(res, {
    body: req.body, action: 'permit.apply', requireRole: 'operator',
    skipPermitCheck: true, // 本次变更即“新增许可”, 单独做隔离判定
    mutate: ({ graph, detail, result }) => {
      if (!Number.isInteger(deviceId)) {
        throw new ApiError(400, 'DEVICE_REQUIRED', '必须提供 device_id');
      }
      const node = graph.nodeById.get(deviceId);
      if (!node || node.kind !== 'device') throw new ApiError(404, 'NOT_FOUND', '目标设备不存在');
      if (activePermits().some((p) => p.device_id === deviceId)) {
        throw new ApiError(422, 'PERMIT_EXISTS', '该设备已有有效检修许可');
      }
      const { isolated, livePaths, truncated } = evaluateIsolation(graph, deviceId);
      if (!isolated) {
        throw new ApiError(422, 'PERMIT_NOT_ISOLATED',
          '许可申请失败: 仍存在未切断的供电路径, 请断开并挂牌相关开关',
          {
            device_id: deviceId,
            device_name: node.name,
            livePaths: livePaths.map((p) => serializePath(graph, p)),
            // 至少返回一条真实带电路径; 列表触顶时用 truncated 标记
            truncated
          });
      }
      const info = db.prepare(
        `INSERT INTO permits(device_id, status, requested_by) VALUES (?, 'active', ?)`
      ).run(deviceId, req.body.actor.trim());
      detail.permit_id = info.lastInsertRowid;
      detail.device_id = deviceId;
      result.permit_id = info.lastInsertRowid;
    }
  });
}));

app.post('/api/permits/:id/end', wrap((req, res) => {
  const permitId = parseInt(req.params.id, 10);
  runMutation(res, {
    body: req.body, action: 'permit.end', requireRole: 'operator',
    skipPermitCheck: true,
    mutate: ({ detail, result }) => {
      const permit = db.prepare(`SELECT * FROM permits WHERE id=?`).get(permitId);
      if (!permit) throw new ApiError(404, 'NOT_FOUND', '检修许可不存在');
      if (permit.status !== 'active') throw new ApiError(422, 'PERMIT_NOT_ACTIVE', '该许可已结束');
      db.prepare(
        `UPDATE permits SET status='ended', ended_at=datetime('now'), ended_by=? WHERE id=?`
      ).run(req.body.actor.trim(), permitId);
      detail.permit_id = permitId;
      detail.device_id = permit.device_id;
      result.permit_id = permitId;
    }
  });
}));

// ---------------------------------------------------------------------------
// 临时操作单 —— 仅操作员; 预演只读, 确认原子执行
// ---------------------------------------------------------------------------

// 预演/确认共用的操作者身份校验(预演不落库, 但沿用同一 actor/role 约定)
function requireOperator(body) {
  const actor = typeof body.actor === 'string' ? body.actor.trim() : '';
  const role = body.role;
  if (!actor) throw new ApiError(400, 'ACTOR_REQUIRED', '必须填写操作者姓名');
  if (role !== 'admin' && role !== 'operator') {
    throw new ApiError(400, 'ROLE_REQUIRED', '角色必须是 admin 或 operator');
  }
  if (role !== 'operator') throw new ApiError(403, 'FORBIDDEN', '临时操作单仅允许 operator 执行');
  return actor.trim();
}

// 预演: 不校验/递增修订号, 不写任何库; 永远基于当前状态推演并返回当前修订号。
app.post('/api/orders/preview', wrap((req, res) => {
  requireOperator(req.body || {});
  const actor = req.body.actor.trim();
  const graph = loadGraph();
  const steps = normalizeSteps(graph, req.body?.steps);
  const simulation = simulateOrder(graph, activePermits(), steps, actor);
  const permitStep = steps.find((s) => s.action === 'permit');
  res.json({
    ok: true,
    kind: 'order.preview',
    revision: currentRevision(), // 预演所依据的修订号
    success: simulation.success,
    failedStep: simulation.failedStep,
    error: simulation.error,
    steps: simulation.steps,
    // 若末步申请许可, 附目标设备当前隔离状态(纯展示, 不改变任何数据)
    permitIsolation: permitStep
      ? (() => {
          const r = evaluateIsolation(graph, permitStep.device_id);
          return {
            device_id: permitStep.device_id,
            device_name: permitStep.device_name,
            isolated: r.isolated,
            livePaths: r.livePaths.map((p) => serializePath(graph, p)),
            blockedPathCount: r.blockedPaths.length,
            truncated: r.truncated
          };
        })()
      : null
  });
}));

// 确认: STALE_REVISION / 角色 / 事务回滚 / 单次修订号递增 / 整单审计, 均沿用既有约定。
app.post('/api/orders/confirm', wrap((req, res) => {
  runMutation(res, {
    body: req.body, action: 'order.confirm', requireRole: 'operator',
    skipPermitCheck: true, // 整单隔离保护在逐步推演中逐次完成, 等价且更精确
    mutate: ({ detail, result }) => {
      const graph = loadGraph();
      const steps = normalizeSteps(graph, req.body?.steps);
      const actor = req.body.actor.trim();

      const simulation = simulateOrder(graph, activePermits(), steps, actor);
      if (!simulation.success) {
        const f = simulation.steps[simulation.failedStep - 1];
        // 隔离失败(violations)或末步许可未隔离(livePaths)都在此携带实际带电路径
        throw new OrderError(422, f.error.code,
          `第 ${simulation.failedStep} 步执行失败: ${f.error.message}`,
          {
            step: simulation.failedStep,
            step_name: ACTION_LABEL[f.action],
            step_results: simulation.steps,
            ...(f.violations ? { violations: f.violations } : {}),
            ...(f.isolation ? {
              livePaths: f.isolation.livePaths,
              truncated: f.isolation.truncated,
              device_id: f.device_id,
              device_name: f.device_name
            } : {})
          });
      }

      const committed = commitOrder(db, steps, actor);
      detail.steps = committed;
      result.steps = committed;
      const permit = committed.find((c) => c.action === 'permit');
      if (permit) result.permit_id = permit.permit_id;
    }
  });
}));

// ---------------------------------------------------------------------------
// 错误处理
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err instanceof ApiError || err instanceof OrderError) {
    const body = { ok: false, error: { code: err.code, message: err.message } };
    if (err.current) body.current = err.current;
    if (err.violations) body.violations = err.violations;
    if (err.livePaths) body.livePaths = err.livePaths;
    if (err.truncated) body.truncated = err.truncated;
    if (err.step !== undefined) {
      body.step = err.step;
      body.step_name = err.step_name;
      body.step_results = err.step_results;
    }
    if (err.device_id !== undefined) {
      body.device_id = err.device_id;
      body.device_name = err.device_name;
    }
    return res.status(err.status).json(body);
  }
  console.error(err);
  res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: '服务器内部错误' } });
});

app.listen(PORT, () => {
  console.log(`[loto-drill] 已启动: http://0.0.0.0:${PORT} (DB: ${DB_PATH})`);
});
