'use strict';
// 临时操作单端到端回归: 预演不落地 / 确认原子执行 / 逐步状态机与隔离保护 /
// 失败回滚并返回步骤序号与带电路径 / 修订号只 +1 / 审计整单快照 / STALE_REVISION。
// 运行前: LOTO_DB=/tmp/loto-order-test.db PORT=3100 node server.js  (需全新演示库)
const BASE = 'http://127.0.0.1:3100';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✔', msg); }
  else { fail++; console.log('  ✘ FAIL:', msg); }
}

async function call(method, url, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

const OP = { actor: '操作员甲', role: 'operator' };
const ADMIN = { actor: '管理员乙', role: 'admin' };
// 演示网络固定 id: S1=1 S2=2 K1=3 K2=4 K3=5 D1=6 D2=7
const K1 = 3, K2 = 4, K3 = 5, D1 = 6;

const FULL_ORDER = [
  { action: 'open', switch_id: K1 },
  { action: 'tag', switch_id: K1 },
  { action: 'open', switch_id: K2 },
  { action: 'tag', switch_id: K2 },
  { action: 'permit', device_id: D1 }
];

(async () => {
  let { data: s } = await call('GET', '/api/state');
  let rev = s.revision;
  console.log('初始修订号:', rev);

  console.log('\n[1] 预演: 展示各步结果与目标设备隔离状态, 不落地');
  let r = await call('POST', '/api/orders/preview', { ...OP, revision: rev, steps: FULL_ORDER });
  ok(r.status === 200 && r.data.ok && r.data.preview === true, '预演 HTTP 200');
  ok(r.data.allOk === true && r.data.steps.length === 5, '5 步全部可执行');
  ok(r.data.steps.every((x) => x.ok), '每步结果均为成功');
  ok(r.data.steps[4].action === 'permit' && r.data.steps[4].permit_id >= 1,
    '末步为申请许可并给出临时许可号');
  ok(r.data.isolation && r.data.isolation.device_id === D1 && r.data.isolation.isolated === true,
    '展示目标设备隔离状态: 已隔离');
  ok(Array.isArray(r.data.isolation.blockedPaths) && r.data.isolation.blockedPaths.length >= 2,
    '列出被挂牌切断的供电路径(两个电源)');
  let after = await call('GET', '/api/state');
  ok(after.data.revision === rev, '预演后修订号不变');
  ok(after.data.permits.length === 0, '预演不产生许可');
  ok(after.data.nodes.find((n) => n.id === K1).tagged === false
    && after.data.nodes.find((n) => n.id === K1).open_pos === false,
    '预演不改变开关真实状态');
  let audit = await call('GET', '/api/audit?limit=500');
  ok(audit.data.logs.length === 0, '预演不写审计');

  console.log('\n[2] 预演: 首步即违规(未分闸挂牌) → 指出失败步与原因');
  r = await call('POST', '/api/orders/preview', { ...OP, revision: rev, steps: [{ action: 'tag', switch_id: K3 }] });
  ok(r.status === 200 && r.data.allOk === false, '预演不通过');
  ok(r.data.failedStep === 1 && r.data.steps[0].ok === false
    && r.data.steps[0].error.code === 'SWITCH_NOT_OPEN', '第 1 步失败原因 SWITCH_NOT_OPEN');

  console.log('\n[3] 预演: 中途违规(许可申请时仍带电) → 失败步附实际带电路径');
  r = await call('POST', '/api/orders/preview', {
    ...OP, revision: rev,
    steps: [{ action: 'open', switch_id: K1 }, { action: 'tag', switch_id: K1 }, { action: 'permit', device_id: D1 }]
  });
  ok(r.data.allOk === false && r.data.failedStep === 3, '第 3 步(申请许可)失败');
  const failedEntry = r.data.steps[2];
  ok(failedEntry.error.code === 'PERMIT_NOT_ISOLATED', '原因 PERMIT_NOT_ISOLATED');
  ok(Array.isArray(failedEntry.livePaths) && failedEntry.livePaths.length >= 1
    && failedEntry.livePaths[0].nodes[0].name === '2#备用电源',
    '附实际带电路径(2#备用电源 → …)');
  after = await call('GET', '/api/state');
  ok(after.data.revision === rev && after.data.nodes.find((n) => n.id === K1).tagged === false,
    '失败预演同样不落地');

  console.log('\n[4] 确认: 原子执行成功, 修订号只 +1, 审计记整单前后快照');
  r = await call('POST', '/api/orders/commit', { ...OP, revision: rev, steps: FULL_ORDER });
  ok(r.status === 200 && r.data.ok && r.data.action === 'order.commit', '确认 HTTP 200');
  ok(r.data.revision === rev + 1, `修订号 ${rev} → ${r.data.revision}(只 +1)`);
  ok(r.data.permit_id >= 1 && r.data.steps.length === 5, '返回各步结果与许可号');
  ok(r.data.snapshot.permits.some((p) => p.device_id === D1), '许可已生效');
  ok(r.data.snapshot.nodes.find((n) => n.id === K1).tagged === true
    && r.data.snapshot.nodes.find((n) => n.id === K2).tagged === true, 'K1/K2 已挂牌');
  rev = r.data.revision;
  audit = await call('GET', '/api/audit?limit=500');
  const orderLogs = audit.data.logs.filter((l) => l.action === 'order.commit');
  ok(orderLogs.length === 1, '整单只记一条审计(order.commit)');
  const log = orderLogs[0];
  ok(log.actor === OP.actor && log.role === 'operator', '审计记录操作者与角色');
  ok(log.rev_after === log.rev_before + 1, '审计前后修订号连续');
  ok(Array.isArray(log.detail.steps) && log.detail.steps.length === 5, '审计 detail 含 5 个步骤');
  ok(log.state_before && log.state_after
    && log.state_before.nodes.find((n) => n.id === K1).tagged === false
    && log.state_after.nodes.find((n) => n.id === K1).tagged === true,
    '审计含整单前后完整快照');

  console.log('\n[5] 许可存续期: “解牌→重新挂牌”补救序列 → 第 1 步即拒绝, 整单回滚');
  r = await call('POST', '/api/orders/commit', {
    ...OP, revision: rev,
    steps: [{ action: 'untag', switch_id: K2 }, { action: 'tag', switch_id: K2 }]
  });
  ok(r.status === 422 && r.data.error.code === 'ORDER_STEP_FAILED', 'HTTP 422 ORDER_STEP_FAILED');
  ok(r.data.step === 1 && r.data.cause.code === 'ISOLATION_VIOLATION',
    '第 1 步即因隔离保护被拒(不允许后续步骤补救)');
  ok(Array.isArray(r.data.violations) && r.data.violations[0].device_id === D1
    && r.data.violations[0].livePaths.length >= 1, '附受影响许可与重新来电路径');
  after = await call('GET', '/api/state');
  ok(after.data.revision === rev
    && after.data.nodes.find((n) => n.id === K2).tagged === true, '整单回滚: K2 仍挂牌, 修订号不变');

  console.log('\n[6] 中途失败: 前几步也不落库');
  r = await call('POST', '/api/orders/commit', {
    ...OP, revision: rev,
    steps: [{ action: 'open', switch_id: K3 }, { action: 'untag', switch_id: K1 }]
  });
  ok(r.status === 422 && r.data.step === 2 && r.data.cause.code === 'ISOLATION_VIOLATION',
    '第 2 步(解牌 K1)破坏许可隔离被拒');
  after = await call('GET', '/api/state');
  ok(after.data.nodes.find((n) => n.id === K3).open_pos === false,
    '第 1 步(K3 分闸)随整单回滚, K3 仍合闸');
  ok(after.data.revision === rev, '修订号不变');

  console.log('\n[7] 结束许可后: 解牌+合闸混合序列一次确认');
  const permitId = after.data.permits.find((p) => p.device_id === D1).id;
  r = await call('POST', `/api/permits/${permitId}/end`, { ...OP, revision: rev });
  ok(r.status === 200, '结束许可成功'); rev = r.data.revision;
  r = await call('POST', '/api/orders/commit', {
    ...OP, revision: rev,
    steps: [
      { action: 'untag', switch_id: K1 },
      { action: 'untag', switch_id: K2 },
      { action: 'close', switch_id: K1 },
      { action: 'close', switch_id: K2 }
    ]
  });
  ok(r.status === 200 && r.data.revision === rev + 1, '4 步混合序列成功, 修订号只 +1');
  ok(r.data.snapshot.nodes.every((n) => n.kind !== 'switch' || (!n.tagged && !n.open_pos)),
    '全部开关恢复合闸未挂牌');
  rev = r.data.revision;

  console.log('\n[8] 确认: 末步申请许可时仍带电 → 整单失败附带电路径');
  r = await call('POST', '/api/orders/commit', {
    ...OP, revision: rev,
    steps: [{ action: 'open', switch_id: K1 }, { action: 'permit', device_id: D1 }]
  });
  ok(r.status === 422 && r.data.step === 2 && r.data.cause.code === 'PERMIT_NOT_ISOLATED',
    '第 2 步许可申请失败');
  ok(Array.isArray(r.data.livePaths) && r.data.livePaths.length >= 1, '响应附实际带电路径');
  after = await call('GET', '/api/state');
  ok(after.data.nodes.find((n) => n.id === K1).open_pos === false
    && after.data.permits.length === 0 && after.data.revision === rev,
    '整单回滚: K1 仍合闸, 无许可, 修订号不变');

  console.log('\n[9] 乐观锁: 预演后版本变化, 确认返回 409 + 当前完整状态');
  r = await call('POST', '/api/orders/preview', { ...OP, revision: rev, steps: [{ action: 'open', switch_id: K1 }] });
  ok(r.status === 200 && r.data.allOk === true, '基于当前版本预演通过');
  let other = await call('POST', `/api/switches/${K3}/open`, { ...OP, revision: rev });
  ok(other.status === 200, '他人(另一会话)提交变更');
  r = await call('POST', '/api/orders/commit', { ...OP, revision: rev, steps: [{ action: 'open', switch_id: K1 }] });
  ok(r.status === 409 && r.data.error.code === 'STALE_REVISION', '过期确认 → 409 STALE_REVISION');
  ok(r.data.current && r.data.current.revision === other.data.revision
    && Array.isArray(r.data.current.nodes), '响应携带当前完整状态');
  after = await call('GET', '/api/state');
  ok(after.data.nodes.find((n) => n.id === K1).open_pos === false, '过期操作单未落库');
  rev = after.data.revision;
  r = await call('POST', '/api/orders/preview', { ...OP, revision: rev - 1, steps: [{ action: 'open', switch_id: K1 }] });
  ok(r.status === 409 && r.data.current && r.data.current.revision === rev,
    '过期预演同样返回 409 + 当前状态');
  // 恢复现场: K3 合闸
  r = await call('POST', `/api/switches/${K3}/close`, { ...OP, revision: rev });
  rev = r.data.revision;

  console.log('\n[10] 角色与参数校验');
  r = await call('POST', '/api/orders/commit', { ...ADMIN, revision: rev, steps: [{ action: 'open', switch_id: K1 }] });
  ok(r.status === 403, '管理员执行操作单 → 403');
  r = await call('POST', '/api/orders/preview', { ...ADMIN, revision: rev, steps: [{ action: 'open', switch_id: K1 }] });
  ok(r.status === 403, '管理员预演操作单 → 403');
  r = await call('POST', '/api/orders/commit', { ...OP, revision: rev, steps: [] });
  ok(r.status === 400 && r.data.error.code === 'STEPS_REQUIRED', '空操作单 → 400');
  r = await call('POST', '/api/orders/commit', { ...OP, revision: rev, steps: [{ action: 'permit', device_id: D1 }, { action: 'open', switch_id: K1 }] });
  ok(r.status === 400 && r.data.error.code === 'PERMIT_NOT_LAST', '许可步不在末位 → 400');
  r = await call('POST', '/api/orders/commit', { ...OP, revision: rev, steps: [{ action: 'bogus', switch_id: K1 }] });
  ok(r.status === 400 && r.data.error.code === 'INVALID_ACTION', '未知动作 → 400');
  r = await call('POST', '/api/orders/commit', { ...OP, revision: rev, steps: [{ action: 'open' }] });
  ok(r.status === 400 && r.data.error.code === 'SWITCH_REQUIRED', '缺开关编号 → 400');
  r = await call('POST', '/api/orders/commit', { role: 'operator', revision: rev, steps: [{ action: 'open', switch_id: K1 }] });
  ok(r.status === 400, '缺 actor → 400');
  r = await call('POST', '/api/orders/commit', { ...OP, steps: [{ action: 'open', switch_id: K1 }] });
  ok(r.status === 400, '缺 revision → 400');

  console.log('\n[11] 操作单中的状态机错误与不存在节点');
  r = await call('POST', '/api/orders/commit', { ...OP, revision: rev, steps: [{ action: 'close', switch_id: K1 }] });
  ok(r.status === 422 && r.data.step === 1 && r.data.cause.code === 'INVALID_STATE',
    '合闸中的开关再合闸 → 第 1 步 INVALID_STATE');
  r = await call('POST', '/api/orders/commit', { ...OP, revision: rev, steps: [{ action: 'open', switch_id: 9999 }] });
  ok(r.status === 404 && r.data.step === 1 && r.data.cause.code === 'NOT_FOUND',
    '开关不存在 → 404 并指出步骤序号');
  after = await call('GET', '/api/state');
  ok(after.data.revision === rev, '上述失败均未改变修订号');

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
