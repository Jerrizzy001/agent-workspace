import { useRef } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};
loader.config({ monaco });
export default function CodeEditor({
  content,
  path,
  readOnly,
  onChange,
  onSave,
}: {
  content: string;
  path: string;
  readOnly: boolean;
  onChange: (v: string) => void;
  onSave?: () => void;
}) {
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const extension = path.split(".").pop();
  const language =
    extension === "diff"
      ? "diff"
      : ["ts", "tsx"].includes(extension || "")
        ? "typescript"
        : ["js", "jsx"].includes(extension || "")
          ? "javascript"
          : extension === "json"
            ? "json"
            : extension === "md"
              ? "markdown"
              : extension === "css"
                ? "css"
                : "plaintext";
  return (
    <Editor
      onMount={(editor) => {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
          saveRef.current?.(),
        );
      }}
      height="100%"
      theme="vs-dark"
      language={language}
      key={path + String(readOnly)}
      path={path}
      defaultValue={content}
      value={readOnly ? content : undefined}
      onChange={(v) => onChange(v || "")}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        padding: { top: 18 },
        scrollBeyondLastLine: false,
        automaticLayout: true,
      }}
    />
  );
}
