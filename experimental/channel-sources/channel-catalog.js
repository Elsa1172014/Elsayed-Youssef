/**
 * Isolated, opt-in channel catalog. No modifications to the existing IPTV app.
 * Source URLs must be officially authorized for this application.
 */
export function validateChannel(channel) {
  if (!channel || typeof channel !== "object") return false;
  if (!/^[a-z0-9_-]{3,64}$/i.test(channel.id || "")) return false;
  if (typeof channel.name !== "string" || !channel.name.trim()) return false;
  if (!["hls", "dash", "official_embed"].includes(channel.sourceType)) return false;
  if (channel.rightsVerified !== true || channel.enabled !== true) return false;
  if (typeof channel.rightsNotes !== "string" || !channel.rightsNotes.trim()) return false;
  try {
    const url = new URL(channel.sourceUrl);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}

export function listAuthorizedChannels(catalog) {
  if (!catalog || catalog.enabled !== true || !Array.isArray(catalog.channels)) return [];
  return catalog.channels.filter(validateChannel);
}

export function getPlayableSource(channel) {
  if (!validateChannel(channel)) return null;
  return { url: channel.sourceUrl, type: channel.sourceType };
}
