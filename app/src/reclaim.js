// Real Reclaim Protocol zkTLS proof flow for the member's "Prove access" button.
//
// The member (who actually holds the streaming-service session) generates a Reclaim
// proof in their browser/phone, we transform it to the on-chain `Reclaim.Proof` struct,
// abi-encode it into the `bytes` blob our pool expects, and the member submits it via
// `submitAccessProof(member, proofBytes)`. On-chain, ReclaimAdapterVerifier asks the
// deployed Reclaim beacon to check the witness signatures, then enforces the
// provider⇄ref / member / pool / freshness bindings.
//
// SECURITY: the Reclaim *app secret* must never ship in a real frontend. In production
// you initialise `ReclaimProofRequest` on a small backend and hand the browser a prepared
// request (or use the SDK's backend-init flow). For this prototype we read it from a Vite
// env var (`VITE_RECLAIM_APP_SECRET`) so the demo is self-contained — do not do this in
// production. No credential/cookie/access-token ever touches the chain: only the witness
// signatures over the claim do.
import { ReclaimProofRequest, transformForOnchain } from "@reclaimprotocol/js-sdk";
import { ethers } from "ethers";
import { CFG } from "./chain.js";

const R = CFG.reclaim || {};
// Enabled only when a deploy wrote reclaim.appId + reclaim.providerId into deployed.json.
// When disabled, the app falls back to the MockProofVerifier demo path (host toggles it).
export const reclaimEnabled = !!(R.appId && R.providerId);

const APP_SECRET = import.meta.env?.VITE_RECLAIM_APP_SECRET || R.appSecret || "";

// Must match contracts/interfaces/IReclaim.sol ReclaimProof, field order included.
const PROOF_TYPES = [
  "tuple(" +
    "tuple(string provider,string parameters,string context) claimInfo," +
    "tuple(" +
      "tuple(bytes32 identifier,address owner,uint32 timestampS,uint32 epoch) claim," +
      "bytes[] signatures" +
    ") signedClaim" +
  ")",
];

// Kick off a Reclaim proof session bound to (member, pool). Resolves to the abi-encoded
// proof bytes ready for `submitAccessProof`. `onUrl` receives the request URL (show it as
// a QR / open link) while the member completes the flow on the Reclaim app.
export async function startAccessProof({ member, pool, onUrl }) {
  if (!reclaimEnabled) {
    throw new Error("Reclaim not configured — set reclaim.appId/providerId in deployed.json.");
  }
  if (!APP_SECRET) {
    throw new Error("Missing VITE_RECLAIM_APP_SECRET (or reclaim.appSecret) for the proof request.");
  }

  const req = await ReclaimProofRequest.init(R.appId, APP_SECRET, R.providerId);

  // Bind the proof to this exact (member, pool): the SDK writes contextAddress=member,
  // contextMessage=pool into the claim context, which the adapter checks byte-for-byte.
  // Lowercase both to match ReclaimAdapterVerifier._toHexString (lowercase 0x hex).
  req.addContext(member.toLowerCase(), pool.toLowerCase());

  const url = await req.getRequestUrl();
  onUrl?.(url);

  const proof = await new Promise((resolve, reject) => {
    req.startSession({
      onSuccess: (proofs) => resolve(Array.isArray(proofs) ? proofs[0] : proofs),
      onError: (e) => reject(e instanceof Error ? e : new Error(String(e))),
    });
  });

  return encodeProofForChain(proof);
}

// Transform an SDK proof into the on-chain struct and abi-encode it to `bytes`.
// Field access is by name (not object key order) so it stays correct across SDK versions.
export function encodeProofForChain(proof) {
  const oc = transformForOnchain(proof);
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const value = [
    [oc.claimInfo.provider, oc.claimInfo.parameters, oc.claimInfo.context],
    [
      [
        oc.signedClaim.claim.identifier,
        oc.signedClaim.claim.owner,
        Number(oc.signedClaim.claim.timestampS),
        Number(oc.signedClaim.claim.epoch),
      ],
      oc.signedClaim.signatures,
    ],
  ];
  return abi.encode(PROOF_TYPES, [value]);
}

// The subscriptionRef a pool must be created with so this provider's proofs unlock it:
// keccak256(bytes(providerName)) == subscriptionRef (enforced by the adapter).
export function refForProvider(providerName) {
  return ethers.id(providerName);
}
