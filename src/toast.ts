export function createPathCopiedToast(document: Document) {
  const window = document.defaultView!;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.setAttribute("aria-atomic", "true");
  document.body.append(toast);
  let timer: number | undefined;

  return () => {
    window.clearTimeout(timer);
    toast.textContent = "Path copied";
    toast.classList.add("visible");
    timer = window.setTimeout(() => toast.classList.remove("visible"), 1500);
  };
}
