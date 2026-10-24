import { bashTool } from './bash.ts';
import { editTool, writeTool } from './edit.ts';
import { grepTool } from './grep.ts';
import { readTool } from './read.ts';
import { sleepTool } from './sleep.ts';
import { notebookEditTool } from './notebook-edit.ts';
import { toolSearchTool } from './tool-search.ts';
import { monitorTool } from './monitor.ts';
import type { ToolSpec } from './registry.ts';

// The fixed order the model sees (cache rule 1).
export const CORE_TOOLS: ToolSpec[] = [readTool, grepTool, editTool, writeTool, bashTool, sleepTool, notebookEditTool, toolSearchTool, monitorTool];
