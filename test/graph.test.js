'use strict';

// src/graph.js 的隔离判定单元测试(不走 HTTP), 重点验证:
// 数量/长度上限只截断诊断展示, 绝不能把“枚举未知”当作“已隔离”。
// 运行: node test/graph.test.js

const assert = require('assert');
const {
  evaluateIsolation,
  validateActivePermits,
  findReachableTarget,
  MAX_LIVE_PATHS,
  MAX_BLOCKED_PATHS,
  MAX_PATH_LEN
} = require('../src/graph');

let pass = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  pass++;
  console.log('  ✔', msg);
}
function eq(a, b, msg) {
  assert.strictEqual(a, b, `${msg} (期望 ${b}, 实际 ${a})`);
  pass++;
  console.log('  ✔', msg);
}

// 构建 graph.js 期望的图结构。spec:
//   nodes: [[id, kind, {enabled?, tagged?}], ...]
//   edges: [[id, from, to], ...]  (outAdj 按插入顺序, 测试依赖该顺序)
function buildGraph(nodeSpecs, edgeSpecs) {
  const nodes = nodeSpecs.map(([id, kind, extra = {}]) => ({
    id, kind, name: `N${id}`,
    enabled: extra.enabled !== undefined ? !!extra.enabled : true,
    open_pos: false,
    tagged: !!extra.tagged
  }));
  const edges = edgeSpecs.map(([id, from, to]) => ({
    id, from, to, from_node: from, to_node: to
  }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const outAdj = new Map();
  for (const e of edges) {
    if (!outAdj.has(e.from_node)) outAdj.set(e.from_node, []);
    outAdj.get(e.from_node).push(e);
  }
  return { nodes, edges, nodeById, outAdj };
}

console.log('\n[T1] 存在未挂牌通路 → 未隔离, 给出带电路径');
{
  const g = buildGraph(
    [[1, 'source'], [2, 'switch'], [3, 'device']],
    [[1, 1, 2], [2, 2, 3]]
  );
  const r = evaluateIsolation(g, 3);
  eq(r.isolated, false, '判定为未隔离');
  eq(r.livePaths.length, 1, '1 条带电路径');
  eq(r.livePaths[0].nodes.join(','), '1,2,3', '路径节点链正确');
  eq(r.truncated.live.countLimited, false, '未触发数量截断');
}

console.log('\n[T2] 所有通路均被挂牌切断 → 已隔离, blocked 路径被记录');
{
  const g = buildGraph(
    [[1, 'source'], [2, 'switch', { tagged: true }], [3, 'device'],
     [4, 'source'], [5, 'switch', { tagged: true }]],
    [[1, 1, 2], [2, 2, 3], [3, 4, 5], [4, 5, 3]]
  );
  const r = evaluateIsolation(g, 3);
  eq(r.isolated, true, '判定为已隔离');
  eq(r.livePaths.length, 0, '无带电路径');
  eq(r.blockedPaths.length, 2, '记录 2 条被挂牌切断的路径');
  const reach = findReachableTarget(g, 3);
  eq(reach.reachable, false, '完整可达性分析同样不可达');
}

console.log('\n[T3] 无启用电源 → 视为已隔离, 可申请');
{
  const g = buildGraph(
    [[1, 'source', { enabled: false }], [2, 'switch'], [3, 'device']],
    [[1, 1, 2], [2, 2, 3]]
  );
  const r = evaluateIsolation(g, 3);
  eq(r.isolated, true, '无启用电源时已隔离');
  eq(r.livePaths.length, 0, '无带电路径');
}

console.log('\n[T4] 回归: 同一启用电源先枚举到 >=200 条“挂牌截断”支路, 其后仍有带电路径');
{
  // 旧实现把 blocked 与 live 混在一个 200 上限的列表里: 前 200 条全部在挂牌
  // 开关处截断后触顶返回, 真正到达设备的路径被漏掉 → 误判隔离、误生效。
  const BLOCKED = MAX_BLOCKED_PATHS + 1; // 201 个挂牌支路
  const nodeSpecs = [[1, 'source'], [1000, 'device']];
  const edgeSpecs = [];
  for (let i = 0; i < BLOCKED; i++) {
    const sw = 100 + i;
    nodeSpecs.push([sw, 'switch', { tagged: true }]);
    edgeSpecs.push([i + 1, 1, sw]); // blocked 边排在最前
  }
  nodeSpecs.push([900, 'switch']); // 未挂牌开关 → 设备
  edgeSpecs.push([BLOCKED + 1, 1, 900]);
  edgeSpecs.push([BLOCKED + 2, 900, 1000]);
  const g = buildGraph(nodeSpecs, edgeSpecs);

  const r = evaluateIsolation(g, 1000);
  eq(r.isolated, false, '即使 blocked 列表触顶, 仍正确判定为未隔离(核心回归)');
  ok(r.livePaths.length >= 1, `至少给出 1 条实际带电路径(实际 ${r.livePaths.length})`);
  const witness = r.livePaths.find((p) => p.nodes[p.nodes.length - 1] === 1000);
  ok(witness, '带电路径真实到达设备');
  eq(r.truncated.blocked.countLimited, true, 'blocked 诊断列表标记数量截断');
  eq(r.truncated.live.countLimited, false, 'live 列表不受 blocked 挤占');
}

console.log('\n[T5] 回归: 带电路径长于展示长度上限(64 节点) → 仍未隔离并给出见证路径');
{
  const MIDDLE = 64; // 电源 + 64 个中间开关 + 设备 = 66 节点, 超过 MAX_PATH_LEN=64
  const nodeSpecs = [[1, 'source'], [1000, 'device']];
  for (let i = 0; i < MIDDLE; i++) nodeSpecs.push([100 + i, 'switch']);
  const edgeSpecs = [[1, 1, 100]];
  for (let i = 0; i < MIDDLE - 1; i++) edgeSpecs.push([i + 2, 100 + i, 100 + i + 1]);
  edgeSpecs.push([MIDDLE + 1, 100 + MIDDLE - 1, 1000]);
  const g = buildGraph(nodeSpecs, edgeSpecs);

  const r = evaluateIsolation(g, 1000);
  eq(r.isolated, false, '长路径超展示上限也不能误判隔离');
  ok(r.livePaths.length >= 1, '补充了 BFS 见证带电路径');
  eq(r.livePaths[0].nodes.length, MIDDLE + 2, '见证路径完整(66 节点, 可超过展示上限)');
  eq(r.truncated.live.lengthLimited, true, 'live 诊断枚举标记长度截断');
}

console.log('\n[T6] 含环图: 枚举终止且不重复; 环后可达设备仍被正确识别');
{
  const g = buildGraph(
    [[1, 'source'], [2, 'switch'], [3, 'switch'], [4, 'device']],
    [[1, 1, 2], [2, 2, 3], [3, 3, 2], [4, 2, 4]] // 2↔3 成环, 2→4
  );
  const reach = findReachableTarget(g, 4);
  eq(reach.reachable, true, 'BFS 穿过环路区域到达设备');
  const r = evaluateIsolation(g, 4);
  eq(r.isolated, false, '未隔离');
  ok(r.livePaths.every((p) => new Set(p.nodes).size === p.nodes.length),
    '枚举路径无重复节点');
}

console.log('\n[T7] 带电路径数量超上限(200) → 标记数量截断, 结论仍正确且至少 1 条');
{
  // 5 层每层 3 个开关, 层间全连接: 3^5 = 243 条到设备的简单路径
  const nodeSpecs = [[1, 'source'], [1000, 'device']];
  for (let layer = 0; layer < 5; layer++) {
    for (let j = 0; j < 3; j++) nodeSpecs.push([10 + layer * 10 + j, 'switch']);
  }
  const edgeSpecs = [];
  let eid = 1;
  const layerIds = (l) => (l < 0 ? [1] : [0, 1, 2].map((j) => 10 + l * 10 + j));
  for (let layer = 0; layer < 5; layer++) {
    for (const a of layerIds(layer - 1)) for (const b of layerIds(layer)) edgeSpecs.push([eid++, a, b]);
  }
  for (const a of layerIds(4)) edgeSpecs.push([eid++, a, 1000]);
  const g = buildGraph(nodeSpecs, edgeSpecs);

  const r = evaluateIsolation(g, 1000);
  eq(r.isolated, false, '243 条带电路径 → 未隔离');
  eq(r.livePaths.length, MAX_LIVE_PATHS, `诊断仅展示上限 ${MAX_LIVE_PATHS} 条`);
  eq(r.truncated.live.countLimited, true, 'live 列表标记数量截断');
  eq(r.truncated.live.limit, MAX_LIVE_PATHS, '截断信息携带上限值');
  eq(r.truncated.live.maxLength, MAX_PATH_LEN, '截断信息携带长度上限值');
}

console.log('\n[T8] validateActivePermits: 违规许可携带带电路径与截断信息');
{
  const g = buildGraph(
    [[1, 'source'], [2, 'switch'], [3, 'device']],
    [[1, 1, 2], [2, 2, 3]]
  );
  const violations = validateActivePermits(g, [{ id: 7, device_id: 3, device_name: 'N3' }]);
  eq(violations.length, 1, '发现 1 个失去隔离的许可');
  eq(violations[0].permit.id, 7, '许可信息透传');
  ok(violations[0].livePaths.length >= 1, '携带实际带电路径');
  ok(violations[0].truncated && violations[0].truncated.live, '携带截断信息');
}

console.log(`\n结果: ${pass} 项断言全部通过`);
