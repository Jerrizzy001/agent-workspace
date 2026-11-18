// Apply the saved color scheme before the first paint, including browser pairing.
(() => {
  let mode = "dark";
  try {
    mode = localStorage.getItem("workspace.appearance") || "dark";
  } catch {}
  document.documentElement.dataset.theme =
    mode === "light" ||
    (mode === "system" && !matchMedia("(prefers-color-scheme: dark)").matches)
      ? "light"
      : "dark";
})();
