import type { Tool, ToolSpec } from "../types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregisterPrefix(prefix: string): void {
    for (const name of [...this.tools.keys()]) if (name.startsWith(prefix)) this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(groups?: Tool["group"][]): Tool[] {
    return [...this.tools.values()].filter((t) => !groups || groups.includes(t.group));
  }

  specs(groups?: Tool["group"][]): ToolSpec[] {
    return this.list(groups).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }
}
