#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { scanDirectoryTree } = require("./scanner.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = path.join(__dirname, "renderer");
const PORT = Number(process.env.PORT || 4174);
const HOST = process.env.HOST || "0.0.0.0";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// Minimal ZIP archive builder (store method 0, zero external dependencies)
function createZipBuffer(files) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);

    localParts.push(localHeader, data);
    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralSize = centralParts.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

async function buildPcAppZip() {
  const relativeFiles = [
    "README-PC.md",
    "Iniciar-WinDirStat-Windows.bat",
    "iniciar-windirstat-linux-mac.sh",
    "windirstat_desktop.py",
    "package.json",
    "main.cjs",
    "preload.cjs",
    "scanner.cjs",
    "server.mjs",
    "renderer/index.html",
    "renderer/app.js",
    "renderer/windirstat.js",
  ];
  const entries = [];
  for (const rel of relativeFiles) {
    const data = await fs.readFile(path.join(__dirname, rel));
    entries.push({ name: `WinDirStat-REA-PC/${rel}`, data });
  }
  return createZipBuffer(entries);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/scan") {
      const targetPath = url.searchParams.get("path") || process.cwd();
      try {
        const result = await scanDirectoryTree(targetPath);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.pathname === "/api/download-pc-app") {
      const zipBuf = await buildPcAppZip();
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="WinDirStat-REA-PC.zip"',
        "Content-Length": String(zipBuf.length),
      });
      res.end(zipBuf);
      return;
    }

    let reqPath = url.pathname;
    if (reqPath.startsWith("/windirstat/")) {
      reqPath = reqPath.slice("/windirstat".length);
    }
    if (reqPath === "/" || reqPath === "/windirstat") {
      reqPath = "/index.html";
    }

    const safeRel = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = path.join(RENDERER_DIR, safeRel);
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

server.listen(PORT, HOST, () => {
  const localUrl = `http://127.0.0.1:${PORT}/`;
  console.log(`WinDirStat 2.9.3 Desktop Server running at ${localUrl}`);
  if (process.argv.includes("--open")) {
    const cmd =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", localUrl]]
        : process.platform === "darwin"
          ? ["open", [localUrl]]
          : ["xdg-open", [localUrl]];
    const child = spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true });
    child.unref();
  }
});
