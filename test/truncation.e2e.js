'use strict';
// 通过真实 HTTP 接口验证“枚举触顶漏掉带电路径”的修复。
// 仅手动运行: 需在运行中的服务上执行, 会向当前库写入临时拓扑。
const BASE = process.env.BASE || 'http://127.0.0.1:3100';

async function call(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const r = await fetch(BASE + url, opts);
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const OP = { actor: '截断回归操作员', role: 'operator' };
const ADMIN = { actor: '截断回归管理员', role: 'admin' };

(async () => {
  let rev = (await call('GET', '/api/state')).data.revision;
  const M = (body) => ({ ...body, revision: rev });
  let pass = 0, fail = 0;
  const ok = (c, m) => { c ? (pass++, console.log('  ✔', m)) : (fail++, console.log('  ✘ FAIL:', m)); };

  console.log('[E1] 搭建: 1 个启用电源先接 201 个挂牌开关支路, 再接一条未挂牌支路到设备');
  const src = (await call('POST', '/api/admin/nodes', M({ ...ADMIN, kind: 'source', name: '截断回归电源' })));
  rev = src.data.revision;
  const dev = (await call('POST', '/api/admin/nodes', M({ ...ADMIN, kind: 'device', name: '截断回归设备' })));
  rev = dev.data.revision;
  const srcId = src.data.snapshot.nodes.find((n) => n.name === '截断回归电源').id;
  const devId = dev.data.snapshot.nodes.find((n) => n.name === '截断回归设备').id;

  for (let i = 0; i < 201; i++) {
    const s = await call('POST', '/api/admin/nodes', M({ ...ADMIN, kind: 'switch', name: `截回归挂牌T${i}` }));
    rev = s.data.revision;
    const swId = s.data.snapshot.nodes.find((n) => n.name === `截回归挂牌T${i}`).id;
    // 先分闸再挂牌
    rev = (await call('POST', `/api/switches/${swId}/open`, M(OP))).data.revision;
    rev = (await call('POST', `/api/switches/${swId}/tag`, M(OP))).data.revision;
    rev = (await call('POST', '/api/admin/edges', M({ ...ADMIN, from_node: srcId, to_node: swId }))).data.revision;
  }
  const bus = await call('POST', '/api/admin/nodes', M({ ...ADMIN, kind: 'switch', name: '截回归母线开关' }));
  rev = bus.data.revision;
  const busId = bus.data.snapshot.nodes.find((n) => n.name === '截回归母线开关').id;
  rev = (await call('POST', '/api/admin/edges', M({ ...ADMIN, from_node: srcId, to_node: busId }))).data.revision;
  rev = (await call('POST', '/api/admin/edges', M({ ...ADMIN, from_node: busId, to_node: devId }))).data.revision;

  console.log('[E2] 申请许可: 旧实现 blocked 前 200 条触顶 → 误生效; 修复后必须拒绝');
  let r = await call('POST', '/api/permits', M({ ...OP, device_id: devId }));
  ok(r.status === 422, `HTTP 422(得到 ${r.status})`);
  ok(r.data.error.code === 'PERMIT_NOT_ISOLATED', 'PERMIT_NOT_ISOLATED');
  ok(Array.isArray(r.data.livePaths) && r.data.livePaths.length >= 1,
    `拒绝携带至少 1 条实际带电路径(${r.data?.livePaths?.length ?? 0})`);
  ok(JSON.stringify(r.data.livePaths || []).includes('截回归母线开关'), '带电路径经过未挂牌母线开关');
  ok(r.data.truncated && r.data.truncated.blocked && r.data.truncated.blocked.countLimited === true,
    '响应标记 blocked 数量截断');
  ok(r.data.truncated.live.countLimited === false, 'live 未被 blocked 挤占');

  console.log('[E3] 诊断接口 /api/devices/:id/paths 携带截断标记且结论正确');
  const diag = await call('GET', `/api/devices/${devId}/paths`);
  ok(diag.status === 200 && diag.data.isolated === false, '诊断接口判定未隔离');
  ok(diag.data.truncated.blocked.countLimited === true, '诊断接口标记 blocked 截断');

  console.log('[E4] 挂牌母线开关后隔离成立 → 许可生效; 再解牌触顶场景下仍被整体拒绝');
  rev = (await call('POST', `/api/switches/${busId}/open`, M(OP))).data.revision;
  rev = (await call('POST', `/api/switches/${busId}/tag`, M(OP))).data.revision;
  r = await call('POST', '/api/permits', M({ ...OP, device_id: devId }));
  ok(r.status === 200, `许可生效 #${r.data?.permit_id}`);
  rev = r.data.revision;
  r = await call('POST', `/api/switches/${busId}/untag`, M(OP));
  ok(r.status === 422 && r.data.error.code === 'ISOLATION_VIOLATION',
    '有效许可期间解牌被拒绝(枚举触顶也不能放过)');
  ok(r.data.violations[0].livePaths.length >= 1, '拒绝携带真实重新来电路径');
  ok(r.data.violations[0].truncated.blocked.countLimited === true, '拒绝携带截断标记');
  rev = (await call('GET', '/api/state')).data.revision; // 解牌被回滚, 修订号不变

  console.log('[E5] 清理: 结束许可并删除临时节点');
  const permitId = (await call('GET', '/api/state')).data.permits.find((p) => p.device_id === devId).id;
  rev = (await call('POST', `/api/permits/${permitId}/end`, M(OP))).data.revision;
  // 设备在许可结束后可删; 删除设备/电源会级联删除边, 其余节点逐个删除
  rev = (await call('DELETE', `/api/admin/nodes/${devId}`, M(ADMIN))).data.revision;
  rev = (await call('DELETE', `/api/admin/nodes/${srcId}`, M(ADMIN))).data.revision;
  for (let i = 0; i < 201; i++) {
    const st = await call('GET', '/api/state');
    const n = st.data.nodes.find((x) => x.name === `截回归挂牌T${i}`);
    if (!n) continue;
    rev = (await call('DELETE', `/api/admin/nodes/${n.id}`, M(ADMIN))).data.revision;
  }
  const busLeft = (await call('GET', '/api/state')).data.nodes.find((x) => x.name === '截回归母线开关');
  if (busLeft) rev = (await call('DELETE', `/api/admin/nodes/${busLeft.id}`, M(ADMIN))).data.revision;
  const left = (await call('GET', '/api/state')).data.nodes.some((n) => n.name.startsWith('截回归'));
  ok(!left, '临时拓扑已清理');

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
