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
  if (data.type === "invoke" || data.type === "attachment" || data.type === "agentControl") {
    try {
      // Image bytes arrive only from the desktop clipboard broker in main;
      // agent-control grants only from the owner window's IPC in main.
      const result =
        data.type === "agentControl"
          ? await core.agentControl(data.action, data.payload)
          : data.type === "attachment"
          ? await core.createAttachment({
              sessionId: data.sessionId,
              generation: data.generation,
              data: data.data,
            })
          : await core.invoke(data.command, data.payload);
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
