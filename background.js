chrome.commands.onCommand.addListener(command => {
  if (command === "open-upload") {
    chrome.action.openPopup();
  }
});
