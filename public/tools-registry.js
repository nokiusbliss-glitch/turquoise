export const TOOL_REGISTRY = [
  { id: 'tic-tac-toe', title: 'Tic Tac Toe', category: 'games', description: '2-player classic', minPeers: 2, maxPeers: 9, implemented: true },
  { id: 'whiteboard', title: 'Whiteboard', category: 'tools', description: 'Shared whiteboard (placeholder)', minPeers: 2, maxPeers: 50, implemented: false },
  { id: 'diagram', title: 'Diagram', category: 'tools', description: 'Diagram collaboration (placeholder)', minPeers: 2, maxPeers: 50, implemented: false },
  { id: 'sketch', title: 'Sketch', category: 'tools', description: 'Sketch board (placeholder)', minPeers: 2, maxPeers: 50, implemented: false },
  { id: 'math-graph', title: 'Math Graph', category: 'tools', description: 'Function plotting (placeholder)', minPeers: 2, maxPeers: 50, implemented: false },
  { id: 'collab-code', title: 'Collaborative Coding', category: 'tools', description: 'Live code pad (placeholder)', minPeers: 2, maxPeers: 50, implemented: false },
  { id: 'collab-table', title: 'Collaborative Table', category: 'tools', description: 'Shared table (placeholder)', minPeers: 2, maxPeers: 50, implemented: false },
  { id: 'notes', title: 'Notes Pad', category: 'tools', description: 'Shared notes (placeholder)', minPeers: 2, maxPeers: 50, implemented: false },
];

export function getToolById(toolId) {
  return TOOL_REGISTRY.find(t => t.id === toolId) || null;
}
