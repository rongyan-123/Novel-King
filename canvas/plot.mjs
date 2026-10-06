export function parsePlotProposal(reply) {
  try {
    const proposal = typeof reply === 'string' ? JSON.parse(reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) : reply;
    if (!proposal || !Array.isArray(proposal.nodes) || !Array.isArray(proposal.edges) || proposal.nodes.length > 80 || proposal.edges.length > 160) return null;
    const ids = new Set();
    for (const node of proposal.nodes) {
      if (!node || typeof node.id !== 'string' || !node.id || node.id.length > 80 || ids.has(node.id) || typeof node.text !== 'string' || !node.text.trim() || node.text.length > 2000) return null;
      ids.add(node.id);
    }
    if (proposal.edges.some((edge) => !edge || !ids.has(edge.from) || !ids.has(edge.to) || (edge.label != null && (typeof edge.label !== 'string' || edge.label.length > 200)))) return null;
    return { advice: typeof proposal.advice === 'string' ? proposal.advice.slice(0, 12000) : '', nodes: proposal.nodes, edges: proposal.edges };
  } catch { return null; }
}

export function proposalSkeleton(proposal, origin, prefix) {
  const positions = new Map();
  const cards = proposal.nodes.map((node, index) => {
    const position = { x: origin.x + index % 3 * 330, y: origin.y + Math.floor(index / 3) * 240, id: `${prefix}-${index}` };
    positions.set(node.id, position);
    return { ...position, type: 'rectangle', width: 250, height: 140, roughness: 0, backgroundColor: '#e7f5ff', strokeColor: '#4263eb', roundness: { type: 3 }, label: { text: node.text, fontSize: 18, fontFamily: 2 }, customData: { source: 'ai-proposal' } };
  });
  const arrows = proposal.edges.map((edge) => {
    const from = positions.get(edge.from), to = positions.get(edge.to);
    return { type: 'arrow', x: from.x + 250, y: from.y + 70, start: { id: from.id }, end: { id: to.id }, points: [[0, 0], [to.x - from.x - 250, to.y - from.y]], strokeColor: '#4263eb', roughness: 0, label: { text: edge.label || '', fontFamily: 2, fontSize: 14 } };
  });
  return [...cards, ...arrows];
}
