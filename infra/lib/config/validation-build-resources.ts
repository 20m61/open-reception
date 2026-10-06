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
 * 4144 MiB). So SMALL gives a ~1.5–2 GiB heap, and any compute type below 16 GiB gives ~2 GiB. The heap
 * is therefore set explicitly (`--max-old-space-size`), and the compute type is chosen so that the
 * whole build fits in memory with that heap.
 *
 * ## Measured requirement (2f1ed92, node 22, 2026-10-06/07; ct-run0-g10)
 *
 * Reproduction (positive control): `tsc --noEmit` of the repo in a node:22 Linux container limited to
 * 3 GiB / 2 CPUs exits 134 with `node::OOMErrorHandler` — the CodeBuild failure. With a 4 or 7 GiB
 * limit (default heap 2096 MiB) it passes; the margin over the bisected minimum is ~15 %.
 *
 * Each Validation stage was then run on its own (macOS, 4 CPUs, clean: no tsbuildinfo / `.next`)
 * under `/usr/bin/time -l`, sampling the summed RSS of the whole process tree every 0.5 s. The minimum
 * heap was bisected with `--max-old-space-size` (OOM at the lower bound, pass at the upper one):
 *
 * | stage                         | min heap (MiB) | tree peak RSS (MiB) |
 * | ----------------------------- | -------------- | ------------------- |
 * | `npm run typecheck`           | 1665..1792     | 1934                |
 * | `npm run lint`                | (not bisected) | 1009                |
 * | `npm test` (3 workers)        | (not bisected) | 738                 |
 * | `npm run build:open-next`     | 1537..1792     | 3823                |
 * | `npm run aws:local:test`      | (not bisected) | 265 (+ MiniStack)   |
 * | infra typecheck / infra test  | (not bisected) | 939 / 2031          |
 * | 3-stack `cdk synth`           | (not bisected) | 1526                |
 *
 * `build:open-next` is the binding stage for memory: with a 1536 MiB heap it dies with
 * `Reached heap limit` in Next's "Running TypeScript" step, and its process tree peaks at ~3.8 GiB
 * (on 4 CPUs, as on MEDIUM). In a 3 GiB / 2 CPU container (SMALL as observed) the build fails even
 * with a 2560 MiB heap, at the memory limit. Raising NODE_OPTIONS on SMALL cannot make it fit.
 *
 * The invariant tests take these numbers as the *requirement* and derive whether the synthesized
 * template satisfies it; they do not pin the chosen compute type or heap as literals.
 */
export const VALIDATION_MEASURED_REQUIREMENT = Object.freeze({
  /** Smallest `--max-old-space-size` (MiB) at which every bisected stage passed. */
  minHeapMiB: 1792,
  /** Largest summed RSS of one stage's process tree (MiB): build:open-next on 4 CPUs. */
  treePeakRssMiB: 3823,
  /** RSS of the largest single process within that tree (MiB). */
  largestProcessRssMiB: 1907,
});

/** Heap head-room over the measured minimum: the repository (and its type graph) keeps growing. */
export const VALIDATION_HEAP_HEADROOM = 1.5;
/** Memory left for the OS, the CodeBuild agent and non-Node processes (MiniStack, npm). */
export const VALIDATION_OS_RESERVE_MIB = 1024;

/**
 * Memory (GiB) assumed for the Linux general1 compute types, ordered cheapest first.
 *
 * Conservative on purpose: the CodeBuild user guide ("Build environment compute modes and types",
 * read 2026-10-07) lists 4 / 8 / 16 GiB, but the 7.5 failure matches a 3 GiB machine — the typecheck
 * OOM reproduces in a 3 GiB container (Node heap 1584 MiB) and does not in a 4 GiB one (2096 MiB).
 * Until the memory Node actually sees on CodeBuild is measured, each type is taken as 1 GiB less.
 */
export const CODEBUILD_LINUX_MEMORY_GIB: ReadonlyArray<readonly [string, number]> = Object.freeze([
  ['BUILD_GENERAL1_SMALL', 3],
  ['BUILD_GENERAL1_MEDIUM', 7],
  ['BUILD_GENERAL1_LARGE', 15],
] as const);

/** Heap given to every Node process of the Validation build. */
export const VALIDATION_NODE_HEAP_MIB = 3072;

/**
 * The one buildspec command that sets the heap. It is a buildspec command (buildspec 0.2 keeps
 * exports across commands and phases), not a project environment variable, so the reviewed project
 * environment-variable allowlist is unchanged and a StartBuild override cannot replace it.
 */
export const VALIDATION_NODE_OPTIONS_COMMAND = `export NODE_OPTIONS=--max-old-space-size=${VALIDATION_NODE_HEAP_MIB}`;
