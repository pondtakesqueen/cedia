import { bashTool } from './bash.ts';
import { editTool, writeTool } from './edit.ts';
import { readTool } from './read.ts';
import type { ToolSpec } from './registry.ts';

// The fixed order the model sees (cache rule 1).
export const CORE_TOOLS: ToolSpec[] = [readTool, editTool, writeTool, bashTool];
