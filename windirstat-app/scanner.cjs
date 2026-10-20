const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const IGNORED_NAMES = new Set([".git", "node_modules", ".turbo", ".cache"]);

async function fastSampleHash(filePath, size) {
  if (size <= 0 || size > 64 * 1024 * 1024) return null;
  let fh;
  try {
    fh = await fs.open(filePath, "r");
    const sampleLen = Math.min(size, 65536);
    const buf = Buffer.allocUnsafe(sampleLen);
    const { bytesRead } = await fh.read(buf, 0, sampleLen, 0);
    return crypto
      .createHash("sha256")
      .update(`${size}:`)
      .update(buf.subarray(0, bytesRead))
      .digest("hex")
      .slice(0, 16);
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function scanDirectoryTree(targetPath, maxEntries = 6000) {
  const resolved = path.resolve(targetPath);
  let entriesVisited = 0;

  async function walk(currentPath, isRoot = false) {
    const name = isRoot ? resolved : path.basename(currentPath) || currentPath;
    let st;
    try {
      st = await fs.lstat(currentPath);
    } catch {
      return null;
    }

    if (st.isSymbolicLink()) return null;

    const mtime = st.mtime.toISOString().slice(0, 16).replace("T", " ");

    if (st.isFile()) {
      const sizeLogical = Math.max(1, st.size);
      const sizePhysical =
        typeof st.blocks === "number" && st.blocks > 0
          ? st.blocks * 512
          : Math.max(4096, Math.ceil(sizeLogical / 4096) * 4096);
      const hash = sizeLogical >= 1024 ? await fastSampleHash(currentPath, st.size) : null;
      return {
        name,
        type: "file",
        sizePhysical,
        sizeLogical,
        mtime,
        hash,
      };
    }

    if (st.isDirectory()) {
      const children = [];
      let dirEntries = [];
      try {
        dirEntries = await fs.readdir(currentPath, { withFileTypes: true });
      } catch {
        return {
          name,
          type: isRoot ? "drive" : "dir",
          mtime,
          children: [],
        };
      }

      for (const entry of dirEntries) {
        if (entriesVisited >= maxEntries) break;
        if (!isRoot && IGNORED_NAMES.has(entry.name)) continue;
        entriesVisited++;
        const childNode = await walk(path.join(currentPath, entry.name), false);
        if (childNode) children.push(childNode);
      }

      return {
        name,
        type: isRoot ? "drive" : "dir",
        mtime,
        children,
      };
    }

    return null;
  }

  const root = await walk(resolved, true);
  if (!root) {
    throw new Error(`Não foi possível ler o diretório: ${resolved}`);
  }
  return {
    scannedPath: resolved,
    entriesVisited,
    root,
  };
}

module.exports = { scanDirectoryTree };
