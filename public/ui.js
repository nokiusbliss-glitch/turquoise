export function initUI() {

  const menuBtn = document.getElementById("menuBtn");
  const sidebar = document.getElementById("sidebar");

  if (!menuBtn || !sidebar) {
    throw new Error("Invariant violated: UI elements missing");
  }

  menuBtn.addEventListener("click", () => {
    sidebar.classList.toggle("hidden");
  });
}