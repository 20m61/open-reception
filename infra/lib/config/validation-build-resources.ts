/**
 * Build resources of the candidate Validation project (`OpenReceptionDevDeployValidation`).
 *
 * ## Why this exists
 *
 * The first unarmed run (runbook 7.5, 2026-10-06, execution cb6744e1-…, SHA 2f1ed92) failed in
 * Validation: `npm run typecheck` exited 134 with `node::OOMErrorHandler` on BUILD_GENERAL1_SMALL
 * with no NODE_OPTIONS. Nothing reached the broker.
 *
 * Node sizes its default heap from the machine's memory, not from what the build needs: half of the
 * physical (or cgroup) memory, capped at 2 GiB below 16 GiB (measured 2026-10-06, node 22 in a
 * container: 3 GiB limit -> heap_size_limit 1584 MiB, 4 and 7 GiB -> 2096 MiB; a 16 GiB Mac ->
 * 4144 MiB). So the heap is set explicitly (`--max-old-space-size`), and the compute type is chosen
 * so that the build fits in memory with that heap.
 *
 * ## Measured (2f1ed92, node 22, 2026-10-06/07; ct-run0-g10)
 *
 * - Reproduction (positive control): `tsc --noEmit` of the repo in a node:22 Linux container
 *   limited to 3 GiB / 2 CPUs exits 134 with `node::OOMErrorHandler` — the CodeBuild failure. With a
 *   4 or 7 GiB limit (default heap 2096 MiB) it passes.
 * - Minimum heap, bisected with `--max-old-space-size` on clean trees (no tsbuildinfo / `.next`;
 *   OOM at the lower bound, pass at the upper one): `npm run typecheck` 1665..1792 MiB,
 *   `npm run build:open-next` 1537..1792 MiB (it dies in Next's "Running TypeScript" step).
 * - Whole buildspec replayed in a node:22 Linux container (`docker run --memory=<M> --memory-swap=<M>
 *   --cpus=<N>`; inside, `os.availableParallelism()` reported N, so test workers matched N). All
 *   stages except `aws:local:test` (needs Python; not measured, nor is `npm ci`: the OS reserve is
 *   assumed to cover them). The cgroup `anon` was sampled every 0.5 s per stage, so a peak is a
 *   sampled lower bound. See `VALIDATION_MEASURED_RUNS`. Two observations beyond memory:
 *   - on 2 CPUs the build phase took ~20 min (the project timeout is 30 min), and one infra test
 *     (`the app entry point synthesizes the stack for ap-northeast-1 …`, 60 s timeout) timed out
 *     at 87 s; on 4 CPUs the phase took ~13 min and that test passed;
 *   - `build:open-next` downloads Google Fonts (`next/font`), so the build needs that network path.
 *
 * The invariant tests take these measurements as the requirement and check the synthesized template
 * against them; they do not pin the chosen compute type or heap as literals. SMALL is ruled out by
 * time as well as memory: on 2 vCPUs an infra test exceeds its timeout, so Validation would be red
 * however much heap it had. Re-measuring SMALL's real memory alone must not move it back.
 */

/** Smallest `--max-old-space-size` (MiB) at which every bisected stage passed (upper bounds above). */
export const VALIDATION_MIN_HEAP_MIB = 1792;

/** One replay of the Validation buildspec in a Linux container (2026-10-07). */
export interface ValidationMeasuredRun {
  /** CPUs given to the container (= vCPUs of the compute type it stands for). */
  readonly vcpus: number;
  /** `--max-old-space-size` used for the run. */
  readonly heapMiB: number;
  /** Largest cgroup `anon` (MiB) seen in any stage. */
  readonly anonPeakMiB: number;
  /** Build-phase seconds (stages replayed, without `aws:local:test` and `npm ci`). */
  readonly buildPhaseSeconds: number;
  /** Tests that exceeded their own timeout in the replay (a red Validation regardless of memory). */
  readonly testTimeoutsExceeded: number;
}
export const VALIDATION_MEASURED_RUNS: readonly ValidationMeasuredRun[] = Object.freeze([
  // 3 GiB / 2 CPUs (SMALL as observed in 7.5): typecheck 1859, build:open-next 2217..2430, infra test 1344.
  // Also: infra test `the app entry point synthesizes the stack for ap-northeast-1 …` took 87 s (> 60 s).
  { vcpus: 2, heapMiB: 2560, anonPeakMiB: 2430, buildPhaseSeconds: 1202, testTimeoutsExceeded: 1 },
  // 5.8 GiB (the container host's limit) / 4 CPUs (MEDIUM's vCPUs): typecheck 1922, build 2079, infra test 1626.
  { vcpus: 4, heapMiB: 3072, anonPeakMiB: 2079, buildPhaseSeconds: 770, testTimeoutsExceeded: 0 },
]);

/** Heap head-room over the measured minimum: the repository (and its type graph) keeps growing. */
export const VALIDATION_HEAP_HEADROOM = 1.5;
/** Memory left for the OS, the CodeBuild agent and non-Node processes (MiniStack, npm). */
export const VALIDATION_OS_RESERVE_MIB = 1024;

/**
 * Memory (GiB) and vCPUs assumed for the Linux general1 compute types, ordered cheapest first.
 *
 * Memory is conservative on purpose: the CodeBuild user guide ("Build environment compute modes and
 * types", read 2026-10-07) lists 4 / 8 / 16 GiB, but the 7.5 failure matches a 3 GiB machine — the
 * typecheck OOM reproduces in a 3 GiB container and not in a 4 GiB one. Until the memory Node
 * actually sees on CodeBuild is measured, each type is taken as 1 GiB less. vCPUs are as listed.
 */
export const CODEBUILD_LINUX_COMPUTE: ReadonlyArray<{ readonly type: string; readonly memoryGiB: number; readonly vcpus: number }> =
  Object.freeze([
    { type: 'BUILD_GENERAL1_SMALL', memoryGiB: 3, vcpus: 2 },
    { type: 'BUILD_GENERAL1_MEDIUM', memoryGiB: 7, vcpus: 4 },
    { type: 'BUILD_GENERAL1_LARGE', memoryGiB: 15, vcpus: 8 },
  ]);

/** Heap given to every Node process of the Validation build. */
export const VALIDATION_NODE_HEAP_MIB = 3072;

/**
 * The one buildspec command that sets the heap. It is a buildspec command (buildspec 0.2 keeps
 * exports across commands and phases), not a project environment variable, so the reviewed project
 * environment-variable allowlist is unchanged and a StartBuild environment override cannot replace it.
 */
export const VALIDATION_NODE_OPTIONS_COMMAND = `export NODE_OPTIONS=--max-old-space-size=${VALIDATION_NODE_HEAP_MIB}`;
