#!/usr/bin/env python3
"""Generates the render fixtures in spec/fixtures/render/ (design JSON + procedural asset images).

Usage: python3 scripts/gen_render_fixtures.py ../../spec/fixtures/render

Expected PNGs are produced by the Rust golden test (DESYN_UPDATE_GOLDENS=1 cargo test --test golden) after the
images were inspected; this script only writes inputs. Requires Pillow for the asset images.
"""

import json
import math
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

OUT = sys.argv[1] if len(sys.argv) > 1 else "spec/fixtures/render"
ASSETS = os.path.join(OUT, "assets")

_ids = {}


def nid(name):
    """Stable 12-char [a-z0-9] id from a readable name."""
    if name in _ids:
        return _ids[name]
    s = "".join(c for c in name.lower() if c.isalnum())[:8]
    n = len(_ids) + 1
    v = (s + "x" * 8)[:8] + format(n, "04d")
    _ids[name] = v
    return v


def color(c):
    return c.lower()


def solid(c, **kw):
    f = {"type": "solid", "color": color(c)}
    f.update(kw)
    return f


def stops(*pairs):
    return [{"pos": p, "color": color(c)} for p, c in pairs]


def linear(angle, *pairs, **kw):
    f = {"type": "linear", "angle": angle, "stops": stops(*pairs)}
    f.update(kw)
    return f


def radial(cx, cy, rx, ry, *pairs, **kw):
    f = {"type": "radial", "cx": cx, "cy": cy, "rx": rx, "ry": ry, "stops": stops(*pairs)}
    f.update(kw)
    return f


def conic(cx, cy, angle, *pairs, **kw):
    f = {"type": "conic", "cx": cx, "cy": cy, "angle": angle, "stops": stops(*pairs)}
    f.update(kw)
    return f


def stroke(c, w, align="center", **kw):
    s = {"fills": [solid(c)], "width": w, "align": align, "cap": "butt", "join": "miter"}
    s.update(kw)
    return s


def base(t, name, x, y, w, h, **kw):
    n = {
        "id": nid(name),
        "type": t,
        "name": name,
        "parent": None,
        "x": x,
        "y": y,
        "width": w,
        "height": h,
        "rotation": 0,
        "opacity": 1,
        "blend": "normal",
        "visible": True,
        "locked": False,
        "effects": [],
    }
    n.update(kw)
    return n


def shaped(t, name, x, y, w, h, fills=None, strokes=None, radius=0, **kw):
    n = base(t, name, x, y, w, h, **kw)
    n.setdefault("fills", fills if fills is not None else [solid("#d9d9d9")])
    n.setdefault("strokes", strokes or [])
    n.setdefault("cornerRadius", radius)
    return n


def rect(name, x, y, w, h, **kw):
    return shaped("rect", name, x, y, w, h, **kw)


def ellipse(name, x, y, w, h, **kw):
    return shaped("ellipse", name, x, y, w, h, **kw)


def polygon(name, x, y, w, h, sides, **kw):
    return shaped("polygon", name, x, y, w, h, sides=sides, **kw)


def star(name, x, y, w, h, points, inner, **kw):
    return shaped("star", name, x, y, w, h, points=points, innerRatio=inner, **kw)


def path(name, x, y, w, h, paths, **kw):
    return shaped("path", name, x, y, w, h, paths=paths, **kw)


def line(name, x, y, length, strokes, start="none", end="none", **kw):
    n = base("line", name, x, y, length, 0, **kw)
    n.update({"strokes": strokes, "startCap": start, "endCap": end})
    return n


def container(t, name, x, y, w, h, children, clip=False, **kw):
    n = base(t, name, x, y, w, h, **kw)
    n["children"] = children
    n["clip"] = clip
    return n


def frame(name, x, y, w, h, children, fills=None, strokes=None, radius=0, clip=True, **kw):
    n = container("frame", name, x, y, w, h, children, clip=clip, **kw)
    n["fills"] = fills if fills is not None else [solid("#ffffff")]
    n["strokes"] = strokes or []
    n["cornerRadius"] = radius
    return n


def group(name, x, y, w, h, children, **kw):
    return container("group", name, x, y, w, h, children, **kw)


def boolean(name, op, x, y, w, h, children, fills=None, **kw):
    n = container("boolean", name, x, y, w, h, children, **kw)
    n["op"] = op
    n["fills"] = fills if fills is not None else [solid("#d9d9d9")]
    n["strokes"] = kw.pop("strokes", [])
    n["cornerRadius"] = 0
    return n


def text_style(family="Inter", weight=400, size=24, fill="#111111", **kw):
    s = {
        "fontFamily": family,
        "fontWeight": weight,
        "fontStyle": "normal",
        "fontSize": size,
        "fills": [solid(fill)] if isinstance(fill, str) else fill,
        "letterSpacing": 0,
        "textCase": "none",
        "decoration": "none",
    }
    s.update(kw)
    return s


def paragraph(align="left", lh=None, **kw):
    p = {
        "align": align,
        "direction": "auto",
        "lineHeight": lh or {"unit": "percent", "value": 120},
        "spacing": 0,
        "indent": 0,
        "list": "none",
    }
    p.update(kw)
    return p


def text(name, x, y, w, h, runs, style=None, para=None, auto="height", valign="top", **kw):
    n = base("text", name, x, y, w, h, **kw)
    if isinstance(runs, str):
        runs = [{"text": runs}]
    n.update(
        {
            "runs": runs,
            "style": style or text_style(),
            "paragraph": para or paragraph(),
            "autoResize": auto,
            "verticalAlign": valign,
        }
    )
    return n


def image(name, x, y, w, h, asset, fit="fill", radius=0, **kw):
    n = base("image", name, x, y, w, h)
    n.update({"assetId": asset, "fit": fit, "cornerRadius": radius, "strokes": kw.pop("strokes", [])})
    n.update(kw)
    return n


def svg(name, x, y, w, h, markup=None, asset=None, **kw):
    n = base("svg", name, x, y, w, h)
    if markup:
        n["markup"] = markup
    if asset:
        n["assetId"] = asset
    n.update(kw)
    return n


def chart(name, x, y, w, h, kind, cats, series, **opts):
    n = base("chart", name, x, y, w, h)
    o = {
        "legend": True,
        "grid": True,
        "labels": False,
        "palette": ["#ffb02e", "#4f8cff", "#2fbf71", "#e5484d", "#a463f2"],
        "fontFamily": "Inter",
        "fontSize": 12,
        "textColor": "#2b2b30",
    }
    o.update(opts)
    n.update({"chart": kind, "data": {"labels": cats, "series": series}, "options": o})
    return n


def table(name, x, y, w, h, rows, cols, cells, **kw):
    n = base("table", name, x, y, w, h)
    n.update(
        {
            "rows": rows,
            "cols": cols,
            "colWidths": kw.pop("colWidths", [w / cols] * cols),
            "rowHeights": kw.pop("rowHeights", [h / rows] * rows),
            "cells": cells,
            "header": kw.pop("header", True),
            "stripe": kw.pop("stripe", True),
            "borderColor": kw.pop("borderColor", "#d4d4d8"),
            "borderWidth": kw.pop("borderWidth", 1),
            "cellPadding": kw.pop("cellPadding", 8),
            "defaultStyle": kw.pop("defaultStyle", text_style(size=13, fill="#1f1f23")),
        }
    )
    n.update(kw)
    return n


def qr(name, x, y, size, data, fg="#111111", bg="#ffffff", ec="M", rounded=False):
    n = base("qr", name, x, y, size, size)
    n.update({"data": data, "fg": fg, "bg": bg, "errorCorrection": ec, "rounded": rounded})
    return n


def design(name, w, h, children, background=None, kind="social-post", assets=None, extra_pages=None, page_kw=None):
    """children: list of (node, [descendants...]) trees given as nested dicts with '_children'."""
    nodes = {}
    pid = nid(name + "-page")
    page = base("page", "Page 1", 0, 0, w, h)
    page.update(
        {
            "id": pid,
            "children": [],
            "clip": True,
            "unit": "px",
            "background": background if background is not None else [solid("#ffffff")],
            "bleed": 0,
        }
    )
    page.update(page_kw or {})
    root = base("root", "Root", 0, 0, 0, 0)
    root.update({"id": "root", "children": [pid]})
    nodes["root"] = root
    nodes[pid] = page

    def add(parent_id, tree):
        node = dict(tree)
        kids = node.pop("_children", [])
        node["parent"] = parent_id
        if node["type"] in ("frame", "group", "boolean"):
            node["children"] = []
        nodes[node["id"]] = node
        nodes[parent_id]["children"].append(node["id"])
        for k in kids:
            add(node["id"], k)

    for c in children:
        add(pid, c)
    for p in extra_pages or []:
        ptree = dict(p)
        pkids = ptree.pop("_children", [])
        ptree["parent"] = "root"
        ptree["children"] = []
        nodes[ptree["id"]] = ptree
        root["children"].append(ptree["id"])
        for k in pkids:
            add(ptree["id"], k)
    return {
        "schema": 1,
        "id": nid(name + "-design"),
        "name": name,
        "kind": kind,
        "nodes": nodes,
        "assets": assets or {},
        "styles": {"colors": {}, "text": {}, "effects": {}, "variables": {}},
        "meta": {},
    }


def kids(node, children):
    node = dict(node)
    node["_children"] = children
    return node


# ---------------------------------------------------------------------------------------------------- assets


def make_assets():
    os.makedirs(ASSETS, exist_ok=True)
    # A photo-like landscape: dusk sky gradient, sun with glow, layered hills, water reflection.
    w, h = 960, 640
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / h
        for x in range(w):
            if t < 0.62:
                k = t / 0.62
                r = int(36 + (255 - 36) * k)
                g = int(28 + (142 - 28) * k ** 1.4)
                b = int(84 + (90 - 84) * k)
            else:
                k = (t - 0.62) / 0.38
                r = int(70 - 40 * k)
                g = int(54 - 30 * k)
                b = int(96 - 30 * k)
            px[x, y] = (r, g, b)
    glow = Image.new("RGB", (w, h), (0, 0, 0))
    d = ImageDraw.Draw(glow)
    d.ellipse((w * 0.58 - 120, h * 0.5 - 120, w * 0.58 + 120, h * 0.5 + 120), fill=(255, 176, 46))
    glow = glow.filter(ImageFilter.GaussianBlur(60))
    img = ImageChops.add(img, glow, scale=1.0)
    d = ImageDraw.Draw(img)
    d.ellipse((w * 0.58 - 54, h * 0.5 - 54, w * 0.58 + 54, h * 0.5 + 54), fill=(255, 226, 150))
    for i, (col, base_y, amp, freq, ph) in enumerate(
        [
            ((92, 52, 92), 0.56, 40, 2.1, 0.3),
            ((60, 34, 70), 0.6, 30, 3.3, 1.2),
            ((34, 20, 44), 0.64, 22, 4.7, 2.0),
        ]
    ):
        pts = [(0, h)]
        for x in range(0, w + 8, 8):
            y = h * base_y - amp * math.sin(x / w * freq * math.pi + ph) - amp * 0.4 * math.sin(x / w * freq * 3.1)
            pts.append((x, y))
        pts.append((w, h))
        d.polygon(pts, fill=col)
    # Shimmering reflection: short streaks that narrow and fade with depth.
    refl = Image.new("RGB", (w, h), (0, 0, 0))
    rd = ImageDraw.Draw(refl)
    sx = w * 0.58
    for i, y in enumerate(range(int(h * 0.7), h, 7)):
        k = 1 - (y - h * 0.7) / (h * 0.3)
        half = 70 * k + 8 + 18 * math.sin(i * 1.7)
        c = int(150 * k + 30)
        rd.line((sx - half, y, sx + half, y), fill=(c, int(c * 0.7), int(c * 0.35)), width=2)
    refl = refl.filter(ImageFilter.GaussianBlur(1.6))
    img = ImageChops.add(img, refl)
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    img.save(os.path.join(ASSETS, "photo0000001.jpg"), quality=88)

    # Portrait-ish subject on transparent background (logo / cutout) + its matte.
    s = 400
    cut = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(cut)
    d.ellipse((60, 60, 340, 340), fill=(255, 176, 46, 255))
    d.ellipse((120, 110, 280, 270), fill=(255, 226, 150, 255))
    d.rectangle((180, 20, 220, 380), fill=(43, 43, 48, 255))
    cut.save(os.path.join(ASSETS, "cutout000001.png"))
    matte = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(matte)
    d.ellipse((40, 40, 360, 360), fill=255)
    matte = matte.filter(ImageFilter.GaussianBlur(14))
    Image.merge("RGBA", [matte, matte, matte, matte]).save(os.path.join(ASSETS, "matte0000001.png"))

    # Small seamless tile pattern.
    t = 48
    tile = Image.new("RGBA", (t, t), (255, 248, 236, 255))
    d = ImageDraw.Draw(tile)
    d.ellipse((6, 6, 22, 22), fill=(255, 176, 46, 255))
    d.ellipse((30, 30, 42, 42), fill=(79, 140, 255, 255))
    tile.save(os.path.join(ASSETS, "tile00000001.png"))

    # SVG asset (icon with gradient).
    with open(os.path.join(ASSETS, "icon00000001.svg"), "w") as f:
        f.write(
            """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb02e"/><stop offset="1" stop-color="#e5484d"/></linearGradient></defs>
<circle cx="32" cy="32" r="28" fill="url(#g)"/>
<path d="M20 34l8 8 16-18" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>"""
        )


def asset(aid, kind, mime, w=None, h=None):
    a = {"id": aid, "kind": kind, "mime": mime}
    if w:
        a["width"] = w
        a["height"] = h
    return a


PHOTO = asset("photo0000001", "image", "image/jpeg", 960, 640)
CUTOUT = asset("cutout000001", "image", "image/png", 400, 400)
MATTE = asset("matte0000001", "image", "image/png", 400, 400)
TILE = asset("tile00000001", "image", "image/png", 48, 48)
ICON = asset("icon00000001", "svg", "image/svg+xml", 64, 64)


def assets(*refs):
    return {r["id"]: r for r in refs}


# ---------------------------------------------------------------------------------------------------- fixtures


def fx_shapes():
    c = []
    c.append(rect("rect-plain", 20, 20, 100, 70, fills=[solid("#4f8cff")]))
    c.append(rect("rect-radii", 140, 20, 100, 70, fills=[solid("#ffb02e")], cornerRadius=[0, 24, 8, 35]))
    c.append(rect("rect-smooth", 260, 20, 100, 70, fills=[solid("#2fbf71")], cornerRadius=24, cornerSmoothing=1))
    c.append(rect("rect-rotated", 380, 25, 80, 60, fills=[solid("#e5484d")], rotation=30, cornerRadius=10))
    c.append(ellipse("ellipse", 20, 110, 100, 80, fills=[solid("#a463f2")]))
    c.append(ellipse("pie", 140, 110, 90, 90, fills=[solid("#ffb02e")], arc={"start": -90, "end": 180, "inner": 0}))
    c.append(ellipse("donut", 250, 110, 90, 90, fills=[solid("#14b8a6")], arc={"start": 0, "end": 300, "inner": 0.55}))
    c.append(ellipse("ring", 360, 110, 90, 90, fills=[solid("#2b2b30")], arc={"start": 0, "end": 360, "inner": 0.8}))
    c.append(polygon("triangle", 20, 215, 90, 80, 3, fills=[solid("#4f8cff")]))
    c.append(polygon("hexagon", 130, 215, 90, 80, 6, fills=[solid("#2fbf71")], cornerRadius=8))
    c.append(star("star5", 240, 210, 90, 90, 5, 0.45, fills=[solid("#ffb02e")]))
    c.append(star("star12", 350, 210, 90, 90, 12, 0.7, fills=[solid("#e5484d")], cornerRadius=3))
    c.append(
        path(
            "path-evenodd",
            20,
            315,
            100,
            100,
            [{"d": "M0 0H100V100H0Z M25 25V75H75V25Z", "fillRule": "evenodd"}],
            fills=[solid("#2b2b30")],
        )
    )
    c.append(
        path(
            "path-curve",
            130,
            315,
            100,
            100,
            [{"d": "M10 90C10 10 90 10 90 90Q50 60 10 90Z", "fillRule": "nonzero"}],
            fills=[solid("#a463f2")],
            strokes=[stroke("#2b2b30", 3, join="round")],
        )
    )
    colors = ["#4f8cff", "#e5484d", "#2fbf71", "#ffb02e"]
    for i, op in enumerate(["union", "subtract", "intersect", "exclude"]):
        b = boolean(f"bool-{op}", op, 250 + (i % 2) * 110, 310 + (i // 2) * 90, 80, 80, [], fills=[solid(colors[i])])
        b = kids(
            b,
            [
                rect(f"bool-{op}-a", 0, 0, 55, 55, fills=[solid("#000000")]),
                ellipse(f"bool-{op}-b", 25, 25, 55, 55, fills=[solid("#000000")]),
            ],
        )
        c.append(b)
    c.append(line("line-arrow", 20, 440, 200, [stroke("#2b2b30", 3, cap="round")], start="circle", end="arrow"))
    c.append(line("line-tri", 20, 470, 200, [stroke("#e5484d", 4)], start="bar", end="triangle"))
    c.append(line("line-diamond", 20, 500, 440, [stroke("#4f8cff", 6, cap="round")], start="square", end="diamond"))
    return design("shapes", 480, 520, c, background=[solid("#f6f4f0")])


def fx_paints():
    c = []
    c.append(rect("lin-0", 20, 20, 140, 90, fills=[linear(90, (0, "#ffb02e"), (1, "#e5484d"))], radius=12))
    c.append(rect("lin-45", 170, 20, 140, 90, fills=[linear(45, (0, "#4f8cff"), (0.5, "#a463f2"), (1, "#e5484d"))], radius=12))
    c.append(rect("lin-180", 320, 20, 140, 90, fills=[linear(180, (0, "#ffffff"), (1, "#2b2b30"))], radius=12))
    c.append(rect("radial", 20, 125, 140, 90, fills=[radial(0.5, 0.5, 0.5, 0.5, (0, "#fff3d6"), (0.6, "#ffb02e"), (1, "#7a2e00"))], radius=12))
    c.append(rect("radial-off", 170, 125, 140, 90, fills=[radial(0.2, 0.3, 0.9, 0.7, (0, "#ffffff"), (1, "#4f8cff"))], radius=12))
    c.append(
        ellipse(
            "conic",
            340,
            125,
            100,
            100,
            fills=[conic(0.5, 0.5, 0, (0, "#ff0000"), (0.17, "#ffff00"), (0.33, "#00ff00"), (0.5, "#00ffff"), (0.67, "#0000ff"), (0.83, "#ff00ff"), (1, "#ff0000"))],
        )
    )
    c.append(rect("img-fill", 20, 240, 140, 100, fills=[{"type": "image", "assetId": "photo0000001", "mode": "fill"}], radius=16))
    c.append(rect("img-fit", 170, 240, 140, 100, fills=[solid("#2b2b30"), {"type": "image", "assetId": "photo0000001", "mode": "fit"}], radius=16))
    c.append(rect("img-tile", 320, 240, 140, 100, fills=[{"type": "image", "assetId": "tile00000001", "mode": "tile", "scale": 0.5}], radius=16))
    c.append(rect("img-stretch", 20, 355, 140, 100, fills=[{"type": "image", "assetId": "photo0000001", "mode": "stretch", "adjust": {"saturation": -1}}], radius=16))
    c.append(
        rect(
            "stack",
            170,
            355,
            140,
            100,
            fills=[
                solid("#4f8cff"),
                linear(90, (0, "#ffffff00"), (1, "#ffffff")),
                solid("#e5484d", opacity=0.35, blend="multiply"),
            ],
            radius=16,
        )
    )
    c.append(rect("opacity", 320, 355, 140, 100, fills=[solid("#2fbf71", opacity=0.5)], radius=16, strokes=[stroke("#2b2b30", 2)]))
    return design("paints", 480, 480, c, assets=assets(PHOTO, TILE), background=[solid("#ffffff")])


def fx_strokes():
    c = []
    aligns = ["inside", "center", "outside"]
    for i, a in enumerate(aligns):
        c.append(rect(f"rect-{a}", 30 + i * 150, 30, 120, 80, fills=[solid("#fff3d6")], strokes=[stroke("#2b2b30", 10, a)], radius=18))
        c.append(ellipse(f"ell-{a}", 40 + i * 150, 135, 100, 80, fills=[solid("#e7efff")], strokes=[stroke("#4f8cff", 10, a)]))
        c.append(star(f"star-{a}", 45 + i * 150, 235, 90, 90, 5, 0.5, fills=[solid("#ffe4e4")], strokes=[stroke("#e5484d", 6, a, join="round")]))
    c.append(rect("dashed", 30, 350, 120, 80, fills=[], strokes=[stroke("#2b2b30", 4, dash=[12, 6], cap="round")], radius=12))
    c.append(
        rect(
            "per-side",
            180,
            350,
            120,
            80,
            fills=[solid("#f1f1f4")],
            strokes=[stroke("#a463f2", 1, "inside", sides=[0, 0, 8, 2])],
        )
    )
    c.append(
        path(
            "joins",
            330,
            350,
            120,
            80,
            [{"d": "M0 80L30 0L60 80L90 0L120 80", "fillRule": "nonzero"}],
            fills=[],
            strokes=[stroke("#2fbf71", 10, join="bevel"), stroke("#2b2b30", 2, join="miter")],
        )
    )
    c.append(
        rect(
            "multi",
            30,
            450,
            420,
            14,
            fills=[],
            strokes=[
                {"fills": [linear(90, (0, "#ffb02e"), (1, "#a463f2"))], "width": 6, "align": "center", "cap": "round", "join": "round"}
            ],
            radius=7,
        )
    )
    return design("strokes", 480, 480, c, background=[solid("#ffffff")])


def fx_effects():
    c = []
    card = lambda n, x, y, eff, **kw: rect(n, x, y, 130, 100, fills=[solid("#ffffff")], radius=18, effects=eff, **kw)
    c.append(card("drop", 30, 30, [{"type": "dropShadow", "x": 0, "y": 10, "blur": 24, "spread": 0, "color": "#0000004d"}]))
    c.append(card("drop-spread", 180, 30, [{"type": "dropShadow", "x": 8, "y": 8, "blur": 0, "spread": 4, "color": "#e5484d"}]))
    c.append(
        card(
            "inner",
            330,
            30,
            [{"type": "innerShadow", "x": 0, "y": 6, "blur": 12, "spread": 0, "color": "#4f8cff99"}],
        )
    )
    c.append(
        kids(
            group("blur-group", 30, 170, 130, 100, [], effects=[{"type": "layerBlur", "radius": 8}]),
            [
                ellipse("blur-a", 0, 0, 80, 80, fills=[solid("#ffb02e")]),
                rect("blur-b", 50, 30, 80, 70, fills=[solid("#4f8cff")], radius=12),
            ],
        )
    )
    c.append(
        ellipse(
            "glow",
            205,
            180,
            80,
            80,
            fills=[solid("#ffb02e")],
            effects=[{"type": "glow", "radius": 30, "strength": 0.8, "color": "#ffb02e"}],
        )
    )
    c.append(
        rect(
            "noise",
            330,
            170,
            130,
            100,
            fills=[linear(135, (0, "#a463f2"), (1, "#4f8cff"))],
            radius=18,
            effects=[{"type": "noise", "amount": 0.6, "scale": 2, "mono": True}],
        )
    )
    # Background blur over a busy backdrop.
    for i in range(6):
        c.append(ellipse(f"dot-{i}", 40 + i * 70, 320, 60, 60, fills=[solid(["#ffb02e", "#e5484d", "#4f8cff", "#2fbf71", "#a463f2", "#14b8a6"][i])]))
    c.append(text("behind", 40, 395, 400, 40, "Frosted glass panel", style=text_style(weight=700, size=30, fill="#2b2b30")))
    c.append(
        rect(
            "glass",
            60,
            300,
            360,
            150,
            fills=[solid("#ffffff59")],
            strokes=[stroke("#ffffffb3", 1, "inside")],
            radius=24,
            effects=[{"type": "backgroundBlur", "radius": 24}, {"type": "dropShadow", "x": 0, "y": 8, "blur": 30, "spread": 0, "color": "#00000026"}],
        )
    )
    return design("effects", 480, 480, c, background=[solid("#f3f1ec")])


def fx_blend():
    modes = [
        "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn",
        "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity",
    ]
    c = [rect("backdrop", 0, 0, 480, 480, fills=[linear(90, (0, "#1b3a8a"), (0.5, "#ffb02e"), (1, "#e9f3ff"))])]
    for i, m in enumerate(modes):
        x = 20 + (i % 4) * 115
        y = 20 + (i // 4) * 115
        c.append(ellipse(f"blend-{m}", x, y, 95, 95, fills=[radial(0.35, 0.35, 0.7, 0.7, (0, "#ff5f6d"), (1, "#5ac8a8"))], blend=m))
    return design("blend", 480, 480, c)


def fx_masks():
    c = []
    # Alpha mask: star masks the photo and a stripe.
    c.append(
        kids(
            group("mask-group", 20, 20, 200, 200, []),
            [
                star("mask-star", 0, 0, 200, 200, 6, 0.55, fills=[solid("#000000")], mask=True),
                image("masked-photo", 0, 0, 200, 200, "photo0000001"),
                rect("masked-stripe", 0, 120, 200, 30, fills=[solid("#ffb02ecc")]),
            ],
        )
    )
    # Luminance mask: gradient fades the content.
    lum = rect("lum-mask", 0, 0, 200, 200, fills=[linear(90, (0, "#ffffff"), (1, "#000000"))], mask=True)
    lum["maskType"] = "luminance"
    c.append(
        kids(
            group("lum-group", 250, 20, 200, 200, []),
            [lum, rect("lum-content", 0, 0, 200, 200, fills=[solid("#4f8cff")], radius=24)],
        )
    )
    # Clipping frame, rotated, with overflowing children and group opacity.
    c.append(
        kids(
            frame("clip-frame", 40, 260, 180, 160, [], fills=[solid("#fff3d6")], radius=28, rotation=-8),
            [
                ellipse("clip-big", -40, 60, 160, 160, fills=[solid("#e5484d")]),
                rect("clip-bar", 100, -20, 40, 220, fills=[solid("#2b2b30")]),
            ],
        )
    )
    c.append(
        kids(
            group("opacity-group", 260, 260, 190, 170, [], opacity=0.5),
            [
                rect("og-a", 0, 0, 120, 120, fills=[solid("#2fbf71")], radius=12),
                rect("og-b", 70, 50, 120, 120, fills=[solid("#a463f2")], radius=12),
            ],
        )
    )
    c.append(rect("flipped", 400, 440, 60, 30, fills=[linear(90, (0, "#2b2b30"), (1, "#ffb02e"))], flipX=True))
    return design("masks", 480, 480, c, assets=assets(PHOTO), background=[solid("#f7f7f5")])


def fx_text():
    c = []
    c.append(
        text(
            "headline",
            24,
            20,
            432,
            60,
            "Atmospheric Minimalism",
            style=text_style("Instrument Serif", 400, 46, "#1b1b1f"),
        )
    )
    c.append(
        text(
            "rich",
            24,
            86,
            432,
            80,
            [
                {"text": "Rich text with "},
                {"text": "bold", "style": {"fontWeight": 700}},
                {"text": ", "},
                {"text": "italic", "style": {"fontStyle": "italic"}},
                {"text": ", "},
                {"text": "underline", "style": {"decoration": "underline", "fills": [solid("#4f8cff")]}},
                {"text": ", "},
                {"text": "strike", "style": {"decoration": "strikethrough"}},
                {"text": " and a "},
                {"text": "highlight", "style": {"highlight": "#ffb02e66"}},
                {"text": "."},
            ],
            style=text_style(size=20),
            para=paragraph(lh={"unit": "percent", "value": 140}),
        )
    )
    c.append(
        text(
            "centered",
            24,
            176,
            200,
            100,
            "Centered paragraph that wraps onto several lines.",
            style=text_style("Instrument Sans", 500, 18, "#2b2b30"),
            para=paragraph("center"),
        )
    )
    c.append(
        text(
            "list",
            244,
            176,
            212,
            110,
            "Bullet one\nBullet two\n\tNested item\nBullet three",
            style=text_style(size=16, fill="#2b2b30"),
            para=paragraph(list="bullet"),
        )
    )
    c.append(
        text(
            "gradient",
            24,
            292,
            432,
            70,
            "SUN EDITION",
            style=text_style(weight=800, size=54, fill=[linear(90, (0, "#ffb02e"), (1, "#e5484d"))], letterSpacing=0.06),
        )
    )
    c.append(
        text(
            "outline",
            24,
            360,
            220,
            60,
            "Outline",
            style=text_style(weight=800, size=44, fill="#ffffff"),
            strokes=[stroke("#2b2b30", 2, "outside", join="round")],
        )
    )
    c.append(
        text(
            "curved",
            250,
            350,
            210,
            110,
            "ON THE CURVE",
            style=text_style("JetBrains Mono", 600, 20, "#a463f2"),
            para=paragraph("center"),
            auto="none",
            curve=140,
        )
    )
    c.append(
        text(
            "mono",
            24,
            430,
            230,
            30,
            "let x = 42; // 🌞",
            style=text_style("JetBrains Mono", 400, 16, "#2b2b30"),
        )
    )
    return design("text", 480, 480, c, background=[solid("#fbfaf7")])


def fx_images():
    c = []
    c.append(image("img-fill", 20, 20, 140, 140, "photo0000001", "fill", radius=20))
    c.append(image("img-fit", 170, 20, 140, 140, "photo0000001", "fit", strokes=[stroke("#2b2b30", 2, "inside")]))
    c.append(image("img-crop", 320, 20, 140, 140, "photo0000001", "crop", crop={"x": 0.45, "y": 0.3, "w": 0.3, "h": 0.45}))
    c.append(image("img-ellipse", 20, 175, 140, 140, "photo0000001", shape="ellipse", strokes=[stroke("#ffb02e", 4, "outside")]))
    c.append(image("img-adjust", 170, 175, 140, 140, "photo0000001", adjust={
        "brightness": 0.2, "contrast": 0.3, "saturation": 0.4, "hue": 0, "temperature": -0.4, "tint": 0,
        "exposure": 0, "vignette": 0.6, "blur": 0, "grayscale": 0, "sepia": 0, "sharpen": 0.5, "grain": 0}))
    c.append(image("img-duotone", 320, 175, 140, 140, "photo0000001", adjust={
        "brightness": 0, "contrast": 0.1, "saturation": 0, "hue": 0, "temperature": 0, "tint": 0, "exposure": 0,
        "vignette": 0, "blur": 0, "grayscale": 0, "sepia": 0, "sharpen": 0, "grain": 0, "duotone": ["#1b1446", "#ffb02e"]}))
    c.append(image("img-blur", 20, 330, 140, 130, "photo0000001", radius=12, adjust={
        "brightness": 0, "contrast": 0, "saturation": 0, "hue": 0, "temperature": 0, "tint": 0, "exposure": 0,
        "vignette": 0, "blur": 12, "grayscale": 0, "sepia": 0, "sharpen": 0, "grain": 0}))
    c.append(image("img-preset", 170, 330, 140, 130, "photo0000001", flipX=True, adjust={
        "brightness": 0, "contrast": 0, "saturation": 0, "hue": 0, "temperature": 0, "tint": 0, "exposure": 0,
        "vignette": 0, "blur": 0, "grayscale": 0, "sepia": 0, "sharpen": 0, "grain": 0, "filter": "vintage"}))
    c.append(image("img-matte", 320, 330, 140, 130, "cutout000001", "fit", maskAssetId="matte0000001"))
    return design("images", 480, 480, c, assets=assets(PHOTO, CUTOUT, MATTE), background=[solid("#efece6")])


SVG_MARKUP = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b3a8a"/><stop offset="1" stop-color="#ffb02e"/></linearGradient>
<radialGradient id="sun" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff3d6"/><stop offset="1" stop-color="#ffb02e"/></radialGradient>
<clipPath id="clip"><circle cx="100" cy="100" r="92"/></clipPath>
<mask id="fade"><rect width="200" height="200" fill="url(#fadeg)"/></mask>
<linearGradient id="fadeg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>
</defs>
<g clip-path="url(#clip)">
<rect width="200" height="200" fill="url(#sky)"/>
<circle cx="100" cy="120" r="38" fill="url(#sun)"/>
<path d="M0 150 Q50 110 100 150 T200 140 V200 H0Z" fill="#2b2b30" opacity="0.9"/>
<g mask="url(#fade)"><rect x="0" y="170" width="200" height="30" fill="#ffffff" opacity="0.6"/></g>
</g>
<circle cx="100" cy="100" r="92" fill="none" stroke="#2b2b30" stroke-width="4" stroke-dasharray="10 6"/>
</svg>"""

SVG_FILTER = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<filter id="s"><feGaussianBlur stdDeviation="4"/></filter>
<rect x="20" y="20" width="60" height="60" rx="12" fill="#4f8cff" filter="url(#s)"/>
<text x="50" y="58" font-family="Inter" font-size="20" font-weight="700" text-anchor="middle" fill="#ffffff">SVG</text>
</svg>"""


def fx_svg():
    c = []
    c.append(svg("svg-scene", 20, 20, 200, 200, SVG_MARKUP))
    c.append(svg("svg-recolor", 250, 20, 200, 200, SVG_MARKUP, recolor={"#2b2b30": "#a463f2", "#ffb02e": "#2fbf71"}))
    c.append(svg("svg-asset", 30, 260, 120, 120, asset="icon00000001"))
    c.append(svg("svg-sticker", 180, 260, 120, 120, asset="icon00000001", strokes=[stroke("#ffffff", 8, "outside", join="round")], effects=[{"type": "dropShadow", "x": 0, "y": 4, "blur": 10, "spread": 0, "color": "#00000040"}]))
    c.append(svg("svg-filter", 330, 260, 120, 120, SVG_FILTER))
    return design("svg", 480, 480, c, assets=assets(ICON), background=[solid("#f1efe9")])


def fx_charts():
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"]
    s1 = {"name": "Revenue", "values": [12, 19, 15, 24, 28, 31]}
    s2 = {"name": "Costs", "values": [8, 11, 13, 14, 16, 18]}
    c = []
    w, h = 300, 220
    pos = [(20 + (i % 3) * 320, 20 + (i // 3) * 240) for i in range(12)]
    c.append(chart("ch-column", *pos[0], w, h, "column", months, [s1, s2], unit="k"))
    c.append(chart("ch-bar", *pos[1], w, h, "bar", ["North", "South", "East", "West"], [{"name": "Sales", "values": [42, 31, 27, 18]}], labels=True, legend=False))
    c.append(chart("ch-stacked", *pos[2], w, h, "stacked-column", months, [s1, s2]))
    c.append(chart("ch-line", *pos[3], w, h, "line", months, [s1, s2]))
    c.append(chart("ch-area", *pos[4], w, h, "area", months, [s1]))
    c.append(chart("ch-scatter", *pos[5], w, h, "scatter", ["1", "2", "3", "5", "8", "13"], [{"name": "Points", "values": [3, 7, 4, 9, 6, 12]}]))
    c.append(chart("ch-pie", *pos[6], w, h, "pie", ["Design", "Code", "Docs", "Ops"], [{"name": "Time", "values": [40, 30, 20, 10]}], labels=True))
    c.append(chart("ch-donut", *pos[7], w, h, "donut", ["A", "B", "C"], [{"name": "Share", "values": [55, 30, 15]}], labels=True))
    c.append(chart("ch-radar", *pos[8], w, h, "radar", ["Speed", "Power", "Range", "Comfort", "Price"], [{"name": "Model X", "values": [8, 6, 9, 5, 4]}, {"name": "Model Y", "values": [6, 8, 5, 8, 7]}]))
    c.append(chart("ch-funnel", *pos[9], w, h, "funnel", ["Visits", "Signups", "Trials", "Paid"], [{"name": "Users", "values": [1000, 520, 260, 90]}], labels=True, legend=False))
    c.append(chart("ch-progress", *pos[10], w, 60, "progress", ["Done"], [{"name": "Progress", "values": [68]}], labels=True))
    return design("charts", 980, 980, c, background=[solid("#ffffff")])


def fx_table_qr():
    cells = []
    head = ["Plan", "Price", "Credits", "Support"]
    rows = [["Free", "$0", "40", "Community"], ["Pro", "$8", "600", "Email"], ["Self-host", "—", "Unlimited", "You"]]
    for ci, t in enumerate(head):
        cells.append({"r": 0, "c": ci, "text": t})
    for ri, r in enumerate(rows):
        for ci, t in enumerate(r):
            cell = {"r": ri + 1, "c": ci, "text": t, "align": "right" if ci in (1, 2) else "left"}
            if ri == 1 and ci == 0:
                cell["fill"] = solid("#ffb02e33")
                cell["style"] = {"fontWeight": 700}
            cells.append(cell)
    cells.append({"r": 4, "c": 0, "text": "Prices exclude VAT. Credits reset monthly.", "colspan": 4, "align": "center", "style": {"fontSize": 11, "fills": [solid("#6b6b73")]}})
    c = [
        table("pricing", 20, 20, 440, 210, 5, 4, cells, colWidths=[120, 80, 110, 130], rowHeights=[44, 40, 40, 40, 46]),
        qr("qr-square", 30, 260, 180, "https://desyn.app", ec="M"),
        qr("qr-rounded", 260, 260, 180, "https://desyn.app/templates?ref=fixture", fg="#1b1446", bg="#fff3d6", ec="Q", rounded=True),
    ]
    return design("table_qr", 480, 480, c, background=[solid("#ffffff")])


def fx_social():
    c = []
    c.append(image("social-photo", 0, 0, 1080, 1080, "photo0000001", "fill", adjust={
        "brightness": -0.05, "contrast": 0.1, "saturation": 0.1, "hue": 0, "temperature": 0.1, "tint": 0, "exposure": 0,
        "vignette": 0.35, "blur": 0, "grayscale": 0, "sepia": 0, "sharpen": 0, "grain": 0}))
    c.append(rect("social-scrim", 0, 560, 1080, 520, fills=[linear(180, (0, "#00000000"), (1, "#000000b3"))]))
    c.append(text("social-eyebrow", 80, 640, 920, 40, "SUMMER SOLSTICE", style=text_style("Instrument Sans", 600, 28, "#ffb02e", letterSpacing=0.18)))
    c.append(text("social-headline", 80, 690, 920, 220, "Chase the light\nall the way home", style=text_style("Instrument Serif", 400, 96, "#ffffff"), para=paragraph(lh={"unit": "percent", "value": 105})))
    c.append(text("social-body", 80, 910, 640, 80, "Golden-hour walks, long dinners and the sea. Book by June 21.", style=text_style("Inter", 400, 30, "#ffffffd9")))
    c.append(
        kids(
            frame("social-cta", 780, 920, 220, 72, [], fills=[solid("#ffb02e")], radius=36, effects=[{"type": "dropShadow", "x": 0, "y": 8, "blur": 24, "spread": 0, "color": "#00000059"}]),
            [text("social-cta-label", 0, 20, 220, 34, "Book now", style=text_style("Inter", 700, 28, "#1b1446"), para=paragraph("center"), auto="none")],
        )
    )
    c.append(svg("social-logo", 80, 80, 72, 72, asset="icon00000001"))
    c.append(text("social-brand", 168, 96, 400, 44, "desyn travel", style=text_style("Inter", 700, 32, "#ffffff")))
    return design("social", 1080, 1080, c, assets=assets(PHOTO, ICON))


def fx_anim():
    c = []
    a = lambda preset, phase, start, dur, easing="ease-out": {
        "id": nid(f"anim-{preset}-{phase}-{start}"), "preset": preset, "phase": phase, "startMs": start, "durationMs": dur, "easing": easing}
    c.append(rect("anim-bg-card", 40, 40, 400, 400, fills=[solid("#1b1446")], radius=32, anim=[a("zoom-in", "in", 0, 600)]))
    c.append(text("anim-title", 80, 100, 320, 60, "Hello, sun", style=text_style("Instrument Serif", 400, 52, "#ffb02e"), anim=[a("rise", "in", 200, 600)]))
    c.append(text("anim-type", 80, 180, 320, 40, "typewriter reveal", style=text_style("JetBrains Mono", 400, 22, "#ffffff"), anim=[a("typewriter", "in", 300, 800, "linear")]))
    c.append(ellipse("anim-sun", 190, 260, 100, 100, fills=[solid("#ffb02e")], anim=[a("pop", "in", 400, 500), a("pulse", "loop", 900, 1200, "ease-in-out")], effects=[{"type": "glow", "radius": 20, "strength": 0.6, "color": "#ffb02e"}]))
    c.append(rect("anim-wipe", 80, 390, 320, 8, fills=[solid("#ffb02e")], radius=4, anim=[a("wipe", "in", 500, 700)]))
    return design("anim", 480, 480, c, background=[solid("#0f0d1f")], page_kw={"durationMs": 2400})


FIXTURES = {
    "shapes": fx_shapes,
    "paints": fx_paints,
    "strokes": fx_strokes,
    "effects": fx_effects,
    "blend": fx_blend,
    "masks": fx_masks,
    "text": fx_text,
    "images": fx_images,
    "svg": fx_svg,
    "charts": fx_charts,
    "table_qr": fx_table_qr,
    "social": fx_social,
    "anim": fx_anim,
}

# Render settings per fixture (read by the golden test).
SETTINGS = {
    "anim": {"timeMs": 520},
    "social": {"scale": 0.5},
    "charts": {"scale": 1},
}


def main():
    os.makedirs(OUT, exist_ok=True)
    make_assets()
    for name, fn in FIXTURES.items():
        _ids.clear()
        d = fn()
        d["meta"]["render"] = SETTINGS.get(name, {})
        with open(os.path.join(OUT, f"{name}.json"), "w") as f:
            json.dump(d, f, indent=1, ensure_ascii=False)
            f.write("\n")
    print(f"wrote {len(FIXTURES)} fixtures to {OUT}")


if __name__ == "__main__":
    main()
