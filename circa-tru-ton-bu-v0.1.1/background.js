// Chỉ mở trang công cụ. Mọi lời gọi mạng nằm trong trang công cụ (tool.js); không có tác vụ nền, không tự gửi gì.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("tool.html");
  const [tab] = await chrome.tabs.query({ url });
  if (tab) await chrome.tabs.update(tab.id, { active: true });
  else await chrome.tabs.create({ url });
});
