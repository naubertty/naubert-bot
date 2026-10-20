// WinDirStat Clean-Room Engine backed by REA Evidence
// Implements exact CColorSpace, TreeMapLayout (Rows/Squarified), AddRidge, DrawCushion, and PC Local Folder Scanner

export const GRAPH_PALETTE_BRIGHTNESS = 0.6;

export const DEFAULT_CUSHION_COLORS = [
  [0, 0, 255],     // .dll / .sys - Blue
  [255, 0, 0],     // .exe / .msi - Red
  [0, 255, 0],     // .mp4 / .mkv - Green
  [255, 255, 0],   // .zip / .7z  - Yellow
  [0, 255, 255],   // .iso / .vhd - Cyan
  [255, 0, 255],   // .pak / .bin - Magenta
  [255, 170, 0],   // .ts / .js   - Orange
  [0, 85, 255],    // .pdb / .lib - Dodger Blue
  [255, 0, 85],    // .png / .jpg - Hot Pink
  [85, 255, 0],    // .db / .sqlite - Lime Green
  [170, 0, 255],   // .woff2 / .ttf - Violet
  [0, 255, 85],    // .json / .xml - Spring Green
  [255, 0, 170],   // .pdf / .md  - Deep Pink
  [0, 170, 255],   // .cpp / .h   - Sky Blue
  [255, 85, 0],    // .log / .dmp - Orange Red
  [0, 255, 170],   // .wasm / .node - Aquamarine
  [85, 0, 255],    // .cab / .msix - Indigo
  [255, 255, 255], // other - White
];

export const PRESETS = {
  Classic: {
    style: "Rows",
    grid: true,
    showExtensions: true,
    brightness: 0.88,
    saturation: 1.0,
    height: 0.38,
    scaleFactor: 0.91,
    ambientLight: 0.13,
    lightSourceX: -1.0,
    lightSourceY: -1.0,
  },
  Calm: {
    style: "Squarified",
    grid: true,
    showExtensions: true,
    brightness: 0.72,
    saturation: 0.65,
    height: 0.15,
    scaleFactor: 0.80,
    ambientLight: 0.70,
    lightSourceX: -1.0,
    lightSourceY: -1.0,
  },
  Flat: {
    style: "Squarified",
    grid: true,
    showExtensions: true,
    brightness: 0.72,
    saturation: 0.85,
    height: 0.0,
    scaleFactor: 0.80,
    ambientLight: 1.0,
    lightSourceX: -1.0,
    lightSourceY: -1.0,
  },
  Pastel: {
    style: "Squarified",
    grid: true,
    showExtensions: true,
    brightness: 0.82,
    saturation: 0.40,
    height: 0.10,
    scaleFactor: 0.80,
    ambientLight: 0.85,
    lightSourceX: -1.0,
    lightSourceY: -1.0,
  },
  HighContrast: {
    style: "Rows",
    grid: true,
    showExtensions: true,
    brightness: 0.62,
    saturation: 1.0,
    height: 0.0,
    scaleFactor: 0.80,
    ambientLight: 1.0,
    lightSourceX: -1.0,
    lightSourceY: -1.0,
  },
};

export function distributeFirst(first, second, third) {
  const h = Math.trunc((first - 255) / 2);
  first = 255;
  second += h;
  third += h;
  if (second > 255) {
    const j = second - 255;
    second = 255;
    third = Math.min(255, third + j);
  } else if (third > 255) {
    const j = third - 255;
    third = 255;
    second = Math.min(255, second + j);
  }
  return [first, second, third];
}

export function normalizeColor(red, green, blue) {
  if (red > 255) {
    [red, green, blue] = distributeFirst(red, green, blue);
  } else if (green > 255) {
    [green, red, blue] = distributeFirst(green, red, blue);
  } else if (blue > 255) {
    [blue, red, green] = distributeFirst(blue, red, green);
  }
  return [
    Math.max(0, Math.min(255, red | 0)),
    Math.max(0, Math.min(255, green | 0)),
    Math.max(0, Math.min(255, blue | 0)),
  ];
}

export function makeBrightColor(rgb, brightness = GRAPH_PALETTE_BRIGHTNESS) {
  let dred = (rgb[0] & 0xff) / 255.0;
  let dgreen = (rgb[1] & 0xff) / 255.0;
  let dblue = (rgb[2] & 0xff) / 255.0;
  const sum = dred + dgreen + dblue;
  if (sum > 0) {
    const f = (3.0 * brightness) / sum;
    dred *= f;
    dgreen *= f;
    dblue *= f;
  }
  return normalizeColor(
    Math.trunc(dred * 255),
    Math.trunc(dgreen * 255),
    Math.trunc(dblue * 255),
  );
}

export function blendColor(color, background, amount) {
  const a = Math.max(0, Math.min(1, amount));
  return [
    Math.trunc(color[0] * (1.0 - a) + background[0] * a),
    Math.trunc(color[1] * (1.0 - a) + background[1] * a),
    Math.trunc(color[2] * (1.0 - a) + background[2] * a),
  ];
}

export function prepareRenderColor(baseRgb, brightness, saturation, flag = 0) {
  let color = baseRgb;
  let b = brightness;
  if (flag === 1) {
    color = makeBrightColor(baseRgb, GRAPH_PALETTE_BRIGHTNESS);
    b = brightness * 0.66;
  } else if (flag === 2) {
    color = makeBrightColor(baseRgb, GRAPH_PALETTE_BRIGHTNESS);
    b = Math.min(brightness * 1.2, 1.0);
  }
  const gray = Math.trunc((color[0] + color[1] + color[2]) / 3);
  const sat = Math.max(0, Math.min(1, saturation));
  color = blendColor(color, [gray, gray, gray], 1.0 - sat);
  return { color, brightness: b };
}

export function addRidge(rc, surface, h) {
  const width = rc.right - rc.left;
  const height = rc.bottom - rc.top;
  if (width <= 0 || height <= 0) return;
  const h4 = 4.0 * h;
  const wf = h4 / width;
  surface[2] += wf * (rc.right + rc.left);
  surface[0] -= wf;

  const hf = h4 / height;
  surface[3] += hf * (rc.bottom + rc.top);
  surface[1] -= hf;
}

export function arrangeRows(bounds, parentWeight, weights) {
  const count = weights.length;
  const regions = new Array(count);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (count === 0 || width <= 0 || height <= 0) return [];

  if (parentWeight <= 0) {
    const step = width / count;
    let left = bounds.left;
    for (let i = 0; i < count; i++) {
      const next = left + step;
      const right = i + 1 === count ? bounds.right : Math.trunc(next);
      regions[i] = { left: Math.trunc(left), top: bounds.top, right, bottom: bounds.bottom };
      left = next;
    }
    return regions;
  }

  const MIN_PROPORTION = 0.4;
  const horizontalRows = width >= height;
  const normalizedWidth = horizontalRows ? width / height : height / width;
  const rowOrigin = horizontalRows ? bounds.top : bounds.left;
  const rowExtent = horizontalRows ? height : width;
  const columnExtent = horizontalRows ? width : height;

  let top = rowOrigin;
  for (let rowBegin = 0; rowBegin < count; ) {
    let rowWeight = 0;
    let rowFraction = 0.0;
    let rowEnd = rowBegin;
    for (; rowEnd < count; rowEnd++) {
      const childWeight = weights[rowEnd];
      if (childWeight === 0) break;
      rowWeight += childWeight;
      const candidateFraction = rowWeight / parentWeight;
      const childWidth = (childWeight / parentWeight) * (normalizedWidth / candidateFraction);
      if (rowEnd > rowBegin && childWidth / candidateFraction < MIN_PROPORTION) {
        rowWeight -= childWeight;
        break;
      }
      rowFraction = candidateFraction;
    }
    if (rowEnd === rowBegin) {
      for (let i = rowBegin; i < count; i++) {
        regions[i] = { left: bounds.left, top: bounds.top, right: bounds.left, bottom: bounds.top };
      }
      break;
    }
    while (rowEnd < count && weights[rowEnd] === 0) rowEnd++;

    const nextTop = top + rowFraction * rowExtent;
    const bottom =
      rowEnd === count
        ? horizontalRows
          ? bounds.bottom
          : bounds.right
        : Math.trunc(nextTop);
    let left = horizontalRows ? bounds.left : bounds.top;
    for (let i = rowBegin; i < rowEnd; i++) {
      const nextLeft = rowWeight > 0 ? left + (weights[i] / rowWeight) * columnExtent : left;
      const lastChild = i + 1 === rowEnd || (i + 1 < count && weights[i + 1] === 0);
      const right = lastChild
        ? horizontalRows
          ? bounds.right
          : bounds.bottom
        : Math.trunc(nextLeft);
      regions[i] = horizontalRows
        ? { left: Math.trunc(left), top: Math.trunc(top), right, bottom }
        : { left: Math.trunc(top), top: Math.trunc(left), right: bottom, bottom: right };
      left = nextLeft;
    }
    top = nextTop;
    rowBegin = rowEnd;
  }
  return regions;
}

export function arrangeSquarified(bounds, parentWeight, weights) {
  const count = weights.length;
  const regions = new Array(count);
  const totalW = bounds.right - bounds.left;
  const totalH = bounds.bottom - bounds.top;
  if (count === 0 || totalW <= 0 || totalH <= 0) return [];
  if (parentWeight <= 0) return arrangeRows(bounds, parentWeight, weights);

  const remaining = { ...bounds };
  let remainingWeight = parentWeight;
  const weightPerPixel = remainingWeight / totalW / totalH;
  let head = 0;

  while (head < count && remaining.right > remaining.left && remaining.bottom > remaining.top) {
    const remW = remaining.right - remaining.left;
    const remH = remaining.bottom - remaining.top;
    const horizontal = remW >= remH;
    const rowThickness = horizontal ? remH : remW;
    const squaredRowWeight = rowThickness * rowThickness * weightPerPixel;

    const rowBegin = head;
    let rowEnd = head;
    let worst = Number.MAX_VALUE;
    const largest = weights[rowBegin];
    let rowWeight = 0;

    while (rowEnd < count) {
      const childWeight = weights[rowEnd];
      if (childWeight === 0) {
        rowEnd = count;
        break;
      }
      const nextWeight = rowWeight + childWeight;
      const squaredWeight = nextWeight * nextWeight;
      const nextWorst = Math.max(
        (squaredRowWeight * largest) / squaredWeight,
        squaredWeight / squaredRowWeight / childWeight,
      );
      if (rowEnd > rowBegin && nextWorst > worst) break;
      rowWeight += childWeight;
      rowEnd++;
      worst = nextWorst;
    }

    if (rowWeight === 0) {
      for (let i = head; i < count; i++) {
        regions[i] = { left: remaining.left, top: remaining.top, right: remaining.left, bottom: remaining.top };
      }
      break;
    }

    const remainingExtent = horizontal ? remW : remH;
    const rowWidth =
      rowWeight < remainingWeight
        ? Math.max(1, Math.min(remainingExtent, Math.trunc((rowWeight / remainingWeight) * remainingExtent)))
        : remainingExtent;

    const rowBounds = { ...remaining };
    if (horizontal) rowBounds.right = rowBounds.left + rowWidth;
    else rowBounds.bottom = rowBounds.top + rowWidth;

    let begin = horizontal ? rowBounds.top : rowBounds.left;
    const span = horizontal ? rowBounds.bottom - rowBounds.top : rowBounds.right - rowBounds.left;
    for (let i = rowBegin; i < rowEnd; i++) {
      const next = begin + (weights[i] / rowWeight) * span;
      const lastChild = i + 1 === rowEnd || (i + 1 < count && weights[i + 1] === 0);
      const end = lastChild ? (horizontal ? rowBounds.bottom : rowBounds.right) : Math.trunc(next);
      regions[i] = horizontal
        ? { left: rowBounds.left, top: Math.trunc(begin), right: rowBounds.right, bottom: end }
        : { left: Math.trunc(begin), top: rowBounds.top, right: end, bottom: rowBounds.bottom };
      begin = next;
    }

    if (horizontal) remaining.left += rowWidth;
    else remaining.top += rowWidth;
    remainingWeight -= rowWeight;
    head += rowEnd - rowBegin;
  }

  for (let i = 0; i < count; i++) {
    if (!regions[i]) {
      regions[i] = { left: bounds.left, top: bounds.top, right: bounds.left, bottom: bounds.top };
    }
  }
  return regions;
}

/**
 * Converts a browser FileList (from <input type="file" webkitdirectory>) into a WinDirStat CItem tree.
 * Calculates physical size aligned to 4096-byte NTFS clusters (with MFT resident optimization for files <= 700 B).
 */
export function buildTreeFromBrowserFiles(fileList, rootFolderName = "Pasta Local do PC") {
  const root = {
    name: rootFolderName,
    type: "drive",
    childrenMap: new Map(),
    children: [],
  };

  for (const file of fileList) {
    const relPath = file.webkitRelativePath || file.name;
    const parts = relPath.split("/").filter(Boolean);
    if (parts.length > 1 && root.name === "Pasta Local do PC") {
      root.name = parts[0];
    }
    const startIdx = parts.length > 1 ? 1 : 0;
    let current = root;

    for (let i = startIdx; i < parts.length - 1; i++) {
      const folderName = parts[i];
      if (!current.childrenMap.has(folderName)) {
        const dirNode = {
          name: folderName,
          type: "dir",
          childrenMap: new Map(),
          children: [],
        };
        current.childrenMap.set(folderName, dirNode);
        current.children.push(dirNode);
      }
      current = current.childrenMap.get(folderName);
    }

    const fileName = parts[parts.length - 1];
    const sizeLogical = file.size || 0;
    // NTFS resident attribute threshold (~700B) vs 4096-byte cluster allocation
    const sizePhysical =
      sizeLogical === 0
        ? 0
        : sizeLogical <= 700
          ? sizeLogical
          : Math.ceil(sizeLogical / 4096) * 4096;
    const dt = file.lastModified ? new Date(file.lastModified) : new Date();
    const mtime = dt.toISOString().slice(0, 16).replace("T", " ");

    current.children.push({
      name: fileName,
      type: "file",
      sizePhysical: Math.max(1, sizePhysical),
      sizeLogical: Math.max(1, sizeLogical),
      mtime,
    });
  }

  function cleanMaps(node) {
    delete node.childrenMap;
    if (node.children) {
      for (const c of node.children) cleanMaps(c);
    }
  }
  cleanMaps(root);
  return root;
}

export const DATASETS = {
  windowsSystem: {
    name: "C:\\ (NVMe Windows 11 System Volume - Demo)",
    totalCapacity: 68_719_476_736,
    root: {
      name: "C:\\",
      type: "drive",
      children: [
        {
          name: "Windows",
          type: "dir",
          children: [
            {
              name: "System32",
              type: "dir",
              children: [
                { name: "ntoskrnl.exe", type: "file", sizePhysical: 12_484_608, sizeLogical: 12_482_112, mtime: "2026-10-12 09:14" },
                { name: "shell32.dll", type: "file", sizePhysical: 8_912_896, sizeLogical: 8_910_200, mtime: "2026-10-12 09:14" },
                { name: "win32kfull.sys", type: "file", sizePhysical: 4_718_592, sizeLogical: 4_716_032, mtime: "2026-10-11 18:02" },
                { name: "d3dcompiler_47.dll", type: "file", sizePhysical: 4_915_200, sizeLogical: 4_912_880, mtime: "2026-09-20 14:22", hash: "ea91f0c4128b9044" },
                { name: "Chakra.dll", type: "file", sizePhysical: 5_242_880, sizeLogical: 5_240_120, mtime: "2026-09-18 11:05" },
                {
                  name: "DriverStore",
                  type: "dir",
                  children: [
                    { name: "nvlddmkm.sys", type: "file", sizePhysical: 58_720_256, sizeLogical: 58_718_912, mtime: "2026-10-02 20:10" },
                    { name: "igdkmd64.sys", type: "file", sizePhysical: 31_457_280, sizeLogical: 31_455_000, mtime: "2026-08-19 07:45" },
                    { name: "nvngx_dlss.dll", type: "file", sizePhysical: 44_040_192, sizeLogical: 44_038_400, mtime: "2026-10-02 20:10" },
                  ],
                },
              ],
            },
            {
              name: "WinSxS",
              type: "dir",
              children: [
                { name: "amd64_microsoft-windows-servicingstack.cab", type: "file", sizePhysical: 48_234_496, sizeLogical: 48_234_496, mtime: "2026-10-14 03:18" },
                { name: "LCU-Package-KB5044285.msix", type: "file", sizePhysical: 62_914_560, sizeLogical: 62_914_560, mtime: "2026-10-15 04:00" },
                { name: "ManifestCache_9a81f0.bin", type: "file", sizePhysical: 29_360_128, sizeLogical: 41_943_040, mtime: "2026-10-15 04:02" },
              ],
            },
            {
              name: "Temp",
              type: "dir",
              children: [
                { name: "MEMORY.DMP", type: "file", sizePhysical: 45_088_768, sizeLogical: 45_088_768, mtime: "2026-10-09 22:41" },
                { name: "CBS_Reporting.log", type: "file", sizePhysical: 14_680_064, sizeLogical: 14_678_910, mtime: "2026-10-19 16:30" },
              ],
            },
          ],
        },
        {
          name: "Users",
          type: "dir",
          children: [
            {
              name: "Analyst",
              type: "dir",
              children: [
                {
                  name: "Workspaces",
                  type: "dir",
                  children: [
                    {
                      name: "rea-reverse-engineering",
                      type: "dir",
                      children: [
                        { name: "ghidra-headless-cache.db", type: "file", sizePhysical: 52_428_800, sizeLogical: 52_428_800, mtime: "2026-10-20 12:15" },
                        { name: "target-capture-bundle.zip", type: "file", sizePhysical: 38_797_312, sizeLogical: 38_795_100, mtime: "2026-10-20 14:40" },
                        { name: "WinDirStat-x64.pdb", type: "file", sizePhysical: 33_554_432, sizeLogical: 33_554_432, mtime: "2026-10-20 15:02", hash: "bb0249d17a882c01" },
                        { name: "WinDirStat.exe", type: "file", sizePhysical: 3_670_016, sizeLogical: 3_668_480, mtime: "2026-10-20 15:02", hash: "7c491820fa9911bc" },
                        { name: "runtime-evidence.json", type: "file", sizePhysical: 19_922_944, sizeLogical: 19_920_115, mtime: "2026-10-20 16:10" },
                      ],
                    },
                    {
                      name: "windirstat-build",
                      type: "dir",
                      children: [
                        { name: "WinDirStat-x64.pdb", type: "file", sizePhysical: 33_554_432, sizeLogical: 33_554_432, mtime: "2026-10-20 15:02", hash: "bb0249d17a882c01" },
                        { name: "WinDirStat.exe", type: "file", sizePhysical: 3_670_016, sizeLogical: 3_668_480, mtime: "2026-10-20 15:02", hash: "7c491820fa9911bc" },
                        { name: "TreeMap.obj", type: "file", sizePhysical: 8_388_608, sizeLogical: 8_385_120, mtime: "2026-10-20 15:01" },
                        { name: "FinderNtfs.obj", type: "file", sizePhysical: 6_291_456, sizeLogical: 6_289_000, mtime: "2026-10-20 15:01" },
                      ],
                    },
                  ],
                },
                {
                  name: "Videos",
                  type: "dir",
                  children: [
                    { name: "rea-hopper-showcase-4k.mp4", type: "file", sizePhysical: 83_886_080, sizeLogical: 83_886_080, mtime: "2026-10-18 19:20" },
                    { name: "treemap-cushion-lighting-demo.mkv", type: "file", sizePhysical: 54_525_952, sizeLogical: 54_525_952, mtime: "2026-10-19 21:05" },
                    { name: "rea-hopper-showcase-backup.mp4", type: "file", sizePhysical: 83_886_080, sizeLogical: 83_886_080, mtime: "2026-10-18 19:25", hash: "9912fa081bc44110" },
                  ],
                },
                {
                  name: "VirtualMachines",
                  type: "dir",
                  children: [
                    { name: "win11-analysis-sandbox.iso", type: "file", sizePhysical: 96_468_992, sizeLogical: 96_468_992, mtime: "2026-10-01 10:00" },
                    { name: "flare-vm-snapshot.vhd", type: "file", sizePhysical: 75_497_472, sizeLogical: 104_857_600, mtime: "2026-10-10 08:30" },
                  ],
                },
              ],
            },
          ],
        },
        {
          name: "Program Files",
          type: "dir",
          children: [
            {
              name: "WinDirStat",
              type: "dir",
              children: [
                { name: "WinDirStat.exe", type: "file", sizePhysical: 3_670_016, sizeLogical: 3_668_480, mtime: "2026-10-20 15:02", hash: "7c491820fa9911bc" },
                { name: "d3dcompiler_47.dll", type: "file", sizePhysical: 4_915_200, sizeLogical: 4_912_880, mtime: "2026-09-20 14:22", hash: "ea91f0c4128b9044" },
                { name: "WinDirStat-Manual.pdf", type: "file", sizePhysical: 7_340_032, sizeLogical: 7_338_100, mtime: "2026-10-05 12:00" },
              ],
            },
            {
              name: "Ghidra_12.1",
              type: "dir",
              children: [
                { name: "decompile-linux-x64.bin", type: "file", sizePhysical: 41_943_040, sizeLogical: 41_943_040, mtime: "2026-09-15 16:00" },
                { name: "processor-x86-sleigh.pak", type: "file", sizePhysical: 27_262_976, sizeLogical: 27_260_000, mtime: "2026-09-15 16:00" },
              ],
            },
          ],
        },
        {
          name: "<Free Space>",
          type: "freespace",
          sizePhysical: 115_343_360,
          sizeLogical: 115_343_360,
          mtime: "—",
          colorFlag: 1,
        },
        {
          name: "<Unknown>",
          type: "unknown",
          sizePhysical: 18_874_368,
          sizeLogical: 18_874_368,
          mtime: "—",
          colorFlag: 2,
        },
      ],
    },
  },
  windirstatRepo: {
    name: "windirstat/windirstat v2.9.3 (REA Imported Source Tree)",
    totalCapacity: 4_019_556,
    root: {
      name: "windirstat-v2.9.3",
      type: "drive",
      children: [
        {
          name: "windirstat",
          type: "dir",
          children: [
            {
              name: "Controls",
              type: "dir",
              children: [
                { name: "TreeMap.cpp", type: "file", sizePhysical: 39598, sizeLogical: 39598, mtime: "2026-10-20 17:27" },
                { name: "WdsListControl.cpp", type: "file", sizePhysical: 35929, sizeLogical: 35929, mtime: "2026-10-20 17:27" },
                { name: "Sunburst.cpp", type: "file", sizePhysical: 31829, sizeLogical: 31829, mtime: "2026-10-20 17:27" },
                { name: "TreeListControl.cpp", type: "file", sizePhysical: 25771, sizeLogical: 25771, mtime: "2026-10-20 17:27" },
                { name: "HilbertMooreTreeMap.cpp", type: "file", sizePhysical: 22837, sizeLogical: 22837, mtime: "2026-10-20 17:27" },
                { name: "IconHandler.cpp", type: "file", sizePhysical: 19805, sizeLogical: 19805, mtime: "2026-10-20 17:27" },
                { name: "TreeMap.h", type: "file", sizePhysical: 15546, sizeLogical: 15546, mtime: "2026-10-20 17:27" },
                { name: "FlameGraph.cpp", type: "file", sizePhysical: 14021, sizeLogical: 14021, mtime: "2026-10-20 17:27" },
                { name: "ExtensionListControl.cpp", type: "file", sizePhysical: 13590, sizeLogical: 13590, mtime: "2026-10-20 17:27" },
                { name: "FileDupeControl.cpp", type: "file", sizePhysical: 10087, sizeLogical: 10087, mtime: "2026-10-20 17:27" },
                { name: "TreeMapLayout.cpp", type: "file", sizePhysical: 8998, sizeLogical: 8998, mtime: "2026-10-20 17:27" },
              ],
            },
            {
              name: "Views",
              type: "dir",
              children: [
                { name: "StorageAnalyticsView.cpp", type: "file", sizePhysical: 27094, sizeLogical: 27094, mtime: "2026-10-20 17:27" },
                { name: "GraphView.cpp", type: "file", sizePhysical: 15223, sizeLogical: 15223, mtime: "2026-10-20 17:27" },
                { name: "FlameGraphView.cpp", type: "file", sizePhysical: 15080, sizeLogical: 15080, mtime: "2026-10-20 17:27" },
                { name: "FileTabbedView.cpp", type: "file", sizePhysical: 6983, sizeLogical: 6983, mtime: "2026-10-20 17:27" },
                { name: "TreeMapView.cpp", type: "file", sizePhysical: 6853, sizeLogical: 6853, mtime: "2026-10-20 17:27" },
                { name: "SunburstView.cpp", type: "file", sizePhysical: 6003, sizeLogical: 6003, mtime: "2026-10-20 17:27" },
              ],
            },
            {
              name: "Dialogs",
              type: "dir",
              children: [
                { name: "SelectDrivesDlg.cpp", type: "file", sizePhysical: 48272, sizeLogical: 48272, mtime: "2026-10-20 17:27" },
                { name: "RecoveryDlg.cpp", type: "file", sizePhysical: 22785, sizeLogical: 22785, mtime: "2026-10-20 17:27" },
                { name: "MessageBoxDlg.cpp", type: "file", sizePhysical: 16873, sizeLogical: 16873, mtime: "2026-10-20 17:27" },
                { name: "SearchDlg.cpp", type: "file", sizePhysical: 11501, sizeLogical: 11501, mtime: "2026-10-20 17:27" },
              ],
            },
            {
              name: "res",
              type: "dir",
              children: [
                { name: "license.txt", type: "file", sizePhysical: 35147, sizeLogical: 35147, mtime: "2026-10-20 17:27", hash: "gpl30001a9c" },
                { name: "WinDirStat.ico", type: "file", sizePhysical: 29150, sizeLogical: 29150, mtime: "2026-10-20 17:27" },
                { name: "lang_combined.txt", type: "file", sizePhysical: 184320, sizeLogical: 184320, mtime: "2026-10-20 17:27" },
              ],
            },
            { name: "WinDirStatModel.Actions.cpp", type: "file", sizePhysical: 63762, sizeLogical: 63762, mtime: "2026-10-20 17:27" },
            { name: "FinderRemote.cpp", type: "file", sizePhysical: 57348, sizeLogical: 57348, mtime: "2026-10-20 17:27" },
            { name: "Item.cpp", type: "file", sizePhysical: 51792, sizeLogical: 51792, mtime: "2026-10-20 17:27" },
            { name: "windirstat.rc", type: "file", sizePhysical: 51772, sizeLogical: 51772, mtime: "2026-10-20 17:27" },
            { name: "MainFrame.Commands.cpp", type: "file", sizePhysical: 50623, sizeLogical: 50623, mtime: "2026-10-20 17:27" },
            { name: "UiAppearance.cpp", type: "file", sizePhysical: 41662, sizeLogical: 41662, mtime: "2026-10-20 17:27" },
            { name: "UiTypes.h", type: "file", sizePhysical: 41520, sizeLogical: 41520, mtime: "2026-10-20 17:27" },
            { name: "Item.Extended.cpp", type: "file", sizePhysical: 37664, sizeLogical: 37664, mtime: "2026-10-20 17:27" },
            { name: "HelpersTasks.cpp", type: "file", sizePhysical: 36364, sizeLogical: 36364, mtime: "2026-10-20 17:27" },
            { name: "RecoveryNtfs.cpp", type: "file", sizePhysical: 34966, sizeLogical: 34966, mtime: "2026-10-20 17:27" },
            { name: "WinDirStatModel.cpp", type: "file", sizePhysical: 34886, sizeLogical: 34886, mtime: "2026-10-20 17:27" },
            { name: "CsvLoader.cpp", type: "file", sizePhysical: 34857, sizeLogical: 34857, mtime: "2026-10-20 17:27" },
            { name: "FinderNtfs.cpp", type: "file", sizePhysical: 23758, sizeLogical: 23758, mtime: "2026-10-20 17:27" },
          ],
        },
        { name: "LICENSE.md", type: "file", sizePhysical: 35147, sizeLogical: 35147, mtime: "2026-10-20 17:27", hash: "gpl30001a9c" },
        { name: "CHANGELOG.md", type: "file", sizePhysical: 20109, sizeLogical: 20109, mtime: "2026-10-20 17:27" },
      ],
    },
  },
};

export function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val >= 100 || i === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[i]}`;
}

export function getExtension(node) {
  if (node.type === "freespace") return "<Free Space>";
  if (node.type === "unknown") return "<Unknown>";
  if (node.type !== "file") return "";
  const idx = node.name.lastIndexOf(".");
  return idx > 0 ? node.name.slice(idx).toLowerCase() : ".noext";
}
