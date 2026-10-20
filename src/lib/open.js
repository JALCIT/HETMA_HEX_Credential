// Open a short-lived file link in a new tab. The tab is opened during the click
// (so popup blockers allow it) and pointed at the signed URL once it arrives.
export async function openSigned(getUrl) {
  const tab = window.open('about:blank', '_blank');
  try {
    const url = await getUrl();
    if (tab) { tab.opener = null; tab.location.href = url; } else window.location.assign(url);
  } catch (e) { tab?.close(); throw e; }
}
