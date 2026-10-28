# Layout fixtures (Rust core only)

Normalization cases for `desyn-core`: auto-layout (row / column / grid, gap, padding, wrap, reverse, fill / hug,
space-between, cross alignment), constraints on parent resize, group bounds refit and text auto-resize.

```jsonc
{ "name": "…", "description": "…", "before": Design, "tx": Transaction, "after": Design, "dropped": [] }
```

A conforming engine applies `tx` to `before` **with** normalization and the font-free `ApproxMeasurer`
(line height from the paragraph style) and compares the result with `after` canonically. Expectations are computed
by hand in the generator (`crates/desyn-core/scripts/gen_layout_fixtures.py`, see the comments next to each case),
not taken from the implementation. Regenerate with:

```sh
python3 crates/desyn-core/scripts/gen_layout_fixtures.py spec/fixtures/layout
```

The TypeScript applier does not run layout, so it does not read this directory.
