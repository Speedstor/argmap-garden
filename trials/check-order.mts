// Scoring trial for argmap's order of checks.
//
// Question: on maps with hidden truth, which order of checking bets reaches the
// true conclusion in the fewest checks?
//
// Run from the repository:   node trials/check-order.mts ['<json options>']
// Against another clone:     node trials/check-order.mts <path to an argmap clone> ['<json options>']
// Examples:
//   node trials/check-order.mts '{"maps":300,"seed":1,"orGroups":2}'
//   node trials/check-order.mts '{"file":"arguments/second-industrialization.yaml","maps":1000}'
//
// A made-up map is generated as an argmap YAML file and read with the tool's own
// load(), so the statuses come from the real engine. With "file", the structure
// and the labels come from that argument file, and only the truth is random.
// Each bet is secretly true or false. Checking a bet reveals it; a false bet is
// knocked out. "Presumed" is the conclusion with nothing knocked. "Truth" is the
// conclusion with every false bet knocked. A "flip map" is one where they differ.

import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const arg1 = process.argv[2];
const firstIsOptions = arg1 !== undefined && arg1.trimStart().startsWith('{');
const root = arg1 === undefined || firstIsOptions ? resolve(here, '..') : arg1;
const optionsJson = firstIsOptions ? arg1 : process.argv[3];
const am = await import(pathToFileURL(resolve(root, 'src/index.ts')).href);
const ws = await import(pathToFileURL(resolve(root, 'src/workspace.ts')).href);

const DEFAULTS = {
  maps: 300, // how many random maps, or with "file" how many draws of the truth
  file: '', // an argument file to take the structure and labels from, in place of made-up maps
  seed: 1,
  orGroups: 1, // lines of support under the conclusion (1 = one line, all needed)
  groupSize: 3, // members per line of support
  depth: 2, // levels of supported claims under the conclusion
  objections: 2, // objections, each a bet that attacks a supported claim
  rebutted: 1, // share of objections answered by a rebuttal bet that attacks the objection
  named: 1, // share of bets whose label carries a name (by). argmap reads an unnamed label above assumed as assumed
  // Chance that a bet is really false, by trust label: observed, corroborated, track-record, assumed.
  // "informative" labels by default. Flat: [0.2,0.2,0.2,0.2]. Inverted: [0.4,0.25,0.1,0.03].
  falseRate: [0.03, 0.1, 0.25, 0.4],
  labelMix: [0.1, 0.2, 0.3, 0.4], // share of bets carrying each label
  mcSamples: 24, // worlds sampled per bet by the "influence" order
  strategies: ['file', 'random', 'shaky', 'exposure', 'exposure-once', 'influence'],
};
const opt = { ...DEFAULTS, ...(optionsJson ? JSON.parse(optionsJson) : {}) };

const TRUST = ['observed', 'corroborated', 'track-record', 'assumed'];
const COST = ['low', 'medium', 'high'];

// Small seeded generator (mulberry32), so a run can be repeated exactly.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(r: () => number, weights: number[]): number {
  let x = r() * weights.reduce((s, w) => s + w, 0);
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i] as number;
    if (x < 0) return i;
  }
  return weights.length - 1;
}

interface Made {
  yaml: string;
  bets: string[]; // in file order
  trust: Map<string, number>; // bet id -> index into TRUST
}

function makeMap(r: () => number): Made {
  // Build the nodes first, then write them out in the order they were made:
  // a claim, then the bets it rests on directly, then its supported children.
  const nodes: { id: string; because?: string[][]; trust?: number; cost?: string; named?: boolean }[] = [];
  const bets: string[] = [];
  const trust = new Map<string, number>();
  const internal: string[] = [];
  let n = 0;
  const bet = (): string => {
    const id = `b${++n}`;
    const t = pick(r, opt.labelMix);
    trust.set(id, t);
    bets.push(id);
    nodes.push({ id, trust: t, cost: COST[Math.floor(r() * 3)] as string, named: r() < opt.named });
    return id;
  };
  const supported = (id: string, level: number, groups: number): void => {
    const node: { id: string; because: string[][] } = { id, because: [] };
    nodes.push(node);
    internal.push(id);
    const children: string[] = [];
    for (let g = 0; g < groups; g++) {
      const members: string[] = [];
      for (let m = 0; m < opt.groupSize; m++) {
        if (level < opt.depth && r() < 0.5) {
          const child = `c${++n}`;
          members.push(child);
          children.push(child);
        } else members.push(bet());
      }
      node.because.push(members);
    }
    for (const child of children) supported(child, level + 1, 1);
  };
  supported('main', 1, opt.orGroups);
  const attacks: string[] = [];
  for (let k = 0; k < opt.objections; k++) {
    const target = internal[Math.floor(r() * internal.length)] as string;
    const objection = bet();
    attacks.push(`  - [${objection}, ${target}]`);
    if (r() < opt.rebutted) attacks.push(`  - [${bet()}, ${objection}]`);
  }
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.because) {
      lines.push(`  ${node.id}:`, `    text: Claim ${node.id} follows from its support.`, `    because:`);
      for (const g of node.because) lines.push(`      - [${g.join(', ')}]`);
    } else {
      lines.push(`  ${node.id}:`, `    text: Bet ${node.id} holds in 40 of 60 cases.`, `    bet:`, `      trust: ${TRUST[node.trust as number]}`, `      cost: ${node.cost}`, ...(node.named ? [`      by: tester`] : []));
    }
  }
  const yaml = ['argmap: 1', 'title: Trial map', 'conclusion: main', '', 'claims:', ...lines, ...(attacks.length ? ['', 'attacks:', ...attacks] : []), ''].join('\n');
  return { yaml, bets, trust };
}

type Arg = unknown;

// With "file": the same real map on every draw. Bets are its leaves in the order the
// tool lists its claims, and each bet's chance of being false goes by the label as typed.
function fromFile(path: string): { arg: Arg; made: Made } {
  const loaded = ws.loadFile(resolve(path));
  if (!loaded.ok) {
    console.error(`cannot use ${path}:`, JSON.stringify(loaded.issues.filter((i: { severity: string }) => i.severity === 'error').slice(0, 3)));
    process.exit(1);
  }
  const arg = loaded.argument as { claims: Map<string, { id: string; because: string[][]; bet?: { trust: string } }> };
  const bets: string[] = [];
  const trust = new Map<string, number>();
  for (const c of arg.claims.values()) {
    if (c.because.length > 0) continue;
    bets.push(c.id);
    trust.set(c.id, Math.max(0, TRUST.indexOf(c.bet?.trust ?? 'assumed')));
  }
  return { arg, made: { yaml: '', bets, trust } };
}
const conclusionOf = (arg: Arg, knocked: Set<string>): string => am.evaluate(arg, knocked).get((arg as { conclusion: string }).conclusion);

// Each strategy returns the next bet to check, given what is already known.
type Chooser = (arg: Arg, made: Made, checked: Set<string>, knocked: Set<string>, r: () => number, state: Record<string, unknown>) => string;

const choosers: Record<string, Chooser> = {
  // Top to bottom, as the bets appear in the file.
  file: (_a, made, checked) => made.bets.find((b) => !checked.has(b)) as string,
  random: (_a, made, checked, _k, r, state) => {
    if (!state.order) {
      const o = [...made.bets];
      for (let i = o.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [o[i], o[j]] = [o[j] as string, o[i] as string];
      }
      state.order = o;
    }
    return (state.order as string[]).find((b) => !checked.has(b)) as string;
  },
  // Shakiest label first, ignoring the structure of the map.
  shaky: (_a, made, checked) => [...made.bets].filter((b) => !checked.has(b)).sort((x, y) => (made.trust.get(y) as number) - (made.trust.get(x) as number))[0] as string,
  // argmap's own order (betReports, which next ranks by), worked out again after every check.
  exposure: (arg, _m, checked, knocked) => {
    const a = am.analyze(arg, knocked);
    return (a.bets as { id: string }[]).find((b) => !checked.has(b.id))?.id as string;
  },
  // argmap's order read once at the start and followed to the end.
  'exposure-once': (arg, _m, checked, _k, _r, state) => {
    if (!state.order) state.order = (am.analyze(arg, new Set()).bets as { id: string }[]).map((b) => b.id);
    return (state.order as string[]).find((b) => !checked.has(b)) as string;
  },
  // Chance that this bet is false, times the chance the conclusion then differs from now,
  // with the other unchecked bets drawn at random. Knows the true false rates: an upper bound
  // on what a well-calibrated p could add.
  influence: (arg, made, checked, knocked, r) => {
    const now = conclusionOf(arg, knocked);
    const open = made.bets.filter((b) => !checked.has(b));
    let best = open[0] as string;
    let bestScore = -1;
    for (const b of open) {
      let flips = 0;
      for (let s = 0; s < opt.mcSamples; s++) {
        const k = new Set(knocked);
        k.add(b);
        for (const o of open) if (o !== b && r() < (opt.falseRate[made.trust.get(o) as number] as number)) k.add(o);
        if (conclusionOf(arg, k) !== now) flips++;
      }
      const score = (opt.falseRate[made.trust.get(b) as number] as number) * (flips / opt.mcSamples) + 1e-6 * (made.trust.get(b) as number);
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    return best;
  },
};

interface Tally {
  flipMaps: number;
  firstRight: number; // checks until the conclusion first matches the truth, summed over flip maps
  firstRightSq: number; // the same, squared, for the standard error
  lead: number; // checks saved against file order on the same map, summed over flip maps
  leadSq: number;
  lastWrong: number; // checks until it matches and stays matched, summed over flip maps
  wrongShare: number; // share of all steps where the conclusion was wrong, summed over all maps
}

const tallies: Record<string, Tally> = {};
for (const s of opt.strategies) tallies[s] = { flipMaps: 0, firstRight: 0, firstRightSq: 0, lead: 0, leadSq: 0, lastWrong: 0, wrongShare: 0 };
let made = 0;
let flipMaps = 0;
let betCount = 0;
let skipped = 0;
const truthMix: Record<string, number> = { stands: 0, falls: 0, contested: 0 };
const presumedMix: Record<string, number> = { stands: 0, falls: 0, contested: 0 };

const r = rng(opt.seed);
const fixed = opt.file ? fromFile(opt.file) : undefined;
while (made < opt.maps) {
  let m: Made;
  let arg: Arg;
  if (fixed) {
    m = fixed.made;
    arg = fixed.arg;
  } else {
    m = makeMap(r);
    const loaded = am.load(m.yaml);
    if (!loaded.ok) {
      skipped++;
      if (skipped > opt.maps) {
        console.error('too many generated maps failed to load; first issues:', JSON.stringify(loaded.issues.slice(0, 3)));
        process.exit(1);
      }
      continue;
    }
    arg = loaded.argument;
  }
  const falseBets = new Set(m.bets.filter((b) => r() < (opt.falseRate[m.trust.get(b) as number] as number)));
  const truth = conclusionOf(arg, falseBets);
  const presumed = conclusionOf(arg, new Set());
  made++;
  betCount += m.bets.length;
  truthMix[truth] = (truthMix[truth] ?? 0) + 1;
  presumedMix[presumed] = (presumedMix[presumed] ?? 0) + 1;
  const flip = truth !== presumed;
  if (flip) flipMaps++;
  const seedBase = Math.floor(r() * 2 ** 31);
  let fileFirst = -1; // file order's count on this map, for the paired lead
  for (const s of ['file', ...opt.strategies.filter((x: string) => x !== 'file')]) {
    const choose = choosers[s] as Chooser;
    const rs = rng(seedBase); // the same private stream for every strategy on this map
    const checked = new Set<string>();
    const knocked = new Set<string>();
    const state: Record<string, unknown> = {};
    let first = -1;
    let lastWrong = 0;
    let wrong = 0;
    for (let step = 0; step <= m.bets.length; step++) {
      const right = conclusionOf(arg, knocked) === truth;
      if (right && first < 0) first = step;
      if (!right) {
        lastWrong = step + 1;
        wrong++;
      }
      if (step === m.bets.length) break;
      const b = choose(arg, m, checked, knocked, rs, state);
      checked.add(b);
      if (falseBets.has(b)) knocked.add(b);
    }
    if (s === 'file') fileFirst = first;
    const t = tallies[s];
    if (!t) continue; // file order was run only to pair against
    t.wrongShare += wrong / (m.bets.length + 1);
    if (flip) {
      t.flipMaps++;
      t.firstRight += first;
      t.firstRightSq += first * first;
      t.lead += fileFirst - first;
      t.leadSq += (fileFirst - first) ** 2;
      t.lastWrong += lastWrong;
    }
  }
}

const round = (x: number): number => Math.round(x * 100) / 100;
const ratio = (s: string): number | null => {
  const a = tallies[s];
  const f = tallies.file;
  return a && f && f.firstRight > 0 ? Math.round((a.firstRight / f.firstRight) * 1000) / 1000 : null;
};
const out = {
  options: opt,
  maps: made,
  meanBets: round(betCount / made),
  presumed: presumedMix,
  truth: truthMix,
  flipMaps,
  // For each order: on maps where the presumed conclusion is wrong, the mean number of checks
  // until the conclusion first matches the truth, and until it matches for good. Lower is better.
  results: Object.fromEntries(
    Object.entries(tallies).map(([s, t]) => [
      s,
      {
        checksToFirstRight: t.flipMaps ? round(t.firstRight / t.flipMaps) : null,
        shareOfFileOrder: ratio(s), // this order's checks divided by file order's, on the same flip maps
        standardError: t.flipMaps > 1 ? round(Math.sqrt((t.firstRightSq / t.flipMaps - (t.firstRight / t.flipMaps) ** 2) / (t.flipMaps - 1))) : null,
        // Checks saved against file order, paired map by map, with the standard error of that mean.
        leadOverFile: t.flipMaps ? round(t.lead / t.flipMaps) : null,
        leadStandardError: t.flipMaps > 1 ? round(Math.sqrt((t.leadSq / t.flipMaps - (t.lead / t.flipMaps) ** 2) / (t.flipMaps - 1))) : null,
        checksToStayRight: t.flipMaps ? round(t.lastWrong / t.flipMaps) : null,
        shareOfStepsWrong: round(t.wrongShare / made),
      },
    ]),
  ),
};
console.log(JSON.stringify(out, null, 1));
