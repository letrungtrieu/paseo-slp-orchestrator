// Errors thrown by pipeline steps that should be reported back to the calling agent as a
// failed tool call (so it can correct itself) rather than crash the plugin.
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}
