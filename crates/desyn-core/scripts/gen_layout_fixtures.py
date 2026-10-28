"""Writes spec/fixtures/layout/*.json: Rust-only normalization fixtures with hand-computed expectations.

Each case: before design, a transaction, and the expected design after `apply_transaction(normalize: true)`
with the ApproxMeasurer (text line height = paragraph line height; 120% of font size here).
"""
import copy
import json
import os
import sys

OUT = sys.argv[1]


def base(id, type, name, parent, x, y, w, h, **extra):
    n = {"id": id, "type": type, "name": name, "parent": parent, "x": x, "y": y, "width": w, "height": h,
         "rotation": 0, "opacity": 1, "blend": "normal", "visible": True, "locked": False, "effects": []}
    n.update(extra)
    return n


def rect(id, parent, x, y, w, h, **extra):
    return base(id, "rect", "Rect " + id[-2:], parent, x, y, w, h,
                fills=[{"type": "solid", "color": "#d9d9d9"}], strokes=[], cornerRadius=0, **extra)


def frame(id, parent, x, y, w, h, children, **extra):
    return base(id, "frame", "Frame", parent, x, y, w, h, fills=[{"type": "solid", "color": "#ffffff"}],
                strokes=[], cornerRadius=0, children=children, clip=True, **extra)


def group(id, parent, x, y, w, h, children):
    return base(id, "group", "Group", parent, x, y, w, h, children=children, clip=False)


def text(id, parent, x, y, w, h, s, auto, size=10):
    return base(id, "text", "Text", parent, x, y, w, h, runs=[{"text": s}],
                style={"fontFamily": "Inter", "fontWeight": 400, "fontStyle": "normal", "fontSize": size,
                       "fills": [{"type": "solid", "color": "#111111"}], "letterSpacing": 0, "textCase": "none",
                       "decoration": "none"},
                paragraph={"align": "left", "direction": "auto", "lineHeight": {"unit": "percent", "value": 120},
                           "spacing": 0, "indent": 0, "list": "none"},
                autoResize=auto, verticalAlign="top")


def layout(mode, gap=0, padding=(0, 0, 0, 0), main="start", cross="start", **extra):
    l = {"mode": mode, "gap": gap, "padding": list(padding), "mainAlign": main, "crossAlign": cross}
    l.update(extra)
    return l


def design(top, nodes):
    page = base("page00000001", "page", "Page 1", "root", 0, 0, 1000, 1000, children=top, clip=True, unit="px",
                background=[{"type": "solid", "color": "#ffffff"}], bleed=0)
    root = base("root", "root", "Root", None, 0, 0, 0, 0, children=["page00000001"])
    d = {"schema": 1, "id": "dsn000000001", "name": "Layout fixture", "kind": "custom",
         "nodes": {"root": root, "page00000001": page}, "assets": {},
         "styles": {"colors": {}, "text": {}, "effects": {}, "variables": {}}, "meta": {}}
    for n in nodes:
        d["nodes"][n["id"]] = n
    return d


def tx(ops):
    return {"id": "tx0000000001", "label": "Layout", "ops": ops, "source": "user", "ts": 1760000000000}


def setgeo(d, id, **kv):
    d["nodes"][id].update(kv)


cases = []

# 1. Row, hug both axes, gap / padding, cross center.
before = design(["frame0000001"], [
    frame("frame0000001", "page00000001", 100, 100, 10, 10, ["rect00000001", "rect00000002"],
          layout=layout("row", gap=0, padding=(5, 5, 5, 5), cross="center"), sizing={"h": "hug", "v": "hug"}),
    rect("rect00000001", "frame0000001", 0, 0, 20, 10),
    rect("rect00000002", "frame0000001", 0, 0, 30, 20),
])
after = copy.deepcopy(before)
after["nodes"]["frame0000001"]["layout"]["gap"] = 10
# x: 5, then 5 + 20 + 10 = 35; cross center in inner height 20: rect1 y = 5 + (20 - 10) / 2 = 10, rect2 y = 5.
setgeo(after, "rect00000001", x=5, y=10)
setgeo(after, "rect00000002", x=35, y=5)
# width = 5 + 20 + 10 + 30 + 5 = 70, height = 5 + 20 + 5 = 30.
setgeo(after, "frame0000001", width=70, height=30)
cases.append(("row-hug-gap-padding-center", "Row auto-layout hugging its content: gap, padding, centered cross axis.",
              before, tx([{"op": "patch", "id": "frame0000001", "path": ["layout", "gap"], "value": 10}]), after))

# 2. Column with fill children in a fixed frame.
before = design(["frame0000001"], [
    frame("frame0000001", "page00000001", 0, 0, 100, 200, ["rect00000001", "rect00000002"],
          layout=layout("column", gap=10, padding=(10, 10, 10, 10))),
    rect("rect00000001", "frame0000001", 0, 0, 20, 30, sizing={"h": "fill", "v": "fixed"}),
    rect("rect00000002", "frame0000001", 0, 0, 20, 30),
])
after = copy.deepcopy(before)
after["nodes"]["rect00000002"]["sizing"] = {"h": "fixed", "v": "fill"}
# inner 80 x 180. A: fill width 80, height 30 at (10, 10). B: height 180 - 30 - 10 = 140 at (10, 50), width 20.
setgeo(after, "rect00000001", x=10, y=10, width=80, height=30)
setgeo(after, "rect00000002", x=10, y=50, width=20, height=140)
cases.append(("column-fill", "Column auto-layout distributing fill sizes on both axes.", before,
              tx([{"op": "update", "id": "rect00000002", "set": {"sizing": {"h": "fixed", "v": "fill"}}}]), after))

# 3. Space-between row.
before = design(["frame0000001"], [
    frame("frame0000001", "page00000001", 0, 0, 200, 50, ["rect00000001", "rect00000002", "rect00000003"],
          layout=layout("row")),
    rect("rect00000001", "frame0000001", 0, 0, 20, 20),
    rect("rect00000002", "frame0000001", 20, 0, 20, 20),
    rect("rect00000003", "frame0000001", 40, 0, 20, 20),
])
after = copy.deepcopy(before)
after["nodes"]["frame0000001"]["layout"]["mainAlign"] = "space-between"
after["nodes"]["frame0000001"]["layout"]["crossAlign"] = "end"
# free = 200 - 60 = 140, gap' = 70: x = 0, 90, 180; cross end: y = 50 - 20 = 30.
setgeo(after, "rect00000001", x=0, y=30)
setgeo(after, "rect00000002", x=90, y=30)
setgeo(after, "rect00000003", x=180, y=30)
cases.append(("row-space-between-end", "Space-between distribution with end cross alignment.", before,
              tx([{"op": "patch", "id": "frame0000001", "path": ["layout", "mainAlign"], "value": "space-between"},
                  {"op": "patch", "id": "frame0000001", "path": ["layout", "crossAlign"], "value": "end"}]), after))

# 4. Constraints on parent resize.
before = design(["frame0000001"], [
    frame("frame0000001", "page00000001", 0, 0, 100, 100, ["rect00000001", "rect00000002", "rect00000003"]),
    rect("rect00000001", "frame0000001", 10, 10, 20, 20, constraints={"h": "right", "v": "bottom"}),
    rect("rect00000002", "frame0000001", 10, 40, 80, 20, constraints={"h": "stretch", "v": "center"}),
    rect("rect00000003", "frame0000001", 50, 50, 50, 50, constraints={"h": "scale", "v": "scale"}),
])
after = copy.deepcopy(before)
setgeo(after, "frame0000001", width=200, height=150)
# right: x 10 + 100 = 110; bottom: y 10 + 50 = 60.
setgeo(after, "rect00000001", x=110, y=60)
# stretch: width 80 + 100 = 180; center: y 40 + 25 = 65.
setgeo(after, "rect00000002", width=180, y=65)
# scale 2 x 1.5: x 100, w 100, y 75, h 75.
setgeo(after, "rect00000003", x=100, width=100, y=75, height=75)
cases.append(("constraints-resize", "Children follow right/bottom, stretch/center and scale constraints.", before,
              tx([{"op": "update", "id": "frame0000001", "set": {"width": 200, "height": 150}}]), after))

# 5. Constraints are skipped for children set explicitly in the same transaction.
after2 = copy.deepcopy(after)
setgeo(after2, "rect00000001", x=5, y=5)
before5 = copy.deepcopy(before)
cases.append(("constraints-explicit-child-wins", "A child whose geometry the transaction sets is not constrained.",
              before5, tx([{"op": "update", "id": "frame0000001", "set": {"width": 200, "height": 150}},
                           {"op": "update", "id": "rect00000001", "set": {"x": 5, "y": 5}}]), after2))

# 6. Group bounds follow children.
before = design(["group0000001"], [
    group("group0000001", "page00000001", 100, 100, 10, 10, ["rect00000001"]),
    rect("rect00000001", "group0000001", 0, 0, 10, 10),
])
after = copy.deepcopy(before)
# child moved to x = 20 inside the group: union = [20, 30] -> group x = 120, child x = 0; and a second child added.
setgeo(after, "group0000001", x=120, y=100, width=40, height=30)
setgeo(after, "rect00000001", x=0, y=0)
after["nodes"]["group0000001"]["children"].append("rect00000002")
r2 = rect("rect00000002", "group0000001", 20, 10, 20, 20)
# new child at group-local (40, 10) before the refit -> (20, 10) after shifting by 20.
after["nodes"]["rect00000002"] = r2
cases.append(("group-bounds-refit", "Group bounds refit to moved and added children, children keep page position.",
              before, tx([{"op": "update", "id": "rect00000001", "set": {"x": 20}},
                          {"op": "create", "parent": "group0000001",
                           "nodes": [rect("rect00000002", "group0000001", 40, 10, 20, 20)]}]), after))

# 7. Text auto-resize height.
before = design(["text00000001"], [text("text00000001", "page00000001", 10, 10, 200, 99, "Hi", "height")])
after = copy.deepcopy(before)
after["nodes"]["text00000001"]["runs"] = [{"text": "Hello\nworld"}]
# two paragraphs, one line each at 120% of 10px = 12 -> 24.
setgeo(after, "text00000001", height=24)
cases.append(("text-autoresize-height", "Fixed-width text grows to its line count.", before,
              tx([{"op": "update", "id": "text00000001", "set": {"runs": [{"text": "Hello\nworld"}]}}]), after))

# 8. Row wrap with rowGap, hug height.
before = design(["frame0000001"], [
    frame("frame0000001", "page00000001", 0, 0, 100, 10, ["rect00000001", "rect00000002", "rect00000003"],
          layout=layout("row", gap=10, wrap=True, rowGap=5), sizing={"h": "fixed", "v": "hug"}),
    rect("rect00000001", "frame0000001", 0, 0, 40, 20),
    rect("rect00000002", "frame0000001", 0, 0, 40, 20),
    rect("rect00000003", "frame0000001", 0, 0, 40, 20),
])
after = copy.deepcopy(before)
after["nodes"]["frame0000001"]["name"] = "Wrapped"
# line 1: 40 + 10 + 40 = 90 <= 100; third wraps. positions (0,0), (50,0), (0,25); height 20 + 5 + 20 = 45.
setgeo(after, "rect00000002", x=50)
setgeo(after, "rect00000003", y=25)
setgeo(after, "frame0000001", height=45)
cases.append(("row-wrap-row-gap", "Wrapping row with a separate row gap and hugging height.", before,
              tx([{"op": "update", "id": "frame0000001", "set": {"name": "Wrapped"}}]), after))

# 9. Grid with two columns.
before = design(["frame0000001"], [
    frame("frame0000001", "page00000001", 0, 0, 210, 10, ["rect00000001", "rect00000002", "rect00000003"],
          layout=layout("grid", gap=10, columns=2), sizing={"h": "fixed", "v": "hug"}),
    rect("rect00000001", "frame0000001", 0, 0, 50, 30),
    rect("rect00000002", "frame0000001", 0, 0, 50, 30),
    rect("rect00000003", "frame0000001", 0, 0, 50, 30),
])
after = copy.deepcopy(before)
after["nodes"]["frame0000001"]["layout"]["mainAlign"] = "center"
# column width (210 - 10) / 2 = 100; centered: x = 25 and 135; rows at y 0 and 40; height 30 + 10 + 30 = 70.
setgeo(after, "rect00000001", x=25, y=0)
setgeo(after, "rect00000002", x=135, y=0)
setgeo(after, "rect00000003", x=25, y=40)
setgeo(after, "frame0000001", height=70)
cases.append(("grid-two-columns-centered", "Grid layout: equal columns, centered cells, row gap defaults to gap.",
              before, tx([{"op": "patch", "id": "frame0000001", "path": ["layout", "mainAlign"], "value": "center"}]),
              after))

# 10. Reverse column + hidden children skipped.
before = design(["frame0000001"], [
    frame("frame0000001", "page00000001", 0, 0, 50, 100, ["rect00000001", "rect00000002", "rect00000003"],
          layout=layout("column", gap=5)),
    rect("rect00000001", "frame0000001", 0, 0, 10, 10),
    rect("rect00000002", "frame0000001", 0, 0, 10, 20),
    rect("rect00000003", "frame0000001", 0, 0, 10, 30, visible=False),
])
after = copy.deepcopy(before)
after["nodes"]["frame0000001"]["layout"]["reverse"] = True
# visible children reversed: rect2 at y 0, rect1 at y 20 + 5 = 25; hidden rect3 untouched.
setgeo(after, "rect00000002", y=0)
setgeo(after, "rect00000001", y=25)
cases.append(("column-reverse-skips-hidden", "Reverse order; hidden children do not take part in layout.", before,
              tx([{"op": "patch", "id": "frame0000001", "path": ["layout", "reverse"], "value": True}]), after))

os.makedirs(OUT, exist_ok=True)
for name, desc, b, t, a in cases:
    with open(os.path.join(OUT, name + ".json"), "w") as f:
        json.dump({"name": name, "description": desc, "before": b, "tx": t, "after": a, "dropped": []}, f, indent=2)
        f.write("\n")
print(f"wrote {len(cases)} layout fixtures to {OUT}")
