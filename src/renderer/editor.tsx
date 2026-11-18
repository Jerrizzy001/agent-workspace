import { useRef } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { useAppearance } from "./appearance";
self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};
loader.config({ monaco });
// Match the app's own surfaces (tokens.css).
monaco.editor.defineTheme("workspace-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#1e1e1e",
    "editor.lineHighlightBackground": "#262626",
    "editor.lineHighlightBorder": "#26262600",
    "editorLineNumber.foreground": "#6e6e6e",
    "editorLineNumber.activeForeground": "#a8a8a8",
    "editorGutter.background": "#1e1e1e",
    "editor.selectionBackground": "#3f638b",
    "editorCursor.foreground": "#e6e6e6",
    "editorWidget.background": "#2c2c2c",
    "editorWidget.border": "#4a4a4a",
    "scrollbarSlider.background": "#4a4a4a80",
    "scrollbarSlider.hoverBackground": "#5a5a5a",
  },
});
monaco.editor.defineTheme("workspace-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#ffffff",
    "editor.lineHighlightBackground": "#f5f5f5",
    "editor.lineHighlightBorder": "#f5f5f500",
    "editorLineNumber.foreground": "#8a8a8a",
    "editorLineNumber.activeForeground": "#1d1d1f",
    "editor.selectionBackground": "#b3d7ff",
    "editorCursor.foreground": "#1d1d1f",
  },
});
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
  const { resolved } = useAppearance();
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
      theme={resolved === "light" ? "workspace-light" : "workspace-dark"}
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
        fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace',
        padding: { top: 16 },
        scrollBeyondLastLine: false,
        automaticLayout: true,
      }}
    />
  );
}
