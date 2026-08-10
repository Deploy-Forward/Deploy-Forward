/**
 * super-start's scan worker (node:worker_threads) — the live watch's rescan runs HERE
 * so the main thread never blocks: the marquee keeps rolling and the footer seconds
 * keep counting while syncOnce + the corpus re-read do their 1–3s of synchronous I/O
 * (the on-screen pause Marco caught on the first live recording, 2026-07-16).
 *
 * Contract: workerData.push=true runs syncOnce first (the REAL board push, digest
 * dedup and all — writes are syncOnce's own, atomic tmp+rename), then a fresh
 * readShowcaseData(). Posts { ok, data } or { ok: false, error } — the main loop maps
 * fatal auth codes to the monitor's exit messages and anything else to the honest
 * "sync failed — retrying" note.
 */
import { parentPort, workerData } from "node:worker_threads";
import { syncOnce } from "./sync.js";
import { readShowcaseData } from "./superStart.js";

(async () => {
  try {
    if ((workerData as { push?: boolean } | undefined)?.push) {
      await syncOnce({ verbose: false });
    }
    parentPort?.postMessage({ ok: true, data: readShowcaseData() });
  } catch (e) {
    parentPort?.postMessage({ ok: false, error: (e as Error).message });
  }
})();
