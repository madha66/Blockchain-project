import { Identity } from "../models.js";
import { pickContact } from "./contacts.js";
import { clusterIdFor, isoWeekCohort } from "./cohort.js";
import { encryptIdentifier, identityHashFor, maskIdentifier } from "./identity.js";
import { logAudit } from "./audit.js";

const refuse = (status, code) => Object.assign(new Error(code), { status, code });

/**
 * Finds or creates the identity for an identifier and links it to `wallet`.
 *  - A banned identity (in Mongo or on-chain) is refused, whatever wallet asks.
 *  - One identity per wallet: a wallet already tied to another identity is refused.
 *  - One wallet per identity: an identity whose wallet is still linked is refused; after an
 *    unlink the identity (and its history) moves to the new wallet.
 */
export async function resolveIdentity({ type, value, wallet, chain, userId = null, cluster = {}, aadhaarRef = null, createdAt = new Date() }) {
  const w = wallet.toLowerCase();
  const { identityHash, salt } = identityHashFor(type, value);
  let identity = await Identity.findOne({ identityHash });

  if (identity?.banned || (await chain.isIdentityBanned(identityHash))) {
    await logAudit("identity", "identity_refused_banned", { wallet: w, user: userId });
    throw refuse(403, "IDENTITY_BANNED");
  }

  const otherForWallet = await Identity.findOne({ linkedWallet: w, identityHash: { $ne: identityHash } });
  const onChain = await chain.identityOf(w);
  if (otherForWallet || (onChain && /^0x0{64}$/.test(onChain) === false && onChain !== identityHash)) {
    await logAudit("identity", "identity_refused_wallet_has_identity", { wallet: w, user: userId });
    throw refuse(409, "WALLET_HAS_IDENTITY");
  }

  let inherited = false;
  if (identity) {
    if (identity.linkedWallet && identity.linkedWallet !== w) {
      await logAudit("identity", "identity_refused_duplicate", { wallet: w, user: userId });
      throw refuse(409, "IDENTITY_WALLET_ACTIVE");
    }
    inherited = !identity.linkedWallet;
    identity.linkedWallet = w;
    await identity.save();
  } else {
    const contact = await pickContact();
    identity = await Identity.create({
      identityHash,
      salt,
      identifierType: type,
      identifierEnc: encryptIdentifier(value),
      identifierMasked: maskIdentifier(type, value),
      aadhaarRef,
      clusterId: clusterIdFor(cluster),
      cohortId: isoWeekCohort(createdAt),
      linkedWallet: w,
      contact: contact._id,
    });
  }
  await logAudit("identity", inherited ? "identity_inherited" : "identity_linked", {
    wallet: w,
    user: userId,
    data: { identityHash, identifierType: type },
  });
  return { identity, inherited };
}
