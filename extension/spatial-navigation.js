(function (root) {
  'use strict';

  function chooseSpatialTarget(targets, selectedId, direction) {
    const current = targets.find(target => target.id === selectedId);
    if (!current) return targets[0]?.id ?? null;
    if (!['up', 'down', 'left', 'right'].includes(direction)) return selectedId;
    const horizontal = direction === 'left' || direction === 'right';
    const sign = direction === 'left' || direction === 'up' ? -1 : 1;
    const center = target => ({ x: target.left + target.width / 2, y: target.top + target.height / 2 });
    const origin = center(current);
    let best = { id: selectedId, score: Infinity };
    for (const target of targets) {
      if (target.id === selectedId) continue;
      const point = center(target);
      const primary = (horizontal ? point.x - origin.x : point.y - origin.y) * sign;
      if (primary <= 1) continue;
      const orthogonal = Math.abs(horizontal ? point.y - origin.y : point.x - origin.x);
      const extent = horizontal
        ? (current.height + target.height) / 2
        : (current.width + target.width) / 2;
      const gap = Math.max(0, orthogonal - extent);
      const score = primary + gap * 3 + orthogonal * 0.01;
      if (score < best.score) best = { id: target.id, score };
    }
    return best.id;
  }

  const exported = { chooseSpatialTarget };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else root.TabOutSpatial = exported;
})(globalThis);
