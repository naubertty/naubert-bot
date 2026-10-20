import {
  GRAPH_PALETTE_BRIGHTNESS,
  DEFAULT_CUSHION_COLORS,
  PRESETS,
  normalizeColor,
  makeBrightColor,
  prepareRenderColor,
  addRidge,
  arrangeRows,
  arrangeSquarified,
  buildTreeFromBrowserFiles,
  DATASETS,
  formatBytes,
  getExtension,
} from "./windirstat.js";

const state = {
  datasetKey: "windowsSystem",
  treeRoot: null,
  zoomRoot: null,
  selectedNode: null,
  selectedExtension: null,
  activeTab: "treelist",
  viewMode: "treemap",
  options: { ...PRESETS.Classic },
  extensionStats: [],
  extensionColorMap: new Map(),
  visibleRects: [],
  expandedPaths: new Set(),
};

function setStatus(message) {
  const el = document.getElementById("scan-status-pill");
  if (el) el.innerHTML = message;
}

function enrichTree(rawNode, parent = null, pathPrefix = "") {
  const path = pathPrefix ? `${pathPrefix}/${rawNode.name}` : rawNode.name;
  const node = {
    name: rawNode.name,
    type: rawNode.type,
    path,
    parent,
    mtime: rawNode.mtime || "2026-10-20 15:00",
    hash: rawNode.hash || null,
    colorFlag: rawNode.colorFlag || 0,
    sizePhysical: rawNode.sizePhysical || 0,
    sizeLogical: rawNode.sizeLogical || 0,
    files: 0,
    folders: 0,
    children: [],
  };

  if (Array.isArray(rawNode.children) && rawNode.children.length > 0) {
    let sumPhys = 0;
    let sumLog = 0;
    let files = 0;
    let folders = 0;
    for (const childRaw of rawNode.children) {
      const child = enrichTree(childRaw, node, path);
      node.children.push(child);
      sumPhys += child.sizePhysical;
      sumLog += child.sizeLogical;
      if (child.type === "dir") {
        folders += 1 + child.folders;
        files += child.files;
      } else if (child.type === "file") {
        files += 1;
      }
    }
    node.children.sort((a, b) => b.sizePhysical - a.sizePhysical);
    node.sizePhysical = sumPhys;
    node.sizeLogical = sumLog;
    node.files = files;
    node.folders = folders;
  }
  return node;
}

function computeExtensions(root) {
  const map = new Map();
  function walk(n) {
    if (!n.children || n.children.length === 0) {
      const ext = getExtension(n);
      if (ext) {
        const cur = map.get(ext) || { ext, bytes: 0, count: 0, flag: n.colorFlag || 0 };
        cur.bytes += n.sizePhysical;
        cur.count += 1;
        map.set(ext, cur);
      }
      return;
    }
    for (const c of n.children) walk(c);
  }
  walk(root);

  const list = Array.from(map.values()).sort((a, b) => b.bytes - a.bytes);
  const extColorMap = new Map();
  let paletteIdx = 0;
  for (const item of list) {
    let baseRgb;
    if (item.ext === "<Free Space>") {
      baseRgb = [100, 140, 100];
    } else if (item.ext === "<Unknown>") {
      baseRgb = [220, 200, 80];
    } else {
      const raw = DEFAULT_CUSHION_COLORS[paletteIdx % DEFAULT_CUSHION_COLORS.length];
      baseRgb = makeBrightColor(raw, GRAPH_PALETTE_BRIGHTNESS);
      paletteIdx++;
    }
    item.color = baseRgb;
    extColorMap.set(item.ext, { color: baseRgb, flag: item.flag });
  }
  state.extensionStats = list;
  state.extensionColorMap = extColorMap;
}

function collectLeaves(root, out = []) {
  if (!root.children || root.children.length === 0) {
    if (root.type === "file") out.push(root);
    return out;
  }
  for (const c of root.children) collectLeaves(c, out);
  return out;
}

function renderCushionRect(imgData, width, height, rc, surface, baseColor, brightness, options) {
  const x0 = Math.max(0, rc.left);
  const y0 = Math.max(0, rc.top);
  const x1 = Math.min(width, rc.right);
  const y1 = Math.min(height, rc.bottom);
  if (x1 <= x0 || y1 <= y0) return;

  const isCushion =
    options.ambientLight < 1.0 && options.height > 0.0 && options.scaleFactor > 0.0;
  const factor = brightness / GRAPH_PALETTE_BRIGHTNESS;
  const data = imgData.data;

  if (!isCushion) {
    const [r, g, b] = normalizeColor(
      Math.trunc(baseColor[0] * factor),
      Math.trunc(baseColor[1] * factor),
      Math.trunc(baseColor[2] * factor),
    );
    for (let iy = y0; iy < y1; iy++) {
      let idx = (iy * width + x0) * 4;
      for (let ix = x0; ix < x1; ix++) {
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
        idx += 4;
      }
    }
    return;
  }

  const lxRaw = options.lightSourceX;
  const lyRaw = options.lightSourceY;
  const lzRaw = 10.0;
  const len = Math.hypot(lxRaw, lyRaw, lzRaw);
  const lx = lxRaw / len;
  const ly = lyRaw / len;
  const lz = lzRaw / len;

  const Ia = options.ambientLight;
  const Is = 1.0 - Ia;
  const colR = baseColor[0] * factor;
  const colG = baseColor[1] * factor;
  const colB = baseColor[2] * factor;
  const nxStep = -2.0 * surface[0];

  for (let iy = y0; iy < y1; iy++) {
    const ny = -(2.0 * surface[1] * (iy + 0.5) + surface[3]);
    const nyLyLz = ny * ly + lz;
    const ny2_1 = ny * ny + 1.0;
    let nx = -(2.0 * surface[0] * (x0 + 0.5) + surface[2]);
    let idx = (iy * width + x0) * 4;

    for (let ix = x0; ix < x1; ix++) {
      let cosa = (nx * lx + nyLyLz) / Math.sqrt(nx * nx + ny2_1);
      if (cosa > 1.0) cosa = 1.0;
      let pixel = Is * cosa;
      if (pixel < 0.0) pixel = 0.0;
      pixel += Ia;

      const [r, g, b] = normalizeColor(
        Math.trunc(colR * pixel),
        Math.trunc(colG * pixel),
        Math.trunc(colB * pixel),
      );
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
      idx += 4;
      nx += nxStep;
    }
  }
}

function drawTreemapCanvas() {
  const canvas = document.getElementById("treemap-canvas");
  if (!canvas) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(240, Math.floor(rect.height));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  state.visibleRects = [];

  if (state.viewMode === "sunburst") {
    drawSunburst(ctx, width, height);
    return;
  }
  if (state.viewMode === "flamegraph") {
    drawFlameGraph(ctx, width, height);
    return;
  }

  const imgData = ctx.createImageData(width, height);
  const bg = state.options.grid ? 18 : 12;
  for (let i = 0; i < imgData.data.length; i += 4) {
    imgData.data[i] = bg;
    imgData.data[i + 1] = bg + 2;
    imgData.data[i + 2] = bg + 8;
    imgData.data[i + 3] = 255;
  }

  const root = state.zoomRoot || state.treeRoot;
  if (!root || root.sizePhysical <= 0) {
    ctx.putImageData(imgData, 0, 0);
    return;
  }

  const stack = [
    {
      node: root,
      rc: { left: 0, top: 0, right: width, bottom: height },
      surface: [0, 0, 0, 0],
      ridgeHeight: state.options.height,
      asRoot: true,
      depth: 0,
    },
  ];

  const gridWidth = state.options.grid ? 1 : 0;
  const cushionShading =
    state.options.ambientLight < 1.0 &&
    state.options.height > 0.0 &&
    state.options.scaleFactor > 0.0;

  while (stack.length > 0) {
    const item = stack.pop();
    const w = item.rc.right - item.rc.left;
    const h = item.rc.bottom - item.rc.top;
    if (w <= gridWidth || h <= gridWidth) continue;

    const surface = item.surface.slice();
    if (cushionShading && !item.asRoot) {
      addRidge(item.rc, surface, item.ridgeHeight);
    }

    if (!item.node.children || item.node.children.length === 0) {
      const leafRc = {
        left: item.rc.left + (state.options.grid ? 1 : 0),
        top: item.rc.top + (state.options.grid ? 1 : 0),
        right: item.rc.right,
        bottom: item.rc.bottom,
      };
      const ext = getExtension(item.node);
      const extEntry = state.extensionColorMap.get(ext) || {
        color: [200, 200, 200],
        flag: 0,
      };
      const prepared = prepareRenderColor(
        extEntry.color,
        state.options.brightness,
        state.options.saturation,
        item.node.colorFlag || extEntry.flag,
      );
      renderCushionRect(
        imgData,
        width,
        height,
        leafRc,
        surface,
        prepared.color,
        prepared.brightness,
        state.options,
      );
      state.visibleRects.push({ node: item.node, rc: leafRc, depth: item.depth });
      continue;
    }

    const children = item.node.children;
    const weights = children.map((c) => c.sizePhysical);
    const regions =
      state.options.style === "Squarified"
        ? arrangeSquarified(item.rc, item.node.sizePhysical, weights)
        : arrangeRows(item.rc, item.node.sizePhysical, weights);

    for (let i = children.length - 1; i >= 0; i--) {
      const reg = regions[i];
      if (!reg || reg.right <= reg.left || reg.bottom <= reg.top) continue;
      stack.push({
        node: children[i],
        rc: reg,
        surface,
        ridgeHeight: item.ridgeHeight * state.options.scaleFactor,
        asRoot: false,
        depth: item.depth + 1,
      });
    }
  }

  ctx.putImageData(imgData, 0, 0);

  if (state.options.showExtensions) {
    ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const vis of state.visibleRects) {
      const w = vis.rc.right - vis.rc.left;
      const h = vis.rc.bottom - vis.rc.top;
      if (w < 38 || h < 18) continue;
      const ext = getExtension(vis.node);
      if (!ext) continue;
      const cx = (vis.rc.left + vis.rc.right) / 2;
      const cy = (vis.rc.top + vis.rc.bottom) / 2;
      ctx.fillStyle = "rgba(0,0,0,0.78)";
      ctx.fillText(ext, cx + 1, cy + 1);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(ext, cx, cy);
    }
  }

  for (const vis of state.visibleRects) {
    const ext = getExtension(vis.node);
    const isSelectedNode =
      state.selectedNode &&
      (vis.node === state.selectedNode || vis.node.path.startsWith(state.selectedNode.path + "/"));
    const isSelectedExt = state.selectedExtension && ext === state.selectedExtension;
    if (isSelectedNode || isSelectedExt) {
      ctx.strokeStyle = isSelectedNode ? "#ffffff" : "#facc15";
      ctx.lineWidth = isSelectedNode ? 2 : 1.5;
      ctx.strokeRect(
        vis.rc.left + 1,
        vis.rc.top + 1,
        Math.max(1, vis.rc.right - vis.rc.left - 2),
        Math.max(1, vis.rc.bottom - vis.rc.top - 2),
      );
    }
  }
}

function drawSunburst(ctx, width, height) {
  ctx.fillStyle = "#0b0f17";
  ctx.fillRect(0, 0, width, height);
  const root = state.zoomRoot || state.treeRoot;
  if (!root || root.sizePhysical <= 0) return;

  const cx = width / 2;
  const cy = height / 2;
  const maxRadius = Math.min(width, height) / 2 - 14;
  const innerRadius = 28;
  const maxDepth = 5;
  const ringWidth = Math.max(16, (maxRadius - innerRadius) / maxDepth);

  function drawArcNode(node, startAngle, sweepAngle, depth) {
    if (depth > maxDepth || sweepAngle < 0.008) return;
    if (depth > 0) {
      const r0 = innerRadius + (depth - 1) * ringWidth;
      const r1 = r0 + ringWidth - 2;
      const ext = getExtension(node);
      const extEntry = state.extensionColorMap.get(ext);
      const rgb = extEntry ? extEntry.color : DEFAULT_CUSHION_COLORS[depth % DEFAULT_CUSHION_COLORS.length];
      ctx.beginPath();
      ctx.arc(cx, cy, r1, startAngle, startAngle + sweepAngle, false);
      ctx.arc(cx, cy, r0, startAngle + sweepAngle, startAngle, true);
      ctx.closePath();
      ctx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
      ctx.fill();
      ctx.strokeStyle = "#0b0f17";
      ctx.lineWidth = 1;
      ctx.stroke();

      state.visibleRects.push({
        node,
        sunburst: { cx, cy, r0, r1, startAngle, endAngle: startAngle + sweepAngle },
        depth,
      });
    }

    if (node.children && node.children.length > 0) {
      let curAngle = startAngle;
      for (const child of node.children) {
        const childSweep = (child.sizePhysical / node.sizePhysical) * sweepAngle;
        drawArcNode(child, curAngle, childSweep, depth + 1);
        curAngle += childSweep;
      }
    }
  }

  drawArcNode(root, -Math.PI / 2, Math.PI * 2, 0);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "600 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(root.name, cx, cy);
}

function drawFlameGraph(ctx, width, height) {
  ctx.fillStyle = "#0b0f17";
  ctx.fillRect(0, 0, width, height);
  const root = state.zoomRoot || state.treeRoot;
  if (!root || root.sizePhysical <= 0) return;

  const maxDepth = 6;
  const barHeight = Math.min(34, Math.floor((height - 20) / maxDepth));

  function drawFrame(node, x, w, depth) {
    if (depth >= maxDepth || w < 2) return;
    const y = height - (depth + 1) * (barHeight + 2) - 6;
    const ext = getExtension(node);
    const extEntry = state.extensionColorMap.get(ext);
    const rgb = extEntry ? extEntry.color : [79, 157, 232];

    ctx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    ctx.fillRect(x, y, Math.max(1, w - 1), barHeight);

    if (w > 48) {
      ctx.fillStyle = "#0b0f17";
      ctx.font = "600 11px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const label = `${node.name} (${formatBytes(node.sizePhysical)})`;
      ctx.fillText(label.slice(0, Math.floor(w / 7)), x + 5, y + barHeight / 2);
    }

    state.visibleRects.push({
      node,
      rc: { left: x, top: y, right: x + w, bottom: y + barHeight },
      depth,
    });

    if (node.children && node.children.length > 0) {
      let curX = x;
      for (const child of node.children) {
        const cw = (child.sizePhysical / node.sizePhysical) * w;
        drawFrame(child, curX, cw, depth + 1);
        curX += cw;
      }
    }
  }

  drawFrame(root, 8, width - 16, 0);
}

function renderSwatchCanvas(rgb, flag = 0) {
  const c = document.createElement("canvas");
  c.width = 28;
  c.height = 14;
  c.className = "ext-swatch";
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(28, 14);
  const surface = [0, 0, 0, 0];
  addRidge(
    { left: 0, top: 0, right: 28, bottom: 14 },
    surface,
    state.options.height * state.options.scaleFactor,
  );
  const prep = prepareRenderColor(
    rgb,
    state.options.brightness,
    state.options.saturation,
    flag,
  );
  renderCushionRect(
    img,
    28,
    14,
    { left: 0, top: 0, right: 28, bottom: 14 },
    surface,
    prep.color,
    prep.brightness,
    state.options,
  );
  ctx.putImageData(img, 0, 0);
  return c;
}

function renderExtensionList() {
  const tbody = document.getElementById("ext-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const total = state.treeRoot ? state.treeRoot.sizePhysical : 1;

  for (const item of state.extensionStats) {
    const tr = document.createElement("tr");
    if (state.selectedExtension === item.ext) tr.classList.add("selected");
    tr.addEventListener("click", () => {
      state.selectedExtension = state.selectedExtension === item.ext ? null : item.ext;
      renderExtensionList();
      drawTreemapCanvas();
    });

    const tdExt = document.createElement("td");
    tdExt.className = "ext-cell";
    tdExt.appendChild(renderSwatchCanvas(item.color, item.flag));
    const span = document.createElement("span");
    span.textContent = item.ext;
    tdExt.appendChild(span);

    const tdBytes = document.createElement("td");
    tdBytes.className = "num";
    tdBytes.textContent = formatBytes(item.bytes);

    const tdPct = document.createElement("td");
    tdPct.className = "num";
    tdPct.textContent = `${((item.bytes / total) * 100).toFixed(1)}%`;

    const tdFiles = document.createElement("td");
    tdFiles.className = "num";
    tdFiles.textContent = String(item.count);

    tr.append(tdExt, tdBytes, tdPct, tdFiles);
    tbody.appendChild(tr);
  }
}

function renderTreeList() {
  const tbody = document.getElementById("tree-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (state.activeTab === "topfiles") {
    renderTopFiles(tbody);
    return;
  }
  if (state.activeTab === "dupes") {
    renderDuplicates(tbody);
    return;
  }

  const rows = [];
  function walk(node, depth) {
    rows.push({ node, depth });
    if (node.children && node.children.length > 0 && state.expandedPaths.has(node.path)) {
      for (const c of node.children) walk(c, depth + 1);
    }
  }
  if (state.treeRoot) walk(state.treeRoot, 0);

  for (const { node, depth } of rows) {
    const tr = document.createElement("tr");
    if (state.selectedNode === node) tr.classList.add("selected");
    tr.addEventListener("click", () => {
      state.selectedNode = node;
      updateInspector(node);
      renderTreeList();
      drawTreemapCanvas();
    });
    tr.addEventListener("dblclick", () => {
      if (node.children && node.children.length > 0) {
        state.zoomRoot = node;
        updateZoomBanner();
        drawTreemapCanvas();
      }
    });

    const tdName = document.createElement("td");
    tdName.style.paddingLeft = `${8 + depth * 16}px`;
    tdName.className = "tree-name-cell";

    if (node.children && node.children.length > 0) {
      const toggle = document.createElement("button");
      toggle.className = "tree-toggle";
      toggle.textContent = state.expandedPaths.has(node.path) ? "▾" : "▸";
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        if (state.expandedPaths.has(node.path)) state.expandedPaths.delete(node.path);
        else state.expandedPaths.add(node.path);
        renderTreeList();
      });
      tdName.appendChild(toggle);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "tree-spacer";
      tdName.appendChild(spacer);
    }

    const icon = document.createElement("span");
    icon.className = "node-icon";
    icon.textContent =
      node.type === "drive"
        ? "💽"
        : node.type === "dir"
          ? "📁"
          : node.type === "freespace"
            ? "🟩"
            : node.type === "unknown"
              ? "🟨"
              : "📄";
    tdName.appendChild(icon);

    const label = document.createElement("span");
    label.textContent = node.name;
    tdName.appendChild(label);

    const parentTotal = node.parent ? node.parent.sizePhysical : node.sizePhysical;
    const pct = parentTotal > 0 ? (node.sizePhysical / parentTotal) * 100 : 100;

    const tdBar = document.createElement("td");
    const barWrap = document.createElement("div");
    barWrap.className = "subtree-bar-wrap";
    const barFill = document.createElement("div");
    barFill.className = "subtree-bar-fill";
    barFill.style.width = `${Math.max(1, pct).toFixed(1)}%`;
    barWrap.appendChild(barFill);
    tdBar.appendChild(barWrap);

    const tdPct = document.createElement("td");
    tdPct.className = "num";
    tdPct.textContent = `${pct.toFixed(1)}%`;

    const tdPhys = document.createElement("td");
    tdPhys.className = "num";
    tdPhys.textContent = formatBytes(node.sizePhysical);

    const tdLog = document.createElement("td");
    tdLog.className = "num";
    tdLog.textContent = formatBytes(node.sizeLogical);

    const tdFiles = document.createElement("td");
    tdFiles.className = "num";
    tdFiles.textContent = node.children.length > 0 ? String(node.files) : "—";

    const tdFolders = document.createElement("td");
    tdFolders.className = "num";
    tdFolders.textContent = node.children.length > 0 ? String(node.folders) : "—";

    tr.append(tdName, tdBar, tdPct, tdPhys, tdLog, tdFiles, tdFolders);
    tbody.appendChild(tr);
  }
}

function renderTopFiles(tbody) {
  const leaves = collectLeaves(state.treeRoot).sort((a, b) => b.sizePhysical - a.sizePhysical);
  const total = state.treeRoot.sizePhysical || 1;
  for (const node of leaves.slice(0, 40)) {
    const tr = document.createElement("tr");
    if (state.selectedNode === node) tr.classList.add("selected");
    tr.addEventListener("click", () => {
      state.selectedNode = node;
      updateInspector(node);
      renderTreeList();
      drawTreemapCanvas();
    });
    const pct = (node.sizePhysical / total) * 100;
    tr.innerHTML = `
      <td>📄 <strong>${node.name}</strong> <span class="muted-path">${node.path}</span></td>
      <td><div class="subtree-bar-wrap"><div class="subtree-bar-fill" style="width:${pct.toFixed(1)}%"></div></div></td>
      <td class="num">${pct.toFixed(1)}%</td>
      <td class="num">${formatBytes(node.sizePhysical)}</td>
      <td class="num">${formatBytes(node.sizeLogical)}</td>
      <td class="num">1</td>
      <td class="num">${node.mtime}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderDuplicates(tbody) {
  const leaves = collectLeaves(state.treeRoot);
  const groups = new Map();
  for (const f of leaves) {
    if (f.sizeLogical === 0) continue;
    const key = f.hash || `${f.sizeLogical}:${f.name}`;
    const list = groups.get(key) || [];
    list.push(f);
    groups.set(key, list);
  }
  for (const [key, items] of groups.entries()) {
    if (items.length < 2) continue;
    const totalPhys = items.reduce((s, x) => s + x.sizePhysical, 0);
    const header = document.createElement("tr");
    header.className = "dupe-group-row";
    header.innerHTML = `
      <td colspan="3">🔁 <strong>Hash/Size Bucket [${key}]</strong> (${items.length} cópias)</td>
      <td class="num"><strong>${formatBytes(totalPhys)}</strong></td>
      <td class="num">${formatBytes(items[0].sizeLogical)} cada</td>
      <td class="num">${items.length}</td>
      <td class="num">Desperdício: ${formatBytes(totalPhys - items[0].sizePhysical)}</td>
    `;
    tbody.appendChild(header);
    for (const node of items) {
      const tr = document.createElement("tr");
      tr.addEventListener("click", () => {
        state.selectedNode = node;
        updateInspector(node);
        drawTreemapCanvas();
      });
      tr.innerHTML = `
        <td style="padding-left:28px">📄 ${node.path}</td>
        <td></td>
        <td class="num">—</td>
        <td class="num">${formatBytes(node.sizePhysical)}</td>
        <td class="num">${formatBytes(node.sizeLogical)}</td>
        <td class="num">1</td>
        <td class="num">${node.mtime}</td>
      `;
      tbody.appendChild(tr);
    }
  }
}

function updateInspector(node) {
  const el = document.getElementById("selected-node-info");
  if (!el || !node) return;
  const ext = getExtension(node) || "(Directory/Container)";
  const ratio =
    node.sizeLogical > 0 ? ((node.sizePhysical / node.sizeLogical) * 100).toFixed(1) : "100.0";
  el.innerHTML = `
    <div><strong>Path:</strong> <code>${node.path}</code></div>
    <div><strong>Type / Extension:</strong> <code>${node.type.toUpperCase()}</code> · <code>${ext}</code></div>
    <div><strong>Physical vs Logical:</strong> <code>${formatBytes(node.sizePhysical)}</code> / <code>${formatBytes(node.sizeLogical)}</code> (${ratio}% allocation)</div>
    ${node.files ? `<div><strong>Subtree Counts:</strong> <code>${node.files} files</code>, <code>${node.folders} folders</code></div>` : ""}
  `;
}

function updateZoomBanner() {
  const btnOut = document.getElementById("btn-zoom-out");
  const btnReset = document.getElementById("btn-zoom-reset");
  const label = document.getElementById("zoom-path-label");
  const root = state.zoomRoot || state.treeRoot;
  if (label && root) label.textContent = root.path;
  const zoomed = state.zoomRoot && state.zoomRoot !== state.treeRoot;
  if (btnOut) btnOut.disabled = !zoomed;
  if (btnReset) btnReset.disabled = !zoomed;
}

function applyRawTree(rawRoot, sourceLabel = "") {
  state.treeRoot = enrichTree(rawRoot);
  state.zoomRoot = state.treeRoot;
  state.selectedNode = state.treeRoot;
  state.selectedExtension = null;
  state.expandedPaths.clear();
  state.expandedPaths.add(state.treeRoot.path);
  for (const c of state.treeRoot.children) {
    if (c.children && c.children.length > 0) state.expandedPaths.add(c.path);
  }
  computeExtensions(state.treeRoot);
  updateZoomBanner();
  updateInspector(state.treeRoot);
  renderTreeList();
  renderExtensionList();
  drawTreemapCanvas();
  if (sourceLabel) {
    setStatus(
      `Ativo: <strong>${sourceLabel}</strong> (${state.treeRoot.files} arqs, ${formatBytes(state.treeRoot.sizePhysical)})`,
    );
  }
}

function loadDataset(key) {
  state.datasetKey = key;
  const raw = DATASETS[key];
  if (!raw) return;
  applyRawTree(raw.root, raw.name);
}

async function scanSystemPath(targetPath) {
  try {
    setStatus(`⏳ Escaneando <strong>${targetPath}</strong>...`);
    if (window.windirstatAPI && typeof window.windirstatAPI.scanDirectory === "function") {
      const res = await window.windirstatAPI.scanDirectory(targetPath);
      if (res && res.root) {
        applyRawTree(res.root, targetPath);
        return;
      }
    }
    const resp = await fetch(`/api/scan?path=${encodeURIComponent(targetPath)}`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    applyRawTree(data.root, data.scannedPath || targetPath);
  } catch (err) {
    setStatus(`⚠️ Erro ao escanear: <strong>${err.message}</strong>`);
  }
}

function exportCsv() {
  if (!state.treeRoot) return;
  const lines = ["Path,Type,PhysicalBytes,LogicalBytes,Files,Folders,Modified"];
  function walk(node) {
    lines.push(
      `"${node.path.replace(/"/g, '""')}",${node.type},${node.sizePhysical},${node.sizeLogical},${node.files},${node.folders},"${node.mtime}"`,
    );
    if (node.children) {
      for (const c of node.children) walk(c);
    }
  }
  walk(state.treeRoot);
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `windirstat-report-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function syncControlsFromOptions() {
  document.getElementById("opt-style").value = state.options.style;
  document.getElementById("opt-brightness").value = Math.round(state.options.brightness * 100);
  document.getElementById("val-brightness").textContent = `${Math.round(state.options.brightness * 100)}%`;
  document.getElementById("opt-height").value = Math.round(state.options.height * 100);
  document.getElementById("val-height").textContent = state.options.height.toFixed(2);
  document.getElementById("opt-scale").value = Math.round(state.options.scaleFactor * 100);
  document.getElementById("val-scale").textContent = state.options.scaleFactor.toFixed(2);
  document.getElementById("opt-ambient").value = Math.round(state.options.ambientLight * 100);
  document.getElementById("val-ambient").textContent = `${Math.round(state.options.ambientLight * 100)}%`;
  document.getElementById("opt-grid").checked = state.options.grid;
  document.getElementById("opt-ext-labels").checked = state.options.showExtensions;
}

function initEvents() {
  document.getElementById("dataset-select").addEventListener("change", (e) => {
    const val = e.target.value;
    if (val.startsWith("scan:")) {
      scanSystemPath(val.slice(5));
    } else {
      loadDataset(val);
    }
  });

  // Button to pick a real folder from the user's PC via browser File API / Electron dialog
  const folderInput = document.getElementById("pc-folder-input");
  document.getElementById("btn-pick-pc-folder").addEventListener("click", async () => {
    if (window.windirstatAPI && typeof window.windirstatAPI.selectDirectory === "function") {
      const picked = await window.windirstatAPI.selectDirectory();
      if (picked) await scanSystemPath(picked);
      return;
    }
    folderInput.click();
  });

  folderInput.addEventListener("change", (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setStatus(`⏳ Processando ${files.length} arquivos locais do seu PC...`);
    setTimeout(() => {
      const rawRoot = buildTreeFromBrowserFiles(files);
      applyRawTree(rawRoot, `PC Local: ${rawRoot.name}`);
    }, 20);
  });

  document.getElementById("btn-scan-path").addEventListener("click", () => {
    const input = document.getElementById("custom-scan-path");
    if (input && input.value.trim()) {
      scanSystemPath(input.value.trim());
    }
  });

  document.getElementById("btn-export-csv").addEventListener("click", exportCsv);

  document.getElementById("preset-select").addEventListener("change", (e) => {
    const preset = PRESETS[e.target.value];
    if (preset) {
      state.options = { ...preset };
      syncControlsFromOptions();
      renderExtensionList();
      drawTreemapCanvas();
    }
  });

  document.getElementById("opt-style").addEventListener("change", (e) => {
    state.options.style = e.target.value;
    drawTreemapCanvas();
  });

  document.getElementById("view-mode-select").addEventListener("change", (e) => {
    state.viewMode = e.target.value;
    drawTreemapCanvas();
  });

  for (const [id, key, valId, fmt] of [
    ["opt-brightness", "brightness", "val-brightness", (v) => `${Math.round(v * 100)}%`],
    ["opt-height", "height", "val-height", (v) => v.toFixed(2)],
    ["opt-scale", "scaleFactor", "val-scale", (v) => v.toFixed(2)],
    ["opt-ambient", "ambientLight", "val-ambient", (v) => `${Math.round(v * 100)}%`],
  ]) {
    document.getElementById(id).addEventListener("input", (e) => {
      const val = Number(e.target.value) / 100;
      state.options[key] = val;
      document.getElementById(valId).textContent = fmt(val);
      renderExtensionList();
      drawTreemapCanvas();
    });
  }

  document.getElementById("opt-grid").addEventListener("change", (e) => {
    state.options.grid = e.target.checked;
    drawTreemapCanvas();
  });

  document.getElementById("opt-ext-labels").addEventListener("change", (e) => {
    state.options.showExtensions = e.target.checked;
    drawTreemapCanvas();
  });

  document.getElementById("btn-zoom-out").addEventListener("click", () => {
    if (state.zoomRoot && state.zoomRoot.parent) {
      state.zoomRoot = state.zoomRoot.parent;
      updateZoomBanner();
      drawTreemapCanvas();
    }
  });

  document.getElementById("btn-zoom-reset").addEventListener("click", () => {
    state.zoomRoot = state.treeRoot;
    updateZoomBanner();
    drawTreemapCanvas();
  });

  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-tab]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.activeTab = btn.getAttribute("data-tab");
      renderTreeList();
    });
  });

  const canvas = document.getElementById("treemap-canvas");
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;

    for (let i = state.visibleRects.length - 1; i >= 0; i--) {
      const vis = state.visibleRects[i];
      if (vis.rc && x >= vis.rc.left && x < vis.rc.right && y >= vis.rc.top && y < vis.rc.bottom) {
        state.selectedNode = vis.node;
        let p = vis.node.parent;
        while (p) {
          state.expandedPaths.add(p.path);
          p = p.parent;
        }
        updateInspector(vis.node);
        renderTreeList();
        drawTreemapCanvas();
        break;
      }
    }
  });

  canvas.addEventListener("dblclick", () => {
    if (state.selectedNode) {
      const target =
        state.selectedNode.children && state.selectedNode.children.length > 0
          ? state.selectedNode
          : state.selectedNode.parent;
      if (target) {
        state.zoomRoot = target;
        updateZoomBanner();
        drawTreemapCanvas();
      }
    }
  });

  window.addEventListener("resize", () => drawTreemapCanvas());
}

window.addEventListener("DOMContentLoaded", () => {
  initEvents();
  syncControlsFromOptions();
  loadDataset("windowsSystem");
});
