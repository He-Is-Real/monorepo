// Share links (plan 1.3): the services' plain share URLs. No SDKs, scripts or trackers: the
// browser just opens the address. Instagram has no share URL, so the menu copies the link.

export function shareLinks(url: string, title: string) {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(title);
  return {
    whatsapp: `https://wa.me/?text=${t}%20${u}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
    x: `https://x.com/intent/post?url=${u}&text=${t}`,
  };
}
