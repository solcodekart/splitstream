import { useState, useEffect, useRef, useCallback } from "react";
import { ethers } from "ethers";
import {
  Wallet, Plus, Check, Users, Bell, ShieldCheck, Music, Clapperboard, Youtube,
  Tv, ArrowRight, X, Lock, Zap, ChevronRight, Gavel, Sparkles, AlertTriangle,
  AudioLines, MonitorPlay, Package, Film, PlayCircle, Mountain, Feather, Gamepad2,
} from "lucide-react";
import {
  configured, MODE, CHAIN, ACCOUNTS, CFG, CYCLE, REMINDER_WINDOW, toUnits, fromUnits, fmt,
  getWriteSigner, connectInjected, factory, pool, verifier, arbitrator, ensureApproval, ensureBalance,
  loadPools, loadMember, loadJoinedMembers, latestDisputeId,
} from "./chain.js";
import { reclaimEnabled, startAccessProof } from "./reclaim.js";

// ───────────────────────────────────────────────────────────────────────────
// Splitstream — wired to the SubscriptionPool contracts on a local ganache chain.
// "Connect" picks one of ganache's deterministic dev accounts and signs real txs.
// ───────────────────────────────────────────────────────────────────────────

// Real-world plan catalog. `price` is the FULL monthly plan cost the host actually pays the
// provider; `seats` is how many people that plan officially lets share. The host form pre-fills
// the per-seat price as price ÷ seats (editable). US figures are current US list prices; EU
// figures are representative eurozone prices (they vary by country). Annual-only plans
// (Nintendo) are shown as their per-month equivalent. Prices sourced ~July 2026 — see
// docs/plan-catalog.md for the citations behind each number.
const PLATFORMS = {
  spotify:    { name: "Spotify",              plan: "Premium Family", Icon: Music,        tint: "bg-green-500",  seats: 6, price: { US: 21.99, EU: 21.99 } },
  netflix:    { name: "Netflix",              plan: "Premium 4K",     Icon: Clapperboard, tint: "bg-red-600",    seats: 4, price: { US: 26.99, EU: 21.99 } },
  youtube:    { name: "YouTube Premium",      plan: "Family",         Icon: Youtube,      tint: "bg-rose-500",   seats: 6, price: { US: 26.99, EU: 29.99 } },
  disney:     { name: "Disney+",              plan: "Premium",        Icon: Tv,           tint: "bg-blue-600",   seats: 4, price: { US: 18.99, EU: 15.99 } },
  applemusic: { name: "Apple Music",          plan: "Family",         Icon: AudioLines,   tint: "bg-pink-500",   seats: 6, price: { US: 16.99, EU: 16.99 } },
  appletv:    { name: "Apple TV+",            plan: "Monthly",        Icon: MonitorPlay,  tint: "bg-gray-800",   seats: 6, price: { US: 12.99, EU: 9.99 } },
  prime:      { name: "Amazon Prime",         plan: "Prime",          Icon: Package,      tint: "bg-sky-500",    seats: 3, price: { US: 14.99, EU: 8.99 } },
  max:        { name: "Max",                  plan: "Standard",       Icon: Film,         tint: "bg-indigo-600", seats: 2, price: { US: 18.49, EU: 9.99 } },
  hulu:       { name: "Hulu",                 plan: "No Ads",         Icon: PlayCircle,   tint: "bg-green-600",  seats: 2, price: { US: 18.99, EU: 18.99 } },
  paramount:  { name: "Paramount+",           plan: "Premium",        Icon: Mountain,     tint: "bg-blue-500",   seats: 6, price: { US: 13.99, EU: 7.99 } },
  peacock:    { name: "Peacock",              plan: "Premium",        Icon: Feather,      tint: "bg-purple-600", seats: 3, price: { US: 10.99, EU: 10.99 } },
  nintendo:   { name: "Nintendo Switch Online", plan: "Family",       Icon: Gamepad2,     tint: "bg-red-500",    seats: 8, price: { US: 2.92,  EU: 2.92 } },
};
const platformOf = (key) => PLATFORMS[key] || PLATFORMS.spotify;
// US prices for the US region; everything else (EU / UK / Global) uses the euro pricebook.
const priceBookFor = (region) => (region === "US" ? "US" : "EU");
const suggestSeatPrice = (platform, region, seats) => {
  const svc = platformOf(platform);
  const total = svc.price[priceBookFor(region)] ?? svc.price.US;
  return (total / Math.max(1, seats)).toFixed(2);
};

export default function App() {
  if (!configured) return <NotDeployed />;

  const [view, setView] = useState("browse");
  const [acct, setAcct] = useState(null); // { label, address, privateKey }
  const [pools, setPools] = useState([]);
  const [members, setMembers] = useState({}); // poolAddr -> member view for acct
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [proving, setProving] = useState(null); // pool the member is proving access to

  const toastTimer = useRef(null);
  const flash = useCallback((msg, kind = "ok") => {
    setToast({ msg, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const signer = acct ? getWriteSigner(acct) : null;

  const refresh = useCallback(async () => {
    try {
      const ps = await loadPools();
      setPools(ps);
      if (acct) {
        const entries = await Promise.all(
          ps.map(async (p) => [p.address, await loadMember(p.address, acct.address)])
        );
        setMembers(Object.fromEntries(entries));
      } else {
        setMembers({});
      }
    } catch (e) {
      console.error(e);
    }
  }, [acct]);

  // initial + polling (the chain mines every 1s, so the stream advances)
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  // run a tx with busy + toast handling
  async function run(label, fn) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      flash(label);
      await refresh();
    } catch (e) {
      console.error(e);
      flash(reason(e), "err");
    } finally {
      setBusy(false);
    }
  }

  function connect(a) {
    setAcct(a);
    flash(`Connected as ${a.label}`);
  }
  async function connectWallet() {
    try {
      const a = await connectInjected();
      setAcct(a);
      flash("Wallet connected");
    } catch (e) {
      flash(reason(e), "err");
    }
  }

  // ── contract actions ──────────────────────────────────────────────────────
  const join = (p, buffer) =>
    run("Joined — buffer streaming", async () => {
      const need = buffer + toUnits(50); // buffer + headroom for bond/top-ups
      await ensureBalance(signer, need);
      await ensureApproval(signer, p.address, need);
      await (await pool(p.address, signer).join(buffer)).wait();
      setView("pools");
    });

  const topUp = (p, amount) =>
    run("Topped up — runway extended", async () => {
      await ensureBalance(signer, amount);
      await ensureApproval(signer, p.address, amount);
      await (await pool(p.address, signer).topUp(amount)).wait();
    });

  const exit = (p) =>
    run("Exited — buffer + bond refunded", async () => {
      await (await pool(p.address, signer).exit()).wait();
      await (await pool(p.address, signer).withdraw()).wait();
    });

  const withdraw = (p) =>
    run("Withdrew available balance", async () => {
      await (await pool(p.address, signer).withdraw()).wait();
    });

  const createPool = (data) =>
    run("Pool deployed — bond posted", async () => {
      const f = factory(signer);
      const meta = JSON.stringify({ platform: data.platform, region: data.region, plan: data.plan });
      const seatPrice = toUnits(data.seatPrice);
      const ownerBond = toUnits(Math.round(data.seatPrice * data.seats * 1.5));
      const params = [
        CFG.contracts.token, seatPrice, BigInt(CYCLE), BigInt(data.seats),
        ownerBond, toUnits(2), 600n, BigInt(REMINDER_WINDOW), ownerBond,
        ethersId(meta), meta,
      ];
      await (await f.createPool(params)).wait();
      const count = Number(await f.poolCount());
      const addr = await f.allPools(count - 1);
      await ensureBalance(signer, ownerBond);
      await ensureApproval(signer, addr, ownerBond);
      await (await pool(addr, signer).fundOwnerBond()).wait();
      setView("browse");
    });

  // member: dispute the host (owner took money but cut access). Freezes the
  // streamed funds and escalates to the arbitrator.
  const raiseDispute = (p) =>
    run("Dispute opened — funds frozen pending a ruling", async () => {
      await (await pool(p.address, signer).raiseDispute("0x")).wait();
    });

  // jury verdict (mock arbitrator). 1 = member wins + owner bond slashed,
  // 2 = host wins, 0 = tie/refund. In production a real court delivers this.
  const resolveDispute = (p, memberAddr, ruling) =>
    run(
      ruling === 1 ? "Ruled for member — funds refunded, host bond slashed"
        : ruling === 2 ? "Ruled for host — streamed funds released"
        : "Ruled a tie — funds refunded to member",
      async () => {
        const id = await latestDisputeId(p.address, memberAddr);
        if (id === null || id === undefined) throw new Error("No open dispute found");
        await (await arbitrator(signer).giveRuling(id, ruling)).wait();
      }
    );

  // host: reclaim the owner bond once the pool is wound down. The contract blocks
  // this while any seat is taken OR any dispute is still open (F3 fix), so a host
  // can't dodge a pending slash by draining the bond first.
  const reclaimOwnerBond = (p) =>
    run("Owner bond reclaimed", async () => {
      await (await pool(p.address, signer).reclaimOwnerBond()).wait();
    });

  // member: generate a real Reclaim zkTLS proof-of-access and submit it on-chain.
  // The proof is bound to (member, pool); the pool stamps `lastProof` so the host can
  // then claim the streamed funds within `proofValidity`. Runs via a modal that drives
  // the Reclaim session; this handler just relays the resulting proof bytes on-chain.
  const submitProof = (p, proofBytes) =>
    run("Access proven on-chain", async () => {
      await (await pool(p.address, signer).submitAccessProof(acct.address, proofBytes)).wait();
    });

  // host: claim a member's streamed funds. With real Reclaim wired, the member has
  // already submitted a fresh proof (ownerClaim reverts StaleProof otherwise). In the
  // MockProofVerifier dev/demo path there's no real proof, so the host stamps one here.
  const verifyAndClaim = (p, memberAddr) =>
    run(reclaimEnabled ? "Streamed funds claimed" : "Access verified — streamed funds claimed", async () => {
      if (!reclaimEnabled) {
        // dev/demo only: toggle the mock verifier and stamp a proof so ownerClaim passes.
        await (await verifier(signer).setAccepts(memberAddr, true)).wait();
        await (await pool(p.address, signer).submitAccessProof(memberAddr, "0x")).wait();
      }
      await (await pool(p.address, signer).ownerClaim(memberAddr)).wait();
    });

  return (
    <div className="min-h-screen bg-white text-gray-900 antialiased">
      <Nav view={view} setView={setView} acct={acct} accounts={ACCOUNTS}
        onConnect={connect} onConnectWallet={connectWallet} busy={busy} />

      <main className="mx-auto max-w-6xl px-6">
        {view === "browse" && (
          <Browse pools={pools} members={members} acct={acct} onJoin={join} goCreate={() => setView("create")} />
        )}
        {view === "pools" && (
          <MyPools pools={pools} members={members} acct={acct} onTopUp={topUp} onExit={exit}
            onWithdraw={withdraw} onDispute={raiseDispute} onProve={setProving}
            goBrowse={() => setView("browse")} />
        )}
        {view === "host" && (
          <Host pools={pools} acct={acct} accounts={ACCOUNTS} onVerifyClaim={verifyAndClaim}
            onResolve={resolveDispute} onReclaimBond={reclaimOwnerBond} goCreate={() => setView("create")} />
        )}
        {view === "create" && (
          <CreatePool onCreate={createPool} onCancel={() => setView("browse")} />
        )}
      </main>

      <Footer />
      {proving && acct && (
        <ProveAccessModal pool={proving} member={acct.address}
          onClose={() => setProving(null)}
          onProof={async (p, bytes) => { setProving(null); await submitProof(p, bytes); }} />
      )}
      {busy && <BusyBar />}
      {toast && <Toast toast={toast} />}
    </div>
  );
}

// keccak of metadata for subscriptionRef
const ethersId = (s) => ethers.id(s);
function reason(e) {
  return e?.shortMessage || e?.reason || e?.info?.error?.message || e?.message || "Transaction failed";
}

// ── Nav ─────────────────────────────────────────────────────────────────────
function Nav({ view, setView, acct, accounts, onConnect, onConnectWallet, busy }) {
  const [open, setOpen] = useState(false);
  const local = MODE === "local";
  const tabs = [
    { id: "browse", label: "Browse" },
    { id: "pools", label: "My Pools" },
    { id: "host", label: "Host" },
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-gray-200 bg-white/70 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
        <button onClick={() => setView("browse")} className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gray-900">
            <Zap className="h-4 w-4 text-white" />
          </div>
          <span className="text-lg font-semibold tracking-tight">Splitstream</span>
          <span className="ml-1 hidden rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500 sm:inline">
            {local ? "local" : CHAIN?.name || "testnet"}
          </span>
        </button>

        <nav className="hidden items-center gap-1 sm:flex">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setView(t.id)}
              className={"rounded-full px-4 py-1.5 text-sm font-medium transition-colors " +
                (view === t.id ? "bg-gray-100 text-gray-900" : "text-gray-500 hover:text-gray-900")}>
              {t.label}
            </button>
          ))}
        </nav>

        <div className="relative">
          {acct ? (
            <div className="flex items-center gap-2 rounded-full border border-gray-200 px-3.5 py-1.5 text-sm font-medium">
              <span className="h-2 w-2 rounded-full bg-green-500" />
              {acct.label} · {short(acct.address)}
            </div>
          ) : local ? (
            <button onClick={() => setOpen((o) => !o)}
              className="flex items-center gap-2 rounded-full bg-gray-900 px-4 py-1.5 text-sm font-medium text-white transition-transform hover:scale-105">
              <Wallet className="h-4 w-4" /> Connect
            </button>
          ) : (
            <button onClick={onConnectWallet}
              className="flex items-center gap-2 rounded-full bg-gray-900 px-4 py-1.5 text-sm font-medium text-white transition-transform hover:scale-105">
              <Wallet className="h-4 w-4" /> Connect MetaMask
            </button>
          )}
          {open && local && !acct && (
            <div className="absolute right-0 mt-2 w-60 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl">
              <div className="border-b border-gray-100 px-4 py-2 text-xs font-medium text-gray-400">Dev accounts</div>
              {accounts.map((a) => (
                <button key={a.address} onClick={() => { onConnect(a); setOpen(false); }}
                  className="flex w-full items-center justify-between px-4 py-2.5 text-sm hover:bg-gray-50">
                  <span className="font-medium">{a.label}</span>
                  <span className="text-gray-400">{short(a.address)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

// ── Browse ──────────────────────────────────────────────────────────────────
function Browse({ pools, members, acct, onJoin, goCreate }) {
  const [joinFor, setJoinFor] = useState(null);
  return (
    <>
      <section className="py-20 text-center sm:py-28">
        <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-gray-200 px-3.5 py-1.5 text-xs font-medium text-gray-600">
          <Sparkles className="h-3.5 w-3.5" /> Live on your local chain
        </div>
        <h1 className="mx-auto max-w-3xl text-5xl font-semibold tracking-tight sm:text-7xl">
          Split subscriptions<br />
          <span className="text-gray-400">with people you don't know.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-gray-500">
          A smart contract holds the money, streams it by the second, and only pays the host
          once they prove your access is live. Every button here is a real transaction.
        </p>
        <div className="mt-9 flex items-center justify-center gap-3">
          <button onClick={() => document.getElementById("pools-grid")?.scrollIntoView({ behavior: "smooth" })}
            className="flex items-center gap-2 rounded-full bg-gray-900 px-6 py-3 text-base font-medium text-white transition-transform hover:scale-105">
            Find a pool <ArrowRight className="h-4 w-4" />
          </button>
          <button onClick={goCreate}
            className="rounded-full border border-gray-300 px-6 py-3 text-base font-medium text-gray-900 transition-colors hover:bg-gray-50">
            Host your own
          </button>
        </div>
        <div className="mx-auto mt-16 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-3">
          <Pillar Icon={Zap} title="Streams by the second" body="Pay only for the time you hold your seat. Stop any time." />
          <Pillar Icon={ShieldCheck} title="Proof-gated payout" body="The host gets paid only while a zkTLS proof shows access is real." />
          <Pillar Icon={Gavel} title="Bonds & disputes" body="Both sides post a bond. A decentralised jury settles the rest." />
        </div>
      </section>

      <section id="pools-grid" className="pb-20">
        <div className="mb-6 flex items-end justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Open pools</h2>
          <span className="text-sm text-gray-400">{pools.length} on-chain</span>
        </div>
        {pools.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-gray-200 py-16 text-center text-gray-400">
            No pools yet — run <code className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-600">npm run deploy</code> to seed some, or host one.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {pools.map((p) => (
              <PoolCard key={p.address} pool={p} mine={!!members[p.address]?.isActive}
                isOwner={acct && p.owner.toLowerCase() === acct.address.toLowerCase()}
                onJoin={() => setJoinFor(p)} canJoin={!!acct} />
            ))}
          </div>
        )}
      </section>

      {joinFor && (
        <JoinModal pool={joinFor} onClose={() => setJoinFor(null)}
          onConfirm={(buffer) => { onJoin(joinFor, buffer); setJoinFor(null); }} />
      )}
    </>
  );
}

function Pillar({ Icon, title, body }) {
  return (
    <div className="rounded-2xl bg-gray-50 p-6 text-left">
      <Icon className="h-6 w-6 text-gray-900" />
      <h3 className="mt-4 text-base font-semibold tracking-tight">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-gray-500">{body}</p>
    </div>
  );
}

function PoolCard({ pool, mine, isOwner, onJoin, canJoin }) {
  const meta = platformOf(pool.meta.platform);
  const { Icon } = meta;
  const full = pool.seatsTaken >= pool.seatCount;
  return (
    <div className="group flex flex-col rounded-3xl border border-gray-200 p-6 transition-shadow hover:shadow-lg">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={"flex h-11 w-11 items-center justify-center rounded-2xl text-white " + meta.tint}>
            <Icon className="h-6 w-6" />
          </div>
          <div>
            <div className="font-semibold tracking-tight">{meta.name}</div>
            <div className="text-xs text-gray-400">{pool.meta.plan} · {pool.meta.region}</div>
          </div>
        </div>
        {pool.active ? (
          <span className="flex items-center gap-1 rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700">
            <ShieldCheck className="h-3 w-3" /> Active
          </span>
        ) : (
          <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
            <Lock className="h-3 w-3" /> Inactive
          </span>
        )}
      </div>

      <div className="mt-6 flex items-end gap-1">
        <span className="text-3xl font-semibold tracking-tight">${fmt(pool.seatPrice)}</span>
        <span className="mb-1 text-sm text-gray-400">/ cycle</span>
      </div>

      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between text-xs text-gray-500">
          <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" /> {pool.seatsTaken}/{pool.seatCount} seats</span>
          <span>{pool.seatCount - pool.seatsTaken} open</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
          <div className="h-full rounded-full bg-gray-900 transition-all"
            style={{ width: `${(pool.seatsTaken / pool.seatCount) * 100}%` }} />
        </div>
      </div>

      <button onClick={onJoin} disabled={mine || full || isOwner || !canJoin}
        className={"mt-6 flex w-full items-center justify-center gap-2 rounded-full py-2.5 text-sm font-medium transition-colors " +
          (mine ? "bg-green-50 text-green-700"
            : isOwner ? "cursor-default bg-gray-50 text-gray-400"
            : full || !canJoin ? "cursor-not-allowed bg-gray-100 text-gray-400"
            : "bg-gray-900 text-white hover:bg-gray-700")}>
        {mine ? (<><Check className="h-4 w-4" /> Joined</>)
          : isOwner ? "You host this"
          : full ? "Full"
          : !canJoin ? "Connect to join"
          : (<>Join pool <ChevronRight className="h-4 w-4" /></>)}
      </button>
    </div>
  );
}

// ── Join modal ────────────────────────────────────────────────────────────────
function JoinModal({ pool, onClose, onConfirm }) {
  const meta = platformOf(pool.meta.platform);
  const [cycles, setCycles] = useState(1);
  const price = fromUnits(pool.seatPrice);
  const buffer = price * cycles;
  const bond = 2;
  return (
    <Overlay onClose={onClose}>
      <div className="flex items-center gap-3">
        <div className={"flex h-11 w-11 items-center justify-center rounded-2xl text-white " + meta.tint}>
          <meta.Icon className="h-6 w-6" />
        </div>
        <div>
          <h3 className="text-lg font-semibold tracking-tight">Join {meta.name}</h3>
          <p className="text-xs text-gray-400">{pool.meta.plan} · {pool.meta.region}</p>
        </div>
      </div>
      <p className="mt-5 text-sm leading-relaxed text-gray-500">
        You prepay a streaming <span className="font-medium text-gray-900">buffer</span>. It flows to the
        host by the second. Top up any time — let it run dry and you lose the seat automatically.
      </p>
      <div className="mt-5">
        <label className="mb-2 block text-sm font-medium">Prepay how many cycles?</label>
        <div className="flex gap-2">
          {[1, 2, 3].map((c) => (
            <button key={c} onClick={() => setCycles(c)}
              className={"flex-1 rounded-xl border py-2.5 text-sm font-medium transition-colors " +
                (cycles === c ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 text-gray-600 hover:border-gray-400")}>
              {c}×
            </button>
          ))}
        </div>
      </div>
      <div className="mt-5 space-y-2 rounded-2xl bg-gray-50 p-4 text-sm">
        <Row label={`Buffer (${cycles} × $${price.toFixed(2)})`} value={`$${buffer.toFixed(2)}`} />
        <Row label="Refundable member bond" value={`$${bond.toFixed(2)}`} />
        <div className="border-t border-gray-200 pt-2">
          <Row label="Total deposit" value={`$${(buffer + bond).toFixed(2)}`} bold />
        </div>
      </div>
      <button onClick={() => onConfirm(toUnits(buffer))}
        className="mt-5 w-full rounded-full bg-gray-900 py-3 text-sm font-medium text-white transition-colors hover:bg-gray-700">
        Confirm & sign transaction
      </button>
      <p className="mt-3 text-center text-xs text-gray-400">Signs join() on the pool contract.</p>
    </Overlay>
  );
}

// ── Prove access (real Reclaim zkTLS flow) ─────────────────────────────────────
// Drives a Reclaim proof session for the connected member, bound to (member, pool).
// The member completes the flow on the Reclaim app (scan the QR / open the link);
// on success we get abi-encoded proof bytes and hand them up to submitAccessProof.
function ProveAccessModal({ pool, member, onClose, onProof }) {
  const meta = platformOf(pool.meta.platform);
  const [url, setUrl] = useState(null);
  const [status, setStatus] = useState("starting"); // starting | awaiting | submitting | error
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setStatus("awaiting");
        const bytes = await startAccessProof({
          member, pool: pool.address, onUrl: (u) => alive && setUrl(u),
        });
        if (!alive) return;
        setStatus("submitting");
        await onProof(pool, bytes); // closes the modal + submits on-chain
      } catch (e) {
        if (alive) { setErr(reason(e)); setStatus("error"); }
      }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <Overlay onClose={onClose}>
      <div className="flex items-center gap-3">
        <div className={"flex h-11 w-11 items-center justify-center rounded-2xl text-white " + meta.tint}>
          <meta.Icon className="h-6 w-6" />
        </div>
        <div>
          <h3 className="text-lg font-semibold tracking-tight">Prove your {meta.name} access</h3>
          <p className="text-xs text-gray-400">zkTLS proof · bound to this pool &amp; your address</p>
        </div>
      </div>

      {status === "error" ? (
        <>
          <Banner tone="red" Icon={AlertTriangle} title="Proof failed." body={err || "Something went wrong."} />
          <button onClick={onClose}
            className="mt-5 w-full rounded-full bg-gray-900 py-3 text-sm font-medium text-white transition-colors hover:bg-gray-700">
            Close
          </button>
        </>
      ) : status === "submitting" ? (
        <p className="mt-6 text-sm text-gray-500">Proof received — submitting it on-chain…</p>
      ) : (
        <>
          <p className="mt-5 text-sm leading-relaxed text-gray-500">
            Open the Reclaim flow below and sign in to {meta.name}. Reclaim's witnesses attest your
            membership over zkTLS — your password and cookies never leave your device, and never touch
            the chain. Only the signed attestation does.
          </p>
          <div className="mt-5 rounded-2xl bg-gray-50 p-4 text-sm">
            {url ? (
              <a href={url} target="_blank" rel="noreferrer"
                className="flex items-center justify-center gap-2 rounded-full bg-gray-900 py-3 text-sm font-medium text-white transition-colors hover:bg-gray-700">
                <ShieldCheck className="h-4 w-4" /> Open Reclaim to prove access
              </a>
            ) : (
              <p className="text-center text-gray-400">Preparing your proof request…</p>
            )}
            {url && (
              <p className="mt-3 break-all text-center text-xs text-gray-400">
                Or scan / paste this link on your phone:<br />{url}
              </p>
            )}
          </div>
          <p className="mt-3 text-center text-xs text-gray-400">Waiting for the proof to complete…</p>
        </>
      )}
    </Overlay>
  );
}

// ── My Pools ──────────────────────────────────────────────────────────────────
function MyPools({ pools, members, acct, onTopUp, onExit, onWithdraw, onDispute, onProve, goBrowse }) {
  if (!acct) return <Empty title="Connect to see your seats" body="Your memberships and streaming buffers live on-chain, tied to your wallet." cta="Use the Connect menu" />;
  const mine = pools.filter((p) => {
    const m = members[p.address];
    return m && (m.joined || m.isActive || m.buffer > 0n || m.withdrawable > 0n);
  });
  if (mine.length === 0) return <Empty title="No seats yet" body="Join a pool and your streaming buffer shows up here, ticking down in real time." cta="Browse pools" onClick={goBrowse} />;
  return (
    <section className="py-12">
      <h2 className="mb-6 text-2xl font-semibold tracking-tight">My seats</h2>
      <div className="space-y-4">
        {mine.map((p) => (
          <MembershipRow key={p.address} pool={p} m={members[p.address]}
            onTopUp={onTopUp} onExit={onExit} onWithdraw={onWithdraw} onDispute={onDispute} onProve={onProve} />
        ))}
      </div>
    </section>
  );
}

function MembershipRow({ pool, m, onTopUp, onExit, onWithdraw, onDispute, onProve }) {
  const meta = platformOf(pool.meta.platform);
  const price = fromUnits(pool.seatPrice);
  const reminder = m.isActive && m.reminderDue;
  // Auto-excluded (buffer ran dry) but the refundable bond is still locked in the
  // pool. The F1 fix lets exit() recover it even though isActive is already false.
  const canReclaimBond = m.joined && !m.isActive && m.bond > 0n && !m.inDispute;
  const pct = Math.min(100, (fromUnits(m.buffer) / price) * 100);
  return (
    <div className="rounded-3xl border border-gray-200 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={"flex h-11 w-11 items-center justify-center rounded-2xl text-white " + meta.tint}>
            <meta.Icon className="h-6 w-6" />
          </div>
          <div>
            <div className="font-semibold tracking-tight">{meta.name}</div>
            <div className="text-xs text-gray-400">{pool.meta.plan} · {pool.meta.region}</div>
          </div>
        </div>
        {m.isActive ? (
          <span className="flex items-center gap-1 rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700">
            <span className="h-2 w-2 rounded-full bg-green-500" /> Streaming
          </span>
        ) : (
          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-500">Inactive</span>
        )}
      </div>

      {m.isActive && (
        <div className="mt-6">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="text-gray-500">Buffer remaining</span>
            <span className="font-medium tabular-nums">${fmt(m.buffer)} · ~{m.runway}s runway</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
            <div className={"h-full rounded-full transition-all " + (reminder ? "bg-amber-500" : "bg-gray-900")}
              style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {reminder && (
        <Banner tone="amber" Icon={Bell} title="Top up or lose your seat."
          body="Your buffer is almost empty — the next settlement will exclude you automatically." />
      )}
      {!m.isActive && m.joined && m.withdrawable === 0n && (
        <Banner tone="red" Icon={X} title="Seat released."
          body={canReclaimBond
            ? "Your buffer ran dry and the stream excluded you. Reclaim your refundable bond below, then re-join from Browse whenever you like."
            : "Your buffer ran dry and the stream excluded you. Re-join from Browse to get a new seat."} />
      )}
      {m.withdrawable > 0n && (
        <Banner tone="blue" Icon={Check} title={`$${fmt(m.withdrawable)} ready to withdraw.`}
          body="Refunds and dispute payouts sit in your pull-payment balance until you withdraw." />
      )}
      {m.inDispute && (
        <Banner tone="amber" Icon={Gavel} title="Dispute open — funds frozen."
          body="Your streamed funds are held pending a jury verdict. If the ruling favours you, they're refunded and the host's bond is slashed." />
      )}

      <div className="mt-5 flex flex-wrap gap-3">
        {m.isActive && !m.inDispute && (
          <>
            <button onClick={() => onTopUp(pool, pool.seatPrice)}
              className="flex flex-1 items-center justify-center gap-2 rounded-full bg-gray-900 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-700">
              <Plus className="h-4 w-4" /> Top up ${price.toFixed(2)}
            </button>
            <button onClick={() => onExit(pool)}
              className="rounded-full border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50">
              Exit
            </button>
            <button onClick={() => onDispute(pool)}
              className="flex items-center gap-1.5 rounded-full border border-red-200 px-5 py-2.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50">
              <Gavel className="h-4 w-4" /> Dispute
            </button>
            {reclaimEnabled && (
              <button onClick={() => onProve(pool)}
                className="flex items-center gap-1.5 rounded-full border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50">
                <ShieldCheck className="h-4 w-4" /> Prove access
              </button>
            )}
          </>
        )}
        {m.inDispute && (
          <div className="flex items-center gap-2 rounded-full bg-amber-50 px-5 py-2.5 text-sm font-medium text-amber-700">
            <Gavel className="h-4 w-4" /> Awaiting jury ruling
          </div>
        )}
        {canReclaimBond && (
          <button onClick={() => onExit(pool)}
            className="flex flex-1 items-center justify-center gap-2 rounded-full bg-gray-900 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-700">
            <ShieldCheck className="h-4 w-4" /> Reclaim your ${fmt(m.bond)} bond
          </button>
        )}
        {!m.isActive && m.withdrawable > 0n && (
          <button onClick={() => onWithdraw(pool)}
            className="flex flex-1 items-center justify-center gap-2 rounded-full bg-gray-900 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-700">
            Withdraw ${fmt(m.withdrawable)}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Host ──────────────────────────────────────────────────────────────────────
function Host({ pools, acct, accounts, onVerifyClaim, onResolve, onReclaimBond, goCreate }) {
  const [rows, setRows] = useState({}); // poolAddr -> [{address,label,m}]
  const owned = acct ? pools.filter((p) => p.owner.toLowerCase() === acct.address.toLowerCase()) : [];

  useEffect(() => {
    let alive = true;
    (async () => {
      const next = {};
      for (const p of owned) {
        next[p.address] = await loadJoinedMembers(p.address);
      }
      if (alive) setRows(next);
    })();
    return () => { alive = false; };
  }, [pools, acct]);

  if (!acct) return <Empty title="Connect to host" body="Hosting a pool means posting a bond and proving access stays live." cta="Use the Connect menu" />;
  if (owned.length === 0) return <Empty title="You don't host any pools" body="Create one — you'll post an owner bond and the contract streams members' payments to you." cta="Create a pool" onClick={goCreate} />;

  return (
    <section className="py-12">
      <div className="mb-6 flex items-end justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">Pools you host</h2>
        <button onClick={goCreate} className="rounded-full border border-gray-300 px-4 py-1.5 text-sm font-medium hover:bg-gray-50">+ New pool</button>
      </div>
      <div className="space-y-4">
        {owned.map((p) => {
          const meta = platformOf(p.meta.platform);
          const seats = rows[p.address] || [];
          return (
            <div key={p.address} className="rounded-3xl border border-gray-200 p-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={"flex h-11 w-11 items-center justify-center rounded-2xl text-white " + meta.tint}>
                    <meta.Icon className="h-6 w-6" />
                  </div>
                  <div>
                    <div className="font-semibold tracking-tight">{meta.name}</div>
                    <div className="text-xs text-gray-400">{p.meta.plan} · {p.meta.region} · {p.seatsTaken}/{p.seatCount} seats</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-gray-400">Owner bond locked</div>
                  <div className="font-semibold tabular-nums">${fmt(p.ownerBond)}</div>
                  {p.ownerBond > 0n && (() => {
                    const disputeOpen = p.openDisputes > 0;
                    const seated = p.seatsTaken > 0;
                    const canReclaim = !disputeOpen && !seated;
                    return (
                      <button onClick={() => canReclaim && onReclaimBond(p)} disabled={!canReclaim}
                        title={disputeOpen ? "A dispute is open — the bond stays locked until it's ruled"
                          : seated ? "Members still hold seats — empty the pool first" : "Reclaim your owner bond"}
                        className={"mt-2 inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors " +
                          (canReclaim ? "bg-gray-900 text-white hover:bg-gray-700" : "cursor-not-allowed bg-gray-100 text-gray-400")}>
                        <Lock className="h-3.5 w-3.5" />
                        {disputeOpen ? "Locked — dispute open" : seated ? "Locked — seats active" : "Reclaim bond"}
                      </button>
                    );
                  })()}
                </div>
              </div>
              {p.openDisputes > 0 && (
                <div className="mt-4 flex items-center gap-2 rounded-2xl bg-amber-50 px-4 py-2.5 text-xs font-medium text-amber-700">
                  <Gavel className="h-3.5 w-3.5" />
                  {p.openDisputes} open dispute{p.openDisputes > 1 ? "s" : ""} — your bond can't be reclaimed until {p.openDisputes > 1 ? "they're" : "it's"} ruled.
                </div>
              )}

              <div className="mt-5 space-y-2">
                {seats.length === 0 && <p className="text-sm text-gray-400">No members yet.</p>}
                {seats.map((s) => (
                  <div key={s.address} className={"rounded-2xl px-4 py-3 text-sm " + (s.m.inDispute ? "bg-amber-50" : "bg-gray-50")}>
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-medium">{s.label}</span>
                        <span className="ml-2 text-gray-400">{short(s.address)}</span>
                        {s.m.inDispute && (
                          <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                            <Gavel className="h-3 w-3" /> in dispute
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="tabular-nums text-gray-500">streamed&nbsp;${fmt(s.m.pending)}</span>
                        {!s.m.inDispute && (
                          <button onClick={() => onVerifyClaim(p, s.address)} disabled={s.m.pending === 0n}
                            className={"flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors " +
                              (s.m.pending === 0n ? "cursor-not-allowed bg-gray-100 text-gray-400" : "bg-gray-900 text-white hover:bg-gray-700")}>
                            <ShieldCheck className="h-3.5 w-3.5" /> Verify &amp; claim
                          </button>
                        )}
                      </div>
                    </div>
                    {s.m.inDispute && (
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-amber-200 pt-3">
                        <span className="mr-1 text-xs font-medium text-amber-700">Simulate jury verdict:</span>
                        <button onClick={() => onResolve(p, s.address, 1)}
                          className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-red-600 ring-1 ring-red-200 transition-colors hover:bg-red-50">
                          Member wins (slash bond)
                        </button>
                        <button onClick={() => onResolve(p, s.address, 2)}
                          className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-gray-700 ring-1 ring-gray-200 transition-colors hover:bg-gray-100">
                          Host wins
                        </button>
                        <button onClick={() => onResolve(p, s.address, 0)}
                          className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-gray-500 ring-1 ring-gray-200 transition-colors hover:bg-gray-100">
                          Tie (refund)
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs leading-relaxed text-gray-400">
                "Verify &amp; claim" stands in for a zkTLS proof: it marks the member's access as proven, then
                calls ownerClaim() — which the contract only allows while that proof is fresh. When a member
                disputes, the payout freezes; the verdict buttons stand in for a decentralised jury
                (Kleros) calling the arbitrator's ruling on-chain.
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Create ────────────────────────────────────────────────────────────────────
function CreatePool({ onCreate, onCancel }) {
  const [platform, setPlatform] = useState("spotify");
  const [region, setRegion] = useState("EU");
  const [seats, setSeats] = useState(platformOf("spotify").seats);
  const [seatPrice, setSeatPrice] = useState(() => suggestSeatPrice("spotify", "EU", platformOf("spotify").seats));
  // `edited` tracks whether the host has hand-typed a price. While false, the field stays in
  // sync with the plan/region/seats auto-fill; once they type, we stop overwriting their value.
  const [edited, setEdited] = useState(false);

  const svc = platformOf(platform);
  const plan = svc.plan;
  const planTotal = svc.price[priceBookFor(region)] ?? svc.price.US;
  const cur = region === "US" ? "$" : "€";

  // Pick a new platform: reset seats to that plan's capacity and re-arm auto-fill.
  const pickPlatform = (key) => {
    const next = platformOf(key);
    setPlatform(key);
    setSeats(next.seats);
    setEdited(false);
    setSeatPrice(suggestSeatPrice(key, region, next.seats));
  };
  // Keep the suggested per-seat price live as region/seats change, unless the host overrode it.
  useEffect(() => {
    if (!edited) setSeatPrice(suggestSeatPrice(platform, region, seats));
  }, [platform, region, seats, edited]);

  const price = parseFloat(seatPrice) || 0;
  const bond = Math.round(price * seats * 1.5);

  return (
    <section className="mx-auto max-w-xl py-12">
      <button onClick={onCancel} className="mb-6 text-sm text-gray-400 hover:text-gray-900">← Back</button>
      <h2 className="text-3xl font-semibold tracking-tight">Host a pool</h2>
      <p className="mt-2 text-gray-500">You post a bond and prove access stays live. The contract streams members' payments to you.</p>

      <div className="mt-8 space-y-6">
        <div>
          <label className="mb-2 block text-sm font-medium">Platform</label>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {Object.entries(PLATFORMS).map(([key, meta]) => (
              <button key={key} onClick={() => pickPlatform(key)}
                className={"flex flex-col items-center gap-2 rounded-2xl border py-4 transition-colors " +
                  (platform === key ? "border-gray-900 bg-gray-50" : "border-gray-200 hover:border-gray-400")}>
                <div className={"flex h-9 w-9 items-center justify-center rounded-xl text-white " + meta.tint}>
                  <meta.Icon className="h-5 w-5" />
                </div>
                <span className="text-center text-xs font-medium leading-tight">{meta.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-2 block text-sm font-medium">Region</label>
            <select value={region} onChange={(e) => setRegion(e.target.value)}
              className="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:border-gray-900 focus:outline-none">
              {["EU", "US", "UK", "Global"].map((r) => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium">Price / seat ({cur})</label>
            <input value={seatPrice}
              onChange={(e) => { setSeatPrice(e.target.value); setEdited(true); }}
              inputMode="decimal"
              className="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:border-gray-900 focus:outline-none" />
            <p className="mt-1 text-xs text-gray-400">
              {edited
                ? <button type="button" onClick={() => setEdited(false)} className="underline hover:text-gray-600">Reset to suggested</button>
                : `Auto-split from the ${cur}${planTotal.toFixed(2)} plan`}
            </p>
          </div>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium">Seats <span className="text-gray-400">· {seats} of {svc.seats}</span></label>
          <input type="range" min={2} max={svc.seats} value={seats} onChange={(e) => setSeats(Number(e.target.value))} className="w-full accent-gray-900" />
          <div className="mt-1 flex justify-between text-xs text-gray-400"><span>2</span><span>{svc.seats}</span></div>
        </div>

        <div className="space-y-2 rounded-2xl bg-gray-50 p-5 text-sm">
          <Row label={`${svc.name} · ${plan} — full plan`} value={`${cur}${planTotal.toFixed(2)}/mo`} />
          <Row label={`Members cover (${seats} × ${cur}${price.toFixed(2)})`} value={`${cur}${(price * seats).toFixed(2)}`} />
          <Row label="Your owner bond (locked)" value={`$${bond}`} />
          <Row label="Proof-of-access" value="Required to claim" />
        </div>

        <button onClick={() => onCreate({ platform, region, plan, seatPrice: price, seats })} disabled={price <= 0}
          className="w-full rounded-full bg-gray-900 py-3 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:cursor-not-allowed disabled:bg-gray-300">
          Deploy pool &amp; post bond
        </button>
      </div>
    </section>
  );
}

// ── shared bits ───────────────────────────────────────────────────────────────
function Overlay({ children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-4 backdrop-blur-sm sm:items-center">
      <div className="relative w-full max-w-md rounded-3xl bg-white p-7 shadow-2xl">
        <button onClick={onClose} className="absolute right-5 top-5 text-gray-400 hover:text-gray-900"><X className="h-5 w-5" /></button>
        {children}
      </div>
    </div>
  );
}
function Row({ label, value, bold }) {
  return (
    <div className="flex items-center justify-between">
      <span className={bold ? "font-medium" : "text-gray-500"}>{label}</span>
      <span className={"tabular-nums " + (bold ? "font-semibold" : "font-medium")}>{value}</span>
    </div>
  );
}
function Banner({ tone, Icon, title, body }) {
  const tones = {
    amber: "bg-amber-50 text-amber-800", red: "bg-red-50 text-red-800", blue: "bg-blue-50 text-blue-800",
  };
  const ic = { amber: "text-amber-600", red: "text-red-600", blue: "text-blue-600" };
  return (
    <div className={"mt-4 flex items-start gap-3 rounded-2xl p-4 " + tones[tone]}>
      <Icon className={"mt-0.5 h-4 w-4 shrink-0 " + ic[tone]} />
      <p className="text-sm leading-relaxed"><span className="font-medium">{title}</span> {body}</p>
    </div>
  );
}
function Empty({ title, body, cta, onClick }) {
  return (
    <section className="flex flex-col items-center py-32 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100"><Users className="h-7 w-7 text-gray-400" /></div>
      <h2 className="mt-5 text-xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 max-w-sm text-gray-500">{body}</p>
      {onClick ? (
        <button onClick={onClick} className="mt-6 rounded-full bg-gray-900 px-6 py-2.5 text-sm font-medium text-white transition-transform hover:scale-105">{cta}</button>
      ) : (
        <p className="mt-6 text-sm font-medium text-gray-400">{cta}</p>
      )}
    </section>
  );
}
function Footer() {
  return (
    <footer className="mt-20 border-t border-gray-200">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-8 text-sm text-gray-400 sm:flex-row">
        <span>Splitstream · local prototype · not audited</span>
        <span>Funds held by the pool contract, never by us.</span>
      </div>
    </footer>
  );
}
function BusyBar() {
  return (
    <div className="fixed left-0 right-0 top-0 z-50 h-0.5 overflow-hidden bg-gray-100">
      <div className="h-full w-1/3 animate-pulse bg-gray-900" />
    </div>
  );
}
function Toast({ toast }) {
  const ok = toast.kind === "ok";
  return (
    <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
      <div className={"flex items-center gap-2 rounded-full px-5 py-3 text-sm font-medium text-white shadow-xl " + (ok ? "bg-gray-900" : "bg-red-600")}>
        {ok ? <Check className="h-4 w-4 text-green-400" /> : <AlertTriangle className="h-4 w-4" />}
        <span className="max-w-xs truncate">{toast.msg}</span>
      </div>
    </div>
  );
}
function NotDeployed() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-white px-6 text-center text-gray-900">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-900"><Zap className="h-6 w-6 text-white" /></div>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight">Splitstream isn't wired up yet</h1>
      <p className="mt-3 max-w-md text-gray-500">Start a local chain and deploy the contracts, then reload:</p>
      <pre className="mt-5 rounded-2xl bg-gray-900 px-6 py-4 text-left text-sm text-gray-100">
{`# in the project root
npm run compile
npm run chain      # terminal 1 (keep running)
npm run deploy     # terminal 2`}
      </pre>
    </div>
  );
}
function short(a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : ""; }
