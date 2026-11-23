// Ustawia licznik ukrytych ofert na ikonie dodatku w danej karcie.
const api = globalThis.browser ?? globalThis.chrome;

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "cw-badge" || !sender.tab) return;
  const tabId = sender.tab.id;
  api.action.setBadgeText({ tabId, text: msg.text || "" });
  api.action.setBadgeBackgroundColor({ tabId, color: "#1d7a46" });
  if (api.action.setBadgeTextColor) api.action.setBadgeTextColor({ tabId, color: "#ffffff" });
});
