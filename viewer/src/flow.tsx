// Custom React Flow node + edge renderers with semantic zoom.
import { memo, useContext, createContext } from 'react';
import { Handle, Position, useStore, BaseEdge, EdgeLabelRenderer, getBezierPath, type NodeProps, type EdgeProps, type Node, type Edge } from '@xyflow/react';
import type { CfNodeData, CfEdgeData, GroupData } from './graph';

/** Highlight state shared with renderers without re-creating node objects. */
export interface Highlight {
  active: boolean;
  nodes: Set<string>;
  edges: Set<string>;
  selected?: string;
  match: Set<string>;
  onToggleService: (svc: string) => void;
}
export const HighlightCtx = createContext<Highlight>({ active: false, nodes: new Set(), edges: new Set(), match: new Set(), onToggleService: () => {} });

/** 0 = far (labels only), 1 = mid (method + path), 2 = near (fields). */
const zoomLevel = (s: { transform: [number, number, number] }) => (s.transform[2] < 0.42 ? 0 : s.transform[2] < 0.95 ? 1 : 2);

const KIND_TEXT: Record<string, string> = {
  entry: 'caller',
  endpoint: 'endpoint',
  function: 'function',
  queue: 'queue',
  topic: 'topic',
  bus: 'event bus',
  sink: 'store',
  external: 'external',
};

function typeText(n: CfNodeData['node']): string {
  if (n.kind === 'entry') return n.type === 'client' ? 'outside world' : n.type === 'schedule' ? 'schedule' : (n.type ?? 'service');
  if (n.kind === 'sink') return n.type ?? 'store';
  if (n.kind === 'queue') return 'SQS queue';
  if (n.kind === 'topic') return 'SNS topic';
  if (n.kind === 'bus') return 'EventBridge bus';
  if (n.kind === 'external') return n.type === 'unresolved' ? 'unresolved host' : 'external';
  if (n.kind === 'function') return 'lambda';
  if (n.type === 'sqs-consumer') return 'queue consumer';
  if (n.type === 'socket.io') return 'socket.io event';
  if (n.type === 'ws') return 'websocket';
  return KIND_TEXT[n.kind] ?? n.kind;
}

export const CfNode = memo(function CfNode({ id, data }: NodeProps<Node<CfNodeData>>) {
  const level = useStore(zoomLevel);
  const hl = useContext(HighlightCtx);
  const n = data.node;
  const dim = hl.active && !hl.nodes.has(id);
  const on = hl.active && hl.nodes.has(id);
  const cls = ['cf-node', `k-${data.column}`, n.kind === 'external' ? 'k-external' : '', dim ? 'is-dim' : '', on ? 'is-on' : '', hl.selected === id ? 'is-selected' : '', hl.match.has(id) ? 'is-match' : '', n.meta?.unmatched ? 'is-unmatched' : ''].join(' ');
  const isEp = n.kind === 'endpoint' && n.type !== 'collapsed';
  const isHttp = isEp && n.type === 'http';
  const method = isHttp ? String(n.meta?.method ?? n.label.split(' ')[0]) : '';
  const rest = isHttp && n.label.startsWith(method + ' ') ? n.label.slice(method.length + 1) : n.type === 'sqs-consumer' ? String(n.meta?.queue ?? n.label) : n.type === 'socket.io' ? String(n.meta?.event ?? n.label) : n.label;
  return (
    <div className={cls} title={n.label}>
      <Handle type="target" position={Position.Left} />
      <div className="cf-node-top">
        {isHttp ? <span className={`method m-${method.toLowerCase()}`}>{method}</span> : <span className="kind">{typeText(n)}</span>}
        {n.service && n.kind !== 'endpoint' && level > 0 ? <span className="svc">{n.service}</span> : null}
      </div>
      <div className={`cf-label ${n.kind === 'entry' ? '' : 'mono'}`}>{rest}</div>
      {level >= 1 && data.ops?.length ? <div className="ops">{data.ops.slice(0, 6).join(' ')}</div> : null}
      {level >= 1 && isEp && level < 2 && (data.fields?.length || data.resFields?.length) ? (
        <div className="hint">
          {data.fields?.length ? `body ${data.fields.length} field${data.fields.length > 1 ? 's' : ''}` : ''}
          {data.fields?.length && data.resFields?.length ? ', ' : ''}
          {data.resFields?.length ? `returns ${data.resFields.length}` : ''}
        </div>
      ) : null}
      {level === 2 && isEp ? (
        <div className="fields">
          {data.fields?.length ? <FieldList title="request" list={data.fields} /> : null}
          {data.resFields?.length ? <FieldList title="response" list={data.resFields} /> : null}
        </div>
      ) : null}
      {level === 2 && n.kind === 'sink' && Array.isArray(n.meta?.columns) ? <div className="hint mono">{(n.meta!.columns as string[]).join(', ')}</div> : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

function FieldList({ title, list }: { title: string; list: { name: string; type: string }[] }) {
  return (
    <div className="field-list">
      <div className="field-title">{title}</div>
      {list.map((f) => (
        <div className="field" key={f.name}>
          <span className="mono">{f.name}</span>
          <span className="ftype mono">{f.type}</span>
        </div>
      ))}
    </div>
  );
}

export const GroupNode = memo(function GroupNode({ data }: NodeProps<Node<GroupData>>) {
  const hl = useContext(HighlightCtx);
  const level = useStore(zoomLevel);
  return (
    <div className={`cf-group ${hl.active ? 'is-quiet' : ''}`}>
      <div className="cf-group-head">
        <span className="cf-group-name">{data.service}</span>
        {level > 0 ? <span className="cf-group-meta">{[data.frameworks.join(', '), data.ports.length ? `:${data.ports.join(', :')}` : ''].filter(Boolean).join('  ')}</span> : null}
        <button className="ghost tiny nodrag" onClick={() => hl.onToggleService(data.service)} title="Collapse this service into one node">
          Collapse
        </button>
      </div>
    </div>
  );
});

export const CfEdge = memo(function CfEdge(props: EdgeProps<Edge<CfEdgeData>>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const hl = useContext(HighlightCtx);
  const level = useStore(zoomLevel);
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.32 });
  const e = data!.edge;
  const on = hl.active && hl.edges.has(id);
  const dim = hl.active && !on;
  const label = e.protocol === 'http' || e.protocol === 'ws' ? [e.method, e.path].filter(Boolean).join(' ') : e.operations?.join(' ') ?? e.method ?? '';
  return (
    <>
      <BaseEdge id={id} path={path} className={`cf-edge f-${data!.family} ${on ? 'is-on' : ''} ${dim ? 'is-dim' : ''} ${e.confidence < 0.55 ? 'is-weak' : ''}`} interactionWidth={14} />
      {label && (level === 2 || (level === 1 && on)) && !dim ? (
        <EdgeLabelRenderer>
          <div className={`edge-label mono ${on ? 'is-on' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});

export const nodeTypes = { cf: CfNode, 'group-svc': GroupNode };
export const edgeTypes = { cf: CfEdge };
