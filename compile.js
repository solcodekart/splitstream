// Compiles all contracts/*.sol using the npm `solc` (bundled compiler, no network).
// Resolves @openzeppelin imports from node_modules. Outputs ./out/artifacts.json
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = __dirname;
const CONTRACTS_DIR = path.join(ROOT, "contracts");

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".sol")) acc.push(p);
  }
  return acc;
}

// Local sources keyed by path relative to ROOT (so relative imports resolve).
const sources = {};
for (const file of walk(CONTRACTS_DIR)) {
  const key = path.relative(ROOT, file).split(path.sep).join("/");
  sources[key] = { content: fs.readFileSync(file, "utf8") };
}

function findImports(importPath) {
  try {
    if (importPath.startsWith("@openzeppelin/")) {
      const full = path.join(ROOT, "node_modules", importPath);
      return { contents: fs.readFileSync(full, "utf8") };
    }
    // local already-provided sources are handled by solc; fallback read:
    const full = path.join(ROOT, importPath);
    return { contents: fs.readFileSync(full, "utf8") };
  } catch (e) {
    return { error: "Not found: " + importPath };
  }
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    viaIR: true,
    evmVersion: "paris",
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const output = JSON.parse(
  solc.compile(JSON.stringify(input), { import: findImports })
);

let hadError = false;
if (output.errors) {
  for (const err of output.errors) {
    if (err.severity === "error") {
      hadError = true;
      console.error(err.formattedMessage);
    }
  }
}
if (hadError) {
  console.error("\nCOMPILATION FAILED");
  process.exit(1);
}

// Flatten artifacts: { ContractName: { abi, bytecode } }
const artifacts = {};
for (const file of Object.keys(output.contracts)) {
  for (const name of Object.keys(output.contracts[file])) {
    const c = output.contracts[file][name];
    artifacts[name] = {
      abi: c.abi,
      bytecode: "0x" + c.evm.bytecode.object,
    };
  }
}
fs.mkdirSync(path.join(ROOT, "out"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "out", "artifacts.json"),
  JSON.stringify(artifacts, null, 2)
);
console.log("Compiled OK:", Object.keys(artifacts).join(", "));
