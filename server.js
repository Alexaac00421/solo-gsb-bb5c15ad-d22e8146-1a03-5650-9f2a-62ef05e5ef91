'use strict';

const express = require('express');
const path = require('path');
const { openDb, initSchema, seedDemo } = require('./src/db');
const {
  evaluateIsolation,
  validateActivePermits,
  serializePath
} = require('./src/graph');

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

// ---------------------------------------------------------------------------
// 步骤原语 —— 单独端点与临时操作单共用, 保证两处规则完全一致
// ---------------------------------------------------------------------------
/**
 * 开关状态机单步执行: open 分闸 / close 合闸 / tag 挂牌 / untag 解牌。
 * 只校验并落库当前一步; 有效许可隔离复查由调用方负责(assertActivePermitsIsolated)。
 */
function applySwitchAction(graph, id, action) {
  const node = graph.nodeById.get(id);
  if (!node || node.kind !== 'switch') throw new ApiError(404, 'NOT_FOUND', '开关不存在');
  if (action === 'open') {
    if (node.open_pos) throw new ApiError(422, 'INVALID_STATE', '开关已在分闸(断开)位置');
    db.prepare(`UPDATE nodes SET open_pos=1 WHERE id=?`).run(id);
  } else if (action === 'close') {
    if (node.tagged) throw new ApiError(422, 'SWITCH_TAGGED', '挂牌开关不得合闸, 请先解牌');
    if (!node.open_pos) throw new ApiError(422, 'INVALID_STATE', '开关已在合闸位置');
    db.prepare(`UPDATE nodes SET open_pos=0 WHERE id=?`).run(id);
  } else if (action === 'tag') {
    if (node.tagged) throw new ApiError(422, 'INVALID_STATE', '该开关已经挂牌');
    if (!node.open_pos) throw new ApiError(422, 'SWITCH_NOT_OPEN', '挂牌前必须先将开关分闸(断开)');
    db.prepare(`UPDATE nodes SET tagged=1 WHERE id=?`).run(id);
  } else if (action === 'untag') {
    if (!node.tagged) throw new ApiError(422, 'INVALID_STATE', '该开关未挂牌');
    db.prepare(`UPDATE nodes SET tagged=0 WHERE id=?`).run(id);
  } else {
    throw new ApiError(400, 'INVALID_ACTION', `未知开关动作: ${action}`);
  }
  return { node_id: id, name: node.name };
}

/** 申请检修许可: 完整可达性隔离判定通过才生效, 否则 422 并附实际带电路径。 */
function applyPermitApply(graph, deviceId, actor) {
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
  ).run(deviceId, actor);
  return { permit_id: info.lastInsertRowid, device_id: deviceId, device_name: node.name };
}

/** 对全部有效许可复查隔离条件; 任一许可将失去隔离则抛 422 ISOLATION_VIOLATION。 */
function assertActivePermitsIsolated() {
  const graph = loadGraph();
  const violations = validateActivePermits(graph, activePermits());
  if (violations.length > 0) {
    throw new ApiError(422, 'ISOLATION_VIOLATION',
      '操作被拒绝: 会使有效检修许可失去断电隔离',
      {
        violations: violations.map((v) => ({
          permit_id: v.permit.id,
          device_id: v.permit.device_id,
          device_name: v.permit.device_name,
          livePaths: v.livePaths.map((p) => serializePath(graph, p)),
          truncated: v.truncated
        }))
      });
  }
}

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

    if (!skipPermitCheck) assertActivePermitsIsolated();

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
// 开关操作 —— 仅操作员(状态机规则见 applySwitchAction, 与操作单共用)
// ---------------------------------------------------------------------------
app.post('/api/switches/:id/open', wrap((req, res) => {
  const id = parseInt(req.params.id, 10);
  runMutation(res, {
    body: req.body, action: 'switch.open', requireRole: 'operator',
    mutate: ({ graph, detail }) => Object.assign(detail, applySwitchAction(graph, id, 'open'))
  });
}));

app.post('/api/switches/:id/close', wrap((req, res) => {
  const id = parseInt(req.params.id, 10);
  runMutation(res, {
    body: req.body, action: 'switch.close', requireRole: 'operator',
    mutate: ({ graph, detail }) => Object.assign(detail, applySwitchAction(graph, id, 'close'))
  });
}));

app.post('/api/switches/:id/tag', wrap((req, res) => {
  const id = parseInt(req.params.id, 10);
  runMutation(res, {
    body: req.body, action: 'switch.tag', requireRole: 'operator',
    mutate: ({ graph, detail }) => Object.assign(detail, applySwitchAction(graph, id, 'tag'))
  });
}));

app.post('/api/switches/:id/untag', wrap((req, res) => {
  const id = parseInt(req.params.id, 10);
  runMutation(res, {
    body: req.body, action: 'switch.untag', requireRole: 'operator',
    mutate: ({ graph, detail }) => Object.assign(detail, applySwitchAction(graph, id, 'untag'))
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
      const r = applyPermitApply(graph, deviceId, req.body.actor.trim());
      detail.permit_id = r.permit_id;
      detail.device_id = r.device_id;
      result.permit_id = r.permit_id;
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
// 临时操作单 —— 仅操作员
// 按序编排开关动作(分闸/挂牌/解牌/合闸), 末步可为设备申请一个许可。
// 预演(preview): SAVEPOINT 内完整执行后强制回滚, 不改变真实网络、许可、
//   修订号或审计, 仅展示各步结果与目标设备隔离状态。
// 确认(commit): 单事务内按原顺序原子执行; 每一步都遵守开关状态机并在
//   该步后立即复查有效许可隔离保护, 不允许用后续步骤补救前一步违规;
//   任一步失败整单回滚不落库, 返回步骤序号与原因(隔离失败附实际带电路径);
//   成功只递增一次修订号, 并记录一条含整单前后快照的审计。
// ---------------------------------------------------------------------------
const ORDER_ACTIONS = ['open', 'close', 'tag', 'untag', 'permit'];
const ORDER_ACTION_LABEL = { open: '分闸', close: '合闸', tag: '挂牌', untag: '解牌', permit: '申请许可' };
const MAX_ORDER_STEPS = 50;

/** 操作单某一步失败: 携带步骤序号与原始原因(含隔离类错误的带电路径)。 */
class OrderStepError extends Error {
  constructor(step, actionLabel, cause) {
    super(`操作单第 ${step} 步(${actionLabel})失败: ${cause.message}`);
    this.status = cause.status || 422;
    this.code = 'ORDER_STEP_FAILED';
    this.step = step;
    this.cause = { code: cause.code, message: cause.message };
    for (const k of ['livePaths', 'violations', 'truncated', 'device_id', 'device_name']) {
      if (cause[k] !== undefined) this[k] = cause[k];
    }
  }
}

/**
 * 校验操作单请求(actor/role/revision 与单步写操作同一约定)并规范步骤:
 *  - steps 为 1..MAX_ORDER_STEPS 的非空数组;
 *  - 开关步 {action: open/close/tag/untag, switch_id};
 *  - 许可步 {action: 'permit', device_id} 仅允许出现在末步(至多一个许可)。
 */
function parseOrder(body) {
  const actor = typeof body.actor === 'string' ? body.actor.trim() : '';
  const role = body.role;
  const baseRev = Number(body.revision);
  if (!actor) throw new ApiError(400, 'ACTOR_REQUIRED', '必须填写操作者姓名');
  if (role !== 'admin' && role !== 'operator') {
    throw new ApiError(400, 'ROLE_REQUIRED', '角色必须是 admin 或 operator');
  }
  if (role !== 'operator') throw new ApiError(403, 'FORBIDDEN', '操作单仅允许 operator 编排执行');
  if (!Number.isInteger(baseRev) || baseRev < 1) {
    throw new ApiError(400, 'REVISION_REQUIRED', '必须携带所见修订号 revision(正整数)');
  }
  const raw = body.steps;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError(400, 'STEPS_REQUIRED', '操作单至少包含一个步骤');
  }
  if (raw.length > MAX_ORDER_STEPS) {
    throw new ApiError(400, 'TOO_MANY_STEPS', `操作单最多 ${MAX_ORDER_STEPS} 步`);
  }
  const steps = raw.map((s, i) => {
    const action = s && s.action;
    if (!ORDER_ACTIONS.includes(action)) {
      throw new ApiError(400, 'INVALID_ACTION',
        `第 ${i + 1} 步动作无效, 允许: open/close/tag/untag/permit`);
    }
    if (action === 'permit') {
      if (i !== raw.length - 1) {
        throw new ApiError(400, 'PERMIT_NOT_LAST', '申请许可只能是操作单的最后一步');
      }
      const deviceId = Number(s.device_id);
      if (!Number.isInteger(deviceId)) {
        throw new ApiError(400, 'DEVICE_REQUIRED', `第 ${i + 1} 步必须提供设备编号 device_id`);
      }
      return { action, device_id: deviceId };
    }
    const switchId = Number(s.switch_id);
    if (!Number.isInteger(switchId)) {
      throw new ApiError(400, 'SWITCH_REQUIRED', `第 ${i + 1} 步必须提供开关编号 switch_id`);
    }
    return { action, switch_id: switchId };
  });
  return { actor, role, baseRev, steps };
}

/**
 * 在事务内按原顺序执行操作单各步, 已完成的步骤结果追加到 results。
 * 每个开关步执行后立即复查有效许可隔离(与单独端点一致), 许可步自身做隔离判定;
 * 任一步失败抛 OrderStepError, 由外层决定回滚(确认)或仅展示(预演)。
 */
function executeOrderSteps(steps, actor, results) {
  steps.forEach((step, i) => {
    const stepNo = i + 1;
    try {
      if (step.action === 'permit') {
        const r = applyPermitApply(loadGraph(), step.device_id, actor);
        results.push({
          step: stepNo, action: 'permit', ok: true,
          device_id: step.device_id, device_name: r.device_name, permit_id: r.permit_id
        });
      } else {
        const r = applySwitchAction(loadGraph(), step.switch_id, step.action);
        assertActivePermitsIsolated();
        results.push({
          step: stepNo, action: step.action, ok: true,
          switch_id: step.switch_id, name: r.name
        });
      }
    } catch (e) {
      if (e instanceof ApiError) throw new OrderStepError(stepNo, ORDER_ACTION_LABEL[step.action], e);
      throw e;
    }
  });
  return results;
}

// 预演: 完整执行后强制回滚, 不落库、不递增修订号、不写审计
app.post('/api/orders/preview', wrap((req, res) => {
  const { actor, baseRev, steps } = parseOrder(req.body || {});
  db.prepare(`SAVEPOINT order_preview`).run();
  try {
    const rev = currentRevision();
    if (rev !== baseRev) {
      throw new ApiError(409, 'STALE_REVISION',
        `修订号已过期: 你基于 ${baseRev}, 当前为 ${rev}`,
        { current: buildSnapshot() });
    }
    const results = [];
    let stepError = null;
    try {
      executeOrderSteps(steps, actor, results);
    } catch (e) {
      if (e instanceof OrderStepError) stepError = e; else throw e;
    }

    const body = { ok: true, preview: true, allOk: !stepError, revision: rev, steps: results };
    if (stepError) {
      // 首个失败步即停止(后续步骤依赖前序状态, 不再预演), 附原因与带电路径
      const def = steps[stepError.step - 1];
      const entry = { step: stepError.step, action: def.action, ok: false, error: stepError.cause };
      if (def.action === 'permit') entry.device_id = def.device_id;
      else entry.switch_id = def.switch_id;
      for (const k of ['livePaths', 'violations', 'truncated']) {
        if (stepError[k] !== undefined) entry[k] = stepError[k];
      }
      body.steps.push(entry);
      body.failedStep = stepError.step;
    } else if (steps[steps.length - 1].action === 'permit') {
      // 末步为申请许可: 展示目标设备在临时事务中的隔离状态(许可已临时生效)
      const deviceId = steps[steps.length - 1].device_id;
      const graph = loadGraph();
      const r = evaluateIsolation(graph, deviceId);
      body.isolation = {
        device_id: deviceId,
        device_name: graph.nodeById.get(deviceId).name,
        isolated: r.isolated,
        livePaths: r.livePaths.map((p) => serializePath(graph, p)),
        blockedPaths: r.blockedPaths.map((p) => serializePath(graph, p)),
        truncated: r.truncated
      };
    }
    res.json(body);
  } finally {
    db.prepare(`ROLLBACK TO order_preview`).run();
    db.prepare(`RELEASE order_preview`).run();
  }
}));

// 确认: 单事务原子执行, 成功只递增一次修订号并记录整单前后快照
app.post('/api/orders/commit', wrap((req, res) => {
  const { actor, role, baseRev, steps } = parseOrder(req.body || {});
  const results = [];
  let payload;
  const tx = db.transaction(() => {
    const revBefore = currentRevision();
    if (revBefore !== baseRev) {
      throw new ApiError(409, 'STALE_REVISION',
        `修订号已过期: 你基于 ${baseRev}, 当前为 ${revBefore}`,
        { current: buildSnapshot() });
    }
    const stateBefore = buildSnapshot();

    executeOrderSteps(steps, actor, results);

    bumpRevision();
    const revAfter = currentRevision();
    const stateAfter = buildSnapshot();
    insertAudit.run({
      actor, role, action: 'order.commit',
      detail: JSON.stringify({ steps: results }),
      rev_before: revBefore,
      rev_after: revAfter,
      state_before: JSON.stringify(stateBefore),
      state_after: JSON.stringify(stateAfter)
    });
    const permitStep = results.find((r) => r.action === 'permit');
    payload = {
      ok: true, action: 'order.commit', steps: results,
      ...(permitStep ? { permit_id: permitStep.permit_id } : {}),
      snapshot: stateAfter, revision: revAfter
    };
  });
  tx.immediate();
  res.status(200).json(payload);
}));

// ---------------------------------------------------------------------------
// 错误处理
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err instanceof OrderStepError) {
    const body = {
      ok: false,
      error: { code: err.code, message: err.message },
      step: err.step,
      cause: err.cause
    };
    if (err.livePaths) body.livePaths = err.livePaths;
    if (err.violations) body.violations = err.violations;
    if (err.truncated) body.truncated = err.truncated;
    if (err.device_id !== undefined) {
      body.device_id = err.device_id;
      body.device_name = err.device_name;
    }
    return res.status(err.status).json(body);
  }
  if (err instanceof ApiError) {
    const body = { ok: false, error: { code: err.code, message: err.message } };
    if (err.current) body.current = err.current;
    if (err.violations) body.violations = err.violations;
    if (err.livePaths) body.livePaths = err.livePaths;
    if (err.truncated) body.truncated = err.truncated;
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
