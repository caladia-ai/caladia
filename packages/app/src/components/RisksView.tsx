import type { ProjectFile, ProjectNode } from '@procsim/file-format';
import { useViewStore } from '../store/viewStore.js';
import type { SimRun } from '../store/viewStore.js';
import { formatMoney } from '../utils/cost.js';
import {
  deriveActivityVariationRisks,
  deriveDecisionCostOfDelay,
  deriveLoopRisks,
  formatHours,
  probabilityOfFailure,
  type ActivityVariationRisk,
  type LoopRisk,
} from '../utils/riskDerivation.js';

interface RisksViewProps {
  project: ProjectFile;
}

/**
 * Risks register — Phase 46 redesign.
 *
 * Four classes of risk, all derived from project structure or simulation
 * output. No manual flagging:
 *
 *  - **Timing risks**: every decision gate with `passProbability < 1` —
 *    any chance of failure. Surfaced with probability + failure delay +
 *    optional cost impact (from a selected crash option).
 *  - **Loop risks**: every loop with iteration variance. Surfaced with
 *    its worst-case additional time (`(max − min) × Σ body durations`).
 *    Loops with deterministic iteration counts are filtered out — they
 *    introduce no schedule uncertainty by themselves.
 *  - **Activity variation**: activities whose duration distribution has
 *    spread/central > 0.75. Computed in `utils/riskDerivation.ts`.
 *  - **Cost drivers**: unchanged from Phase 30 — engine-detected
 *    activities whose cost variance shapes the project's cost
 *    distribution.
 *
 * Pre-Phase-46 the timing section only listed user-flagged decisions
 * (via the now-removed `isRisk` field) and had an "+ Add risk" button
 * that minted orphan decisions off-canvas. Both were removed —
 * inferred risks beat authored ones because every decision with a
 * non-trivial failure chance IS a risk; the user shouldn't have to
 * remember to flag it.
 */
export function RisksView({ project }: RisksViewProps) {
  const setActiveTab = useViewStore((s) => s.setActiveTab);
  const selectNodes = useViewStore((s) => s.selectNodes);
  const revealInspector = useViewStore((s) => s.revealInspector);
  const simHistory = useViewStore((s) => s.simHistory);

  const decisionRisks = project.nodes.filter(
    (n): n is ProjectNode & { nodeType: 'decision' } =>
      n.nodeType === 'decision' && probabilityOfFailure(n) > 0,
  );
  const loopRisks = deriveLoopRisks(project);
  const variationRisks = deriveActivityVariationRisks(project);
  const latestRun = simHistory[0] ?? null;

  /** Select the node without leaving the Risks tab. */
  function handleInspect(nodeId: string) {
    selectNodes([nodeId]);
    revealInspector();
  }

  /** Switch to the canvas with the node selected. */
  function handleLocate(nodeId: string) {
    setActiveTab('canvas');
    selectNodes([nodeId]);
  }

  return (
    <div className="flex-1 overflow-auto bg-gray-50 dark:bg-gray-950">
      <div className="max-w-5xl mx-auto p-6 flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Risks</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 max-w-2xl">
            All risks are derived from the project structure or the latest simulation run. Decision
            gates with any chance of failure, loops with variable iteration counts, and activities
            with wide duration spreads are surfaced automatically.
          </p>
        </header>

        <DecisionRisksSection
          project={project}
          risks={decisionRisks}
          onInspect={handleInspect}
          onLocate={handleLocate}
          onSwitchToCanvas={() => setActiveTab('canvas')}
        />

        <LoopRisksSection
          risks={loopRisks}
          onLocate={(loopBodyNodeId) => handleLocate(loopBodyNodeId)}
          project={project}
          onSwitchToCanvas={() => setActiveTab('canvas')}
        />

        <ActivityVariationSection
          risks={variationRisks}
          onInspect={handleInspect}
          onLocate={handleLocate}
          onSwitchToCanvas={() => setActiveTab('canvas')}
        />

        <CostDriversSection
          project={project}
          latestRun={latestRun}
          onLocate={handleLocate}
          onSwitchToSimulate={() => setActiveTab('simulate')}
          onSwitchToCanvas={() => setActiveTab('canvas')}
        />
      </div>
    </div>
  );
}

// ── Decision-gate risks ───────────────────────────────────────────────────────

interface DecisionRisksSectionProps {
  project: ProjectFile;
  risks: ReadonlyArray<ProjectNode & { nodeType: 'decision' }>;
  onInspect: (nodeId: string) => void;
  onLocate: (nodeId: string) => void;
  onSwitchToCanvas: () => void;
}

function DecisionRisksSection({
  project,
  risks,
  onInspect,
  onLocate,
  onSwitchToCanvas,
}: DecisionRisksSectionProps) {
  const header = (
    <div className="flex flex-col gap-0.5">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        Decision-gate risks
      </h2>
      <p className="text-[11.5px] max-md:text-xs text-gray-500 dark:text-gray-400">
        Every decision gate with a non-zero chance of failure. Cost-of-delay estimates
        assigned-resource billing during the failure delay (working hours × rates × counts ×
        shares).
      </p>
    </div>
  );

  if (risks.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        {header}
        <EmptyHint
          icon="◆"
          title="No decision-gate risks"
          body="Every decision in this project has a 100% pass probability. Lower a gate's pass probability on the canvas to surface it here."
          cta={{ label: 'Go to canvas →', onClick: onSwitchToCanvas }}
        />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      {header}
      <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800/40 text-[11px] max-md:text-xs font-semibold uppercase tracking-[0.05em] text-gray-500 dark:text-gray-400">
            <tr>
              <Th>Name</Th>
              <Th align="right">Failure probability</Th>
              <Th align="right">Failure delay</Th>
              <Th align="right">Cost of delay</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {risks.map((risk) => {
              const probOfFail = probabilityOfFailure(risk);
              const failureDelay = risk.failureDelay;
              const costOfDelay = deriveDecisionCostOfDelay(project, risk);
              return (
                <tr
                  key={risk.id}
                  className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors"
                >
                  <Td>
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {risk.name}
                    </span>
                  </Td>
                  <Td align="right">
                    <span className="text-sm font-mono text-gray-900 dark:text-gray-100">
                      {Math.round(probOfFail * 100)}%
                    </span>
                  </Td>
                  <Td align="right">
                    {failureDelay && failureDelay.value > 0 ? (
                      <span className="text-sm font-mono text-gray-900 dark:text-gray-100">
                        {failureDelay.value}
                        {failureDelay.unit === 'hours'
                          ? 'h'
                          : failureDelay.unit === 'days'
                            ? 'd'
                            : 'w'}
                      </span>
                    ) : (
                      <DashCell />
                    )}
                  </Td>
                  <Td align="right">
                    {costOfDelay !== null && costOfDelay > 0 ? (
                      <span className="text-sm font-mono text-gray-900 dark:text-gray-100">
                        {formatMoney(costOfDelay, project.currency)}
                      </span>
                    ) : (
                      <DashCell />
                    )}
                  </Td>
                  <Td align="right">
                    <RowActions
                      onInspect={() => onInspect(risk.id)}
                      onLocate={() => onLocate(risk.id)}
                    />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Loop risks ────────────────────────────────────────────────────────────────

interface LoopRisksSectionProps {
  risks: ReadonlyArray<LoopRisk>;
  project: ProjectFile;
  onLocate: (nodeId: string) => void;
  onSwitchToCanvas: () => void;
}

function LoopRisksSection({ risks, project, onLocate, onSwitchToCanvas }: LoopRisksSectionProps) {
  const header = (
    <div className="flex flex-col gap-0.5">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Loop risks</h2>
      <p className="text-[11.5px] max-md:text-xs text-gray-500 dark:text-gray-400">
        Loops whose iteration count could vary — worst case adds
        <span className="font-mono"> (max − min) × </span> sum of body durations to the schedule.
        Loops with a fixed iteration count are omitted.
      </p>
    </div>
  );

  if (risks.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        {header}
        <EmptyHint
          icon="↻"
          title="No loop risks"
          body="Either there are no loops in this project, or every loop has a deterministic iteration count."
          cta={{ label: 'Go to canvas →', onClick: onSwitchToCanvas }}
        />
      </section>
    );
  }

  // Map a loop id to its first body node id so "Locate" can navigate to
  // something on the canvas. A loop itself isn't a node; the body's
  // first member is the most useful jump target.
  const loopFirstBody = new Map(
    project.loops.map((l) => [l.id, l.bodyNodeIds[0] ?? null] as const),
  );

  return (
    <section className="flex flex-col gap-3">
      {header}
      <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800/40 text-[11px] max-md:text-xs font-semibold uppercase tracking-[0.05em] text-gray-500 dark:text-gray-400">
            <tr>
              <Th>Loop</Th>
              <Th align="right">Iterations (min–max)</Th>
              <Th align="right">Body duration</Th>
              <Th align="right">Max time extension</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {risks.map((risk) => {
              const firstBody = loopFirstBody.get(risk.loopId);
              return (
                <tr
                  key={risk.loopId}
                  className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors"
                >
                  <Td>
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {risk.label}
                    </span>
                  </Td>
                  <Td align="right">
                    <span className="text-sm font-mono text-gray-900 dark:text-gray-100">
                      {fmtIter(risk.minIterations)}–{fmtIter(risk.maxIterations)}
                    </span>
                  </Td>
                  <Td align="right">
                    <span className="text-sm font-mono text-gray-900 dark:text-gray-100">
                      {formatHours(risk.bodyHours)}
                    </span>
                  </Td>
                  <Td align="right">
                    <span className="text-sm font-mono font-semibold text-gray-900 dark:text-gray-100">
                      {formatHours(risk.maxExtensionHours)}
                    </span>
                  </Td>
                  <Td align="right">
                    {firstBody ? <RowActions onLocate={() => onLocate(firstBody)} /> : <DashCell />}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function fmtIter(n: number): string {
  // Iteration counts can be fractional under normal distributions
  // (mean − 3σ may not be an integer). Round to 1 decimal for display.
  return Number.isInteger(n) ? `${n}` : `${Math.round(n * 10) / 10}`;
}

// ── Activity variation ────────────────────────────────────────────────────────

interface ActivityVariationSectionProps {
  risks: ReadonlyArray<ActivityVariationRisk>;
  onInspect: (nodeId: string) => void;
  onLocate: (nodeId: string) => void;
  onSwitchToCanvas: () => void;
}

function ActivityVariationSection({
  risks,
  onInspect,
  onLocate,
  onSwitchToCanvas,
}: ActivityVariationSectionProps) {
  const header = (
    <div className="flex flex-col gap-0.5">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Activity variation</h2>
      <p className="text-[11.5px] max-md:text-xs text-gray-500 dark:text-gray-400">
        Activities whose duration distribution has a wide spread — worst case is &gt;1.75× the
        expected duration. High-variance activities often dominate sensitivity analyses.
      </p>
    </div>
  );

  if (risks.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        {header}
        <EmptyHint
          icon="↔"
          title="No high-variance activities"
          body="Activities with tight or no distributions don't appear here. Add wider distributions (e.g. triangular min/mode/max) to surface scheduling uncertainty."
          cta={{ label: 'Go to canvas →', onClick: onSwitchToCanvas }}
        />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      {header}
      <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800/40 text-[11px] max-md:text-xs font-semibold uppercase tracking-[0.05em] text-gray-500 dark:text-gray-400">
            <tr>
              <Th>Name</Th>
              <Th align="right">Expected</Th>
              <Th align="right">Worst case</Th>
              <Th align="right">Spread / expected</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {risks.map((risk) => (
              <tr
                key={risk.nodeId}
                className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors"
              >
                <Td>
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {risk.name}
                  </span>
                </Td>
                <Td align="right">
                  <span className="text-sm font-mono text-gray-900 dark:text-gray-100">
                    {formatHours(risk.centralHours)}
                  </span>
                </Td>
                <Td align="right">
                  <span className="text-sm font-mono font-semibold text-gray-900 dark:text-gray-100">
                    {formatHours(risk.worstCaseHours)}
                  </span>
                </Td>
                <Td align="right">
                  <span className="text-sm font-mono text-gray-900 dark:text-gray-100">
                    {`${Math.round(risk.spreadRatio * 100)}%`}
                  </span>
                </Td>
                <Td align="right">
                  <RowActions
                    onInspect={() => onInspect(risk.nodeId)}
                    onLocate={() => onLocate(risk.nodeId)}
                  />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Cost drivers (Phase 30, unchanged semantics) ──────────────────────────────

const TOP_N_DRIVERS = 8;

interface CostDriversSectionProps {
  project: ProjectFile;
  latestRun: SimRun | null;
  onLocate: (nodeId: string) => void;
  onSwitchToSimulate: () => void;
  onSwitchToCanvas: () => void;
}

function CostDriversSection({
  project,
  latestRun,
  onLocate,
  onSwitchToSimulate,
  onSwitchToCanvas,
}: CostDriversSectionProps) {
  const header = (
    <div className="flex flex-col gap-0.5">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Cost drivers</h2>
      <p className="text-[11.5px] max-md:text-xs text-gray-500 dark:text-gray-400">
        Activities whose cost variance contributes most to the project's cost distribution.
        Auto-detected from the latest simulation run.
      </p>
    </div>
  );

  if (!latestRun) {
    return (
      <section className="flex flex-col gap-3">
        {header}
        <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 p-8 flex flex-col items-center text-center gap-3">
          <div className="text-3xl">📊</div>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Run a simulation to see cost drivers
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 max-w-md">
            Cost drivers are detected from Monte Carlo cost variance. Run a simulation on the
            Simulate tab to populate this list.
          </p>
          <button
            type="button"
            onClick={onSwitchToSimulate}
            className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-[12.5px] font-medium px-3 py-1.5 transition-colors"
          >
            Go to Simulate →
          </button>
        </div>
      </section>
    );
  }

  const tornado = latestRun.result.costTornado;

  if (tornado.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        {header}
        <EmptyHint
          icon="○"
          title="No cost variance in this project"
          body="Add a cost distribution to an activity's fixed cost, or a rate distribution to a resource, then re-run the simulation to surface cost drivers here."
          cta={{ label: 'Go to canvas →', onClick: onSwitchToCanvas }}
        />
      </section>
    );
  }

  const budget = project.budget;
  const p95Cost = latestRun.result.costPercentiles.p95;
  const overBudgetGap = budget !== undefined && p95Cost > budget ? p95Cost - budget : null;

  const totalVariance = tornado.reduce((s, t) => s + t.impactCost, 0);
  const visible = tornado.slice(0, TOP_N_DRIVERS);
  const nodeMap = new Map(project.nodes.map((n) => [n.id, n]));

  return (
    <section className="flex flex-col gap-3">
      {header}
      <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
        {overBudgetGap !== null && (
          <div className="px-4 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900 text-[11.5px] max-md:text-xs text-amber-800 dark:text-amber-300">
            P95 cost is{' '}
            <span className="font-mono font-semibold">
              {formatMoney(p95Cost, project.currency)}
            </span>{' '}
            — over budget by{' '}
            <span className="font-mono font-semibold">
              {formatMoney(overBudgetGap, project.currency)}
            </span>
            . The share-of-gap chips below estimate each driver's contribution.
          </div>
        )}
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800/40 text-[11px] max-md:text-xs font-semibold uppercase tracking-[0.05em] text-gray-500 dark:text-gray-400">
            <tr>
              <Th>Name</Th>
              <Th align="right">Cost spread</Th>
              <Th align="right">Share of variance</Th>
              {overBudgetGap !== null && <Th align="right">Share of gap</Th>}
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {visible.map((t) => {
              const node = nodeMap.get(t.nodeId);
              const share = totalVariance > 0 ? t.impactCost / totalVariance : 0;
              const gapShare = overBudgetGap !== null ? share * overBudgetGap : null;
              const sharePct = Math.round(share * 100);
              return (
                <tr
                  key={t.nodeId}
                  className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors"
                >
                  <Td>
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                      {node?.name ?? t.nodeId}
                    </span>
                  </Td>
                  <Td align="right">
                    <span className="text-sm font-mono text-gray-900 dark:text-gray-100">
                      {formatMoney(t.impactCost, project.currency)}
                    </span>
                  </Td>
                  <Td align="right">
                    <div className="inline-flex items-center gap-2 justify-end min-w-[120px]">
                      <div className="h-1 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden flex-1 max-w-[80px]">
                        <div
                          className="h-full bg-gradient-to-r from-emerald-300 to-emerald-600"
                          style={{ width: `${sharePct}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono font-semibold text-gray-900 dark:text-gray-100 w-9 text-right">
                        {sharePct}%
                      </span>
                    </div>
                  </Td>
                  {gapShare !== null && (
                    <Td align="right">
                      <span className="inline-flex items-center text-[11px] max-md:text-xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 rounded px-1.5 py-0.5">
                        ≈{formatMoney(gapShare, project.currency)}
                      </span>
                    </Td>
                  )}
                  <Td align="right">
                    <RowActions onLocate={() => onLocate(t.nodeId)} />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-800 text-[10.5px] max-md:text-xs text-gray-400 dark:text-gray-500">
          Top {visible.length} of {tornado.length} drivers · based on simulation run{' '}
          {latestRun.iterations.toLocaleString()} iters · seed {latestRun.seed}
        </div>
      </div>
    </section>
  );
}

// ── Shared bits ───────────────────────────────────────────────────────────────

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th className={`px-3 py-2 text-${align}`}>{children}</th>;
}

function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <td className={`px-3 py-2 text-${align} align-middle`}>{children}</td>;
}

function DashCell() {
  return <span className="text-sm text-gray-300 dark:text-gray-600">—</span>;
}

function RowButton({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="text-[11.5px] max-md:text-xs font-medium px-2 py-0.5 rounded text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
    >
      {children}
    </button>
  );
}

interface RowActionsProps {
  onInspect?: () => void;
  onLocate: () => void;
}

function RowActions({ onInspect, onLocate }: RowActionsProps) {
  // Domain nodes get an "Edit" affordance (opens the Inspector on this
  // tab); loops have no Inspector surface so they only offer Locate.
  return (
    <div className="inline-flex items-center gap-1 justify-end">
      {onInspect && (
        <RowButton onClick={onInspect} title="Open the Inspector for this risk (stays on this tab)">
          Edit
        </RowButton>
      )}
      <RowButton onClick={onLocate} title="Find this on the canvas">
        Locate
      </RowButton>
    </div>
  );
}

interface EmptyHintProps {
  icon: string;
  title: string;
  body: string;
  /** Optional jump-to-fix button under the body text. The label should
   *  name the tab the user should go to ("Go to canvas →"); onClick
   *  switches there. Audit N-3. */
  cta?: { label: string; onClick: () => void };
}

function EmptyHint({ icon, title, body, cta }: EmptyHintProps) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 p-6 flex flex-col items-center text-center gap-2">
      <div className="text-2xl">{icon}</div>
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</div>
      <p className="text-xs text-gray-500 dark:text-gray-400 max-w-md">{body}</p>
      {cta && (
        <button
          type="button"
          onClick={cta.onClick}
          className="mt-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:underline"
        >
          {cta.label}
        </button>
      )}
    </div>
  );
}
