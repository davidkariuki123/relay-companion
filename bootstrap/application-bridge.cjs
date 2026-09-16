"use strict";

// Inert until a release explicitly enables activation. The stock maintenance
// entry point is disabled during preparation. Adapters must be idempotent for a transaction ID and own the canonical
// lock, OS mutations, source verification and durable journal storage.
async function runBridge({ activationEnabled = false, transactionId, target, adapters } = {}) {
  if (activationEnabled !== true) return { status: "disabled", changed: false };
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(transactionId || "")) throw new Error("A stable migration transaction ID is required");
  if (!/^\d+\.\d+\.\d+$/.test(target?.version || "") || !/^[a-f0-9]{40}$/.test(target?.sourceSha || "")) throw new Error("An exact application target is required");
  const functions = ["lock", "load", "save", "currentUpdateComplete", "verifyTarget", "stage", "drain",
    "transferOwnership", "verifyHealth", "verifyRecovery", "observeStability", "restorePrevious", "retirePrevious"];
  if (functions.some((name) => typeof adapters?.[name] !== "function")) throw new Error("Native migration adapters are incomplete");
  const release = await adapters.lock();
  if (typeof release !== "function") throw new Error("Canonical migration lock was not acquired");
  try {
    let journal = await adapters.load();
    if (journal && (journal.schema !== 1 || journal.transactionId !== transactionId
      || journal.target?.version !== target.version || journal.target?.sourceSha !== target.sourceSha)) throw new Error("Another migration owns the journal");
    const precommit = ["current-update-complete", "target-verified", "application-staged", "work-drained",
      "ownership-transferred", "application-healthy", "recovery-healthy", "stability-observed"];
    const allowed = [...precommit, "previous-retired"];
    if (journal && (!Array.isArray(journal.completed) || new Set(journal.completed).size !== journal.completed.length
      || journal.completed.some((name) => !allowed.includes(name))
      || !["preparing", "deferred", "rollback-required", "rolled-back", "committed", "cleanup-pending", "complete"].includes(journal.state)
      || (journal.pending !== null && !allowed.includes(journal.pending))
      || (["committed", "cleanup-pending", "complete"].includes(journal.state) && precommit.some((name) => !journal.completed.includes(name)))
      || (journal.state === "complete" && !journal.completed.includes("previous-retired")))) throw new Error("Migration journal is invalid; existing ownership was left unchanged");
    if (!journal) journal = { schema: 1, transactionId, target: { ...target }, state: "preparing", completed: [], pending: null };
    if (journal.state === "complete" || journal.state === "rolled-back") return journal;
    const save = async (changes) => { journal = { ...journal, ...changes }; await adapters.save(journal); };
    const step = async (name, action) => {
      if (journal.completed.includes(name)) return;
      await save({ pending: name, ...(name === "ownership-transferred" ? { transferAttempted: true } : {}) });
      const proof = await action({ transactionId, target, journal });
      if (proof?.ok !== true) throw Object.assign(new Error(proof?.reason || `Migration step ${name} did not prove success`), { preserveCurrent: proof?.preserveCurrent === true });
      await save({ pending: null, completed: [...journal.completed, name] });
    };
    if (journal.state === "rollback-required") {
      const restored = await adapters.restorePrevious({ transactionId, target, journal });
      if (restored?.ok !== true) throw new Error("Previous Relay ownership still requires recovery");
      await save({ state: "rolled-back", pending: null });
      return journal;
    }
    if (!["committed", "cleanup-pending"].includes(journal.state)) {
      if (journal.pending === "ownership-transferred") await save({ transferAttempted: true });
      // A restart invalidates observations of activity and process health. Stage
      // and ownership adapters remain idempotent; fresh proof is required before
      // commitment even when the previous process recorded successful samples.
      await save({ completed: journal.completed.filter((name) => ![
        "current-update-complete", "target-verified", "work-drained", "application-healthy",
        "recovery-healthy", "stability-observed",
      ].includes(name)) });
      try {
        await step("current-update-complete", adapters.currentUpdateComplete);
        await step("target-verified", adapters.verifyTarget);
        await step("application-staged", adapters.stage);
        await step("work-drained", adapters.drain);
        await step("ownership-transferred", adapters.transferOwnership);
        await step("application-healthy", adapters.verifyHealth);
        await step("recovery-healthy", adapters.verifyRecovery);
        await step("stability-observed", adapters.observeStability);
        await save({ state: "committed" });
      } catch (error) {
        if (error.preserveCurrent === true) {
          await save({ state: "deferred", failure: String(error.message).slice(0, 500) });
          return journal;
        }
        // A pending transfer may have taken effect before the process died. Do
        // not assume only a completed journal entry means ownership changed.
        const needsRestore = journal.transferAttempted === true || journal.completed.includes("ownership-transferred") || journal.pending === "ownership-transferred";
        if (needsRestore) {
          await save({ state: "rollback-required", failure: String(error.message).slice(0, 500) });
          const restored = await adapters.restorePrevious({ transactionId, target, journal });
          if (restored?.ok !== true) return journal;
          await save({ state: "rolled-back", pending: null });
        } else {
          await save({ state: "preparing", failure: String(error.message).slice(0, 500) });
        }
        return journal;
      }
    }
    // Once committed, cleanup failure must never restore an old installation
    // that might already have been partially removed.
    try {
      await step("previous-retired", adapters.retirePrevious);
      await save({ state: "complete", pending: null });
    } catch (error) {
      await save({ state: "cleanup-pending", failure: String(error.message).slice(0, 500) });
    }
    return journal;
  } finally { await release(); }
}

module.exports = { runBridge };
