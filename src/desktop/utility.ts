import { createCore } from "../core/index";
import { createHostRouter, type HostRouter } from "../core/host-router";
const port = (process as any).parentPort;
const send = (event: any) => port.postMessage({ type: "event", event });
let router: HostRouter | undefined;
const core = await createCore({
  dataDir: process.env.WORKSPACE_DATA_DIR!,
  emit: (event: any) => (router ? router.onLocalEvent(event) : send(event)),
});
// Every command goes through the host router: local folders run in this
// core, SSH folders on their execution host's helper.
router = await createHostRouter({ local: core, emit: send });
port.on("message", async ({ data }: any) => {
  if (data.type === "shutdown") {
    // Disconnecting SSH hosts leaves their tmux sessions running.
    await router!.close().catch(() => {});
    await core.close();
    port.postMessage({ type: "closed" });
    process.exit(0);
  }
  if (
    data.type === "invoke" ||
    data.type === "attachment" ||
    data.type === "agentControl" ||
    data.type === "profiles" ||
    data.type === "ssh" ||
    data.type === "team"
  ) {
    try {
      // Image bytes arrive only from the desktop clipboard broker in main;
      // agent-control grants and SSH management only from the owner window.
      const result =
        data.type === "team"
          ? await router!.team(data.action, data.payload)
          : data.type === "ssh"
          ? await router!.ssh(data.action, data.payload)
          : data.type === "agentControl"
            ? await router!.agentControl(data.action, data.payload)
            : data.type === "profiles"
            ? await router!.profiles(data.action, data.payload)
            : data.type === "attachment"
              ? await router!.createAttachment({
                  sessionId: data.sessionId,
                  generation: data.generation,
                  data: data.data,
                })
              : await router!.invoke(data.command, data.payload);
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
