// Differential / property fuzz for ReclaimAdapterVerifier._extractField — the JSON
// field parser that the adapter uses to read `contextAddress` / `contextMessage` out of
// a Reclaim proof's (signature-bound) context, and thus enforces the member/pool
// bindings. A parser bug here is a security bug: an off-by-one on the terminating quote,
// or a mismatch against the SDK's own extraction, could let a crafted context bind to the
// wrong address.
//
// Strategy: deploy `ParserHarness` (re-exports the adapter's internal `_extractField`) and
// run thousands of adversarial contexts through BOTH the Solidity parser and a JS port of
// the exact same algorithm. Properties asserted per case:
//   (P1) DIFFERENTIAL — Solidity output === JS-reference output, byte-for-byte.
//   (P2) TOTALITY     — the parser never reverts (always returns a string) on any input.
//   (P3) CORRECTNESS  — on a well-formed `{"contextAddress":"<v>",...}` the extracted value
//                        is exactly <v> (for values with no unescaped quote).
// The escaped-quote / first-match / missing-field edge behaviours are already asserted as
// named cases in test-reclaim-adapter.js; this file is the high-volume differential net.
const fs = require("fs");
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const artifacts = JSON.parse(fs.readFileSync(path.join(__dirname, "out", "artifacts.json"), "utf8"));

let passed = 0, failed = 0;
const ok = (c, m) => (c ? (passed++, console.log("  ✓ " + m)) : (failed++, console.log("  ✗ " + m)));

// ── JS reference: a byte-for-byte port of ReclaimAdapterVerifier._extractField ─────────
// Operates on UTF-8 bytes exactly like the Solidity version. Returns "" where the contract
// returns "" (missing target / no closing quote / empty span). The contract can also revert
// on d[end-1] underflow only when target is empty AND matches at index 0 — we never fuzz an
// empty target (the production targets are fixed non-empty literals), so this port and the
// contract stay total and in agreement.
function extractRef(dataStr, targetStr) {
  const d = Buffer.from(dataStr, "utf8");
  const t = Buffer.from(targetStr, "utf8");
  if (d.length < t.length) return "";
  let start = 0, found = false;
  for (let i = 0; i + t.length <= d.length; i++) {
    let isMatch = true;
    for (let j = 0; j < t.length && isMatch; j++) {
      if (d[i + j] !== t[j]) isMatch = false;
    }
    if (isMatch) { start = i + t.length; found = true; break; }
  }
  if (!found) return "";
  let end = start;
  while (end < d.length && !(d[end] === 0x22 /* " */ && d[end - 1] !== 0x5c /* \ */)) end++;
  if (end <= start || end >= d.length) return "";
  return d.slice(start, end).toString("utf8");
}

// ── Corpus generator ──────────────────────────────────────────────────────────────────
// Mulberry32 — small deterministic PRNG so a failing run is reproducible from the seed.
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ADDR = "contextAddress";
const MSG = "contextMessage";
const TARGET_ADDR = `"${ADDR}":"`;
const TARGET_MSG = `"${MSG}":"`;

// Value fragments — a mix of benign and parser-hostile pieces. No RAW unescaped quote inside
// a "value" fragment (an unescaped quote legitimately terminates the field); adversarial
// quote handling is covered by escaped `\"` and lone `\` fragments.
const FRAG = [
  "0x0000000000000000000000000000000000000001",
  "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  "a", "z", "9", "_", "-", ":", ",", "{", "}", "[", "]",
  "\\\"",        // an escaped quote  ->  \"
  "\\\\",        // an escaped backslash -> \\
  "\\",          // a lone trailing backslash
  "contextAddress", "contextMessage",   // decoy key words inside values
  "\\\"contextAddress\\\":\\\"",         // an escaped decoy key/value
  "π", "日本", "€",                      // multibyte UTF-8
  " ", "\\n", "x".repeat(20),
];

function randVal(r, maxFrags) {
  const n = Math.floor(r() * maxFrags);
  let s = "";
  for (let i = 0; i < n; i++) s += FRAG[Math.floor(r() * FRAG.length)];
  return s;
}

// Build one fuzz context. `shape` selects a structural class so the corpus spans the space
// the real parser must survive, not just happy JSON.
function makeContext(r) {
  const shape = Math.floor(r() * 8);
  const a = randVal(r, 6), b = randVal(r, 6), c = randVal(r, 6);
  switch (shape) {
    case 0: // well-formed, values from safe alphabet only (drives P3)
      return { ctx: `{"${ADDR}":"${safeVal(r)}","${MSG}":"${safeVal(r)}"}`, wellFormed: true };
    case 1: // well-formed but hostile values
      return { ctx: `{"${ADDR}":"${a}","${MSG}":"${b}"}` };
    case 2: // fields reversed
      return { ctx: `{"${MSG}":"${b}","${ADDR}":"${a}"}` };
    case 3: // duplicate contextAddress — parser must take the FIRST
      return { ctx: `{"${ADDR}":"${a}","${ADDR}":"${b}","${MSG}":"${c}"}` };
    case 4: // extra decoy keys around the real ones
      return { ctx: `{"junk":"${a}","${ADDR}":"${b}","x${ADDR}":"${c}","${MSG}":"${a}"}` };
    case 5: // target present but never closed (no terminating quote)
      return { ctx: `{"${ADDR}":"${a}${b}${c}` };
    case 6: // no target at all
      return { ctx: `{"foo":"${a}","bar":"${b}"}` };
    case 7: // raw garbage, target maybe embedded mid-blob
      return { ctx: `${a}${TARGET_ADDR}${b}"${c}` };
  }
}
// Safe value: hex-ish chars only, so P3 can predict the exact extracted string.
function safeVal(r) {
  const alpha = "0123456789abcdefx";
  const n = 1 + Math.floor(r() * 42);
  let s = "";
  for (let i = 0; i < n; i++) s += alpha[Math.floor(r() * alpha.length)];
  return s;
}

async function main() {
  const server = ganache.provider({
    logging: { quiet: true }, miner: { defaultGasPrice: 0, timestampIncrement: 0 },
    wallet: { totalAccounts: 2, defaultBalance: 100 },
  });
  const provider = new ethers.BrowserProvider(server);
  const accts = await provider.send("eth_accounts", []);
  const signer = await provider.getSigner(accts[0]);

  const f = new ethers.ContractFactory(
    artifacts["ParserHarness"].abi, artifacts["ParserHarness"].bytecode, signer);
  const harness = await f.deploy();
  await harness.waitForDeployment();

  console.log("\n== Property fuzz: ReclaimAdapterVerifier._extractField vs SDK-algorithm reference ==");

  const N = Number(process.env.FUZZ_N || 1500);
  const r = rng(0xC0FFEE);
  let diffFails = 0, revertFails = 0, correctFails = 0, correctChecked = 0;
  let firstDiff = null;

  for (let i = 0; i < N; i++) {
    const { ctx, wellFormed } = makeContext(r);
    // Alternate which real field we ask for; occasionally ask for a target that isn't there.
    const target = (i % 3 === 0) ? TARGET_MSG : (i % 7 === 0 ? `"missing${i}":"` : TARGET_ADDR);

    let solOut;
    try {
      solOut = await harness.extract(ctx, target);          // (P2) must not revert
    } catch (e) {
      if (revertFails < 3) console.log(`    revert on case ${i}: ctx=${JSON.stringify(ctx)} target=${target}`);
      revertFails++; continue;
    }

    const refOut = extractRef(ctx, target);
    if (solOut !== refOut) {                                 // (P1) differential
      diffFails++;
      if (!firstDiff) firstDiff = { i, ctx, target, solOut, refOut };
    }

    // (P3) correctness on the safe well-formed shape when we asked for contextAddress.
    if (wellFormed && target === TARGET_ADDR) {
      correctChecked++;
      const expected = ctx.slice(ctx.indexOf(TARGET_ADDR) + TARGET_ADDR.length, ctx.indexOf(`","${MSG}"`));
      if (solOut !== expected) correctFails++;
    }
  }

  ok(revertFails === 0, `(P2) totality — no reverts across ${N} adversarial contexts`);
  ok(diffFails === 0, `(P1) differential — Solidity parser matches SDK-algorithm reference on all ${N} cases`);
  if (firstDiff) console.log("    first mismatch:", JSON.stringify(firstDiff));
  ok(correctFails === 0, `(P3) correctness — well-formed contextAddress extracted exactly (${correctChecked} checked)`);

  // A couple of pinned regression vectors: the exact adversarial shapes from the review.
  const pinned = [
    // escaped-decoy earlier in the blob must NOT shadow the real owner value
    { ctx: `{"a":"\\"contextAddress\\":\\"0xdead","contextAddress":"0xbeef","contextMessage":"0x01"}`,
      target: TARGET_ADDR, expect: "0xbeef", note: "escaped decoy does not shadow real field" },
    // value legitimately containing an escaped quote is read through to the real closer
    { ctx: `{"contextAddress":"0x1\\"2","contextMessage":"0x3"}`,
      target: TARGET_ADDR, expect: `0x1\\"2`, note: "escaped quote inside value preserved" },
    // no closing quote -> ""
    { ctx: `{"contextAddress":"0xnoclose`, target: TARGET_ADDR, expect: "", note: "unterminated value -> empty" },
  ];
  for (const p of pinned) {
    const solOut = await harness.extract(p.ctx, p.target);
    ok(solOut === p.expect && solOut === extractRef(p.ctx, p.target), `pinned: ${p.note}`);
  }

  console.log(`\nRESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
