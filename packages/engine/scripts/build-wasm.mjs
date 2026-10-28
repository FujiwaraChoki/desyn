#!/usr/bin/env node
// Builds the wasm engine (crates/desyn-wasm) into packages/engine/wasm and copies the bundled default fonts into
// packages/engine/fonts.
//
//   node scripts/build-wasm.mjs               release: interactive + exporters modules, wasm-opt when available
//   node scripts/build-wasm.mjs --if-missing  skip when the outputs already exist (typecheck / test in CI)
//   node scripts/build-wasm.mjs --dev         debug builds without wasm-opt (fast iteration)
//   node scripts/build-wasm.mjs --no-opt      skip wasm-opt
//
// Needs cargo with the wasm32-unknown-unknown target and the wasm-bindgen CLI at the version Cargo.lock pins.
// wasm-opt comes from PATH (binaryen release, as in CI / Docker) or the `binaryen` dev dependency.
// Honors CARGO_TARGET_DIR (default <repo>/target/desyn-wasm) and CARGO_BUILD_JOBS (default 6).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const repo = join(pkg, "..", "..");
const outDir = join(pkg, "wasm");
const fontsOut = join(pkg, "fonts");
const args = new Set(process.argv.slice(2));
const dev = args.has("--dev");
// wasm-opt level: -Oz by default (download size); DESYN_WASM_OPT=-O3 favours speed.
const OPT_LEVEL = process.env.DESYN_WASM_OPT ?? "-Oz";
const SIMD = process.env.DESYN_WASM_SIMD !== "0";
/** Crates whose inner loops dominate frame time: compiled for speed inside the size-optimized build. */
const HOT_CRATES = (process.env.DESYN_WASM_HOT ?? "tiny-skia,tiny-skia-path,desyn-raster")
  .split(",")
  .filter(Boolean);

const MODULES = [
  { name: "desyn_engine", features: [] },
  { name: "desyn_export", features: ["exporters"] },
];

function log(msg) {
  process.stdout.write(`[build-wasm] ${msg}\n`);
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} exited with ${r.status}`);
}

function has(cmd) {
  const r = spawnSync(cmd, ["--version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
}

function lockedBindgenVersion() {
  const lock = readFileSync(join(repo, "Cargo.lock"), "utf8");
  const m = /name = "wasm-bindgen"\nversion = "([^"]+)"/.exec(lock);
  return m?.[1];
}

function wasmOpt() {
  if (has("wasm-opt")) return "wasm-opt";
  const local = join(pkg, "node_modules", ".bin", "wasm-opt");
  if (existsSync(local)) return local;
  return null;
}

function copyFonts() {
  const src = join(repo, "crates", "desyn-text", "fonts");
  mkdirSync(join(fontsOut, "licenses"), { recursive: true });
  for (const f of readdirSync(src)) {
    if (f.endsWith(".ttf")) copyFileSync(join(src, f), join(fontsOut, f));
  }
  for (const f of readdirSync(join(src, "licenses"))) {
    copyFileSync(join(src, "licenses", f), join(fontsOut, "licenses", f));
  }
  copyFileSync(join(src, "README.md"), join(fontsOut, "README.md"));
}

function outputsExist() {
  return (
    MODULES.every(
      (m) =>
        existsSync(join(outDir, `${m.name}.js`)) && existsSync(join(outDir, `${m.name}_bg.wasm`)),
    ) && existsSync(join(fontsOut, "Inter-VF.ttf"))
  );
}

function main() {
  if (args.has("--if-missing") && outputsExist()) {
    log("outputs exist, skipping (run without --if-missing to rebuild)");
    return;
  }
  const bindgen = lockedBindgenVersion();
  if (!has("cargo"))
    throw new Error("cargo is required (rustup with the wasm32-unknown-unknown target)");
  if (!has("wasm-bindgen")) {
    throw new Error(
      `wasm-bindgen CLI ${bindgen ?? ""} is required: cargo install wasm-bindgen-cli --version ${bindgen}`,
    );
  }
  const cli = spawnSync("wasm-bindgen", ["--version"], { encoding: "utf8" }).stdout.trim();
  if (bindgen && !cli.endsWith(bindgen)) {
    throw new Error(`wasm-bindgen CLI is "${cli}" but Cargo.lock pins ${bindgen}`);
  }
  const targetDir = process.env.CARGO_TARGET_DIR ?? join(repo, "target", "desyn-wasm");
  const env = {
    ...process.env,
    CARGO_TARGET_DIR: targetDir,
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "6",
  };
  mkdirSync(outDir, { recursive: true });
  const opt = dev || args.has("--no-opt") ? null : wasmOpt();
  if (!dev && !args.has("--no-opt") && !opt) log("wasm-opt not found: shipping unoptimized wasm");
  const manifest = {
    built: new Date().toISOString(),
    profile: dev ? "dev" : "release",
    modules: {},
  };
  for (const m of MODULES) {
    const cargoArgs = ["build", "-p", "desyn-wasm", "--lib", "--target", "wasm32-unknown-unknown"];
    if (!dev) {
      cargoArgs.push("--release");
      // Size-optimized code overall; the rasterizer's hot loops keep full speed.
      cargoArgs.push("--config", 'profile.release.opt-level="s"');
      for (const hot of HOT_CRATES) {
        cargoArgs.push("--config", `profile.release.package.${hot}.opt-level=3`);
      }
    }
    if (SIMD) {
      // WebAssembly SIMD (Chrome 91+, Firefox 89+, Safari 16.4+): tiny-skia's pipelines use it.
      cargoArgs.push(
        "--config",
        'target.wasm32-unknown-unknown.rustflags=["-C", "target-feature=+simd128"]',
      );
    }
    if (m.features.length) cargoArgs.push("--features", m.features.join(","));
    log(`cargo ${cargoArgs.join(" ")}`);
    run("cargo", cargoArgs, { cwd: repo, env });
    const built = join(
      targetDir,
      "wasm32-unknown-unknown",
      dev ? "debug" : "release",
      "desyn_wasm.wasm",
    );
    run("wasm-bindgen", ["--target", "web", "--out-dir", outDir, "--out-name", m.name, built]);
    const wasmFile = join(outDir, `${m.name}_bg.wasm`);
    const raw = statSync(wasmFile).size;
    if (opt) {
      const tmp = `${wasmFile}.opt`;
      log(`${opt} ${OPT_LEVEL} ${m.name}`);
      run(opt, [OPT_LEVEL, "--strip-debug", "--strip-producers", wasmFile, "-o", tmp]);
      copyFileSync(tmp, wasmFile);
      rmSync(tmp);
    }
    const bytes = readFileSync(wasmFile);
    manifest.modules[m.name] = {
      features: m.features,
      rawBytes: raw,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      wasmOpt: Boolean(opt),
    };
    log(
      `${m.name}: ${(bytes.length / 1048576).toFixed(2)} MiB${opt ? ` (raw ${(raw / 1048576).toFixed(2)} MiB)` : ""}`,
    );
  }
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFonts();
  log("done");
}

try {
  main();
} catch (e) {
  process.stderr.write(`[build-wasm] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
