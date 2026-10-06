'use strict';
// 临时操作单端到端测试。
// 使用方式: LOTO_DB=/tmp/loto-order-test.db PORT=3100 node server.js 后执行 node test/orders.e2e.js
const BASE = process.env.BASE || 'http://127.0.0.1:3100';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✔', msg); }
  else { fail++; console.log('  ✘ FAIL:', msg); }
}

async function call(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const r = await fetch(BASE + url, opts);
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

const OP = { actor: '操作单操作员', role: 'operator' };
const ADMIN = { actor: '操作单管理员', role: 'admin' };

(async () => {
  let { data: s } = await call('GET', '/api/state');
  let rev = s.revision;
  console.log('初始修订号:', rev);
  const S2 = 2, K1 = 3, K2 = 4, K3 = 5, D1 = 6, D2 = 7;

  const preview = async (steps) =>
    call('POST', '/api/orders/preview', { ...OP, revision: rev, steps });
  const confirm = async (steps, revision = rev) =>
    call('POST', '/api/orders/confirm', { ...OP, revision, steps });
  const auditCount = async () => (await call('GET', '/api/audit?limit=500')).data.logs.length;
  const state = async () => (await call('GET', '/api/state')).data;

  console.log('\n[O1] 预演: 全流程(分闸K1→挂牌→分闸K2→挂牌→申请许可) 通过且不落库');
  const goodSteps = [
    { action: 'open', node_id: K1 }, { action: 'tag', node_id: K1 },
    { action: 'open', node_id: K2 }, { action: 'tag', node_id: K2 },
    { action: 'permit', device_id: D1 }
  ];
  let r = await preview(goodSteps);
  ok(r.status === 200, 'HTTP 200');
  ok(r.data.success === true, '预演成功');
  ok(r.data.failedStep === null, '无失败步');
  ok(r.data.steps.length === 5, '返回 5 个步骤结果');
  ok(r.data.steps[0].ok && r.data.steps[0].before.open_pos === false
    && r.data.steps[0].after.open_pos === true, '第1步展示分闸前后状态');
  ok(r.data.steps[4].action === 'permit' && r.data.steps[4].isolation.isolated === true,
    '末步展示目标设备已隔离');
  ok(r.data.permitIsolation && r.data.permitIsolation.device_id === D1,
    '预演附目标设备隔离状态');
  let cur = await state();
  ok(cur.revision === rev, '修订号不变');
  ok(cur.nodes.find((n) => n.id === K1).open_pos === false && cur.permits.length === 0,
    '真实网络未分闸、许可未创建(预演纯只读)');
  ok(await auditCount() === 0, '无审计记录');

  console.log('\n[O2] 预演: 状态机违规在当步失败, 后续步骤标记 skipped(不能补救)');
  r = await preview([
    { action: 'tag', node_id: K1 },
    { action: 'open', node_id: K1 }
  ]);
  ok(r.status === 200 && r.data.success === false, '预演返回业务失败(HTTP 200, success=false)');
  ok(r.data.failedStep === 1 && r.data.steps[0].error.code === 'SWITCH_NOT_OPEN',
    '第1步未分闸即挂牌 → SWITCH_NOT_OPEN');
  ok(r.data.steps[1].skipped === true, '第2步标记未执行');

  console.log('\n[O3] 预演: 隔离违规当步拒绝; 后续“补救”步骤不得执行');
  // 先用单步接口造出 K1/K2 挂牌且 D1 有有效许可的状态
  for (const id of [K1, K2]) {
    r = await call('POST', `/api/switches/${id}/open`, { ...OP, revision: rev }); rev = r.data.revision;
    r = await call('POST', `/api/switches/${id}/tag`, { ...OP, revision: rev }); rev = r.data.revision;
  }
  r = await call('POST', '/api/permits', { ...OP, revision: rev, device_id: D1 });
  rev = r.data.revision;
  ok(r.status === 200, '准备: D1 许可生效');
  r = await preview([
    { action: 'untag', node_id: K2 },          // 1: 会使 D1 重新来电
    { action: 'tag', node_id: K2 },            // 2: 补救? 不允许执行
    { action: 'untag', node_id: K1 }           // 3: skipped
  ]);
  ok(r.data.success === false && r.data.failedStep === 1, '第1步即失败');
  ok(r.data.steps[0].error.code === 'ISOLATION_VIOLATION', '错误码 ISOLATION_VIOLATION');
  ok(r.data.steps[0].violations[0].device_id === D1, '指出受影响许可 D1');
  ok(r.data.steps[0].violations[0].livePaths.length >= 1
    && JSON.stringify(r.data.steps[0].violations[0].livePaths).includes('2#备用电源'),
    '隔离失败附实际带电路径');
  ok(r.data.steps.slice(1).every((x) => x.skipped), '第2/3步均未执行');
  cur = await state();
  ok(cur.nodes.find((n) => n.id === K2).tagged === true, '真实状态: K2 仍挂牌');

  console.log('\n[O4] 结构校验: 许可步非末位 / 非法动作 / 目标不存在 / 空单');
  r = await preview([{ action: 'permit', device_id: D1 }, { action: 'open', node_id: K3 }]);
  ok(r.status === 400 && r.data.error.code === 'PERMIT_MUST_BE_LAST', '许可必须是末步');
  r = await preview([{ action: 'boom', node_id: K1 }]);
  ok(r.status === 400 && r.data.error.code === 'INVALID_ACTION', '非法动作 → 400');
  r = await preview([{ action: 'open', node_id: 9999 }]);
  ok(r.status === 404 && r.data.error.code === 'NOT_FOUND', '开关不存在 → 404');
  r = await preview([{ action: 'permit', device_id: K1 }]);
  ok(r.status === 404, '对开关申请许可 → 404');
  r = await preview([]);
  ok(r.status === 400 && r.data.error.code === 'STEPS_REQUIRED', '空操作单 → 400');
  r = await preview([{ action: 'open' }]);
  ok(r.status === 400 && r.data.error.code === 'NODE_REQUIRED', '缺 node_id → 400');

  console.log('\n[O5] 身份与角色: 预演/确认均需 operator; 缺 actor 拒绝');
  r = await call('POST', '/api/orders/preview', { ...ADMIN, revision: rev, steps: [{ action: 'open', node_id: K3 }] });
  ok(r.status === 403, '管理员预演 → 403');
  r = await call('POST', '/api/orders/confirm', { role: 'operator', revision: rev, steps: [{ action: 'open', node_id: K3 }] });
  ok(r.status === 400, '缺 actor → 400');
  r = await call('POST', '/api/orders/confirm', { ...ADMIN, revision: rev, steps: [{ action: 'open', node_id: K3 }] });
  ok(r.status === 403, '管理员确认 → 403');

  console.log('\n[O6] 确认失败: 末步许可未隔离 → 422 + 带电路径, 前序开关动作回滚, 整单不落库');
  // 先结束现有许可并解开 K2, 构造“前两步合规但末步必失败”的单子
  const permitId = (await state()).permits.find((p) => p.device_id === D1).id;
  r = await call('POST', `/api/permits/${permitId}/end`, { ...OP, revision: rev }); rev = r.data.revision;
  let auditsBefore = await auditCount();
  r = await confirm([
    { action: 'untag', node_id: K2 },          // K2 解牌(此时无有效许可, 允许)
    { action: 'permit', device_id: D1 }        // 立即申请: S2 仍来电 → 必失败
  ]);
  ok(r.status === 422, 'HTTP 422');
  ok(r.data.error.code === 'PERMIT_NOT_ISOLATED' && r.data.step === 2,
    `第 ${r.data.step} 步失败, 错误码 PERMIT_NOT_ISOLATED`);
  ok(r.data.step_name === '申请许可', '返回失败步骤动作名');
  ok(Array.isArray(r.data.livePaths) && r.data.livePaths.some((p) =>
    p.nodes.some((n) => n.name === '2#备用电源')), '附带实际带电路径');
  cur = await state();
  ok(cur.revision === rev, '修订号不变');
  ok(cur.nodes.find((n) => n.id === K2).tagged === true, '第1步解牌被回滚, K2 仍挂牌');
  ok(cur.permits.length === 0, '许可未创建');
  ok(await auditCount() === auditsBefore, '无审计落库');

  console.log('\n[O7] 确认成功: 原子落库, 修订号只 +1, 整单一条审计含前后快照');
  // K1、K2 当前挂牌且无有效许可; 编排真实可执行单:
  // 分闸 K3(合闸未挂牌→分闸) + 给 D2 申请许可(K1 挂牌已切断 D2 的唯一来源 S1-K1-D2)
  const validSteps = [
    { action: 'open', node_id: K3 },
    { action: 'permit', device_id: D2 }
  ];
  auditsBefore = await auditCount();
  r = await confirm(validSteps);
  ok(r.status === 200, 'HTTP 200 确认成功');
  ok(r.data.revision === rev + 1, `修订号仅 +1 (${rev} → ${r.data.revision})`);
  rev = r.data.revision;
  ok(r.data.steps.length === 2 && r.data.steps[1].permit_id, '返回每步紧凑结果, 许可步带 permit_id');
  cur = await state();
  ok(cur.nodes.find((n) => n.id === K3).open_pos === true, '第1步分闸落库');
  ok(cur.permits.some((p) => p.device_id === D2), '末步许可已创建');
  const logs = (await call('GET', '/api/audit?limit=500')).data.logs;
  ok(logs.length === auditsBefore + 1, '整单仅一条审计');
  const orderLog = logs.find((l) => l.action === 'order.confirm');
  ok(orderLog && orderLog.actor === OP.actor && orderLog.role === 'operator'
    && orderLog.rev_after === orderLog.rev_before + 1
    && Array.isArray(orderLog.detail.steps) && orderLog.detail.steps.length === 2
    && orderLog.state_before && orderLog.state_after,
    '审计含 actor/role/步骤清单/前后修订号/前后完整快照');
  ok(orderLog.state_before.nodes.find((n) => n.id === K3).open_pos === false
    && orderLog.state_after.nodes.find((n) => n.id === K3).open_pos === true,
    '快照反映整单前后网络状态');

  console.log('\n[O8] 确认: 状态机/隔离违规同样返回步骤序号与原因, 整单不落库');
  // D2 现有有效许可, K1 挂牌隔离着它; 对 K1 解牌必破坏隔离
  const before = await state();
  const revBefore = before.revision;
  r = await confirm([
    { action: 'untag', node_id: K1 },
    { action: 'close', node_id: K3 }
  ]);
  ok(r.status === 422 && r.data.step === 1
    && r.data.error.code === 'ISOLATION_VIOLATION'
    && r.data.violations[0].device_id === D2,
    '第1步解牌破坏 D2 许可隔离 → 422 + 步骤序号 + 带电路径');
  cur = await state();
  ok(cur.revision === revBefore && cur.nodes.find((n) => n.id === K1).tagged === true
    && cur.nodes.find((n) => n.id === K3).open_pos === true,
    '整单回滚: K1 仍挂牌, K3 仍分闸, 修订号不变');
  // 挂牌开关合闸
  r = await confirm([{ action: 'close', node_id: K1 }]);
  ok(r.status === 422 && r.data.step === 1 && r.data.error.code === 'SWITCH_TAGGED',
    '挂牌开关合闸 → 422 并给出步骤序号');

  console.log('\n[O9] STALE_REVISION: 预演后版本变化, 确认返回 409 + 当前完整状态');
  const newer = (await call('POST', `/api/switches/${K3}/close`, { ...OP, revision: rev })).data.revision;
  r = await confirm([{ action: 'open', node_id: K3 }], rev); // 过期修订号
  ok(r.status === 409 && r.data.error.code === 'STALE_REVISION', '409 STALE_REVISION');
  ok(r.data.current && r.data.current.revision === newer
    && Array.isArray(r.data.current.nodes) && Array.isArray(r.data.current.permits),
    '响应携带当前完整状态');
  rev = newer;

  console.log('\n[O10] 预演随当前版本: 预演结果带 revision; 预演不校验过期也不报错');
  r = await call('POST', '/api/orders/preview',
    { ...OP, revision: 1, steps: [{ action: 'open', node_id: K3 }] });
  ok(r.status === 200 && r.data.revision === rev, '预演忽略传入修订号, 返回当前版本');
  ok(r.data.steps[0].ok === true, '基于当前状态推演(K3 当前合闸, 分闸可行)');
  cur = await state();
  ok(cur.nodes.find((n) => n.id === K3).open_pos === false, 'K3 当前确为合闸');

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
