const fileInput = document.getElementById("fileInput");
const openBtn = document.getElementById("openBtn");

let file;

fileInput.addEventListener("change", e => {
  file = e.target.files[0];
  openBtn.disabled = !file;
});

openBtn.addEventListener("click", async () => {
  const arrayBuffer = await file.arrayBuffer();
  const base64 = btoa(
    String.fromCharCode(...new Uint8Array(arrayBuffer))
  );

  const url = chrome.runtime.getURL("viewer.html") + `#${base64}`;
  chrome.tabs.create({ url });
});
