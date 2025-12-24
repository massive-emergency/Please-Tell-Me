document.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("fileInput");
  const openBtn = document.getElementById("openBtn");

  let file = null;
  let busy = false;

  openBtn.disabled = true;

  fileInput.addEventListener("change", (e) => {
    file = e.target.files?.[0] || null;
    openBtn.disabled = !file;
  });

  openBtn.addEventListener("click", async () => {
    if (!file || busy) return;
    busy = true;
    openBtn.disabled = true;

    try {
      const buffer = await file.arrayBuffer();
      const token = crypto.randomUUID();

      await chrome.storage.session.set({
        [token]: buffer
      });

      const url =
        chrome.runtime.getURL("viewer.html") + `#${token}`;
      chrome.tabs.create({ url });
    } catch (err) {
      console.error("Failed to open PDF:", err);
      busy = false;
      openBtn.disabled = false;
    }
  });
});
