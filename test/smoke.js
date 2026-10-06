'use strict';
// 端到端业务规则冒烟测试
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

const OP = { actor: '测试操作员甲', role: 'operator' };
const ADMIN = { actor: '测试管理员乙', role: 'admin' };

(async () => {
  let { data: s } = await call('GET', '/api/state');
  let rev = s.revision;
  console.log('初始修订号:', rev);
  const K1 = 3, K2 = 4, K3 = 5, D1 = 6, D2 = 7, S2 = 2;

  console.log('\n[1] 未挂牌直接申请许可 → 失败并给出未切断路径');
  let r = await call('POST', '/api/permits', { ...OP, revision: rev, device_id: D1 });
  ok(r.status === 422, 'HTTP 422');
  ok(r.data.error.code === 'PERMIT_NOT_ISOLATED', '错误码 PERMIT_NOT_ISOLATED');
  ok(Array.isArray(r.data.livePaths) && r.data.livePaths.length >= 2,
    `列出 ${r.data?.livePaths?.length} 条未切断路径(应>=2, 两个启用电源)`);
  ok(JSON.stringify(r.data).includes('1#主电源') && JSON.stringify(r.data).includes('2#备用电源'),
    '路径中包含两个启用电源');

  console.log('\n[2] 开关未分闸直接挂牌 → 拒绝; 挂牌后禁止合闸');
  r = await call('POST', `/api/switches/${K1}/tag`, { ...OP, revision: rev });
  ok(r.status === 422 && r.data.error.code === 'SWITCH_NOT_OPEN', '未分闸挂牌被拒绝');
  r = await call('POST', `/api/switches/${K1}/open`, { ...OP, revision: rev });
  ok(r.status === 200, 'K1 分闸成功'); rev = r.data.revision;
  r = await call('POST', `/api/switches/${K1}/tag`, { ...OP, revision: rev });
  ok(r.status === 200, 'K1 挂牌成功'); rev = r.data.revision;
  r = await call('POST', `/api/switches/${K1}/close`, { ...OP, revision: rev });
  ok(r.status === 422 && r.data.error.code === 'SWITCH_TAGGED', '挂牌开关合闸被拒绝');

  console.log('\n[3] 仅切断 S1, S2 路径仍通电 → 申请仍失败');
  r = await call('POST', '/api/permits', { ...OP, revision: rev, device_id: D1 });
  ok(r.status === 422, '再次被拒绝');
  const remaining = r.data.livePaths || [];
  ok(remaining.length === 1 && remaining[0].nodes[0].name === '2#备用电源',
    '仅剩 2#备用电源 的一条路径');

  console.log('\n[4] 切断 S2 路径(K2分闸+挂牌)后申请 → 生效');
  r = await call('POST', `/api/switches/${K2}/open`, { ...OP, revision: rev });
  rev = r.data.revision;
  r = await call('POST', `/api/switches/${K2}/tag`, { ...OP, revision: rev });
  rev = r.data.revision;
  r = await call('POST', '/api/permits', { ...OP, revision: rev, device_id: D1 });
  ok(r.status === 200, `许可 #${r.data.permit_id} 生效`); rev = r.data.revision;

  console.log('\n[5] 许可有效期: 解牌 / 启用电源 / 改线路破坏隔离 → 整体拒绝, 状态不变');
  r = await call('POST', `/api/switches/${K2}/untag`, { ...OP, revision: rev });
  ok(r.status === 422 && r.data.error.code === 'ISOLATION_VIOLATION', '解牌被拒绝');
  ok(r.data.violations[0].device_id === D1 && r.data.violations[0].livePaths.length === 1,
    '指出受影响许可及重新来电的路径');
  r = await call('GET', '/api/state');
  const k2still = r.data.nodes.find((n) => n.id === K2);
  ok(k2still.tagged === true, 'K2 仍为挂牌状态(操作被回滚)');
  ok(r.data.revision === rev, '修订号不变');

  // 管理员新增旁路 K3->D1? K3已存在到D1。改为: 新增一个新电源和接线绕过挂牌点
  let a = await call('POST', '/api/admin/nodes', { ...ADMIN, revision: rev, kind: 'source', name: '3#应急电源' });
  ok(a.status === 200, '管理员新增 3#应急电源'); rev = a.data.revision;
  const S3 = a.data.snapshot.nodes.find((n) => n.name === '3#应急电源').id;
  a = await call('POST', '/api/admin/edges', { ...ADMIN, revision: rev, from_node: S3, to_node: D1 });
  ok(a.status === 422 && a.data.error.code === 'ISOLATION_VIOLATION',
    '管理员架设绕过挂牌点的旁路 → 拒绝');
  a = await call('GET', '/api/state');
  ok(a.data.edges.every((e) => e.from_node !== S3), '旁路接线未写入');
  ok(a.data.revision === rev, '修订号仍不变');

  // 停用电源(只减少通路)允许; 随后再启用会使被挂牌点旁路贯通 → 拒绝
  a = await call('POST', '/api/admin/nodes', { ...ADMIN, revision: rev, kind: 'source', name: '4#临时电源' });
  ok(a.status === 200, '管理员新增 4#临时电源(默认启用, 暂无接线)'); rev = a.data.revision;
  const S4 = a.data.snapshot.nodes.find((n) => n.name === '4#临时电源').id;
  a = await call('PATCH', `/api/admin/nodes/${S4}`, { ...ADMIN, revision: rev, enabled: false });
  ok(a.status === 200, '停用未接线电源成功'); rev = a.data.revision;
  a = await call('POST', '/api/admin/edges', { ...ADMIN, revision: rev, from_node: S4, to_node: K3 });
  ok(a.status === 200, '停用电源接至 K3(不形成通电回路, 允许)'); rev = a.data.revision;
  a = await call('PATCH', `/api/admin/nodes/${S4}`, { ...ADMIN, revision: rev, enabled: true });
  ok(a.status === 422 && a.data.error.code === 'ISOLATION_VIOLATION',
    '启用该电源将绕过挂牌点恢复供电 → 拒绝');
  a = await call('GET', '/api/state');
  ok(a.data.nodes.find((n) => n.id === S4).enabled === false, '电源仍为停用(操作回滚)');
  ok(a.data.revision === rev, '修订号不变');

  console.log('\n[6] 乐观并发: 过期修订号 → 409 + 当前状态, 且不改变状态');
  a = await call('POST', `/api/switches/${K3}/open`, { ...OP, revision: rev });
  ok(a.status === 200, '甲以最新修订号分闸 K3 成功'); const newer = a.data.revision;
  r = await call('POST', `/api/switches/${K3}/tag`, { ...OP, revision: rev });
  ok(r.status === 409 && r.data.error.code === 'STALE_REVISION', '过期提交返回 409');
  ok(r.data.current && r.data.current.revision === newer, '响应携带当前状态及最新修订号');
  r = await call('GET', '/api/state');
  ok(r.data.revision === newer && r.data.nodes.find((n) => n.id === K3).tagged === false,
    '过期提交未落库, K3 仅分闸未挂牌');
  rev = newer;

  console.log('\n[7] 角色控制: 操作员不能改拓扑; 管理员不能挂牌');
  r = await call('POST', '/api/admin/nodes', { ...OP, revision: rev, kind: 'device', name: 'X' });
  ok(r.status === 403, '操作员新增节点 → 403');
  r = await call('POST', `/api/switches/${K3}/tag`, { ...ADMIN, revision: rev });
  ok(r.status === 403, '管理员挂牌 → 403');
  r = await call('POST', '/api/permits', { ...ADMIN, revision: rev, device_id: D2 });
  ok(r.status === 403, '管理员申请许可 → 403');

  console.log('\n[8] 输入校验: 缺少操作者/修订号');
  r = await call('POST', `/api/switches/${K3}/tag`, { role: 'operator', revision: rev });
  ok(r.status === 400, '缺少 actor → 400');
  r = await call('POST', `/api/switches/${K3}/tag`, { ...OP });
  ok(r.status === 400, '缺少 revision → 400');

  console.log('\n[9] 拓扑规则: 设备不能出线、电源不能入线、自环/重复拒绝');
  r = await call('POST', '/api/admin/edges', { ...ADMIN, revision: rev, from_node: D1, to_node: K3 });
  ok(r.status === 400, '设备作为起点 → 400');
  r = await call('POST', '/api/admin/edges', { ...ADMIN, revision: rev, from_node: K3, to_node: 1 });
  ok(r.status === 400, '电源作为终点 → 400');
  r = await call('POST', '/api/admin/edges', { ...ADMIN, revision: rev, from_node: K3, to_node: K3 });
  ok(r.status === 400, '自环 → 400');
  r = await call('POST', '/api/admin/edges', { ...ADMIN, revision: rev, from_node: K3, to_node: D1 });
  ok(r.status === 400, '重复边 → 400');

  console.log('\n[10] 同设备重复许可、对有许可设备删除节点');
  r = await call('POST', '/api/permits', { ...OP, revision: rev, device_id: D1 });
  ok(r.status === 422 && r.data.error.code === 'PERMIT_EXISTS', '重复申请 → 422');
  r = await call('DELETE', `/api/admin/nodes/${D1}`, { ...ADMIN, revision: rev });
  ok(r.status === 422 && r.data.error.code === 'DEVICE_HAS_ACTIVE_PERMIT', '删除有许可的设备 → 422');

  console.log('\n[11] 结束许可后, 隔离保护解除: K2 可解牌, 许可变为 ended');
  const permitId = (await call('GET', '/api/state')).data.permits.find((p) => p.device_id === D1).id;
  r = await call('POST', `/api/permits/${permitId}/end`, { ...OP, revision: rev });
  ok(r.status === 200, '结束许可成功'); rev = r.data.revision;
  ok(!r.data.snapshot.permits.some((p) => p.id === permitId), '许可已移出有效列表');
  r = await call('POST', `/api/switches/${K2}/untag`, { ...OP, revision: rev });
  ok(r.status === 200, '许可结束后 K2 解牌成功'); rev = r.data.revision;

  console.log('\n[12] 审计日志: 时间/操作者/动作/前后修订号/前后快照');
  const audit = await call('GET', '/api/audit?limit=50');
  ok(audit.data.logs.length >= 6, `记录 ${audit.data.logs.length} 条成功变更`);
  const tagLog = audit.data.logs.find((l) => l.action === 'switch.tag');
  ok(tagLog && tagLog.actor === '测试操作员甲' && tagLog.role === 'operator'
    && tagLog.state_before && tagLog.state_after
    && tagLog.rev_after === tagLog.rev_before + 1,
    '挂牌日志含操作者、角色、前后快照与连续修订号');
  const beforeTagged = tagLog.state_before.nodes.find((n) => n.id === K2 || n.id === K1);
  ok(beforeTagged !== undefined, '快照结构完整');

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
