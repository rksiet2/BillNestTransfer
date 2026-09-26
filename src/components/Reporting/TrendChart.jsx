import React, { useMemo, useRef, useState } from 'react';
import { formatCurrency } from '../../utils/format';

const WIDTH = 640;
const HEIGHT = 220;
const PAD_LEFT = 44;
const PAD_RIGHT = 12;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;

// Formats a bucket key ("YYYY-MM-DD" or "YYYY-MM") into a short axis label.
function formatLabel(day) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const d = new Date(day + 'T00:00:00');
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  }
  if (/^\d{4}-\d{2}$/.test(day)) {
    const d = new Date(day + '-01T00:00:00');
    return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
  }
  return day;
}

// Builds a smooth SVG path through a series of points using quadratic
// mid-point smoothing (lightweight, no external charting library needed).
function buildSmoothPath(points) {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const cur = points[i];
    const next = points[i + 1];
    const midX = (cur.x + next.x) / 2;
    const midY = (cur.y + next.y) / 2;
    d += ` Q ${cur.x} ${cur.y} ${midX} ${midY}`;
  }
  const last = points[points.length - 1];
  d += ` T ${last.x} ${last.y}`;
  return d;
}

export default function TrendChart({ trend, unitLabel = 'order' }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const svgRef = useRef(null);

  const { points, path, areaPath, gridLines, maxRevenue } = useMemo(() => {
    const innerW = WIDTH - PAD_LEFT - PAD_RIGHT;
    const innerH = HEIGHT - PAD_TOP - PAD_BOTTOM;
    const max = Math.max(1, ...trend.map((t) => t.revenue));
    const niceMax = max * 1.15;

    const pts = trend.map((t, i) => {
      const x = trend.length === 1
        ? PAD_LEFT + innerW / 2
        : PAD_LEFT + (i / (trend.length - 1)) * innerW;
      const y = PAD_TOP + innerH - (t.revenue / niceMax) * innerH;
      return { x, y, ...t };
    });

    const linePath = buildSmoothPath(pts);
    const area = pts.length
      ? `${linePath} L ${pts[pts.length - 1].x} ${PAD_TOP + innerH} L ${pts[0].x} ${PAD_TOP + innerH} Z`
      : '';

    const lines = [0, 0.25, 0.5, 0.75, 1].map((frac) => ({
      y: PAD_TOP + innerH * (1 - frac),
      value: niceMax * frac,
    }));

    return { points: pts, path: linePath, areaPath: area, gridLines: lines, maxRevenue: niceMax };
  }, [trend]);

  function handleMove(e) {
    if (!svgRef.current || points.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * WIDTH;
    let closest = 0;
    let closestDist = Infinity;
    points.forEach((p, i) => {
      const dist = Math.abs(p.x - relX);
      if (dist < closestDist) { closestDist = dist; closest = i; }
    });
    setHoverIdx(closest);
  }

  if (trend.length === 0) {
    return <div className="empty-state small">No sales yet.</div>;
  }

  const hovered = hoverIdx !== null ? points[hoverIdx] : null;
  // Show every label if few buckets, otherwise thin them out to avoid crowding.
  const labelStep = Math.max(1, Math.ceil(points.length / 10));

  return (
    <div className="trend-chart-svg-wrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="trend-chart-svg"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {gridLines.map((g, i) => (
          <g key={i}>
            <line x1={PAD_LEFT} y1={g.y} x2={WIDTH - PAD_RIGHT} y2={g.y} stroke="#eef0f3" strokeWidth="1" />
            <text x={PAD_LEFT - 8} y={g.y + 3} textAnchor="end" className="trend-axis-label">
              {g.value >= 1000 ? `${(g.value / 1000).toFixed(1)}k` : Math.round(g.value)}
            </text>
          </g>
        ))}

        <path d={areaPath} fill="url(#trendFill)" />
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />

        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={hoverIdx === i ? 5 : 3}
            fill="white"
            stroke="var(--accent)"
            strokeWidth="2"
            className="trend-dot"
          />
        ))}

        {hovered && (
          <line x1={hovered.x} y1={PAD_TOP} x2={hovered.x} y2={HEIGHT - PAD_BOTTOM} stroke="var(--accent-light)" strokeWidth="1" strokeDasharray="3 3" />
        )}

        {points.map((p, i) => (
          i % labelStep === 0 && (
            <text key={i} x={p.x} y={HEIGHT - 8} textAnchor="middle" className="trend-axis-label">
              {formatLabel(p.day)}
            </text>
          )
        ))}
      </svg>

      {hovered && (
        <div
          className="trend-tooltip"
          style={{
            left: `${(hovered.x / WIDTH) * 100}%`,
            top: `${(hovered.y / HEIGHT) * 100}%`,
          }}
        >
          <strong>{formatLabel(hovered.day)}</strong>
          <span>{formatCurrency(hovered.revenue)}</span>
          <span className="trend-tooltip-orders">{hovered.orders} {unitLabel}{hovered.orders === 1 ? '' : 's'}</span>
        </div>
      )}
    </div>
  );
}
