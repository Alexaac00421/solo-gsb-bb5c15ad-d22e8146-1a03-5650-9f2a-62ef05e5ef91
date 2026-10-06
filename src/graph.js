'use strict';

// 有向供电图与隔离判定逻辑。
// 供电方向: edges from_node -> to_node。
// 只有 enabled=1 的电源为有效电源; 经过 tagged=1 的开关的路径视为已被切断。
// 开关物理分合位(open_pos)是现场状态, 挂牌要求先分闸, 但隔离只认挂牌。
//
// 关键设计: “隔离判定”与“路径枚举”相互独立。
//   1. 隔离判定(findReachableTarget): 不带数量/长度上限的多源 BFS 完整可达性
//      分析, 挂牌开关是不可穿过的屏障。它决定许可能否生效, 因此枚举触顶
//      绝不能被当成“已隔离”。
//   2. 路径枚举(enumeratePaths): 仅用于界面诊断展示, 带数量/长度上限;
//      触顶时在 truncated 中显式标记截断, 未切断与被挂牌切断分别计数,
//      互不挤占名额。
//   3. 只要可达性分析判定设备带电, evaluateIsolation 保证至少给出一条真实
//      带电路径(BFS 见证路径)用于拒绝提示, 必要时可超过展示长度上限。

const MAX_LIVE_PATHS = 200;    // 诊断展示: 未切断路径条数上限
const MAX_BLOCKED_PATHS = 200; // 诊断展示: 被挂牌切断路径条数上限
const MAX_PATH_LEN = 64;       // 诊断展示: 单条路径的节点数上限
const MAX_PATHS = MAX_LIVE_PATHS; // 兼容旧导出名, 语义等同未切断路径上限

function enabledSourceIds(graph) {
  return graph.nodes
    .filter((n) => n.kind === 'source' && n.enabled)
    .map((n) => n.id);
}

function isTaggedSwitch(graph, nodeId) {
  const n = graph.nodeById.get(nodeId);
  return !!n && n.kind === 'switch' && n.tagged;
}

/**
 * 完整的可达性判定: 从所有启用电源出发(挂牌开关为不可穿过的屏障),
 * 不设数量/长度上限, 判断 target 是否仍可达(带电)。
 * @returns {{ reachable:boolean, witness:({nodes:number[], edges:number[]}|null) }}
 *   reachable 时 witness 为一条真实未切断路径(按 BFS 的最短路径), 用于拒绝提示。
 */
function findReachableTarget(graph, targetId) {
  const parent = new Map(); // nodeId -> { from: nodeId|null, edge: edgeId|null }
  const queue = [];
  for (const src of enabledSourceIds(graph)) {
    if (!parent.has(src)) {
      parent.set(src, { from: null, edge: null });
      queue.push(src);
    }
  }

  while (queue.length) {
    const cur = queue.shift();
    if (cur === targetId) {
      const nodes = [cur];
      const edges = [];
      let p = parent.get(cur);
      while (p.from !== null) {
        nodes.unshift(p.from);
        edges.unshift(p.edge);
        p = parent.get(p.from);
      }
      return { reachable: true, witness: { nodes, edges, tagged: [] } };
    }
    if (isTaggedSwitch(graph, cur)) continue; // 挂牌屏障: 不进入其下游

    for (const e of graph.outAdj.get(cur) || []) {
      if (parent.has(e.to)) continue;
      if (isTaggedSwitch(graph, e.to)) continue; // 挂牌开关不展开
      parent.set(e.to, { from: cur, edge: e.id });
      queue.push(e.to);
    }
  }
  return { reachable: false, witness: null };
}

/**
 * 带上限的路径枚举, 仅供诊断展示。分两轮 DFS:
 *   live 轮只记录到达设备的未切断路径(遇挂牌开关即停, 不下探);
 *   blocked 轮记录在挂牌开关处被切断的路径前缀。
 * 两轮各自独立计数, 因此“被挂牌挡住的支路再多”也不会挤掉带电路径。
 * @returns {{ livePaths:Array, blockedPaths:Array, truncated:Object }}
 */
function enumeratePaths(graph, targetId) {
  const livePaths = [];
  const blockedPaths = [];
  const truncated = {
    live: { countLimited: false, lengthLimited: false, limit: MAX_LIVE_PATHS, maxLength: MAX_PATH_LEN },
    blocked: { countLimited: false, lengthLimited: false, limit: MAX_BLOCKED_PATHS, maxLength: MAX_PATH_LEN }
  };

  // 返回 true 表示该轮枚举已触数量上限, 整轮终止(后续结果只会更多, 标记已足够)。
  function dfs(pass, cur, nodeSeen, nodePath, edgeSeen, edgePath) {
    if (cur === targetId) {
      if (pass === 'live') {
        if (livePaths.length >= MAX_LIVE_PATHS) {
          truncated.live.countLimited = true;
          return true;
        }
        livePaths.push({ nodes: nodePath.slice(), edges: edgePath.slice(), tagged: [] });
      }
      return false;
    }

    // 挂牌开关: 屏障。blocked 轮记录被截断的路径前缀, live 轮直接折回。
    if (isTaggedSwitch(graph, cur)) {
      if (pass === 'blocked') {
        if (blockedPaths.length >= MAX_BLOCKED_PATHS) {
          truncated.blocked.countLimited = true;
          return true;
        }
        blockedPaths.push({
          nodes: nodePath.slice(),
          edges: edgePath.slice(),
          blockedByTag: true,
          tagged: [cur]
        });
      }
      return false;
    }

    // 长度上限只截断诊断枚举; 可达性判定不受此限(见 findReachableTarget)。
    if (nodePath.length >= MAX_PATH_LEN) {
      const outs = graph.outAdj.get(cur) || [];
      const canContinue = outs.some((e) =>
        !nodeSeen.has(e.to) && !edgeSeen.has(e.id)
        && !(pass === 'live' && isTaggedSwitch(graph, e.to)));
      if (canContinue) truncated[pass].lengthLimited = true;
      return false;
    }

    const outs = graph.outAdj.get(cur) || [];
    for (const e of outs) {
      // 防止环导致的无限递归: 节点与边都不重复
      if (nodeSeen.has(e.to) || edgeSeen.has(e.id)) continue;
      nodeSeen.add(e.to);
      edgeSeen.add(e.id);
      nodePath.push(e.to);
      edgePath.push(e.id);
      const abort = dfs(pass, e.to, nodeSeen, nodePath, edgeSeen, edgePath);
      edgePath.pop();
      nodePath.pop();
      edgeSeen.delete(e.id);
      nodeSeen.delete(e.to);
      if (abort) return true;
    }
    return false;
  }

  for (const src of enabledSourceIds(graph)) {
    dfs('live', src, new Set([src]), [src], new Set(), []);
    dfs('blocked', src, new Set([src]), [src], new Set(), []);
  }
  return { livePaths, blockedPaths, truncated };
}

function sameNodePath(a, b) {
  return a.nodes.length === b.nodes.length && a.nodes.every((id, i) => id === b.nodes[i]);
}

/**
 * 带电时保证诊断结果至少含一条真实带电路径: 若受限枚举一条也没给出
 * (仅可能发生在带电路径长于展示上限时), 把 BFS 见证路径补入(可超长)。
 */
function ensureWitness(livePaths, witness, liveTrunc) {
  if (!witness) return;
  if (!livePaths.some((p) => sameNodePath(p, witness))) {
    livePaths.unshift(witness);
    if (livePaths.length > MAX_LIVE_PATHS) liveTrunc.countLimited = true;
  }
}

/**
 * 找到 target 设备的供电路径诊断信息。
 * @returns {{ reachable:boolean, witness:Object|null, livePaths:Array,
 *             blockedPaths:Array, truncated:Object }}
 */
function findPathsToTarget(graph, targetId) {
  const { reachable, witness } = findReachableTarget(graph, targetId);
  const { livePaths, blockedPaths, truncated } = enumeratePaths(graph, targetId);
  if (reachable) ensureWitness(livePaths, witness, truncated.live);
  return { reachable, witness, livePaths, blockedPaths, truncated };
}

/**
 * 判定设备是否满足隔离条件: 完整可达性分析确认不存在任何从启用电源
 * 到设备的未切断路径。枚举上限只影响展示列表(truncated), 不影响结论。
 * @returns {{ isolated:boolean, livePaths:Array, blockedPaths:Array, truncated:Object }}
 */
function evaluateIsolation(graph, deviceId) {
  const r = findPathsToTarget(graph, deviceId);
  return {
    isolated: !r.reachable,
    livePaths: r.livePaths,
    blockedPaths: r.blockedPaths,
    truncated: r.truncated
  };
}

/**
 * 对所有有效检修许可重新校验隔离条件。
 * @returns 不满足隔离的许可数组 [{ permit, livePaths, truncated }]
 */
function validateActivePermits(graph, permits) {
  const violations = [];
  for (const p of permits) {
    const r = evaluateIsolation(graph, p.device_id);
    if (!r.isolated) {
      violations.push({ permit: p, livePaths: r.livePaths, truncated: r.truncated });
    }
  }
  return violations;
}

function serializePath(graph, path) {
  return {
    nodes: path.nodes.map((id) => {
      const n = graph.nodeById.get(id);
      return { id, kind: n.kind, name: n.name, tagged: !!n.tagged };
    }),
    edges: path.edges,
    blockedByTag: !!path.blockedByTag
  };
}

module.exports = {
  findPathsToTarget,
  findReachableTarget,
  enumeratePaths,
  evaluateIsolation,
  validateActivePermits,
  serializePath,
  MAX_PATHS,
  MAX_LIVE_PATHS,
  MAX_BLOCKED_PATHS,
  MAX_PATH_LEN
};
