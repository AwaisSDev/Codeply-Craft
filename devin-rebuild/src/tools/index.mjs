/**
 * The built-in tool set, by Devin's documented tool names.
 */
import { readTool, writeTool, editTool, lsTool } from './fs-tools.mjs';
import { execTool, getOutputTool, killShellTool } from './exec-tools.mjs';
import { grepTool, globTool } from './search-tools.mjs';
import { webFetchTool, todoTool } from './misc-tools.mjs';
import { applyPatchTool } from './apply-patch.mjs';
import { skillTool, runSubagentTool, readSubagentTool, askUserQuestionTool, exitPlanModeTool } from './agent-tools.mjs';

export function baseTools(agent) {
  const tools = [readTool, writeTool, editTool, applyPatchTool, lsTool, grepTool, globTool, execTool, getOutputTool, killShellTool, webFetchTool, todoTool];
  if (agent) {
    tools.push(skillTool(agent), askUserQuestionTool(agent));
    if (agent.profile === 'plan') tools.push(exitPlanModeTool(agent));
    const subagentsOn = agent.config?.settings?.subagents_enabled !== false;
    const nestingLeft = agent.depth === 0 || (agent.maxNesting != null && agent.depth < agent.maxNesting);
    if (subagentsOn && nestingLeft && agent.createChild) tools.push(runSubagentTool(agent), readSubagentTool);
  }
  return tools;
}
