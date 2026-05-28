import type { DurationUnit, EdgeType } from '@procsim/file-format';
import { beginEdit, commitEdit, useDomainStore } from '../store/domainStore.js';
import { useResizable } from '../hooks/useResizable.js';

interface EdgePanelProps {
  edgeId: string;
  onClose: () => void;
}

const EDGE_TYPES: ReadonlyArray<{ value: EdgeType; label: string; hint: string }> = [
  { value: 'FS', label: 'Finish → Start', hint: 'Successor starts after predecessor finishes.' },
  { value: 'SS', label: 'Start → Start', hint: 'Successor starts after predecessor starts.' },
  { value: 'FF', label: 'Finish → Finish', hint: 'Successor finishes after predecessor finishes.' },
  { value: 'SF', label: 'Start → Finish', hint: 'Successor finishes after predecessor starts.' },
];

export function EdgePanel({ edgeId, onClose }: EdgePanelProps) {
  const project = useDomainStore((s) => s.project);
  const updateEdgeType = useDomainStore((s) => s.updateEdgeType);
  const updateEdgeLag = useDomainStore((s) => s.updateEdgeLag);
  const deleteEdges = useDomainStore((s) => s.deleteEdges);
  const { width, onMouseDown } = useResizable(288);

  const edge = project.edges.find((e) => e.id === edgeId);
  if (!edge) return null;

  const typeMeta = EDGE_TYPES.find((t) => t.value === edge.type) ?? EDGE_TYPES[0]!;

  return (
    <aside
      style={{ width }}
      className="relative shrink-0 border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col overflow-y-auto"
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-emerald-400 transition-colors z-10"
        onMouseDown={onMouseDown}
      />
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-700">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Edge</h2>
        <button
          onClick={onClose}
          className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
          aria-label="Close panel"
        >
          ×
        </button>
      </div>

      <div className="flex flex-col gap-5 p-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Dependency type
          </label>
          <select
            value={edge.type}
            onChange={(e) => updateEdgeType(edgeId, e.target.value as EdgeType)}
            className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
          >
            {EDGE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{typeMeta.hint}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Lag (positive = gap, negative = overlap)
          </label>
          <div className="flex gap-2">
            <input
              type="number"
              value={edge.lag.value}
              step={0.5}
              onFocus={beginEdit}
              onBlur={commitEdit}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (Number.isFinite(v)) updateEdgeLag(edgeId, v, edge.lag.unit);
              }}
              className="flex-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
            <select
              value={edge.lag.unit}
              onChange={(e) => {
                // I-17 — flush any in-flight edit session on a different
                // field before firing this discrete unit-change. Without
                // this, a focused value input on a sibling field would
                // fold this unit change into its own undo step.
                commitEdit();
                updateEdgeLag(edgeId, edge.lag.value, e.target.value as DurationUnit);
              }}
              className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
            >
              <option value="hours">hours</option>
              <option value="days">days</option>
              <option value="weeks">weeks</option>
            </select>
          </div>
        </div>

        <button
          onClick={() => {
            deleteEdges([edgeId]);
            onClose();
          }}
          className="self-start rounded border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-3 py-1.5 text-sm hover:bg-red-50 dark:hover:bg-red-900/20"
        >
          Delete edge
        </button>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            ID
          </label>
          <p className="text-xs text-gray-400 dark:text-gray-500 font-mono break-all">{edge.id}</p>
        </div>
      </div>
    </aside>
  );
}
