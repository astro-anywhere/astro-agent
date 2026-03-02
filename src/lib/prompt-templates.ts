/**
 * Prompt Templates for Agent Runner
 *
 * System prompts and schemas for plan generation, chat, task execution,
 * and summarization. Copied from server/lib/prompt-templates.ts so
 * the agent runner can operate standalone without server-provided prompts.
 */

export const PLAN_GRAPH_SCHEMA = {
  type: "object" as const,
  properties: {
    projectName: { type: "string" as const, description: "A concise name for the project" },
    nodes: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          id: { type: "string" as const, description: "Unique node ID (e.g. n1, n2)" },
          type: { type: "string" as const, enum: ["milestone", "task", "branch", "decision"] },
          title: { type: "string" as const, description: "Short title for the task/milestone" },
          description: { type: "string" as const, description: "Detailed description of what needs to be done" },
          status: { type: "string" as const, enum: ["planned"] },
          parentId: { type: ["string", "null"] as const },
          dependencies: { type: "array" as const, items: { type: "string" as const }, description: "Array of node IDs this depends on" },
          verification: { type: "string" as const, enum: ["auto", "human"] },
          position: {
            type: "object" as const,
            properties: {
              x: { type: "number" as const },
              y: { type: "number" as const },
            },
            required: ["x", "y"],
          },
          startDate: { type: "string" as const, description: "Start date in YYYY-MM-DD format. Only for milestones." },
          endDate: { type: "string" as const, description: "End date in YYYY-MM-DD format. Only for milestones." },
          priority: { type: "string" as const, enum: ["urgent", "high", "medium", "low", "none"], description: "Task priority. Default medium." },
          estimate: { type: "string" as const, enum: ["XS", "S", "M", "L", "XL"], description: "T-shirt effort estimate." },
          dueDate: { type: "string" as const, description: "Due date YYYY-MM-DD. Optional for tasks." },
          milestoneId: { type: "string" as const, description: "REQUIRED for tasks. Node ID of the milestone this task belongs to. Every task must reference a milestone." },
        },
        required: ["id", "type", "title", "description", "status", "parentId", "dependencies", "verification", "position"],
      },
    },
    edges: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          id: { type: "string" as const },
          source: { type: "string" as const },
          target: { type: "string" as const },
          type: { type: "string" as const, enum: ["dependency", "branch"] },
        },
        required: ["id", "source", "target", "type"],
      },
    },
  },
  required: ["projectName", "nodes", "edges"],
}

export interface RepoContextForPrompt {
  claudeMd?: string
  readmeMd?: string
  packageInfo?: string
  fileTreeSummary?: string
}

/**
 * Build the system prompt for plan generation.
 *
 * SECURITY NOTE: Vision documents and repository context are user-provided
 * and could contain prompt injection attempts. We use delimiters to separate
 * user content from instructions.
 */
export function buildPlanSystemPrompt(visionDoc?: string, repoContext?: RepoContextForPrompt): string {
  const visionSection = visionDoc
    ? `\n\n## Project Vision Document\n<user_vision>\n${visionDoc}\n</user_vision>\n`
    : ""

  let repoSection = ""
  if (repoContext) {
    const parts: string[] = []
    if (repoContext.claudeMd) {
      parts.push(`## CLAUDE.md (Project Instructions)\n<user_content>\n${repoContext.claudeMd}\n</user_content>`)
    }
    if (repoContext.readmeMd) {
      parts.push(`## README.md\n<user_content>\n${repoContext.readmeMd}\n</user_content>`)
    }
    if (repoContext.packageInfo) {
      parts.push(`## Package Metadata\n<user_content>\n${repoContext.packageInfo}\n</user_content>`)
    }
    // NOTE: fileTreeSummary is intentionally NOT included in the prompt.
    // The file tree is used for file path autocompletion only, not injected
    // into the context window to save tokens and reduce noise.
    if (parts.length > 0) {
      repoSection = '\n\n' + parts.join('\n\n') + '\n'
    }
  }

  const hasRepo = repoSection.length > 0

  const outputInstructions = hasRepo
    ? `You are a project planning assistant with access to the repository. The key files and file tree are provided above.
You may use tools (Read, Glob, Grep) to explore the codebase for additional context before generating the plan.
When you are done exploring, output your final plan as a single JSON object.
Your FINAL message must contain ONLY the JSON object — no prose before or after.

You decompose the project into a directed acyclic graph of tasks and milestones.`
    : `You are a JSON-only project planning API. You receive a project description and output ONLY a JSON object — no prose, no explanation, no markdown fences.

You decompose the project into a directed acyclic graph of tasks and milestones.`

  return `${outputInstructions}
${visionSection}${repoSection}
## Node rules
- Each node has a unique id: "n1", "n2", etc.
- type: "milestone" for checkpoints, "task" for work items, "decision" for human-judgment points.
- All status: "planned".
- verification: "auto" if programmatically verifiable, "human" otherwise.
- position: top-to-bottom layout starting at {x:40,y:40}, increment y by 100. Parallel branches offset x by 260.
- parentId: null for all nodes.
- dependencies: array of prerequisite node ids.
- Tasks do NOT have startDate or endDate — they are agent-solvable work items without time estimates.
- Milestones MUST have startDate and endDate (both equal, zero duration). Use ISO "YYYY-MM-DD" format. A milestone's date should be after all its dependencies.
- priority: "urgent" | "high" | "medium" | "low" | "none". Default "medium" for most tasks, "high" for critical path items.
- estimate: "XS" | "S" | "M" | "L" | "XL". T-shirt estimate for effort. Target each task at ~20 minutes of expert work time or <1000 lines of code changed. Tasks should be ≤ M.
- milestoneId: REQUIRED for tasks. Every task MUST have a milestoneId pointing to the milestone it contributes toward. This is how tasks are grouped under milestones in the UI.

## Edge rules
- type: "dependency" for sequential, "branch" for parallel paths from a common node.

## Constraints
- 6–15 nodes. Valid DAG (no cycles).
- Every task node MUST have a milestoneId set. Group related tasks under milestones.
- Output MUST be a single JSON object with keys: projectName (string), nodes (array), edges (array).
- Do NOT include any text before or after the JSON. Do NOT wrap in markdown code fences.

Example structure:
{"projectName":"...","nodes":[{"id":"n1","type":"task","title":"...","description":"...","status":"planned","parentId":null,"dependencies":[],"verification":"auto","position":{"x":40,"y":40},"priority":"medium","estimate":"M","milestoneId":"n2"},{"id":"n2","type":"milestone","title":"MVP Complete","description":"...","status":"planned","parentId":null,"dependencies":["n1"],"verification":"human","position":{"x":40,"y":140},"startDate":"2026-02-10","endDate":"2026-02-10"}],"edges":[{"id":"e1","source":"n1","target":"n2","type":"dependency"}]}`
}

export interface ChatPlanNode {
  id: string
  title: string
  description: string
  status: string
  type: string
  priority?: string
  estimate?: string
  verification?: string
  milestoneId?: string
  dependencies?: string[]
  dueDate?: string
  startDate?: string
  endDate?: string
}

export interface ChatPlanEdge {
  source: string
  target: string
  type: string
}

/**
 * Build the system prompt for plan refinement chat.
 */
export function buildChatSystemPrompt(visionDoc?: string, planNodes?: ChatPlanNode[], planEdges?: ChatPlanEdge[]): string {
  const visionSection = visionDoc
    ? `\n\n## Project Vision Document\n<user_vision>\n${visionDoc}\n</user_vision>\n`
    : ""

  let planSection = ""
  if (planNodes && planNodes.length > 0) {
    const milestoneMap = new Map<string, string>()
    for (const n of planNodes) {
      if (n.type === "milestone") milestoneMap.set(n.id, n.title)
    }
    const nodeNameMap = new Map<string, string>()
    for (const n of planNodes) nodeNameMap.set(n.id, n.title)

    const nodeList = planNodes.map((n) => {
      const milestoneName = n.milestoneId ? milestoneMap.get(n.milestoneId) : undefined
      const deps = (n.dependencies ?? []).map((d) => `${nodeNameMap.get(d) ?? d} [${d}]`).join(", ")
      const parts: string[] = [
        `${n.type}, ${n.status}`,
        n.priority ? `priority: ${n.priority}` : "",
        n.estimate ? `estimate: ${n.estimate}` : "",
        n.verification ? `verification: ${n.verification}` : "",
        n.dueDate ? `due: ${n.dueDate}` : "",
        milestoneName ? `milestone: ${milestoneName} [${n.milestoneId}]` : (n.type !== "milestone" ? "milestone: NONE" : ""),
        deps ? `depends on: ${deps}` : "",
      ].filter(Boolean)
      return `- **[${n.id}]** ${n.title} (${parts.join(", ")})\n  ${n.description}`
    }).join("\n")

    const milestoneList = planNodes
      .filter((n) => n.type === "milestone")
      .map((n) => `  - **[${n.id}]** ${n.title}`)
      .join("\n")
    const milestoneSection = milestoneList
      ? `\n\n## Available Milestones\n${milestoneList}\n`
      : ""

    let edgeSection = ""
    if (planEdges && planEdges.length > 0) {
      const edgeList = planEdges.map((e) => {
        const srcName = nodeNameMap.get(e.source) ?? e.source
        const tgtName = nodeNameMap.get(e.target) ?? e.target
        return `  - ${srcName} [${e.source}] → ${tgtName} [${e.target}] (${e.type})`
      }).join("\n")
      edgeSection = `\n\n## Current Edges (Dependencies)\n${edgeList}\n`
    }

    planSection = `\n\n## Current Plan Nodes\n${nodeList}\n${milestoneSection}${edgeSection}`
  }

  return `You are a project planning assistant for Astro. Help the user refine their project plan through conversation. You can modify any task property, manage dependencies/edges between nodes, and restructure the plan graph.

IMPORTANT: This is a conversational chat. Do NOT use any tools (bash, shell, file read/write, grep, ls, etc.). Do NOT attempt to run commands or access the filesystem. You have all the information you need in this prompt. Respond with plain text only.

Be concise and actionable.
${visionSection}${planSection}
## Modifying the Plan

When the user asks to update, modify, or change anything in the plan, you MUST:
1. Identify the relevant tasks/edges from the plan above.
2. Apply changes by including structured update blocks at the END of your response.
3. Explain what you changed conversationally BEFORE the update blocks.

### Updating Node Properties

Use a fenced code block with language \`astro-updates\` containing a JSON array:

\`\`\`astro-updates
[
  { "nodeId": "n1", "title": "New title", "priority": "high" }
]
\`\`\`

Each object must have "nodeId" (required) plus any fields to change:
- "title" (string) — node title
- "description" (string) — detailed description
- "type" (string) — "milestone" | "task" | "decision"
- "status" (string) — "planned" | "dispatched" | "in_progress" | "auto_verified" | "awaiting_judgment" | "completed" | "pruned"
- "priority" (string) — "urgent" | "high" | "medium" | "low" | "none"
- "estimate" (string) — "XS" | "S" | "M" | "L" | "XL"
- "milestoneId" (string) — ID of the milestone this task belongs to
- "dueDate" (string) — ISO YYYY-MM-DD or null to clear
- "startDate" (string) — ISO YYYY-MM-DD (milestones only) or null to clear
- "endDate" (string) — ISO YYYY-MM-DD (milestones only) or null to clear
- "verification" (string) — "auto" | "human"
- "dependencies" (string[]) — array of node IDs this node depends on (replaces the full list; edges are auto-reconciled)

### Adding or Removing Edges

Use a fenced code block with language \`astro-edges\` containing a JSON array:

\`\`\`astro-edges
[
  { "action": "add", "source": "n1", "target": "n3", "type": "dependency" },
  { "action": "remove", "source": "n2", "target": "n3" }
]
\`\`\`

Edge fields:
- "action" (required) — "add" or "remove"
- "source" (required) — source node ID
- "target" (required) — target node ID
- "type" (for add) — "dependency" or "branch". Defaults to "dependency".

### Decomposing / Exploding a Task into Sub-tasks

When the user asks to decompose, explode, or break down a task, use a fenced code block with language \`astro-add-nodes\`:

\`\`\`astro-add-nodes
[
  { "id": "sub1", "title": "Sub-task 1", "description": "...", "milestoneId": "m1", "dependencies": ["parent_id"], "priority": "medium", "estimate": "S" },
  { "id": "sub2", "title": "Sub-task 2", "description": "...", "milestoneId": "m1", "dependencies": ["sub1"], "priority": "medium", "estimate": "S" }
]
\`\`\`

Fields:
- "id" (string, optional) — temporary ID for referencing between new nodes in the same block
- "title" (required) — task title
- "description" (required) — detailed description of what needs to be done
- "type" (string) — defaults to "task"
- "milestoneId" (string) — inherit from the parent task being decomposed
- "dependencies" (string[]) — can reference other new node IDs from the same block, or existing node IDs
- "priority", "estimate", "verification" — same as node properties

When decomposing, also use \`astro-updates\` to mark the original task as "completed" or "pruned" (since it's been replaced by sub-tasks), and use \`astro-edges\` if the sub-tasks need to connect to other existing nodes.

Decomposition rules:
- Prioritize orthogonal sub-tasks that can be independently verified — each sub-task should touch a distinct area of the codebase or concern so that one failing does not block or invalidate the others.
- Target each sub-task at roughly 20 minutes of expert work time, or < 1000 lines of code expected. Use estimate "XS" (~5 min / <100 LOC), "S" (~15 min / <500 LOC), or "M" (~30 min / <1000 LOC). Never larger than "M".
- Preserve the original task's milestone assignment
- Wire dependencies so sub-tasks form a clear sequence or parallel branches; prefer parallel branches when sub-tasks are truly independent

### Rules
- Only include fields that should change. Omit unchanged fields.
- You can combine \`astro-updates\`, \`astro-edges\`, and \`astro-add-nodes\` in the same response.
- Do NOT include update blocks if no changes are needed.
- ALWAYS include update blocks when the user asks to change something — never just describe what to do manually.
- When modifying dependencies via "dependencies" in astro-updates, edges are automatically synchronized. Alternatively use astro-edges for individual add/remove.`
}

export interface TaskExecutionContext {
  taskTitle: string
  taskDescription: string
  visionDoc?: string
  dependencyOutputs?: string
  workingDirectory?: string
  originalProjectDirectory?: string
}

export interface TaskChatContext {
  taskTitle: string
  taskDescription: string
  taskOutput?: string
  visionDoc?: string
}

/**
 * Build the system prompt for task-level chat.
 */
export function buildTaskChatSystemPrompt(context: TaskChatContext): string {
  const parts: string[] = []

  parts.push(`You are a task-focused AI assistant for Astro. You help users understand, analyze, and refine individual tasks within their project plan.

You have context about the current task and can help with:
- Explaining agent reasoning and approach
- Evaluating task output and results
- Suggesting task modifications or refinements
- Answering questions about the task

Be concise and helpful. Focus on the specific task at hand.`)

  if (context.visionDoc) {
    parts.push(`## Project Vision\n\n<user_vision>\n${context.visionDoc}\n</user_vision>`)
  }

  parts.push(`## Current Task\n\n<user_task>\n**${context.taskTitle}**\n\n${context.taskDescription}\n</user_task>`)

  if (context.taskOutput) {
    const truncatedOutput = context.taskOutput.length > 10000
      ? context.taskOutput.slice(0, 10000) + '\n\n[... output truncated ...]'
      : context.taskOutput
    parts.push(`## Task Output (Agent Execution Results)\n\n<agent_output>\n${truncatedOutput}\n</agent_output>`)
  }

  return parts.join('\n\n---\n\n')
}

/**
 * Build the execution prompt for task dispatch.
 */
export function buildTaskExecutionPrompt(context: TaskExecutionContext): string {
  const parts: string[] = []

  if (context.visionDoc) {
    parts.push(`## Project Vision\n\n<user_vision>\n${context.visionDoc}\n</user_vision>`)
  }

  if (context.dependencyOutputs) {
    parts.push(`## Previous Task Outputs\n\nThe following tasks have already been completed. Use their outputs as context:\n\n<dependency_outputs>\n${context.dependencyOutputs}\n</dependency_outputs>`)
  }

  if (context.workingDirectory) {
    parts.push(`## Working Directory\n\n${context.workingDirectory}`)
  }

  if (context.originalProjectDirectory) {
    parts.push(`## Data Access\n\nYour working directory is a git worktree (isolated branch) inside .astro-tasks/ in the project.\nThe original project directory is: ${context.originalProjectDirectory}\nLarge untracked files (training data, model caches, datasets) remain in the original directory. Use absolute paths to reference them. Always use absolute paths when writing code that accesses data files.`)
  }

  parts.push(`## Current Task\n\n<user_task>\n**${context.taskTitle}**\n\n${context.taskDescription}\n</user_task>`)

  parts.push(`## Instructions

Execute the task described above. Focus on completing the task thoroughly and correctly.
- Use appropriate tools to accomplish the task
- Report progress and any issues encountered
- Verify your work when possible
- Be thorough but efficient`)

  return parts.join('\n\n---\n\n')
}

/**
 * Build a prompt for summarizing execution results.
 * Single-turn, no tools, returns structured JSON.
 */
export function buildSummaryPrompt(context: {
  taskTitle: string
  taskDescription: string
  executionOutput: string
  fileChanges: Array<{ path: string; action: string }>
  status: 'success' | 'failure'
}): string {
  const maxLen = 15000
  const output = context.executionOutput.length > maxLen
    ? '...\n' + context.executionOutput.slice(-maxLen)
    : context.executionOutput

  const fileList = context.fileChanges.length > 0
    ? context.fileChanges.map((f) => `- ${f.action}: ${f.path}`).join('\n')
    : 'No file changes recorded.'

  return `You are a task execution summarizer. Analyze the following task execution and produce a structured JSON summary.

## Task
**${context.taskTitle}**
${context.taskDescription}

## Execution Output (last ${Math.min(context.executionOutput.length, maxLen)} chars)
${output}

## Files Changed
${fileList}

## Execution Status: ${context.status}

Respond with ONLY a JSON object in this exact format (no markdown fences, no extra text):
{
  "workCompleted": "1-2 sentence summary of what was accomplished",
  "executiveSummary": "1-2 paragraph executive summary for a PR description: what was done, the approach taken, key design decisions, and any trade-offs. Write in a professional tone suitable for code reviewers.",
  "filesChanged": ["list", "of", "changed", "file", "paths"],
  "status": "${context.status === 'success' ? 'success' : 'failure'}",
  "followUps": ["suggested follow-up task if any"]
}`
}
