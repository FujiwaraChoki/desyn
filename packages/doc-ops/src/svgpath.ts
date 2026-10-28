// Minimal SVG path-data parser / writer used to scale PathNode geometry (paths live in the node's local box).

export interface PathCommand {
  /** Command letter as written (case = absolute/relative). */
  cmd: string;
  args: number[];
}

const ARG_COUNT: Record<string, number> = {
  m: 2,
  l: 2,
  h: 1,
  v: 1,
  c: 6,
  s: 4,
  q: 4,
  t: 2,
  a: 7,
  z: 0,
};

const NUMBER_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/** Parses path data into commands with implicit repeats expanded. Throws on malformed input. */
export function parsePath(d: string): PathCommand[] {
  const out: PathCommand[] = [];
  let i = 0;
  let current: string | null = null;
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i] as string)) i++;
  };
  const readFlag = (): number => {
    skip();
    const ch = d[i];
    if (ch !== "0" && ch !== "1") throw new Error(`invalid arc flag at ${i}`);
    i++;
    return Number(ch);
  };
  const readNumber = (): number => {
    skip();
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(d);
    if (!m) throw new Error(`expected number at ${i} in path data`);
    i += m[0].length;
    return Number(m[0]);
  };
  for (;;) {
    skip();
    if (i >= d.length) break;
    const ch = d[i] as string;
    if (/[a-zA-Z]/.test(ch)) {
      if (!(ch.toLowerCase() in ARG_COUNT)) throw new Error(`unknown path command "${ch}"`);
      current = ch;
      i++;
      if (ch.toLowerCase() === "z") {
        out.push({ cmd: ch, args: [] });
        continue;
      }
    } else if (current === null || current.toLowerCase() === "z") {
      throw new Error(`path data must start with a command (at ${i})`);
    }
    const cmd = current as string;
    const lower = cmd.toLowerCase();
    const args: number[] = [];
    for (let k = 0; k < (ARG_COUNT[lower] as number); k++) {
      args.push(lower === "a" && (k === 3 || k === 4) ? readFlag() : readNumber());
    }
    out.push({ cmd, args });
    // Extra coordinate pairs after a moveto are implicit linetos.
    if (lower === "m") current = cmd === "m" ? "l" : "L";
  }
  return out;
}

function fmt(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return String(r === 0 ? 0 : r);
}

export function serializePath(commands: PathCommand[]): string {
  return commands
    .map((c) => (c.args.length ? `${c.cmd}${c.args.map(fmt).join(" ")}` : c.cmd))
    .join("");
}

/**
 * Scales path data by (sx, sy). Exact for every command except arcs under non-uniform scale with a rotated
 * ellipse, where radii are scaled per axis (the standard approximation).
 */
export function scalePath(d: string, sx: number, sy: number): string {
  const commands = parsePath(d).map(({ cmd, args }) => {
    const lower = cmd.toLowerCase();
    let next: number[];
    switch (lower) {
      case "h":
        next = [(args[0] as number) * sx];
        break;
      case "v":
        next = [(args[0] as number) * sy];
        break;
      case "a": {
        const [rx, ry, rot, large, sweep, x, y] = args as [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ];
        // A negative scale mirrors the arc, which flips its sweep direction.
        const flip = sx * sy < 0 ? 1 - sweep : sweep;
        next = [Math.abs(rx * sx), Math.abs(ry * sy), rot, large, flip, x * sx, y * sy];
        break;
      }
      default:
        next = args.map((v, i) => v * (i % 2 === 0 ? sx : sy));
    }
    return { cmd, args: next };
  });
  return serializePath(commands);
}
