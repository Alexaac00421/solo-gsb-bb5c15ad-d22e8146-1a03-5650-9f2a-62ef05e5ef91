'use strict';

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------
const state = {
  snapshot: null,        // 服务器返回的当前网络状态
  selectedNodeId: null,  // 图上选中的节点
  highlightPaths: [],    // 需要高亮的路径(节点id数组的数组)
  role: 'operator',
  actor: '',
  order: {
    steps: [],           // 浏览器临时编排, 不落库: {action,node_id|device_id}
    result: null,        // 最近一次预演/确认结果
    kind: null           // 'preview' | 'confirm'
  }
};

const ACTION_LABELS = {
  'node.create': '新增节点', 'node.update': '修改节点', 'node.delete': '删除节点',
  'edge.create': '新增供电关系', 'edge.delete': '删除供电关系',
  'switch.open': '开关分闸', 'switch.close': '开关合闸',
  'switch.tag': '开关挂牌', 'switch.untag': '开关解牌',
  'permit.apply': '申请检修许可', 'permit.end': '结束检修许可',
  'order.confirm': '临时操作单执行'
};
const ORDER_ACTION_LABEL = {
  open: '分闸', close: '合闸', tag: '挂牌', untag: '解牌', permit: '申请许可'
};
const KIND_LABELS = { source: '电源', switch: '开关', device: '设备' };

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function apiGet(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
}

async function mutate(method, url, payload) {
  payload.revision = state.snapshot ? state.snapshot.revision : 1;
  payload.actor = state.actor;
  payload.role = state.role;

  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  if (r.ok) {
    state.snapshot = data.snapshot;
    state.highlightPaths = [];
    render();
    toast(`操作成功（新修订号 ${data.revision}）`, 'success');
    return data;
  }
  // 修订号过期: 用服务器当前状态刷新界面
  if (data.error && data.error.code === 'STALE_REVISION' && data.current) {
    state.snapshot = data.current;
    state.highlightPaths = [];
    render();
    toast(`⚠ ${data.error.message}\n界面已刷新为他人提交后的最新状态，请核对后重新操作。`, 'error');
    return null;
  }
  // 操作单确认失败: 保留步骤明细供结果区展示
  lastOrderError = data.step !== undefined ? data : null;
  handleBusinessError(data);
  return null;
}

function truncationNote(truncated) {
  // 诊断路径限量展示: 任一列表触顶都需显式标记“仅显示部分路径”,
  // 避免把数量/长度上限造成的未知误读为已隔离。
  if (!truncated) return '';
  const parts = [];
  for (const key of ['live', 'blocked']) {
    const t = truncated[key];
    if (!t) continue;
    const label = key === 'live' ? '未切断路径' : '被挂牌切断路径';
    if (t.countLimited) parts.push(`${label}超过 ${t.limit} 条，仅展示前 ${t.limit} 条（判定不受上限影响）`);
    if (t.lengthLimited) parts.push(`${label}存在超过 ${t.maxLength} 个节点的长路径，诊断展示已截断`);
  }
  return parts.length ? `⚠ ${parts.join('；')}。` : '';
}

function handleBusinessError(data) {
  const err = data.error || { message: '未知错误' };
  let msg = `✖ ${err.message}`;
  const paths = [];

  if (data.livePaths) {
    paths.push(...data.livePaths);
  }
  if (data.violations) {
    for (const v of data.violations) {
      msg += `\n• 许可 #${v.permit_id}（${v.device_name}）将失去隔离`;
      paths.push(...v.livePaths);
      const note = truncationNote(v.truncated);
      if (note) msg += `\n  ${note}`;
    }
  }
  if (paths.length) {
    msg += '\n未切断路径：';
    paths.slice(0, 8).forEach((p, i) => {
      msg += `\n  ${i + 1}) ` + p.nodes.map((n) => {
        const label = `${n.name}`;
        return n.tagged ? `🔒${label}` : label;
      }).join(' → ');
    });
    if (paths.length > 8) {
      msg += `\n  …（另有 ${paths.length - 8} 条未在弹窗列出，图中已高亮）`;
    }
    state.highlightPaths = paths.map((p) => p.nodes.map((n) => n.id));
    renderGraph();
  }
  // 申请类失败的顶层截断标记
  const note = truncationNote(data.truncated);
  if (note) msg += `\n${note}`;
  toast(msg, 'error');
}

// ---------------------------------------------------------------------------
// 渲染: 图层(BFS 分层布局)
// ---------------------------------------------------------------------------
function computeLayout(snapshot) {
  const { nodes, edges } = snapshot;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  edges.forEach((e) => indeg.set(e.to, (indeg.get(e.to) || 0) + 1));

  // 分层: 电源在第 0 层, 其余按有向边最长距离; 有环时退化处理
  const level = new Map(nodes.map((n) => [n.id, n.kind === 'source' ? 0 : -1]));
  const queue = nodes.filter((n) => n.kind === 'source').map((n) => n.id);
  while (queue.length) {
    const id = queue.shift();
    for (const e of edges.filter((x) => x.from_node === id)) {
      const nl = level.get(id) + 1;
      if (nl > level.get(e.to)) {
        level.set(e.to, nl);
        queue.push(e.to);
      }
    }
  }
  // 环中不可达节点, 按开关/设备兜底放置
  let fallback = Math.max(0, ...[...level.values()]);
  nodes.forEach((n) => {
    if (level.get(n.id) < 0) { fallback += 1; level.set(n.id, fallback); }
  });

  // 同层节点纵向排列
  const lanes = new Map();
  nodes.forEach((n) => {
    const l = level.get(n.id);
    if (!lanes.has(l)) lanes.set(l, []);
    lanes.get(l).push(n.id);
  });

  const COL_W = 210, ROW_H = 120, NODE_W = 132, NODE_H = 56;
  const pos = new Map();
  const levels = [...lanes.keys()].sort((a, b) => a - b);
  levels.forEach((l) => {
    const ids = lanes.get(l);
    ids.forEach((id, i) => {
      pos.set(id, {
        x: 30 + l * COL_W,
        y: 40 + i * ROW_H,
        w: NODE_W, h: NODE_H
      });
    });
  });
  return { pos, width: 60 + (levels.length - 1) * COL_W + NODE_W,
           height: 80 + Math.max(...[...lanes.values()].map((v) => v.length), 1) * ROW_H };
}

function edgePath(a, b) {
  const x1 = a.x + a.w, y1 = a.y + a.h / 2;
  const x2 = b.x, y2 = b.y + b.h / 2;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

function nodeClass(n) {
  const cls = ['node-group', `node-${n.kind}`];
  if (n.kind === 'source' && !n.enabled) cls.push('disabled');
  if (n.kind === 'switch' && n.open_pos) cls.push('is-open');
  if (n.kind === 'switch' && n.tagged) cls.push('tagged');
  if (n.kind === 'device') {
    const has = (state.snapshot.permits || []).some((p) => p.device_id === n.id);
    if (has) cls.push('has-permit');
  }
  if (state.selectedNodeId === n.id) cls.push('selected');
  return cls.join(' ');
}

function renderGraph() {
  const snap = state.snapshot;
  if (!snap) return;
  const { pos, width, height } = computeLayout(snap);
  const byId = new Map(snap.nodes.map((n) => [n.id, n]));

  const highlightNodeSet = new Set();
  const highlightEdgeSet = new Set();
  state.highlightPaths.forEach((nodeIds) => {
    nodeIds.forEach((id) => highlightNodeSet.add(id));
    for (let i = 0; i < nodeIds.length - 1; i++) {
      const e = snap.edges.find((x) => x.from_node === nodeIds[i] && x.to_node === nodeIds[i + 1]);
      if (e) highlightEdgeSet.add(e.id);
    }
  });

  const taggedSwitchIds = new Set(snap.nodes.filter((n) => n.kind === 'switch' && n.tagged).map((n) => n.id));

  let svg = `<svg width="${Math.max(width, 700)}" height="${Math.max(height, 460)}" xmlns="http://www.w3.org/2000/svg">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
      markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
    <marker id="arrowHot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#ea580c"/></marker></defs>`;

  // 边
  snap.edges.forEach((e) => {
    const a = pos.get(e.from_node), b = pos.get(e.to_node);
    if (!a || !b) return;
    const d = edgePath(a, b);
    const intoTagged = taggedSwitchIds.has(e.to_node);
    let cls = 'edge-line';
    if (highlightEdgeSet.has(e.id)) cls += ' highlight';
    else if (intoTagged) cls += ' tagged-cut';
    const marker = highlightEdgeSet.has(e.id) ? 'url(#arrowHot)' : 'url(#arrow)';
    svg += `<path class="${cls}" d="${d}" marker-end="${marker}"/>`;
    svg += `<path class="edge-hit" d="${d}" data-edge="${e.id}"/>`;
  });

  // 节点
  snap.nodes.forEach((n) => {
    const p = pos.get(n.id);
    const sub = [];
    if (n.kind === 'source') sub.push(n.enabled ? '启用' : '停用');
    if (n.kind === 'switch') {
      sub.push(n.open_pos ? '分闸' : '合闸');
      if (n.tagged) sub.push('🔒已挂牌');
    }
    if (n.kind === 'device') {
      const isolated = snap.isolation[n.id];
      if (isolated) sub.push(isolated.isolated ? '许可有效·已隔离' : '许可有效·未隔离!');
    }
    svg += `<g class="${nodeClass(n)}" transform="translate(${p.x},${p.y})" data-node="${n.id}">
      <rect class="node-rect" width="${p.w}" height="${p.h}"
        ${highlightNodeSet.has(n.id) ? 'stroke="#ea580c" stroke-width="4"' : ''}/>
      <text class="node-title" x="${p.w / 2}" y="23">${escapeHtml(n.name)}</text>
      <text class="node-sub" x="${p.w / 2}" y="42">${KIND_LABELS[n.kind]} · ${sub.join(' · ')}</text>
    </g>`;
  });

  svg += '</svg>';
  const box = $('graphCanvas');
  box.innerHTML = svg;

  box.querySelectorAll('[data-node]').forEach((el) => {
    el.addEventListener('click', () => {
      state.selectedNodeId = parseInt(el.dataset.node, 10);
      renderGraph();
      renderNodeDetail();
    });
  });
  box.querySelectorAll('[data-edge]').forEach((el) => {
    el.addEventListener('click', () => {
      if (state.role !== 'admin') {
        toast('仅管理员可以拆除供电接线', 'info');
        return;
      }
      const edgeId = parseInt(el.dataset.edge, 10);
      if (confirm('确认拆除该供电关系（有向边）？')) {
        mutate('DELETE', `/api/admin/edges/${edgeId}`, {});
      }
    });
  });
}

function renderNodeDetail() {
  const box = $('nodeDetail');
  const snap = state.snapshot;
  const n = snap && snap.nodes.find((x) => x.id === state.selectedNodeId);
  if (!n) { box.innerHTML = '点击图中的电源 / 开关 / 设备查看可执行操作。'; return; }

  const isOp = state.role === 'operator';
  const isAdmin = state.role === 'admin';
  let meta = '';
  const buttons = [];

  if (n.kind === 'source') {
    meta = n.enabled ? '当前：启用电源' : '当前：已停用';
    if (isAdmin) {
      buttons.push(['btn', n.enabled ? '停用电源' : '启用电源', () =>
        mutate('PATCH', `/api/admin/nodes/${n.id}`, { enabled: !n.enabled })]);
    }
  } else if (n.kind === 'switch') {
    meta = `当前：${n.open_pos ? '分闸（断开）' : '合闸（导通）'}${n.tagged ? ' · 🔒已挂牌锁定，禁止合闸' : ''}`;
    if (isOp) {
      if (!n.open_pos && !n.tagged) buttons.push(['btn btn-warn', '分闸', () =>
        mutate('POST', `/api/switches/${n.id}/open`, {})]);
      if (n.open_pos && !n.tagged) buttons.push(['btn', '合闸', () =>
        mutate('POST', `/api/switches/${n.id}/close`, {})]);
      if (n.open_pos && !n.tagged) buttons.push(['btn btn-danger', '挂牌 Lockout', () =>
        mutate('POST', `/api/switches/${n.id}/tag`, {})]);
      if (n.tagged) buttons.push(['btn btn-primary', '解牌', () =>
        mutate('POST', `/api/switches/${n.id}/untag`, {})]);
    }
  } else if (n.kind === 'device') {
    const hasActive = snap.permits.some((p) => p.device_id === n.id);
    const iso = snap.isolation[n.id];
    meta = hasActive
      ? (iso.isolated ? '存在有效许可，隔离条件满足' : '存在有效许可，但当前未隔离！')
      : '无有效检修许可';
    if (isOp) {
      if (!hasActive) buttons.push(['btn btn-primary', '申请检修许可', () =>
        mutate('POST', '/api/permits', { device_id: n.id })]);
    }
    buttons.push(['btn', '查看供电路径', async () => {
      const data = await apiGet(`/api/devices/${n.id}/paths`);
      const note = truncationNote(data.truncated);
      if (data.livePaths.length === 0) {
        toast(`「${n.name}」已隔离（无未切断路径）；被挂牌切断路径 ${data.blockedPaths.length} 条。`
          + (note ? `\n${note}` : ''), 'success');
        state.highlightPaths = data.blockedPaths.map((p) => p.nodes.map((x) => x.id));
      } else {
        toast(`「${n.name}」存在 ${data.livePaths.length} 条未切断供电路径（判定基于完整可达性分析，不随展示上限漏判）。`
          + (note ? `\n${note}` : ''), 'error');
        state.highlightPaths = data.livePaths.map((p) => p.nodes.map((x) => x.id));
      }
      renderGraph();
    }]);
  }

  box.innerHTML = `
    <div class="title">${escapeHtml(n.name)} <span class="badge ${kindBadge(n.kind)}">${KIND_LABELS[n.kind]}</span></div>
    <div class="meta">ID #${n.id} · ${meta}</div>
    <div class="actions" id="nodeActions"></div>`;
  const actions = $('nodeActions');
  buttons.forEach(([cls, label, fn]) => {
    const b = document.createElement('button');
    b.className = `btn btn-sm ${cls}`;
    b.textContent = label;
    b.addEventListener('click', fn);
    actions.appendChild(b);
  });
  if (!buttons.length) {
    actions.innerHTML = `<span class="hint">当前身份「${isAdmin ? '管理员' : '操作员'}」对此节点无操作。</span>`;
  }
}

function kindBadge(kind) {
  return { source: 'badge-green', switch: 'badge-amber', device: 'badge-purple' }[kind];
}

// ---------------------------------------------------------------------------
// 渲染: 许可状态列表 / 许可页
// ---------------------------------------------------------------------------
function renderIsolationList() {
  const box = $('isolationList');
  const snap = state.snapshot;
  if (!snap.permits.length) { box.innerHTML = '<p class="hint">当前没有有效检修许可。</p>'; return; }
  box.innerHTML = snap.permits.map((p) => {
    const iso = snap.isolation[p.device_id];
    const ok = iso && iso.isolated;
    const note = !ok ? truncationNote(iso && iso.truncated) : '';
    return `<div class="isolation-item ${ok ? 'ok' : 'bad'}">
      <b>#${p.id} ${escapeHtml(p.device_name)}</b><br>
      ${ok ? '✔ 隔离满足' : `✖ 仍有 ${iso ? iso.livePaths.length : 0} 条未切断路径`}
      ${ok ? '' : (iso.livePaths.slice(0, 3).map((path) =>
        `<div class="path-line">${path.nodes.map((x) => x.name).join(' → ')}</div>`).join('')
        + (iso.livePaths.length > 3
          ? `<div class="hint">…另有 ${iso.livePaths.length - 3} 条，仅列出前 3 条。</div>` : ''))}
      ${note ? `<div class="path-truncated">${escapeHtml(note)}</div>` : ''}
    </div>`;
  }).join('');
}

function renderPermits() {
  const snap = state.snapshot;
  const box = $('permitList');
  if (!snap.permits.length) {
    box.innerHTML = '<p class="hint">暂无有效许可。先在开关上完成“分闸 → 挂牌”，再来申请。</p>';
  } else {
    box.innerHTML = snap.permits.map((p) => {
      const iso = snap.isolation[p.device_id];
      const ok = iso && iso.isolated;
      const note = ok ? '' : truncationNote(iso && iso.truncated);
      return `<div class="permit-card ${ok ? 'isolated' : 'violated'}">
        <div>
          <b>#${p.id} ${escapeHtml(p.device_name)}</b>
          <div class="permit-meta">申请人：${escapeHtml(p.requested_by)} · 申请时间：${p.created_at} ·
            ${ok ? '✔ 已隔离' : '✖ 未隔离'}</div>
          <div class="permit-paths">${ok
            ? '<span class="hint">所有启用电源路径均经已挂牌开关。</span>'
            : iso.livePaths.slice(0, 5).map((path) =>
              `<div class="path-line">未切断：${path.nodes.map((n) => n.name).join(' → ')}</div>`).join('')
              + (iso.livePaths.length > 5
                ? `<div class="hint">…另有 ${iso.livePaths.length - 5} 条，仅列出前 5 条（隔离判定基于完整可达性分析）。</div>`
                : '')}
          </div>
          ${note ? `<div class="path-truncated">${escapeHtml(note)}</div>` : ''}
        </div>
        <button class="btn btn-sm btn-danger" onclick="endPermit(${p.id})">结束许可</button>
      </div>`;
    }).join('');
  }
  $('applyDevice').innerHTML = snap.nodes.filter((n) => n.kind === 'device')
    .map((n) => `<option value="${n.id}">${escapeHtml(n.name)}</option>`).join('');
}

window.endPermit = (id) => mutate('POST', `/api/permits/${id}/end`, {});

// ---------------------------------------------------------------------------
// 临时操作单: 编排 / 预演(只读) / 确认(原子执行)
// ---------------------------------------------------------------------------
function orderTargetName(snap, step) {
  const id = step.action === 'permit' ? step.device_id : step.node_id;
  const n = snap.nodes.find((x) => x.id === id);
  return n ? n.name : `#${id}（已不存在）`;
}

// 目标下拉随动作切换: 开关动作选开关, 申请许可选设备
function refreshOrderTargets() {
  const snap = state.snapshot;
  if (!snap) return;
  const action = $('orderAction').value;
  const list = action === 'permit'
    ? snap.nodes.filter((n) => n.kind === 'device')
    : snap.nodes.filter((n) => n.kind === 'switch');
  $('orderTarget').innerHTML = list
    .map((n) => `<option value="${n.id}">${escapeHtml(n.name)}${n.kind === 'switch'
      ? `（${n.open_pos ? '分闸' : '合闸'}${n.tagged ? '·🔒挂牌' : ''}）` : ''}</option>`)
    .join('');
}

function renderOrderEditor() {
  const snap = state.snapshot;
  if (!snap) return;
  refreshOrderTargets();
  const tbody = $('orderGrid').querySelector('tbody');
  if (!state.order.steps.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="hint">还没有步骤。</td></tr>';
    return;
  }
  tbody.innerHTML = state.order.steps.map((s, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${ORDER_ACTION_LABEL[s.action]} <span class="hint">${s.action}</span></td>
      <td>${escapeHtml(orderTargetName(snap, s))}</td>
      <td>
        <button class="btn btn-sm" data-order="up" data-idx="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn btn-sm" data-order="down" data-idx="${i}" ${i === state.order.steps.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn btn-sm btn-danger" data-order="del" data-idx="${i}">删除</button>
      </td>
    </tr>`).join('');
}

function stateBadge(st) {
  if (!st) return '';
  return `<span class="hint">[${st.tagged ? '挂牌' : st.open_pos ? '分闸' : '合闸'}]</span>`;
}

function renderOrderResult() {
  const box = $('orderResult');
  const o = state.order;
  if (!o.result) {
    box.innerHTML = '<p class="hint">先在左侧编排步骤，点击“预演”查看各步结果。</p>';
    return;
  }

  const headKind = o.kind === 'confirm' ? '确认执行' : '预演';
  const r = o.result;
  const head = r.success
    ? `<div class="order-head ok">✔ ${headKind}通过：全部 ${r.steps.filter((s) => !s.skipped).length} 步均可执行${
      o.kind === 'confirm' ? `，已原子落库（新修订号 ${r.revision}）` : '（预演不改变真实状态）'}</div>`
    : `<div class="order-head bad">✖ ${headKind}在第 ${r.failedStep} 步失败：${escapeHtml(r.error ? r.error.message : '')}
        <div class="hint">整单${o.kind === 'confirm' ? '已回滚，未写入任何数据' : '预演中止'}；后续步骤标记为“未执行”，不能补救前一步违规。</div></div>`;

  const iso = (x) => x ? `<div class="hint">隔离：${x.isolated ? '✔ 已隔离'
    : `✖ 未隔离，${x.livePaths.length} 条未切断路径`}${x.blockedPathCount ? `；挂牌切断路径 ${x.blockedPathCount} 条` : ''}</div>` : '';

  // 末步许可结论以“按单推演后的该步结果”为准; 另附目标设备当前(执行前)隔离状态
  const permitSim = r.steps.find((s) => s.action === 'permit');
  const permitBanner = r.permitIsolation ? (() => {
    const cur = r.permitIsolation;
    const curTxt = cur.isolated ? '当前已隔离' : `当前未隔离（${cur.livePaths.length} 条未切断路径）`;
    let afterTxt = '';
    if (permitSim) {
      afterTxt = permitSim.ok
        ? '；按本单前面步骤执行后 ✔ 将满足隔离，许可可生效'
        : '；按本单前面步骤执行后仍 ✖ 未隔离，许可将被拒绝';
    }
    return `<div class="order-permit">末步申请许可目标「${escapeHtml(cur.device_name)}」：${curTxt}${afterTxt}</div>`;
  })() : '';

  box.innerHTML = head + permitBanner + r.steps.map((s) => {
    const cls = s.skipped ? 'skipped' : s.ok ? 'ok' : 'bad';
    const target = s.action === 'permit'
      ? `设备「${escapeHtml(s.device_name || '')}」`
      : `开关「${escapeHtml(s.name || '')}」 #${s.node_id}`;
    let pathsHtml = '';
    const paths = [];
    if (s.violations) s.violations.forEach((v) => paths.push(...v.livePaths));
    if (s.isolation && !s.isolation.isolated) paths.push(...s.isolation.livePaths);
    if (paths.length) {
      pathsHtml = paths.slice(0, 5).map((p) =>
        `<div class="path-line">带电：${p.nodes.map((n) => n.tagged ? `🔒${n.name}` : n.name).join(' → ')}</div>`).join('')
        + (paths.length > 5 ? `<div class="hint">…另有 ${paths.length - 5} 条。</div>` : '');
    }
    return `<div class="order-step ${cls}">
      <b>第 ${s.step} 步</b> · ${ORDER_ACTION_LABEL[s.action]} · ${target}
      ${s.before ? `${stateBadge(s.before)} → ${stateBadge(s.after)}` : ''}
      <div>${s.skipped ? '⏭ ' : s.ok ? '✔ ' : '✖ '}${escapeHtml(s.message || (s.error ? s.error.message : ''))}</div>
      ${iso(s.isolation)}${pathsHtml}
    </div>`;
  }).join('');

  // 失败时在网络图上高亮实际带电路径
  if (!r.success) {
    const paths = [];
    r.steps.forEach((s) => {
      if (s.violations) s.violations.forEach((v) => paths.push(...v.livePaths));
      if (s.isolation && !s.isolation.isolated) paths.push(...s.isolation.livePaths);
    });
    if (paths.length) {
      state.highlightPaths = paths.map((p) => p.nodes.map((n) => n.id));
      renderGraph();
    }
  }
}

async function orderPreview() {
  if (!state.order.steps.length) return toast('请先编排至少一个步骤', 'error');
  const r = await fetch('/api/orders/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actor: state.actor, role: state.role,
      revision: state.snapshot ? state.snapshot.revision : 1,
      steps: state.order.steps
    })
  });
  const data = await r.json().catch(() => ({}));
  if (r.ok) {
    state.order.result = data;
    state.order.kind = 'preview';
    renderOrderResult();
    toast(data.success
      ? '预演通过（真实网络、许可、修订号与审计均未改变）'
      : `预演显示第 ${data.failedStep} 步将被拒绝`, data.success ? 'success' : 'error');
    return;
  }
  // 结构/身份类错误直接提示
  toast(`✖ ${data.error ? data.error.message : '预演请求失败'}`, 'error');
}

async function orderConfirm() {
  if (!state.order.steps.length) return toast('请先编排至少一个步骤', 'error');
  if (!confirm(`确认按当前顺序原子执行这 ${state.order.steps.length} 个步骤？\n任一步失败整单回滚、不落库。`)) return;
  const data = await mutate('POST', '/api/orders/confirm', { steps: state.order.steps });
  if (data) {
    state.order.result = {
      success: true, failedStep: null, error: null,
      revision: data.revision, steps: state.order.result ? state.order.result.steps : [],
      permitIsolation: state.order.result ? state.order.result.permitIsolation : null
    };
    state.order.kind = 'confirm';
    renderOrderResult();
  } else if (lastOrderError) {
    state.order.result = {
      success: false,
      failedStep: lastOrderError.step,
      error: lastOrderError.error,
      steps: lastOrderError.step_results,
      permitIsolation: state.order.result ? state.order.result.permitIsolation : null
    };
    state.order.kind = 'confirm';
    renderOrderResult();
  }
}

// 供 orderConfirm 读取最近一次确认失败的步骤明细
let lastOrderError = null;

// ---------------------------------------------------------------------------
// 渲染: 管理页
// ---------------------------------------------------------------------------
function renderAdmin() {
  const snap = state.snapshot;
  const byId = new Map(snap.nodes.map((n) => [n.id, n]));

  $('nodeGrid').querySelector('tbody').innerHTML = snap.nodes.map((n) => {
    const badges = [];
    if (n.kind === 'source') badges.push(n.enabled ? '<span class="badge badge-green">启用</span>' : '<span class="badge badge-gray">停用</span>');
    if (n.kind === 'switch') {
      badges.push(n.open_pos ? '<span class="badge badge-amber">分闸</span>' : '<span class="badge badge-green">合闸</span>');
      if (n.tagged) badges.push('<span class="badge badge-red">🔒挂牌</span>');
    }
    const permit = n.kind === 'device' && snap.permits.find((p) => p.device_id === n.id);
    if (permit) badges.push('<span class="badge badge-purple">有效许可</span>');
    const toggle = n.kind === 'source'
      ? `<button class="btn btn-sm" data-admin="toggle-source" data-id="${n.id}">${n.enabled ? '停用' : '启用'}</button>` : '';
    return `<tr>
      <td>${n.id}</td><td>${KIND_LABELS[n.kind]}</td>
      <td>${escapeHtml(n.name)}</td><td>${badges.join(' ')}</td>
      <td>${toggle} <button class="btn btn-sm btn-danger" data-admin="del-node" data-id="${n.id}">删除</button></td>
    </tr>`;
  }).join('');

  $('edgeGrid').querySelector('tbody').innerHTML = snap.edges.map((e) => {
    const a = byId.get(e.from_node), b = byId.get(e.to_node);
    return `<tr><td>${e.id}</td>
      <td>${a ? escapeHtml(a.name) : '?'}</td><td>→</td>
      <td>${b ? escapeHtml(b.name) : '?'}</td>
      <td><button class="btn btn-sm btn-danger" data-admin="del-edge" data-id="${e.id}">拆除</button></td></tr>`;
  }).join('') || '<tr><td colspan="5" class="hint">还没有供电关系。</td></tr>';

  const nodeOption = (filter) => snap.nodes.filter(filter)
    .map((n) => `<option value="${n.id}">${KIND_LABELS[n.kind]}｜${escapeHtml(n.name)}</option>`).join('');
  $('edgeFrom').innerHTML = nodeOption((n) => n.kind !== 'device');
  $('edgeTo').innerHTML = nodeOption((n) => n.kind !== 'source');
}

// ---------------------------------------------------------------------------
// 渲染: 审计
// ---------------------------------------------------------------------------
async function renderAudit() {
  const box = $('auditList');
  box.innerHTML = '<p class="hint">加载中…</p>';
  const data = await apiGet('/api/audit?limit=100');
  if (!data.logs.length) { box.innerHTML = '<p class="hint">暂无变更记录。</p>'; return; }
  box.innerHTML = data.logs.map((log) => {
    const detail = log.detail ? Object.entries(log.detail)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('，') : '';
    return `<div class="audit-item">
      <div class="audit-head">
        <span class="badge badge-purple">${log.role === 'admin' ? '管理员' : '操作员'}</span>
        <span class="audit-action">${ACTION_LABELS[log.action] || log.action}</span>
        <span>${escapeHtml(log.actor)}</span>
        <span class="audit-ts">${log.ts} UTC</span>
        <span class="audit-rev">修订 ${log.rev_before} → ${log.rev_after}</span>
      </div>
      <div class="audit-detail">${escapeHtml(detail)}</div>
      <details class="snapshot">
        <summary>前后状态快照</summary>
        <pre>前: ${escapeHtml(JSON.stringify(log.state_before, null, 1))}\n\n后: ${escapeHtml(JSON.stringify(log.state_after, null, 1))}</pre>
      </details>
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// 总渲染与事件
// ---------------------------------------------------------------------------
function render() {
  if (!state.snapshot) return;
  $('revision').textContent = state.snapshot.revision;
  renderGraph();
  renderNodeDetail();
  renderIsolationList();
  renderPermits();
  renderAdmin();
  renderOrderEditor();
}

function toast(message, kind) {
  const el = document.createElement('div');
  el.className = `toast-msg toast-${kind}`;
  el.textContent = message;
  $('toast').appendChild(el);
  setTimeout(() => el.remove(), 7000);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function checkIdentity() {
  state.actor = ($('actor').value || '').trim();
  state.role = $('role').value;
  localStorage.setItem('loto.actor', state.actor);
  localStorage.setItem('loto.role', state.role);
  if (!state.actor) { toast('请先在右上角填写操作者姓名', 'info'); return false; }
  return true;
}

// 标签页
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tabpane').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $(`tab-${t.dataset.tab}`).classList.add('active');
    if (t.dataset.tab === 'audit') renderAudit();
  });
});

$('refreshBtn').addEventListener('click', refresh);
$('actor').addEventListener('input', () => {
  localStorage.setItem('loto.actor', $('actor').value);
  state.actor = $('actor').value.trim();
});
$('role').addEventListener('change', () => {
  localStorage.setItem('loto.role', $('role').value);
  state.role = $('role').value;
  render();
});

// 所有变更类操作前校验身份
document.addEventListener('click', (ev) => {
  const actionable = ev.target.closest('button');
  if (!actionable) return;
  const mutating = actionable.id && ['addNodeBtn', 'addEdgeBtn', 'applyBtn',
      'orderAddBtn', 'orderPreviewBtn', 'orderConfirmBtn'].includes(actionable.id)
    || actionable.hasAttribute('data-admin')
    || actionable.closest('#nodeActions')
    || actionable.getAttribute('onclick');
  if (mutating && !actionable.disabled) {
    if (!checkIdentity()) { ev.stopImmediatePropagation(); ev.preventDefault(); }
  }
}, true);

// 管理页事件
$('addNodeBtn').addEventListener('click', () => {
  const kind = $('newNodeKind').value;
  const name = $('newNodeName').value.trim();
  if (!name) return toast('请填写节点名称', 'error');
  mutate('POST', '/api/admin/nodes', { kind, name }).then((d) => { if (d) $('newNodeName').value = ''; });
});
$('addEdgeBtn').addEventListener('click', () => {
  mutate('POST', '/api/admin/edges', {
    from_node: parseInt($('edgeFrom').value, 10),
    to_node: parseInt($('edgeTo').value, 10)
  });
});
$('applyBtn').addEventListener('click', () => {
  mutate('POST', '/api/permits', { device_id: parseInt($('applyDevice').value, 10) });
});

// 临时操作单事件
$('orderAction').addEventListener('change', refreshOrderTargets);
$('orderAddBtn').addEventListener('click', () => {
  const action = $('orderAction').value;
  const target = parseInt($('orderTarget').value, 10);
  if (!Number.isInteger(target)) return toast('没有可选目标', 'error');
  const steps = state.order.steps;
  if (action === 'permit' && steps.length && steps[steps.length - 1].action === 'permit') {
    return toast('末步已是申请许可；一张操作单至多一个申请许可步', 'error');
  }
  if (action !== 'permit' && steps.some((s) => s.action === 'permit')) {
    return toast('申请许可只能是末步，请先删除许可步再追加开关动作', 'error');
  }
  steps.push(action === 'permit'
    ? { action: 'permit', device_id: target }
    : { action, node_id: target });
  state.order.result = null;
  renderOrderEditor();
  renderOrderResult();
});
$('orderGrid').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-order]');
  if (!btn) return;
  const idx = parseInt(btn.dataset.idx, 10);
  const steps = state.order.steps;
  const op = btn.dataset.order;
  if (op === 'del') steps.splice(idx, 1);
  if (op === 'up' && idx > 0) [steps[idx - 1], steps[idx]] = [steps[idx], steps[idx - 1]];
  if (op === 'down' && idx < steps.length - 1) [steps[idx + 1], steps[idx]] = [steps[idx], steps[idx + 1]];
  // 移动后若许可不在末位则纠正(后端同样强制)
  const permitIdx = steps.findIndex((s) => s.action === 'permit');
  if (permitIdx >= 0 && permitIdx !== steps.length - 1) {
    const [p] = steps.splice(permitIdx, 1);
    steps.push(p);
  }
  state.order.result = null;
  renderOrderEditor();
  renderOrderResult();
});
$('orderPreviewBtn').addEventListener('click', orderPreview);
$('orderConfirmBtn').addEventListener('click', orderConfirm);
$('orderClearBtn').addEventListener('click', () => {
  state.order.steps = [];
  state.order.result = null;
  renderOrderEditor();
  renderOrderResult();
});
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-admin]');
  if (!btn) return;
  const id = parseInt(btn.dataset.id, 10);
  if (btn.dataset.admin === 'del-node') {
    if (confirm('删除节点会级联拆除其全部供电关系，确认？')) mutate('DELETE', `/api/admin/nodes/${id}`, {});
  } else if (btn.dataset.admin === 'del-edge') {
    mutate('DELETE', `/api/admin/edges/${id}`, {});
  } else if (btn.dataset.admin === 'toggle-source') {
    const n = state.snapshot.nodes.find((x) => x.id === id);
    mutate('PATCH', `/api/admin/nodes/${id}`, { enabled: !n.enabled });
  }
});

// ---------------------------------------------------------------------------
// 启动与轮询(只更新修订号/状态, 不打断操作)
// ---------------------------------------------------------------------------
async function refresh() {
  const snap = await apiGet('/api/state');
  state.snapshot = snap;
  render();
}

(async function init() {
  const savedActor = localStorage.getItem('loto.actor') || '';
  const savedRole = localStorage.getItem('loto.role') || 'operator';
  $('actor').value = savedActor;
  $('role').value = savedRole;
  state.actor = savedActor.trim();
  state.role = savedRole;
  await refresh();
  setInterval(async () => {
    try {
      const snap = await apiGet('/api/state');
      if (snap.revision !== state.snapshot.revision) {
        state.snapshot = snap;
        render();
      }
    } catch (_) { /* 忽略轮询失败 */ }
  }, 10000);
})();
