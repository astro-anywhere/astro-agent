/**
 * Plan commands - list, show, and graph plan nodes
 */

import chalk from 'chalk';
import { config } from '../lib/config.js';

// ============================================================================
// Types
// ============================================================================

export interface PlanNode {
  id: string;
  projectId: string;
  type: 'milestone' | 'task' | 'branch' | 'decision';
  title: string;
  description: string;
  status: 'planned' | 'dispatched' | 'in_progress' | 'auto_verified' | 'awaiting_judgment' | 'awaiting_approval' | 'completed' | 'pruned';
  parentId: string | null;
  dependencies: string[];
  verification: 'auto' | 'human';
  position: { x: number; y: number };
  startDate?: string;
  endDate?: string;
  priority?: string;
  estimate?: string;
  dueDate?: string;
  milestoneId?: string;
  executionId?: string;
  executionOutput?: string;
  executionError?: string;
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlanEdge {
  id: string;
  source: string;
  target: string;
  type: 'dependency' | 'branch';
}

export interface PlanData {
  nodes: PlanNode[];
  edges: PlanEdge[];
}

export interface PlanListOptions {
  projectId: string;
  json?: boolean;
}

export interface PlanShowOptions {
  nodeId: string;
  json?: boolean;
}

export interface PlanGraphOptions {
  projectId: string;
  json?: boolean;
}

// ============================================================================
// API Client
// ============================================================================

/**
 * Fetch plan data for a project from the backend
 */
async function fetchPlanData(projectId: string): Promise<PlanData> {
  const apiUrl = config.getApiUrl();
  const accessToken = config.getAccessToken();

  if (!accessToken) {
    throw new Error('Not authenticated. Run: npx @astroanywhere/agent@latest launch');
  }

  const res = await fetch(`${apiUrl}/api/data/plan/${projectId}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to fetch plan data (${res.status}): ${body}`);
  }

  return (await res.json()) as PlanData;
}

// ============================================================================
// Formatters
// ============================================================================

const STATUS_ICONS: Record<string, string> = {
  planned: chalk.dim('○'),
  dispatched: chalk.blue('◎'),
  in_progress: chalk.yellow('●'),
  auto_verified: chalk.green('✓'),
  awaiting_judgment: chalk.magenta('?'),
  awaiting_approval: chalk.cyan('⊙'),
  completed: chalk.green('✓'),
  pruned: chalk.dim('✗'),
};

const TYPE_ICONS: Record<string, string> = {
  milestone: chalk.bold('◆'),
  task: chalk.dim('▸'),
  branch: chalk.cyan('⎇'),
  decision: chalk.yellow('◇'),
};

function formatStatus(status: string): string {
  const icon = STATUS_ICONS[status] || '○';
  return `${icon} ${status}`;
}

// Used to format type with icon (available for future extensions)
// function formatType(type: string): string {
//   const icon = TYPE_ICONS[type] || '▸';
//   return `${icon} ${type}`;
// }

function formatDate(dateStr?: string): string {
  if (!dateStr) return chalk.dim('—');
  return chalk.dim(dateStr);
}

function formatNodeSummary(node: PlanNode): string {
  const icon = STATUS_ICONS[node.status] || '○';
  const typeIcon = TYPE_ICONS[node.type] || '▸';
  const title = node.title.length > 50 ? node.title.slice(0, 47) + '...' : node.title;
  return `${icon} ${typeIcon} ${chalk.bold(title)}`;
}

function formatNodeDetail(node: PlanNode): string {
  const lines: string[] = [];

  lines.push(chalk.bold(`\n${TYPE_ICONS[node.type] || '▸'} ${node.title}\n`));
  lines.push(`  ${chalk.dim('ID:')}          ${chalk.cyan(node.id)}`);
  lines.push(`  ${chalk.dim('Type:')}        ${node.type}`);
  lines.push(`  ${chalk.dim('Status:')}      ${formatStatus(node.status)}`);

  if (node.description) {
    lines.push(`  ${chalk.dim('Description:')} ${node.description}`);
  }

  if (node.priority) {
    lines.push(`  ${chalk.dim('Priority:')}    ${node.priority}`);
  }

  if (node.estimate) {
    lines.push(`  ${chalk.dim('Estimate:')}    ${node.estimate}`);
  }

  if (node.startDate || node.endDate) {
    lines.push(`  ${chalk.dim('Dates:')}       ${formatDate(node.startDate)} → ${formatDate(node.endDate)}`);
  }

  if (node.dueDate) {
    lines.push(`  ${chalk.dim('Due:')}         ${formatDate(node.dueDate)}`);
  }

  if (node.verification) {
    lines.push(`  ${chalk.dim('Verification:')} ${node.verification}`);
  }

  if (node.milestoneId) {
    lines.push(`  ${chalk.dim('Milestone:')}   ${node.milestoneId}`);
  }

  if (node.executionId) {
    lines.push(`  ${chalk.dim('Execution:')}   ${node.executionId}`);
    if (node.executionError) {
      lines.push(`  ${chalk.red('Error:')}       ${node.executionError}`);
    }
  }

  if (node.branchName) {
    lines.push(`  ${chalk.dim('Branch:')}      ${chalk.cyan(node.branchName)}`);
  }

  if (node.prUrl) {
    lines.push(`  ${chalk.dim('PR:')}          ${chalk.cyan(node.prUrl)}`);
  }

  lines.push(`  ${chalk.dim('Created:')}     ${formatDate(node.createdAt)}`);
  lines.push(`  ${chalk.dim('Updated:')}     ${formatDate(node.updatedAt)}`);

  return lines.join('\n');
}

// ============================================================================
// Graph Building
// ============================================================================

interface TreeNode extends PlanNode {
  children: TreeNode[];
  level: number;
}

/**
 * Build a tree structure from nodes and edges
 */
function buildTree(nodes: PlanNode[], edges: PlanEdge[]): TreeNode[] {
  // Create a map of node ID to node
  const nodeMap = new Map<string, TreeNode>();
  for (const node of nodes) {
    nodeMap.set(node.id, { ...node, children: [], level: 0 });
  }

  // Build parent-child relationships from edges (dependency edges)
  // In dependency edges, target depends on source, so source is the "parent" in execution order
  const childrenMap = new Map<string, string[]>();
  const hasParent = new Set<string>();

  for (const edge of edges) {
    // edge.source -> edge.target means target depends on source
    // So source's "children" (things that come after it) include target
    if (!childrenMap.has(edge.source)) {
      childrenMap.set(edge.source, []);
    }
    childrenMap.get(edge.source)!.push(edge.target);
    hasParent.add(edge.target);
  }

  // Wire up children
  for (const [parentId, childIds] of childrenMap) {
    const parent = nodeMap.get(parentId);
    if (parent) {
      for (const childId of childIds) {
        const child = nodeMap.get(childId);
        if (child) {
          parent.children.push(child);
        }
      }
    }
  }

  // Find root nodes (nodes with no incoming edges)
  const roots: TreeNode[] = [];
  for (const node of nodeMap.values()) {
    if (!hasParent.has(node.id)) {
      roots.push(node);
    }
  }

  // If no roots found (cycles or isolated nodes), return all nodes as roots
  if (roots.length === 0) {
    return Array.from(nodeMap.values());
  }

  // Assign levels via BFS
  const queue: TreeNode[] = [...roots];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node.id)) continue;
    visited.add(node.id);

    for (const child of node.children) {
      child.level = Math.max(child.level, node.level + 1);
      if (!visited.has(child.id)) {
        queue.push(child);
      }
    }
  }

  return roots;
}

/**
 * Convert tree to nested JSON structure with children arrays
 */
function treeToJson(roots: TreeNode[]): unknown[] {
  function nodeToJson(node: TreeNode): unknown {
    return {
      id: node.id,
      type: node.type,
      title: node.title,
      description: node.description,
      status: node.status,
      priority: node.priority,
      estimate: node.estimate,
      startDate: node.startDate,
      endDate: node.endDate,
      dueDate: node.dueDate,
      verification: node.verification,
      executionId: node.executionId,
      branchName: node.branchName,
      prUrl: node.prUrl,
      children: node.children.map(nodeToJson),
    };
  }
  return roots.map(nodeToJson);
}

/**
 * Render ASCII graph
 */
function renderAsciiGraph(roots: TreeNode[]): string {
  const lines: string[] = [];
  const visited = new Set<string>();

  function renderNode(node: TreeNode, prefix: string, isLast: boolean, isRoot: boolean): void {
    if (visited.has(node.id)) {
      // Handle cycles - show reference
      const connector = isRoot ? '' : (isLast ? '└── ' : '├── ');
      lines.push(`${prefix}${connector}${chalk.dim(`(→ ${node.title.slice(0, 20)}...)`)}`);
      return;
    }
    visited.add(node.id);

    // Current node line
    const connector = isRoot ? '' : (isLast ? '└── ' : '├── ');
    const statusIcon = STATUS_ICONS[node.status] || '○';
    const typeIcon = TYPE_ICONS[node.type] || '▸';
    const title = node.title.length > 40 ? node.title.slice(0, 37) + '...' : node.title;

    lines.push(`${prefix}${connector}${statusIcon} ${typeIcon} ${chalk.bold(title)} ${chalk.dim(`[${node.id.slice(0, 8)}]`)}`);

    // Render children
    const childPrefix = isRoot ? '' : (prefix + (isLast ? '    ' : '│   '));
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const childIsLast = i === node.children.length - 1;
      renderNode(child, childPrefix, childIsLast, false);
    }
  }

  for (let i = 0; i < roots.length; i++) {
    renderNode(roots[i], '', i === roots.length - 1, true);
  }

  return lines.join('\n');
}

// ============================================================================
// Commands
// ============================================================================

/**
 * List all plan nodes for a project
 */
export async function planListCommand(options: PlanListOptions): Promise<void> {
  const { projectId, json } = options;

  try {
    const planData = await fetchPlanData(projectId);

    if (json) {
      console.log(JSON.stringify(planData.nodes, null, 2));
      return;
    }

    if (planData.nodes.length === 0) {
      console.log(chalk.dim('\nNo plan nodes found for this project.\n'));
      return;
    }

    console.log(chalk.bold(`\n📋 Plan Nodes (${planData.nodes.length})\n`));

    // Group by status
    const byStatus: Record<string, PlanNode[]> = {};
    for (const node of planData.nodes) {
      if (!byStatus[node.status]) {
        byStatus[node.status] = [];
      }
      byStatus[node.status].push(node);
    }

    // Order statuses
    const statusOrder = ['in_progress', 'dispatched', 'planned', 'awaiting_approval', 'awaiting_judgment', 'auto_verified', 'completed', 'pruned'];

    for (const status of statusOrder) {
      const nodes = byStatus[status];
      if (!nodes || nodes.length === 0) continue;

      console.log(chalk.bold(`${formatStatus(status)} (${nodes.length})`));
      for (const node of nodes) {
        console.log(`  ${formatNodeSummary(node)} ${chalk.dim(`[${node.id.slice(0, 8)}]`)}`);
      }
      console.log();
    }
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Show details for a specific plan node
 */
export async function planShowCommand(options: PlanShowOptions): Promise<void> {
  const { nodeId, json } = options;

  try {
    // We need to fetch all plans and find the node
    // The API doesn't have a direct node lookup, so we fetch all projects first
    const apiUrl = config.getApiUrl();
    const accessToken = config.getAccessToken();

    if (!accessToken) {
      throw new Error('Not authenticated. Run: npx @astroanywhere/agent@latest launch');
    }

    // Fetch all plans
    const res = await fetch(`${apiUrl}/api/data/plan`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to fetch plan data (${res.status}): ${body}`);
    }

    const planData = (await res.json()) as PlanData;

    // Find the node
    const node = planData.nodes.find(n => n.id === nodeId || n.id.startsWith(nodeId));

    if (!node) {
      console.error(chalk.red(`Node not found: ${nodeId}`));
      process.exit(1);
    }

    if (json) {
      console.log(JSON.stringify(node, null, 2));
      return;
    }

    console.log(formatNodeDetail(node));

    // Show dependencies
    const incomingEdges = planData.edges.filter(e => e.target === node.id);
    const outgoingEdges = planData.edges.filter(e => e.source === node.id);

    if (incomingEdges.length > 0) {
      console.log(chalk.bold('\n  Dependencies (blocks this):'));
      for (const edge of incomingEdges) {
        const dep = planData.nodes.find(n => n.id === edge.source);
        if (dep) {
          console.log(`    ${formatNodeSummary(dep)} ${chalk.dim(`[${dep.id.slice(0, 8)}]`)}`);
        }
      }
    }

    if (outgoingEdges.length > 0) {
      console.log(chalk.bold('\n  Dependents (blocked by this):'));
      for (const edge of outgoingEdges) {
        const dep = planData.nodes.find(n => n.id === edge.target);
        if (dep) {
          console.log(`    ${formatNodeSummary(dep)} ${chalk.dim(`[${dep.id.slice(0, 8)}]`)}`);
        }
      }
    }

    console.log();
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Show ASCII dependency graph for a project
 */
export async function planGraphCommand(options: PlanGraphOptions): Promise<void> {
  const { projectId, json } = options;

  try {
    const planData = await fetchPlanData(projectId);

    if (planData.nodes.length === 0) {
      console.log(chalk.dim('\nNo plan nodes found for this project.\n'));
      return;
    }

    const roots = buildTree(planData.nodes, planData.edges);

    if (json) {
      const nestedJson = treeToJson(roots);
      console.log(JSON.stringify(nestedJson, null, 2));
      return;
    }

    console.log(chalk.bold('\n🌳 Plan Dependency Graph\n'));
    console.log(renderAsciiGraph(roots));
    console.log();

    // Legend
    console.log(chalk.dim('Legend:'));
    console.log(chalk.dim(`  ${STATUS_ICONS.planned} planned  ${STATUS_ICONS.in_progress} in progress  ${STATUS_ICONS.completed} completed  ${STATUS_ICONS.pruned} pruned`));
    console.log(chalk.dim(`  ${TYPE_ICONS.milestone} milestone  ${TYPE_ICONS.task} task  ${TYPE_ICONS.branch} branch  ${TYPE_ICONS.decision} decision`));
    console.log();
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
