#!/usr/bin/env python3
"""
WinDirStat 2.9.3 — Aplicativo Desktop Nativo para PC (Python + Tkinter)
Reconstrução Clean-Room com REA (Zero dependências externas).
Roda em Windows, Linux e macOS:
    python windirstat_desktop.py [caminho_opcional]
"""

import hashlib
import math
import os
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

PALETTE = [
    "#3b82f6", "#ef4444", "#22c55e", "#eab308", "#06b6d4", "#d946ef",
    "#f97316", "#0ea5e9", "#ec4899", "#84cc16", "#8b5cf6", "#10b981",
    "#f43f5e", "#38bdf8", "#fb923c", "#2dd4bf", "#6366f1", "#cbd5e1",
]


def format_bytes(size: int) -> str:
    if size <= 0:
        return "0 B"
    units = ["B", "KiB", "MiB", "GiB", "TiB"]
    idx = min(len(units) - 1, int(math.log(size, 1024)))
    val = size / (1024 ** idx)
    return f"{val:.0f} {units[idx]}" if val >= 100 or idx == 0 else f"{val:.1f} {units[idx]}"


class Node:
    __slots__ = ("name", "path", "is_dir", "size_phys", "size_log", "files", "folders", "mtime", "children", "parent")

    def __init__(self, name: str, path: str, is_dir: bool, parent=None):
        self.name = name
        self.path = path
        self.is_dir = is_dir
        self.size_phys = 0
        self.size_log = 0
        self.files = 0
        self.folders = 0
        self.mtime = ""
        self.children = []
        self.parent = parent

    @property
    def ext(self) -> str:
        if self.is_dir:
            return ""
        _, ext = os.path.splitext(self.name)
        return ext.lower() if ext else ".noext"


def scan_folder(root_path: str, max_entries: int = 25000) -> Node:
    root_path = os.path.abspath(root_path)
    visited = 0

    def walk(cur_path: str, parent=None, is_root=False) -> Node | None:
        nonlocal visited
        name = cur_path if is_root else os.path.basename(cur_path) or cur_path
        try:
            st = os.lstat(cur_path)
        except OSError:
            return None

        if os.path.islink(cur_path):
            return None

        mtime = time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime))
        if not os.path.isdir(cur_path):
            node = Node(name, cur_path, False, parent)
            node.size_log = max(1, st.st_size)
            blocks = getattr(st, "st_blocks", 0)
            node.size_phys = blocks * 512 if blocks else max(4096, ((node.size_log + 4095) // 4096) * 4096)
            node.mtime = mtime
            return node

        node = Node(name, cur_path, True, parent)
        node.mtime = mtime
        try:
            with os.scandir(cur_path) as it:
                entries = list(it)
        except OSError:
            return node

        for entry in entries:
            if visited >= max_entries:
                break
            if not is_root and entry.name in (".git", "node_modules", ".cache", ".turbo"):
                continue
            visited += 1
            child = walk(entry.path, node, False)
            if child is not None:
                node.children.append(child)
                node.size_phys += child.size_phys
                node.size_log += child.size_log
                if child.is_dir:
                    node.folders += 1 + child.folders
                    node.files += child.files
                else:
                    node.files += 1

        node.children.sort(key=lambda c: c.size_phys, reverse=True)
        return node

    return walk(root_path, None, True) or Node(root_path, root_path, True)


def arrange_squarified(bounds, parent_weight, weights):
    x0, y0, x1, y1 = bounds
    count = len(weights)
    if count == 0 or x1 <= x0 or y1 <= y0 or parent_weight <= 0:
        return [(x0, y0, x0, y0)] * count

    regions = [(x0, y0, x0, y0)] * count
    rem_x0, rem_y0, rem_x1, rem_y1 = float(x0), float(y0), float(x1), float(y1)
    rem_weight = float(parent_weight)
    total_area = max(1.0, (rem_x1 - rem_x0) * (rem_y1 - rem_y0))
    weight_per_px = rem_weight / total_area
    head = 0

    while head < count and rem_x1 > rem_x0 and rem_y1 > rem_y0:
        rem_w = rem_x1 - rem_x0
        rem_h = rem_y1 - rem_y0
        horizontal = rem_w >= rem_h
        thickness = rem_h if horizontal else rem_w
        sq_row_weight = max(1e-9, thickness * thickness * weight_per_px)

        row_begin = head
        row_end = head
        worst = float("inf")
        largest = weights[row_begin]
        row_weight = 0.0

        while row_end < count:
            cw = weights[row_end]
            if cw <= 0:
                row_end = count
                break
            next_w = row_weight + cw
            sq_w = next_w * next_w
            next_worst = max((sq_row_weight * largest) / sq_w, sq_w / (sq_row_weight * cw))
            if row_end > row_begin and next_worst > worst:
                break
            row_weight = next_w
            row_end += 1
            worst = next_worst

        if row_weight <= 0:
            break

        extent = rem_w if horizontal else rem_h
        row_width = extent if row_weight >= rem_weight else max(1.0, (row_weight / rem_weight) * extent)

        if horizontal:
            rx0, ry0, rx1, ry1 = rem_x0, rem_y0, rem_x0 + row_width, rem_y1
            span = ry1 - ry0
            pos = ry0
            for i in range(row_begin, row_end):
                nxt = pos + (weights[i] / row_weight) * span
                regions[i] = (int(rx0), int(pos), int(rx1), int(ry1 if i + 1 == row_end else nxt))
                pos = nxt
            rem_x0 += row_width
        else:
            rx0, ry0, rx1, ry1 = rem_x0, rem_y0, rem_x1, rem_y0 + row_width
            span = rx1 - rx0
            pos = rx0
            for i in range(row_begin, row_end):
                nxt = pos + (weights[i] / row_weight) * span
                regions[i] = (int(pos), int(ry0), int(rx1 if i + 1 == row_end else nxt), int(ry1))
                pos = nxt
            rem_y0 += row_width

        rem_weight -= row_weight
        head = row_end

    return regions


class WinDirStatDesktopApp(tk.Tk):
    def __init__(self, initial_path: str):
        super().__init__()
        self.title("WinDirStat 2.9.3 Desktop — Reconstrução REA para PC")
        self.geometry("1280x800")
        self.configure(bg="#0b0f17")

        self.root_node: Node | None = None
        self.zoom_node: Node | None = None
        self.ext_colors: dict[str, str] = {}
        self.rect_items: list[tuple[tuple[int, int, int, int], Node]] = []
        self.tree_map_id_to_node: dict[str, Node] = {}

        self._build_ui(initial_path)
        self.start_scan(initial_path)

    def _build_ui(self, initial_path: str):
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("Treeview", background="#111827", foreground="#f1f5f9", fieldbackground="#111827", rowheight=24)
        style.configure("Treeview.Heading", background="#1e293b", foreground="#94a3b8", font=("Segoe UI", 9, "bold"))

        top_bar = tk.Frame(self, bg="#0f172a", padx=10, pady=8)
        top_bar.pack(fill=tk.X)

        tk.Label(
            top_bar,
            text="WinDirStat 2.9.3 PC",
            bg="#0284c7",
            fg="#ffffff",
            font=("Segoe UI", 10, "bold"),
            padx=8,
            pady=3,
        ).pack(side=tk.LEFT, padx=(0, 10))

        self.path_var = tk.StringVar(value=initial_path)
        entry = tk.Entry(top_bar, textvariable=self.path_var, width=52, bg="#1e293b", fg="#f1f5f9", insertbackground="#fff")
        entry.pack(side=tk.LEFT, padx=4)

        tk.Button(
            top_bar,
            text="📂 Escolher Pasta do PC",
            command=self.pick_folder,
            bg="#2563eb",
            fg="#fff",
            relief=tk.FLAT,
            padx=10,
        ).pack(side=tk.LEFT, padx=4)

        tk.Button(
            top_bar,
            text="🔍 Escanear",
            command=lambda: self.start_scan(self.path_var.get()),
            bg="#059669",
            fg="#fff",
            relief=tk.FLAT,
            padx=10,
        ).pack(side=tk.LEFT, padx=4)

        tk.Button(
            top_bar,
            text="⬆ Subir Nível Zoom",
            command=self.zoom_out,
            bg="#334155",
            fg="#fff",
            relief=tk.FLAT,
            padx=8,
        ).pack(side=tk.LEFT, padx=4)

        self.status_var = tk.StringVar(value="Pronto")
        tk.Label(top_bar, textvariable=self.status_var, bg="#0f172a", fg="#38bdf8", font=("Consolas", 9)).pack(side=tk.RIGHT)

        paned = tk.PanedWindow(self, orient=tk.VERTICAL, bg="#334155", sashwidth=4)
        paned.pack(fill=tk.BOTH, expand=True)

        upper = tk.PanedWindow(paned, orient=tk.HORIZONTAL, bg="#334155", sashwidth=4)
        paned.add(upper, height=300)

        # Left: Directory Tree
        tree_frame = tk.Frame(upper, bg="#111827")
        cols = ("pct", "phys", "log", "files", "folders", "mtime")
        self.tree = ttk.Treeview(tree_frame, columns=cols, selectmode="browse")
        self.tree.heading("#0", text="Nome (Directory Tree)")
        self.tree.heading("pct", text="%")
        self.tree.heading("phys", text="Physical Size")
        self.tree.heading("log", text="Logical Size")
        self.tree.heading("files", text="Files")
        self.tree.heading("folders", text="Folders")
        self.tree.heading("mtime", text="Modified")

        self.tree.column("#0", width=310)
        self.tree.column("pct", width=70, anchor=tk.E)
        self.tree.column("phys", width=100, anchor=tk.E)
        self.tree.column("log", width=100, anchor=tk.E)
        self.tree.column("files", width=70, anchor=tk.E)
        self.tree.column("folders", width=70, anchor=tk.E)
        self.tree.column("mtime", width=120, anchor=tk.E)

        vsb = ttk.Scrollbar(tree_frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        vsb.pack(side=tk.RIGHT, fill=tk.Y)
        self.tree.bind("<<TreeviewSelect>>", self.on_tree_select)
        self.tree.bind("<Double-1>", self.on_tree_double_click)
        upper.add(tree_frame, width=820)

        # Right: Extension List
        ext_frame = tk.Frame(upper, bg="#111827")
        self.ext_tree = ttk.Treeview(ext_frame, columns=("bytes", "pct", "count"), show="headings")
        self.ext_tree.heading("bytes", text="Extension / Bytes")
        self.ext_tree.heading("pct", text="%")
        self.ext_tree.heading("count", text="Files")
        self.ext_tree.column("bytes", width=180)
        self.ext_tree.column("pct", width=70, anchor=tk.E)
        self.ext_tree.column("count", width=70, anchor=tk.E)
        self.ext_tree.pack(fill=tk.BOTH, expand=True)
        upper.add(ext_frame, width=420)

        # Bottom: Treemap Canvas
        canvas_frame = tk.Frame(paned, bg="#05070b")
        self.canvas = tk.Canvas(canvas_frame, bg="#05070b", highlightthickness=0)
        self.canvas.pack(fill=tk.BOTH, expand=True)
        self.canvas.bind("<Configure>", lambda _e: self.draw_treemap())
        self.canvas.bind("<Button-1>", self.on_canvas_click)
        paned.add(canvas_frame)

    def pick_folder(self):
        picked = filedialog.askdirectory(initialdir=self.path_var.get() or os.getcwd())
        if picked:
            self.path_var.set(picked)
            self.start_scan(picked)

    def start_scan(self, target_path: str):
        if not os.path.exists(target_path):
            messagebox.showerror("Erro", f"Caminho não encontrado:\n{target_path}")
            return
        self.status_var.set(f"Escaneando {target_path}...")

        def worker():
            root = scan_folder(target_path)
            self.after(0, lambda: self.on_scan_finished(root))

        threading.Thread(target=worker, daemon=True).start()

    def on_scan_finished(self, root: Node):
        self.root_node = root
        self.zoom_node = root
        self.status_var.set(
            f"Concluído: {root.path} | {format_bytes(root.size_phys)} ({root.files} arquivos, {root.folders} pastas)"
        )
        self.populate_extensions()
        self.populate_tree()
        self.draw_treemap()

    def populate_extensions(self):
        for item in self.ext_tree.get_children():
            self.ext_tree.delete(item)
        stats: dict[str, list[int]] = {}

        def walk(n: Node):
            if not n.children:
                ext = n.ext
                if ext:
                    rec = stats.setdefault(ext, [0, 0])
                    rec[0] += n.size_phys
                    rec[1] += 1
                return
            for c in n.children:
                walk(c)

        if self.root_node:
            walk(self.root_node)

        sorted_exts = sorted(stats.items(), key=lambda kv: kv[1][0], reverse=True)
        total = max(1, self.root_node.size_phys if self.root_node else 1)
        self.ext_colors.clear()
        for idx, (ext, (b, cnt)) in enumerate(sorted_exts):
            color = PALETTE[idx % len(PALETTE)]
            self.ext_colors[ext] = color
            pct = (b / total) * 100.0
            self.ext_tree.insert("", tk.END, values=(f"{ext}  ({format_bytes(b)})", f"{pct:.1f}%", str(cnt)))

    def populate_tree(self):
        for item in self.tree.get_children():
            self.tree.delete(item)
        self.tree_map_id_to_node.clear()
        if not self.root_node:
            return

        def insert_node(parent_iid: str, node: Node, depth: int):
            parent_total = node.parent.size_phys if node.parent else node.size_phys
            pct = (node.size_phys / parent_total * 100.0) if parent_total > 0 else 100.0
            iid = self.tree.insert(
                parent_iid,
                tk.END,
                text=f"{'📁' if node.is_dir else '📄'} {node.name}",
                open=depth < 2,
                values=(
                    f"{pct:.1f}%",
                    format_bytes(node.size_phys),
                    format_bytes(node.size_log),
                    str(node.files) if node.is_dir else "1",
                    str(node.folders) if node.is_dir else "—",
                    node.mtime,
                ),
            )
            self.tree_map_id_to_node[iid] = node
            if depth < 3:
                for c in node.children[:150]:
                    insert_node(iid, c, depth + 1)

        insert_node("", self.root_node, 0)

    def draw_treemap(self):
        self.canvas.delete("all")
        self.rect_items.clear()
        root = self.zoom_node or self.root_node
        if not root or root.size_phys <= 0:
            return

        w = max(100, self.canvas.winfo_width())
        h = max(100, self.canvas.winfo_height())

        stack = [(root, (2, 2, w - 2, h - 2), 0)]
        while stack:
            node, rc, depth = stack.pop()
            x0, y0, x1, y1 = rc
            if x1 - x0 <= 2 or y1 - y0 <= 2:
                continue

            if not node.children or depth >= 6:
                color = self.ext_colors.get(node.ext, "#64748b")
                self.canvas.create_rectangle(x0, y0, x1, y1, fill=color, outline="#0b0f17", width=1)
                if (x1 - x0) > 48 and (y1 - y0) > 18:
                    self.canvas.create_text(
                        (x0 + x1) // 2,
                        (y0 + y1) // 2,
                        text=node.name[:16],
                        fill="#ffffff",
                        font=("Consolas", 8, "bold"),
                    )
                self.rect_items.append((rc, node))
                continue

            weights = [c.size_phys for c in node.children]
            regions = arrange_squarified(rc, node.size_phys, weights)
            for child, reg in zip(reversed(node.children), reversed(regions)):
                stack.append((child, reg, depth + 1))

    def on_tree_select(self, _event):
        sel = self.tree.selection()
        if not sel:
            return
        node = self.tree_map_id_to_node.get(sel[0])
        if node:
            self.status_var.set(f"Selecionado: {node.path} ({format_bytes(node.size_phys)})")

    def on_tree_double_click(self, _event):
        sel = self.tree.selection()
        if not sel:
            return
        node = self.tree_map_id_to_node.get(sel[0])
        if node and node.is_dir:
            self.zoom_node = node
            self.draw_treemap()

    def zoom_out(self):
        if self.zoom_node and self.zoom_node.parent:
            self.zoom_node = self.zoom_node.parent
            self.draw_treemap()

    def on_canvas_click(self, event):
        x, y = event.x, event.y
        for (x0, y0, x1, y1), node in reversed(self.rect_items):
            if x0 <= x <= x1 and y0 <= y <= y1:
                self.status_var.set(
                    f"Treemap Hit: {node.path} | Physical: {format_bytes(node.size_phys)} | Logical: {format_bytes(node.size_log)}"
                )
                break


if __name__ == "__main__":
    start_dir = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    app = WinDirStatDesktopApp(start_dir)
    app.mainloop()
