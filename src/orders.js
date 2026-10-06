'use strict';

// 临时操作单: 编排 -> 预演(纯内存推演) -> 确认(事务内原子落库)。
//
// 预演 simulateOrder 只在节点/许可的内存克隆上按序推演, 完全不触碰数据库:
//   - 每一步都先套用既有开关状态机(与单步接口完全相同的合法条件);
//   - 每个开关动作之后立即对“当前全部有效许可”做完整可达性隔离复查;
//   - 任一步不通过即判定该步失败并中止, 后续步骤统一标记 skipped ——
//     不允许用后续步骤补救前一步的违规(例如先解牌破坏隔离、再重新挂牌)。
//
// 确认时服务端在 IMMEDIATE 事务、修订号校验通过之后重放同一推演; 推演全部
// 通过才按原顺序真正写库(许可插入固定在最后一步), 随后只递增一次修订号、
// 写一条整单审计(含前后完整快照)。任一步失败: 事务回滚, 整单不落库。

const {
  evaluateIsolation,
  validateActivePermits,
  serializePath
} = require('./graph');

const MAX_STEPS = 200;
const SWITCH_ACTIONS = new Set(['open', 'close', 'tag', 'untag']);
const ACTION_LABEL = {
  open: '分闸', close: '合闸', tag: '挂牌', untag: '解牌', permit: '申请许可'
};

// 与 server.ApiError 同构(status/code + 附加字段), server 错误处理按鸭子类型识别。
class OrderError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * 结构校验并归一化操作单。
 * @returns 归一化步骤 [{action,node_id,name} | {action:'permit',device_id,device_name}]
 */
function normalizeSteps(graph, rawSteps) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new OrderError(400, 'STEPS_REQUIRED', '操作单必须至少包含一个步骤');
  }
  if (rawSteps.length > MAX_STEPS) {
    throw new OrderError(400, 'STEPS_TOO_LONG', `操作单最多 ${MAX_STEPS} 步`);
  }

  const steps = [];
  rawSteps.forEach((raw, i) => {
    const seq = i + 1;
    if (!raw || typeof raw !== 'object') {
      throw new OrderError(400, 'INVALID_STEP', `第 ${seq} 步格式不正确`);
    }
    const { action } = raw;

    if (action === 'permit') {
      if (i !== rawSteps.length - 1) {
        throw new OrderError(400, 'PERMIT_MUST_BE_LAST',
          `第 ${seq} 步为申请许可: 许可申请只能是操作单的最后一步`);
      }
      const deviceId = parseInt(raw.device_id, 10);
      if (!Number.isInteger(deviceId)) {
        throw new OrderError(400, 'DEVICE_REQUIRED', `第 ${seq} 步申请许可必须提供 device_id`);
      }
      const node = graph.nodeById.get(deviceId);
      if (!node || node.kind !== 'device') {
        throw new OrderError(404, 'NOT_FOUND', `第 ${seq} 步: 目标设备不存在`);
      }
      steps.push({ action: 'permit', device_id: deviceId, device_name: node.name });
      return;
    }

    if (SWITCH_ACTIONS.has(action)) {
      const nodeId = parseInt(raw.node_id, 10);
      if (!Number.isInteger(nodeId)) {
        throw new OrderError(400, 'NODE_REQUIRED', `第 ${seq} 步必须提供开关编号 node_id`);
      }
      const node = graph.nodeById.get(nodeId);
      if (!node || node.kind !== 'switch') {
        throw new OrderError(404, 'NOT_FOUND', `第 ${seq} 步: 开关不存在`);
      }
      steps.push({ action, node_id: nodeId, name: node.name });
      return;
    }

    throw new OrderError(400, 'INVALID_ACTION',
      `第 ${seq} 步动作无效: 仅支持 open(分闸)、tag(挂牌)、untag(解牌)、close(合闸)、permit(申请许可)`);
  });

  return steps;
}

function stateLabelOf(node) {
  if (node.tagged) return '挂牌';
  return node.open_pos ? '分闸' : '合闸';
}

/**
 * 纯内存预演。输入的 graph / permits 不会被修改。
 * @returns {{ success:boolean, failedStep:number|null,
 *             error:{code:string,message:string}|null, steps:Array }}
 *   steps 每步: {step, action, node_id/name|device_id/device_name, ok, skipped?,
 *                before?, after?, message, error?, violations?, isolation?}
 */
function simulateOrder(graph, permits, steps, requestedBy) {
  // 节点浅拷贝(预演中的分合/挂牌只改动克隆); 拓扑边只读, 直接复用。
  const nodeById = new Map(graph.nodes.map((n) => [n.id, { ...n }]));
  const view = () => ({ nodes: [...nodeById.values()], nodeById, outAdj: graph.outAdj });

  const activeByDevice = new Map();
  for (const p of permits) activeByDevice.set(p.device_id, p);

  const results = [];
  let success = true;
  let failedStep = null;

  function pushSkipped(s, seq) {
    results.push({
      step: seq, action: s.action,
      ...(s.action === 'permit'
        ? { device_id: s.device_id, device_name: s.device_name }
        : { node_id: s.node_id, name: s.name }),
      ok: false, skipped: true,
      message: '未执行: 前序步骤已失败, 整单在该步之前中止(后续步骤不能补救)'
    });
  }

  function failSwitch(s, seq, node, before, code, message, extra) {
    success = false;
    failedStep = seq;
    results.push({
      step: seq, action: s.action, node_id: node ? node.id : s.node_id,
      name: node ? node.name : s.name,
      ok: false, before, after: before,
      error: { code, message }, ...(extra || {})
    });
  }

  function doSwitch(s, seq) {
    const node = nodeById.get(s.node_id);
    const before = { open_pos: node.open_pos, tagged: node.tagged };

    if (s.action === 'open') {
      if (node.open_pos) {
        return failSwitch(s, seq, node, before, 'INVALID_STATE', '开关已在分闸(断开)位置');
      }
      node.open_pos = true;
    } else if (s.action === 'close') {
      if (node.tagged) {
        return failSwitch(s, seq, node, before, 'SWITCH_TAGGED', '挂牌开关不得合闸, 请先解牌');
      }
      if (!node.open_pos) {
        return failSwitch(s, seq, node, before, 'INVALID_STATE', '开关已在合闸位置');
      }
      node.open_pos = false;
    } else if (s.action === 'tag') {
      if (node.tagged) {
        return failSwitch(s, seq, node, before, 'INVALID_STATE', '该开关已经挂牌');
      }
      if (!node.open_pos) {
        return failSwitch(s, seq, node, before, 'SWITCH_NOT_OPEN', '挂牌前必须先将开关分闸(断开)');
      }
      node.tagged = true;
    } else { // untag
      if (!node.tagged) {
        return failSwitch(s, seq, node, before, 'INVALID_STATE', '该开关未挂牌');
      }
      node.tagged = false;
    }

    // 有效许可隔离保护: 该步落地之后, 所有当前有效许可仍必须满足隔离。
    const g = view();
    const violations = validateActivePermits(g, [...activeByDevice.values()]);
    if (violations.length > 0) {
      // 预演失败即中止, 克隆回滚仅为语义干净(失败响应中的 before/after 一致)。
      node.open_pos = before.open_pos;
      node.tagged = before.tagged;
      return failSwitch(s, seq, node, before, 'ISOLATION_VIOLATION',
        '该步会使有效检修许可失去断电隔离; 操作单在该步即拒绝, 后续步骤不能补救',
        {
          violations: violations.map((v) => ({
            permit_id: v.permit.id,
            device_id: v.permit.device_id,
            device_name: v.permit.device_name,
            livePaths: v.livePaths.map((p) => serializePath(g, p)),
            truncated: v.truncated
          }))
        });
    }

    const after = { open_pos: node.open_pos, tagged: node.tagged };
    results.push({
      step: seq, action: s.action, node_id: node.id, name: node.name,
      ok: true, before, after,
      message: `${ACTION_LABEL[s.action]}完成（${stateLabelOf(node)}）`
    });
  }

  function failPermit(s, seq, code, message, isolation) {
    success = false;
    failedStep = seq;
    const node = nodeById.get(s.device_id);
    results.push({
      step: seq, action: 'permit',
      device_id: s.device_id,
      device_name: node ? node.name : s.device_name,
      ok: false, error: { code, message },
      ...(isolation ? { isolation } : {})
    });
  }

  function doPermit(s, seq) {
    const device = nodeById.get(s.device_id);
    if (activeByDevice.has(s.device_id)) {
      return failPermit(s, seq, 'PERMIT_EXISTS', '该设备已有有效检修许可');
    }
    const g = view();
    const r = evaluateIsolation(g, s.device_id);
    const isolation = {
      isolated: r.isolated,
      livePaths: r.livePaths.map((p) => serializePath(g, p)),
      blockedPathCount: r.blockedPaths.length,
      truncated: r.truncated
    };
    if (!r.isolated) {
      return failPermit(s, seq, 'PERMIT_NOT_ISOLATED',
        '许可申请失败: 仍存在未切断的供电路径, 请断开并挂牌相关开关', isolation);
    }
    // 预演中的“拟生效许可”, 同样受后续(不存在, permit 必为末步)隔离保护。
    activeByDevice.set(s.device_id, {
      id: null, device_id: s.device_id, device_name: device.name,
      status: 'active', requested_by: requestedBy
    });
    results.push({
      step: seq, action: 'permit',
      device_id: s.device_id, device_name: device.name,
      ok: true, permit: { permit_id: null }, isolation,
      message: '许可可以生效: 目标设备已断电隔离'
    });
  }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const seq = i + 1;
    if (!success) {
      pushSkipped(s, seq);
    } else if (s.action === 'permit') {
      doPermit(s, seq);
    } else {
      doSwitch(s, seq);
    }
  }

  const failed = failedStep === null ? null : results[failedStep - 1];
  return {
    success,
    failedStep,
    error: failed ? { code: failed.error.code, message: failed.error.message } : null,
    steps: results
  };
}

/**
 * 确认落库: 仅在 simulateOrder 全部通过后调用。按原顺序执行同样的 SQL,
 * 与预演使用同一套状态机/隔离判定(已由预演担保合法), 不会再失败。
 * @returns 每步紧凑记录 [{step, action, node_id?} | {step, action:'permit', device_id, permit_id}]
 */
function commitOrder(db, steps, actor) {
  const applySwitch = {
    open: db.prepare(`UPDATE nodes SET open_pos=1 WHERE id=?`),
    close: db.prepare(`UPDATE nodes SET open_pos=0 WHERE id=?`),
    tag: db.prepare(`UPDATE nodes SET tagged=1 WHERE id=?`),
    untag: db.prepare(`UPDATE nodes SET tagged=0 WHERE id=?`)
  };
  const insertPermit = db.prepare(
    `INSERT INTO permits(device_id, status, requested_by) VALUES (?, 'active', ?)`
  );

  const committed = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const seq = i + 1;
    if (s.action === 'permit') {
      const info = insertPermit.run(s.device_id, actor);
      committed.push({
        step: seq, action: 'permit', device_id: s.device_id,
        permit_id: info.lastInsertRowid
      });
    } else {
      applySwitch[s.action].run(s.node_id);
      committed.push({ step: seq, action: s.action, node_id: s.node_id });
    }
  }
  return committed;
}

module.exports = {
  MAX_STEPS,
  ACTION_LABEL,
  OrderError,
  normalizeSteps,
  simulateOrder,
  commitOrder
};
