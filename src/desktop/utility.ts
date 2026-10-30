import { createCore } from "../core/index";
const port = (process as any).parentPort;
const core = await createCore({
  dataDir: process.env.WORKSPACE_DATA_DIR!,
  emit: (event: any) => port.postMessage({ type: "event", event }),
});
port.on("message", async ({ data }: any) => {
  if (data.type === "shutdown") {
    await core.close();
    port.postMessage({ type: "closed" });
    process.exit(0);
  }
  if (data.type === "invoke") {
    try {
      const result = await core.invoke(data.command, data.payload);
      port.postMessage({ type: "result", id: data.id, result });
    } catch (error) {
      port.postMessage({
        type: "result",
        id: data.id,
        error: error instanceof Error ? error.message : "Core operation failed",
      });
    }
  }
});
port.postMessage({ type: "ready" });
